import type { ServerEvent, WireMessage, WirePart } from './protocol'
import type { ChatAction, ChatState, Message, Part, Thread, ToolPart } from './types'

/**
 * 비동기 이벤트 → 결정론적 UI 상태
 *
 * 모든 상태 변경은 이 순수 함수 하나를 통과한다. 서버 이벤트는
 *   (1) 그 스레드의 activeRun과 runId가 같고
 *   (2) seq가 정확히 lastSeq + 1일 때만
 * 반영된다. 늦게 온 이벤트, 중복 이벤트, 다른 대화의 이벤트는 여기서 걸러진다.
 * 같은 이벤트 시퀀스를 넣으면 항상 같은 상태가 나온다.
 *
 * 불변 업데이트 규칙: "바뀐 것만 새 참조, 나머지는 같은 참조."
 * 그래야 memo된 행 컴포넌트가 실제로 리렌더를 건너뛴다.
 */

export const initialChatState: ChatState = { threads: {}, threadOrder: [], activeThreadId: null }

const NEW_THREAD_TITLE = '새 대화'

// ── 헬퍼 ────────────────────────────────────────────────────────────

function withThread(state: ChatState, threadId: string, fn: (t: Thread) => Thread): ChatState {
  const t = state.threads[threadId]
  if (!t) return state
  const next = fn(t)
  return next === t ? state : { ...state, threads: { ...state.threads, [threadId]: next } }
}

function withMessage(t: Thread, id: string, fn: (m: Message) => Message): Thread {
  const m = t.messages[id]
  if (!m) return t
  const next = fn(m)
  return next === m ? t : { ...t, messages: { ...t.messages, [id]: next } }
}

function withToolPart(m: Message, callId: string, fn: (p: ToolPart) => ToolPart): Message {
  const idx = m.parts.findIndex((p) => p.type === 'tool' && p.callId === callId)
  if (idx === -1) return m
  const parts = m.parts.slice()
  parts[idx] = fn(parts[idx] as ToolPart)
  return { ...m, parts }
}

/** run이 끝났는데 아직 끝나지 않은 tool은 "취소됨"으로 확정한다. (영원히 도는 스피너 방지) */
function settleTools(parts: Part[]): Part[] {
  let changed = false
  const next = parts.map((p) => {
    if (p.type === 'tool' && (p.state === 'input-streaming' || p.state === 'input-available')) {
      changed = true
      return { ...p, state: 'cancelled' as const }
    }
    return p
  })
  return changed ? next : parts
}

/** turn 경계: [user, assistant?] 묶음의 인덱스 범위 */
export function findTurnRange(t: Thread, messageId: string): [number, number] | null {
  const ids = t.messageIds
  const idx = ids.indexOf(messageId)
  if (idx === -1) return null
  const role = (i: number) => t.messages[ids[i]]?.role
  const start = role(idx) === 'user' ? idx : role(idx - 1) === 'user' ? idx - 1 : idx
  const end = role(start + 1) === 'assistant' ? start + 1 : start
  return [start, end]
}

// ── 이벤트 병합 ─────────────────────────────────────────────────────

type Coalesced = ServerEvent & { seqEnd?: number }

/**
 * 한 프레임 동안 쌓인 연속 delta를 하나로 합친다.
 * 토큰 30개가 한 배치로 오면 문자열 이어붙이기(=새 문자열 할당)를 30번이 아니라 1번만 한다.
 * 긴 응답에서 `text += delta`를 반복하면 O(n²)로 느려진다는 보고(vercel/ai#15670)에 대한 대응.
 */
export function coalesce(events: ServerEvent[]): Coalesced[] {
  const out: Coalesced[] = []
  for (const e of events) {
    const prev = out.at(-1)
    const contiguous = prev && prev.runId === e.runId && (prev.seqEnd ?? prev.seq) + 1 === e.seq
    if (contiguous && prev.type === 'text.delta' && e.type === 'text.delta') {
      out[out.length - 1] = { ...prev, delta: prev.delta + e.delta, seqEnd: e.seq }
      continue
    }
    if (contiguous && prev.type === 'tool.args.delta' && e.type === 'tool.args.delta' && prev.callId === e.callId) {
      out[out.length - 1] = { ...prev, delta: prev.delta + e.delta, seqEnd: e.seq }
      continue
    }
    out.push(e)
  }
  return out
}

/**
 * 병합 전에 "현재 run의 lastSeq+1부터 끊김 없이 이어지는 이벤트"만 남긴다.
 * 순서를 반대로 하면, 중복된 seq 2와 새 seq 3이 하나로 합쳐진 뒤 통째로 버려져
 * 새 토큰까지 잃는다. (테스트가 잡아낸 버그)
 */
function contiguous(t: Thread, events: ServerEvent[]): ServerEvent[] {
  const run = t.activeRun
  if (!run) return []
  const out: ServerEvent[] = []
  let last = run.lastSeq
  for (const e of events) {
    if (e.runId !== run.runId || e.seq !== last + 1) continue
    out.push(e)
    last = e.seq
  }
  return out
}

// ── 이벤트 적용 ─────────────────────────────────────────────────────

function applyEvent(t: Thread, e: Coalesced, now: number): Thread {
  const run = t.activeRun
  if (!run || e.runId !== run.runId) return t // 다른 run(이전 run, 다른 대화)의 이벤트
  if (e.seq !== run.lastSeq + 1) return t // 중복이거나 구멍. 구멍은 런타임이 감지해 resume한다.

  const lastSeq = e.seqEnd ?? e.seq
  const id = run.assistantId
  const firstOutput = (m: Message): Message => ({
    ...m,
    status: 'streaming',
    metrics: m.metrics && { ...m.metrics, firstTokenAt: m.metrics.firstTokenAt ?? now },
  })

  switch (e.type) {
    case 'run.started':
      return withMessage({ ...t, activeRun: { ...run, lastSeq } }, id, (m) => ({
        ...m,
        metrics: m.metrics && { ...m.metrics, model: e.model },
      }))

    case 'run.progress':
      return { ...t, activeRun: { ...run, lastSeq, phase: e.phase, retryAt: undefined } }

    case 'text.delta':
      return withMessage({ ...t, activeRun: { ...run, lastSeq, phase: 'generating' } }, id, (m) => {
        const last = m.parts.at(-1)
        const parts =
          last?.type === 'text'
            ? [...m.parts.slice(0, -1), { ...last, text: last.text + e.delta }]
            : [...m.parts, { type: 'text' as const, id: `${e.runId}:${e.seq}`, text: e.delta }]
        return { ...firstOutput(m), parts }
      })

    case 'tool.started':
      return withMessage({ ...t, activeRun: { ...run, lastSeq } }, id, (m) => ({
        ...firstOutput(m),
        parts: [...m.parts, { type: 'tool', callId: e.callId, name: e.name, argsText: '', state: 'input-streaming' }],
      }))

    case 'tool.args.delta':
      return withMessage({ ...t, activeRun: { ...run, lastSeq } }, id, (m) =>
        withToolPart(m, e.callId, (p) => ({ ...p, argsText: p.argsText + e.delta })),
      )

    case 'tool.input.completed':
      return withMessage({ ...t, activeRun: { ...run, lastSeq } }, id, (m) =>
        withToolPart(m, e.callId, (p) => ({ ...p, args: e.args, state: 'input-available' })),
      )

    case 'tool.result':
      return withMessage({ ...t, activeRun: { ...run, lastSeq } }, id, (m) =>
        withToolPart(m, e.callId, (p) => ({ ...p, output: e.output, state: 'output-available' })),
      )

    case 'tool.failed':
      return withMessage({ ...t, activeRun: { ...run, lastSeq } }, id, (m) =>
        withToolPart(m, e.callId, (p) => ({ ...p, state: 'output-error', error: { code: e.code, message: e.message } })),
      )

    case 'run.completed':
      return withMessage({ ...t, activeRun: null, updatedAt: now }, id, (m) => ({
        ...m,
        status: 'done',
        finish: e.finish,
        parts: settleTools(m.parts),
        metrics: m.metrics && { ...m.metrics, endedAt: now, outputTokens: e.usage?.outputTokens },
      }))

    case 'run.failed':
      return withMessage({ ...t, activeRun: null, updatedAt: now }, id, (m) => ({
        ...m,
        status: 'error',
        parts: settleTools(m.parts),
        error: { code: e.code, message: e.message, retryable: e.retryable },
        metrics: m.metrics && { ...m.metrics, endedAt: now },
      }))

    case 'run.cancelled':
      return withMessage({ ...t, activeRun: null, updatedAt: now }, id, (m) => ({
        ...m,
        status: 'aborted',
        parts: settleTools(m.parts),
        metrics: m.metrics && { ...m.metrics, endedAt: now },
      }))
  }
}

// ── 리듀서 ──────────────────────────────────────────────────────────

const freshMetrics = (now: number) => ({ requestedAt: now, attempts: 1, resumes: 0 })

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'state/hydrated':
      return action.state

    case 'thread/created': {
      const thread: Thread = {
        id: action.threadId,
        title: NEW_THREAD_TITLE,
        createdAt: action.now,
        updatedAt: action.now,
        messageIds: [],
        messages: {},
        activeRun: null,
      }
      return {
        threads: { ...state.threads, [thread.id]: thread },
        threadOrder: [thread.id, ...state.threadOrder],
        activeThreadId: thread.id,
      }
    }

    case 'thread/selected':
      return state.threads[action.threadId] ? { ...state, activeThreadId: action.threadId } : state

    case 'thread/deleted': {
      if (!state.threads[action.threadId]) return state
      const { [action.threadId]: _removed, ...threads } = state.threads
      const threadOrder = state.threadOrder.filter((id) => id !== action.threadId)
      return {
        threads,
        threadOrder,
        activeThreadId: state.activeThreadId === action.threadId ? (threadOrder[0] ?? null) : state.activeThreadId,
      }
    }

    case 'turn/submitted': {
      const t = state.threads[action.threadId]
      if (!t || t.activeRun) return state // 한 스레드에 동시에 두 run은 허용하지 않는다
      const user: Message = {
        id: action.userId,
        role: 'user',
        status: 'done',
        parts: [{ type: 'text', id: action.textId, text: action.content }],
      }
      const assistant: Message = {
        id: action.assistantId,
        role: 'assistant',
        status: 'pending',
        parts: [],
        runId: action.runId,
        metrics: freshMetrics(action.now),
      }
      const thread: Thread = {
        ...t,
        title: t.messageIds.length === 0 ? summarizeTitle(action.content) : t.title,
        updatedAt: action.now,
        messageIds: [...t.messageIds, user.id, assistant.id],
        messages: { ...t.messages, [user.id]: user, [assistant.id]: assistant },
        activeRun: { runId: action.runId, assistantId: assistant.id, lastSeq: 0, phase: 'connecting' },
      }
      return {
        ...state,
        threads: { ...state.threads, [t.id]: thread },
        threadOrder: [t.id, ...state.threadOrder.filter((id) => id !== t.id)],
      }
    }

    case 'run/regenerated':
      return withThread(state, action.threadId, (t) => {
        if (t.activeRun) return t
        const idx = t.messageIds.indexOf(action.assistantId)
        const target = t.messages[action.assistantId]
        if (idx === -1 || target?.role !== 'assistant') return t
        // 재생성 경계: 대상 이후의 대화는 무효가 된다 (분기 대신 잘라내기 전략)
        const removed = t.messageIds.slice(idx + 1)
        const messages = { ...t.messages }
        for (const id of removed) delete messages[id]
        messages[target.id] = {
          ...target,
          parts: [],
          status: 'pending',
          runId: action.runId,
          error: undefined,
          finish: undefined,
          metrics: freshMetrics(action.now),
        }
        return {
          ...t,
          messageIds: t.messageIds.slice(0, idx + 1),
          messages,
          activeRun: { runId: action.runId, assistantId: target.id, lastSeq: 0, phase: 'connecting' },
        }
      })

    case 'run/retrying':
      return withThread(state, action.threadId, (t) => {
        const run = t.activeRun
        if (!run || run.runId !== action.runId) return t
        // 재시도는 "보이는 출력이 없을 때"만 하므로 parts를 비워도 사용자가 본 것을 지우지 않는다.
        // 서버는 같은 runId로 run을 새로 만들기 때문에 seq도 1부터 다시 시작한다.
        return withMessage({ ...t, activeRun: { ...run, lastSeq: 0, phase: 'retrying', retryAt: action.retryAt } }, run.assistantId, (m) => ({
          ...m,
          parts: [],
          metrics: m.metrics && { ...m.metrics, attempts: action.attempt },
        }))
      })

    case 'run/resuming':
      return withThread(state, action.threadId, (t) => {
        const run = t.activeRun
        if (!run || run.runId !== action.runId) return t
        return withMessage({ ...t, activeRun: { ...run, phase: 'resuming' } }, run.assistantId, (m) => ({
          ...m,
          metrics: m.metrics && { ...m.metrics, resumes: m.metrics.resumes + 1 },
        }))
      })

    case 'events/received': {
      let next = state
      for (const batch of action.batches) {
        next = withThread(next, batch.threadId, (t) =>
          coalesce(contiguous(t, batch.events)).reduce((acc, e) => applyEvent(acc, e, action.now), t),
        )
      }
      return next
    }

    case 'run/aborted':
    case 'run/interrupted':
      return withThread(state, action.threadId, (t) => {
        const run = t.activeRun
        if (!run || run.runId !== action.runId) return t
        return withMessage({ ...t, activeRun: null, updatedAt: action.now }, run.assistantId, (m) => ({
          ...m,
          status: action.type === 'run/aborted' ? 'aborted' : 'error',
          error: action.type === 'run/interrupted' ? action.error : undefined,
          parts: settleTools(m.parts),
          metrics: m.metrics && { ...m.metrics, endedAt: action.now },
        }))
      })

    case 'turn/deleted':
      return withThread(state, action.threadId, (t) => {
        const range = findTurnRange(t, action.messageId)
        if (!range) return t
        const [start, end] = range
        const removed = t.messageIds.slice(start, end + 1)
        const messages = { ...t.messages }
        for (const id of removed) delete messages[id]
        return {
          ...t,
          messageIds: [...t.messageIds.slice(0, start), ...t.messageIds.slice(end + 1)],
          messages,
          activeRun: removed.includes(t.activeRun?.assistantId ?? '') ? null : t.activeRun,
        }
      })
  }
}

function summarizeTitle(text: string) {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 28 ? `${oneLine.slice(0, 28)}…` : oneLine
}

export const textOf = (m: Message) =>
  m.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')

/**
 * 모델에게 보낼 대화 이력.
 *  - 실패한 답변은 제외한다 (사용자도 신뢰하지 않는 내용).
 *  - 사용자가 중지한 부분 답변은 포함한다 (사용자가 실제로 본 내용).
 *  - 짝 없는 tool 호출 정리는 서버(toResponsesInput)가 한 번 더 책임진다.
 */
export function toWireHistory(t: Thread, uptoIndex = t.messageIds.length): WireMessage[] {
  const out: WireMessage[] = []
  for (const id of t.messageIds.slice(0, uptoIndex)) {
    const m = t.messages[id]
    if (!m) continue
    if (m.role === 'user') {
      out.push({ role: 'user', content: textOf(m) })
      continue
    }
    if (m.status !== 'done' && !(m.status === 'aborted' && m.parts.length > 0)) continue
    const parts: WirePart[] = m.parts.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : { type: 'tool', callId: p.callId, name: p.name, args: p.args, state: p.state, output: p.output, error: p.error?.message },
    )
    out.push({ role: 'assistant', parts })
  }
  return out
}
