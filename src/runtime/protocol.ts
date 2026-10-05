/**
 * BFF ↔ 클라이언트 와이어 프로토콜 (v2)
 *
 * v1과 달라진 점
 *  - 응답이 "텍스트 한 덩어리"가 아니라 text/tool이 섞인 parts의 흐름이 됐다.
 *  - run은 HTTP 연결과 분리됐다. 연결이 끊겨도 서버의 run은 계속되고,
 *    클라이언트는 `GET /api/runs/:runId/events?after=<seq>`로 이어받는다(resume).
 *  - 그래서 seq는 "연결" 단위가 아니라 "run" 단위로 단조 증가한다. 재연결해도 이어진다.
 *  - 사용자 중지는 연결 끊기가 아니라 명시적 cancel 요청이다. (끊김 ≠ 취소)
 */

export type ChatRole = 'user' | 'assistant'

// ── 요청 ────────────────────────────────────────────────────────────

export type WirePart =
  | { type: 'text'; text: string }
  | {
      type: 'tool'
      callId: string
      name: string
      /** 인자 스트리밍 도중 중지됐다면 undefined */
      args?: unknown
      state: ToolState
      output?: unknown
      error?: string
    }

export type WireMessage = { role: 'user'; content: string } | { role: 'assistant'; parts: WirePart[] }

export interface StartRunRequest {
  /** 클라이언트가 발급. 같은 runId로 다시 POST하면 서버는 새로 만들지 않고 기존 run에 붙는다(idempotency). */
  runId: string
  threadId: string
  messages: WireMessage[]
  fault?: FaultMode
}

/**
 * 장애 재현(개발 전용). 실제 운영에서 보고되는 이슈를 계층별로 재현한다.
 */
export type FaultMode =
  | 'none'
  // 네트워크 / 인프라
  | 'fail-before-first-token' // 503 → 자동 재시도
  | 'rate-limit' // 429 + Retry-After → 카운트다운 후 재시도
  | 'drop-mid-stream' // 응답 도중 소켓 끊김 → seq부터 이어받기
  | 'proxy-buffering' // 프록시가 이벤트를 모아서 몰아 보냄 → 토큰이 덩어리로 도착
  | 'server-restart' // 응답 도중 서버 재시작(메모리 로그 유실) → 이어받기 불가(run_gone)
  // 모델
  | 'mid-stream-error' // HTTP 200 이후 스트림 안에서 모델 에러 → 부분 응답 + 수동 재시도
  | 'length-limit' // 출력 길이 제한(response.incomplete) → 잘린 답변 + 이어서 작성
  | 'context-length' // 컨텍스트 초과(400) → 재시도 무의미, 새 대화 유도
  // 도구
  | 'tool-failure' // 외부 API 타임아웃 → tool 단위 실패, 모델은 계속 답변
  // 프로토콜
  | 'protocol-noise' // 중복 이벤트 + 모르는 이벤트 타입 섞임 → 무시되어야 함
  // 속도
  | 'slow' // 토큰 간 지연 → 배칭/스크롤/중지 확인

// ── 이벤트 ──────────────────────────────────────────────────────────

export type ToolState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'cancelled'

export type RunPhase = 'thinking' | 'tool' | 'generating'

export type FinishReason = 'stop' | 'length' | 'content_filter'

export type ErrorCode =
  | 'rate_limited'
  | 'quota_exceeded'
  | 'overloaded'
  | 'context_length_exceeded'
  | 'upstream_error'
  | 'auth_error'
  | 'bad_request'
  | 'network_error'
  | 'stream_stalled'
  | 'stream_incomplete'
  | 'run_gone'
  | 'unknown'

interface Base {
  runId: string
  seq: number
}

export type ServerEvent = Base &
  (
    | { type: 'run.started'; model: string }
    | { type: 'run.progress'; phase: RunPhase }
    | { type: 'text.delta'; delta: string }
    | { type: 'tool.started'; callId: string; name: string }
    | { type: 'tool.args.delta'; callId: string; delta: string }
    | { type: 'tool.input.completed'; callId: string; args: unknown }
    | { type: 'tool.result'; callId: string; output: unknown }
    | { type: 'tool.failed'; callId: string; code: string; message: string }
    | { type: 'run.completed'; finish: FinishReason; usage?: { inputTokens: number; outputTokens: number } }
    | { type: 'run.failed'; code: ErrorCode; message: string; retryable: boolean; retryAfterMs?: number }
    | { type: 'run.cancelled' }
  )

export type ServerEventType = ServerEvent['type']

/** runId/seq는 서버의 run 로그가 채우므로, 이벤트별 payload만 표현하는 분배(distributive) Omit */
export type ServerEventPayload = ServerEvent extends infer E ? (E extends ServerEvent ? Omit<E, 'runId' | 'seq'> : never) : never

export const TERMINAL_EVENTS: ReadonlySet<ServerEventType> = new Set(['run.completed', 'run.failed', 'run.cancelled'])
export const isTerminal = (e: { type: string }) => TERMINAL_EVENTS.has(e.type as ServerEventType)

const KNOWN: ReadonlySet<string> = new Set<ServerEventType>([
  'run.started', 'run.progress', 'text.delta', 'tool.started', 'tool.args.delta',
  'tool.input.completed', 'tool.result', 'tool.failed', 'run.completed', 'run.failed', 'run.cancelled',
])
/** 서버가 새 이벤트 타입을 추가해도 구버전 클라이언트가 멈추지 않도록, 모르는 이벤트는 걸러낸다. */
export const isKnownEvent = (e: { type?: unknown }): e is ServerEvent => typeof e.type === 'string' && KNOWN.has(e.type)
