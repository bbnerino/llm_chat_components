import { readSSE, SSEIdleTimeoutError } from '../lib/sse/parseSSE'
import type { ErrorCode, ServerEvent, StartRunRequest } from './protocol'

/**
 * Transport 어댑터 계층.
 *
 * 런타임은 "ServerEvent의 비동기 스트림"만 알고, 그게 SSE인지 WebSocket인지
 * 테스트용 가짜 스트림인지 모른다. 테스트에서는 async generator 하나로 대체된다.
 */
export interface ChatTransport {
  /** run 시작. 같은 runId로 다시 호출하면 서버는 기존 run에 붙는다. */
  start(req: StartRunRequest, signal: AbortSignal): AsyncIterable<ServerEvent>
  /** after 이후의 이벤트부터 이어받기 */
  resume(runId: string, after: number, signal: AbortSignal): AsyncIterable<ServerEvent>
  /** 사용자 중지. 연결을 끊는 것만으로는 서버의 생성이 멈추지 않는다. */
  cancel(runId: string): Promise<void>
}

export class TransportError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(code: ErrorCode, message: string, retryable: boolean, retryAfterMs?: number) {
    super(message)
    this.name = 'TransportError'
    this.code = code
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
  }
}

/** 서버 heartbeat(2s)를 세 번 넘게 놓치면 끊긴 것으로 본다. */
const IDLE_TIMEOUT_MS = 7_000

export function createSSETransport(base = '/api', idleTimeoutMs = IDLE_TIMEOUT_MS): ChatTransport {
  async function* consume(url: string, init: RequestInit, signal: AbortSignal): AsyncGenerator<ServerEvent> {
    let res: Response
    try {
      res = await fetch(url, { ...init, signal })
    } catch (err) {
      if (signal.aborted) throw err
      throw new TransportError('network_error', '서버에 연결할 수 없습니다.', true)
    }

    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}))
      const retryAfterMs = body.retryAfterMs ?? parseRetryAfter(res.headers.get('retry-after'))
      throw new TransportError(
        body.code ?? (res.status >= 500 ? 'upstream_error' : 'bad_request'),
        body.message ?? `요청 실패 (HTTP ${res.status})`,
        body.retryable ?? (res.status === 429 || res.status >= 500),
        retryAfterMs,
      )
    }

    try {
      for await (const msg of readSSE(res.body, { signal, idleTimeoutMs })) {
        // 타입 검증은 런타임이 한다(무시한 이벤트를 telemetry로 남기기 위해)
        yield JSON.parse(msg.data) as ServerEvent
      }
    } catch (err) {
      if (signal.aborted) throw err
      if (err instanceof SSEIdleTimeoutError) {
        throw new TransportError('stream_stalled', '서버 응답이 멈췄습니다.', true)
      }
      throw new TransportError('network_error', '응답 도중 연결이 끊어졌습니다.', true)
    }
  }

  return {
    start(req, signal) {
      return consume(
        `${base}/runs`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(req) },
        signal,
      )
    },
    resume(runId, after, signal) {
      return consume(`${base}/runs/${encodeURIComponent(runId)}/events?after=${after}`, { headers: { Accept: 'text/event-stream' } }, signal)
    },
    async cancel(runId) {
      // keepalive: 탭을 닫는 중에도 요청이 끝까지 전송되도록
      await fetch(`${base}/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', keepalive: true }).catch(() => {})
    },
  }
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined
  const n = Number(v)
  return Number.isNaN(n) ? undefined : n * 1000
}
