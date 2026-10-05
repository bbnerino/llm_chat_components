import type { ErrorCode, FinishReason, RunPhase, ServerEvent, ToolState } from './protocol'

/**
 * 메시지 = parts의 순서 있는 목록
 *
 * 한 번의 응답 안에서 텍스트와 tool 호출은 섞여서 온다:
 *   [text "찾아볼게요"] [tool search] [tool weather] [text "부산은 맑고…"] [tool followups]
 * "메시지 하나 = 문자열 하나" 모델로는 이 순서를 표현할 수 없고,
 * "이벤트 하나 = 말풍선 하나" 모델로는 텍스트가 조각나고 tool 상태를 추적할 수 없다.
 */
export interface TextPart {
  type: 'text'
  id: string
  text: string
}

export interface ToolPart {
  type: 'tool'
  callId: string
  name: string
  /** 스트리밍 중인 원본 인자 문자열. 화면이 필요할 때만 partial JSON 파싱한다. */
  argsText: string
  /** 인자가 확정되면 채워진다 */
  args?: unknown
  state: ToolState
  output?: unknown
  error?: { code: string; message: string }
}

export type Part = TextPart | ToolPart

/**
 *   pending ──▶ streaming ──completed──▶ done (finish: stop | length | content_filter)
 *      │            ├──사용자 중지──▶ aborted
 *      └────────────┴──실패/끊김────▶ error
 */
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'aborted' | 'error'

export interface MessageError {
  code: ErrorCode
  message: string
  retryable: boolean
}

export interface RunMetrics {
  requestedAt: number
  firstTokenAt?: number
  endedAt?: number
  attempts: number
  resumes: number
  model?: string
  outputTokens?: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  parts: Part[]
  status: MessageStatus
  runId?: string
  finish?: FinishReason
  error?: MessageError
  metrics?: RunMetrics
}

export interface ActiveRun {
  runId: string
  assistantId: string
  /** 마지막으로 반영한 seq. 이어받기(resume)의 커서이기도 하다. */
  lastSeq: number
  phase: RunPhase | 'connecting' | 'resuming' | 'retrying'
  /** 재시도 대기 중이면 재시도 예정 시각 (카운트다운 표시용) */
  retryAt?: number
}

/**
 * 스레드(대화) 단위로 상태를 격리한다.
 * 이전 프로젝트의 실수: 전역 store 하나에 메시지를 담아서, 대화를 전환해도
 * 이전 대화의 스트림이 새 대화 화면에 섞여 들어갔다.
 */
export interface Thread {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 렌더링 순서. 목록 컴포넌트는 이 배열만 구독한다. */
  messageIds: string[]
  /** 각 행은 자기 id의 메시지만 구독한다. 바뀐 메시지만 새 참조가 된다. */
  messages: Record<string, Message>
  activeRun: ActiveRun | null
}

export interface ChatState {
  threads: Record<string, Thread>
  /** 최근 업데이트 순 */
  threadOrder: string[]
  activeThreadId: string | null
}

export interface EventBatch {
  threadId: string
  events: ServerEvent[]
}

/** 리듀서를 순수 함수로 유지하기 위해 시간(now)과 id는 액션으로 주입받는다. */
export type ChatAction =
  | { type: 'state/hydrated'; state: ChatState }
  | { type: 'thread/created'; threadId: string; now: number }
  | { type: 'thread/selected'; threadId: string }
  | { type: 'thread/deleted'; threadId: string }
  | { type: 'turn/submitted'; threadId: string; userId: string; assistantId: string; textId: string; runId: string; content: string; now: number }
  | { type: 'run/regenerated'; threadId: string; assistantId: string; runId: string; now: number }
  | { type: 'run/retrying'; threadId: string; runId: string; attempt: number; retryAt: number }
  | { type: 'run/resuming'; threadId: string; runId: string }
  | { type: 'events/received'; batches: EventBatch[]; now: number }
  | { type: 'run/aborted'; threadId: string; runId: string; now: number }
  | { type: 'run/interrupted'; threadId: string; runId: string; error: MessageError; now: number }
  | { type: 'turn/deleted'; threadId: string; messageId: string }
