/**
 * OpenAI Responses API 경계: 대화 이력 변환(+정리)과 에러 정규화.
 */
import type { ErrorCode, WireMessage } from '../src/runtime/protocol.ts'

type InputItem =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

/**
 * 클라이언트 이력 → Responses API input.
 *
 * 이력에는 "깨진 턴"이 섞여 있을 수 있다. 사용자가 tool 실행 중 중지하면
 * function_call은 있는데 function_call_output이 없는 상태가 남는다.
 * 이걸 그대로 보내면 API가 `400 No tool output found for function call`을 반환하고,
 * 그 대화는 이후 모든 메시지가 실패하는 "벽돌"이 된다.
 *
 * 정리 규칙
 *  1. 인자도 다 못 받은 tool(input-streaming)은 호출 자체를 없던 일로 한다.
 *  2. 인자는 받았지만 결과가 없는 tool은 "사용자가 취소함" 결과를 합성한다.
 *     (지우는 것보다 모델이 무슨 일이 있었는지 알 수 있어 다음 답변이 자연스럽다)
 *  3. 빈 assistant 텍스트는 보내지 않는다.
 */
export function toResponsesInput(messages: WireMessage[]): InputItem[] {
  const items: InputItem[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content.trim()) items.push({ role: 'user', content: m.content })
      continue
    }
    for (const part of m.parts) {
      if (part.type === 'text') {
        if (part.text.trim()) items.push({ role: 'assistant', content: part.text })
        continue
      }
      if (part.state === 'input-streaming' || part.args === undefined) continue // 규칙 1
      items.push({ type: 'function_call', call_id: part.callId, name: part.name, arguments: JSON.stringify(part.args) })
      const output =
        part.state === 'output-available'
          ? part.output
          : part.state === 'output-error'
            ? { error: part.error ?? 'tool_failed' }
            : { error: 'cancelled_by_user', note: '사용자가 이 작업을 중지했습니다.' } // 규칙 2
      items.push({ type: 'function_call_output', call_id: part.callId, output: JSON.stringify(output) })
    }
  }
  return items
}

export interface NormalizedError {
  code: ErrorCode
  message: string
  retryable: boolean
  retryAfterMs?: number
}

/** HTTP 응답(스트림 시작 전 실패)을 도메인 에러로 정규화 */
export async function normalizeHttpError(res: Response): Promise<NormalizedError> {
  const body: any = await res.json().catch(() => ({}))
  const err = body?.error ?? {}
  const retryAfterMs = parseRetryAfter(res.headers)

  if (res.status === 429) {
    if (err.code === 'insufficient_quota') {
      return { code: 'quota_exceeded', message: 'API 사용 한도를 초과했습니다.', retryable: false }
    }
    return { code: 'rate_limited', message: '요청이 많아 잠시 후 다시 시도합니다.', retryable: true, retryAfterMs }
  }
  if (res.status === 400 && (err.code === 'context_length_exceeded' || /context length|maximum context/i.test(err.message ?? ''))) {
    return { code: 'context_length_exceeded', message: '대화가 너무 길어 더 이상 이어갈 수 없습니다.', retryable: false }
  }
  if (res.status === 401 || res.status === 403) {
    return { code: 'auth_error', message: '모델 인증에 실패했습니다.', retryable: false }
  }
  if (res.status === 503 || res.status === 529) {
    return { code: 'overloaded', message: '모델이 혼잡합니다. 잠시 후 다시 시도합니다.', retryable: true, retryAfterMs }
  }
  if (res.status >= 500) {
    return { code: 'upstream_error', message: '모델 서버 오류가 발생했습니다.', retryable: true, retryAfterMs }
  }
  return { code: 'bad_request', message: err.message ?? '잘못된 요청입니다.', retryable: false }
}

/** 스트림 도중 도착한 error / response.failed 이벤트 정규화 (HTTP는 이미 200) */
export function normalizeStreamError(err: any): NormalizedError {
  const code = err?.code ?? err?.type
  if (code === 'rate_limit_exceeded') return { code: 'rate_limited', message: '요청이 많습니다.', retryable: true }
  if (code === 'server_error' || code === 'overloaded') {
    return { code: 'overloaded', message: '모델 처리 중 오류가 발생했습니다.', retryable: true }
  }
  if (code === 'context_length_exceeded') {
    return { code: 'context_length_exceeded', message: '대화가 너무 깁니다.', retryable: false }
  }
  return { code: 'upstream_error', message: err?.message ?? '응답 생성 중 오류가 발생했습니다.', retryable: false }
}

function parseRetryAfter(h: Headers): number | undefined {
  const ms = h.get('retry-after-ms')
  if (ms && !Number.isNaN(Number(ms))) return Number(ms)
  const s = h.get('retry-after')
  if (!s) return undefined
  if (!Number.isNaN(Number(s))) return Number(s) * 1000
  const date = Date.parse(s)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}
