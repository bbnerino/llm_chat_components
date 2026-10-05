import { isKnownEvent, isTerminal, type FaultMode, type ServerEvent, type WireMessage } from './protocol'
import { chatReducer, findTurnRange, initialChatState, textOf, toWireHistory } from './reducer'
import { TransportError, type ChatTransport } from './transport'
import type { ChatAction, ChatState, EventBatch, MessageError } from './types'

/**
 * ChatRuntime — React 바깥에 사는 대화 런타임
 *
 * 왜 React 바깥인가
 *   스트림 reader를 컴포넌트 effect 안에 두면, 대화를 전환하거나 컴포넌트가 언마운트되는 순간
 *   reader가 같이 죽거나(응답 유실) 엉뚱한 화면에 쓴다(대화 섞임). reader의 수명은 "화면"이 아니라
 *   "run"에 묶여야 한다. 그래서 run을 소유하는 객체를 따로 두고, React는 구독만 한다.
 *
 * 책임
 *   - 상태: 순수 리듀서(chatReducer)를 통해서만 변경, useSyncExternalStore로 노출
 *   - 배칭: 이벤트를 큐에 모아 프레임당 1회 반영 → 구독자 알림도 프레임당 1회
 *   - 복구: 첫 출력 전 실패 → 재시도(백오프·Retry-After), 출력 후 끊김 → seq부터 이어받기
 *   - 수명: 화면 복귀(visibilitychange)·네트워크 복구(online)·새로고침 시 진행 중 run 이어받기
 *   - 영속화: 상태 스냅샷을 localStorage에 디바운스 저장
 */

export interface TelemetryEvent {
  at: number
  threadId: string
  runId: string
  kind:
    | 'request' | 'first-output' | 'retry' | 'resume' | 'gap' | 'ignored' | 'completed'
    | 'failed' | 'aborted' | 'interrupted' | 'cancelled'
  detail?: string
}

export interface Scheduler {
  schedule(fn: () => void): () => void
}

export interface RuntimeOptions {
  transport: ChatTransport
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  scheduler?: Scheduler
  getFault?: () => FaultMode
  maxRetries?: number
  maxResumes?: number
  onTelemetry?: (e: TelemetryEvent) => void
  /** tool 시작 같은 "부수효과"는 렌더(마운트 effect)가 아니라 이벤트 처리 시점에 실행한다. */
  onToolStarted?: (info: { threadId: string; messageId: string; callId: string; name: string }) => void
}

const STORAGE_KEY = 'ai-response-runtime:v2'
const uid = () => crypto.randomUUID()

/** 지수 백오프 + full jitter: 동시에 실패한 클라이언트들이 같은 순간에 몰려 재시도하지 않게 한다. */
const backoff = (attempt: number) => Math.random() * Math.min(4000, 300 * 2 ** attempt)

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })
}

/** 화면이 보이면 rAF, 백그라운드 탭이면(rAF가 멈추므로) setTimeout */
export const frameScheduler: Scheduler = {
  schedule(fn) {
    if (typeof document !== 'undefined' && !document.hidden && typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(fn)
      return () => cancelAnimationFrame(id)
    }
    const id = setTimeout(fn, 50)
    return () => clearTimeout(id)
  },
}

class SeqGapError extends Error {}
class ServerRetryableFailure extends TransportError {}

export class ChatRuntime {
  private state: ChatState
  private listeners = new Set<() => void>()
  private readers = new Map<string, AbortController>()
  private queue = new Map<string, ServerEvent[]>()
  private cancelScheduled: (() => void) | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private opts: Required<Pick<RuntimeOptions, 'maxRetries' | 'maxResumes' | 'scheduler'>> & RuntimeOptions

  constructor(opts: RuntimeOptions) {
    this.opts = { maxRetries: 2, maxResumes: 5, scheduler: frameScheduler, ...opts }
    this.state = this.hydrate() ?? initialChatState
  }

  // ── 외부 스토어 인터페이스 (useSyncExternalStore) ─────────────────────

  getState = () => this.state

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private dispatch(action: ChatAction) {
    const prev = this.state
    this.state = chatReducer(prev, action)
    if (prev === this.state) return
    for (const l of this.listeners) l()
    this.persistSoon()
  }

  // ── 공개 API ─────────────────────────────────────────────────────

  /** 페이지 로드 후 한 번 호출: 진행 중이던 run 이어받기 + 화면 복귀/네트워크 복구 감시 */
  start() {
    this.resumeOrphans()
    if (typeof window === 'undefined') return () => {}
    const onVisible = () => document.visibilityState === 'visible' && this.resumeOrphans()
    const onOnline = () => this.resumeOrphans()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('pageshow', onOnline) // bfcache 복원
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pageshow', onOnline)
    }
  }

  createThread() {
    const threadId = uid()
    this.dispatch({ type: 'thread/created', threadId, now: Date.now() })
    return threadId
  }

  selectThread(threadId: string) {
    this.dispatch({ type: 'thread/selected', threadId })
  }

  deleteThread(threadId: string) {
    const run = this.state.threads[threadId]?.activeRun
    if (run) this.killRun(run.runId, true)
    this.dispatch({ type: 'thread/deleted', threadId })
  }

  /** @returns 전송 여부. 이미 응답 생성 중이면 false (single-flight) */
  send(text: string, threadId = this.state.activeThreadId ?? this.createThread()): boolean {
    const content = text.trim()
    const t = this.state.threads[threadId]
    if (!content || !t || t.activeRun) return false
    const runId = uid()
    const messages: WireMessage[] = [...toWireHistory(t), { role: 'user', content }]
    this.dispatch({
      type: 'turn/submitted', threadId, runId, content, now: Date.now(),
      userId: uid(), assistantId: uid(), textId: uid(),
    })
    void this.drive(threadId, runId, messages)
    return true
  }

  regenerate(threadId: string, assistantId: string) {
    if (this.state.threads[threadId]?.activeRun) this.stop(threadId)
    const t = this.state.threads[threadId]
    const idx = t?.messageIds.indexOf(assistantId) ?? -1
    if (!t || idx === -1) return
    const runId = uid()
    const messages = toWireHistory(t, idx)
    this.dispatch({ type: 'run/regenerated', threadId, assistantId, runId, now: Date.now() })
    void this.drive(threadId, runId, messages)
  }

  /**
   * 사용자 중지.
   * @returns 아무 출력도 받기 전에 중지했다면 마지막 사용자 입력 (입력창 복원용)
   */
  stop(threadId: string): string | undefined {
    const t = this.state.threads[threadId]
    const run = t?.activeRun
    if (!t || !run) return
    this.flushNow() // 이미 받은 출력은 화면에 반영한 뒤 중지 상태로 (killRun은 큐를 비우므로 반드시 먼저)
    this.killRun(run.runId, true)
    this.emit({ threadId, runId: run.runId, kind: 'aborted' })
    const assistant = this.state.threads[threadId].messages[run.assistantId]
    this.dispatch({ type: 'run/aborted', threadId, runId: run.runId, now: Date.now() })
    if (assistant && assistant.parts.length === 0) {
      const ids = t.messageIds
      const user = t.messages[ids[ids.indexOf(run.assistantId) - 1]]
      return user ? textOf(user) : undefined
    }
  }

  deleteTurn(threadId: string, messageId: string) {
    const t = this.state.threads[threadId]
    const run = t?.activeRun
    if (t && run) {
      const range = findTurnRange(t, messageId)
      if (range && t.messageIds.slice(range[0], range[1] + 1).includes(run.assistantId)) this.killRun(run.runId, true)
    }
    this.dispatch({ type: 'turn/deleted', threadId, messageId })
  }

  // ── 스트림 구동 ──────────────────────────────────────────────────

  /**
   * run 하나를 끝까지 책임진다.
   * @param messages 새 run이면 이력, 이어받기면 null
   */
  private async drive(threadId: string, runId: string, messages: WireMessage[] | null) {
    this.readers.get(runId)?.abort('replaced') // run당 reader는 하나만
    const controller = new AbortController()
    this.readers.set(runId, controller)
    const { signal } = controller
    const { transport, maxRetries, maxResumes } = this.opts

    let attempt = 1
    let resumes = 0
    /** 서버에 run이 존재함을 확인했는가. 그 뒤로는 재시작이 아니라 이어받기를 한다. */
    let connected = messages === null
    this.emit({ threadId, runId, kind: connected ? 'resume' : 'request', detail: connected ? 'after reload' : `${messages!.length} messages` })

    try {
      while (!signal.aborted) {
        this.flushNow() // 커서(lastSeq)를 읽기 전에 큐를 비워야 정확하다
        const run = this.state.threads[threadId]?.activeRun
        if (!run || run.runId !== runId) return // 이미 끝났거나 삭제됨

        const fault = attempt === 1 && resumes === 0 && messages ? (this.opts.getFault?.() ?? 'none') : 'none'
        const stream = connected
          ? transport.resume(runId, run.lastSeq, signal)
          : transport.start({ runId, threadId, messages: messages ?? [], fault }, signal)
        let expected = connected ? run.lastSeq + 1 : 1
        let sawTerminal = false

        try {
          for await (const e of stream) {
            // 서버가 새 이벤트 타입을 먼저 배포해도 구버전 클라이언트가 멈추지 않도록 무시한다
            if (!isKnownEvent(e)) {
              this.emit({ threadId, runId, kind: 'ignored', detail: `unknown type "${(e as { type?: string }).type}"` })
              continue
            }
            connected = true
            if (e.seq < expected) {
              this.emit({ threadId, runId, kind: 'ignored', detail: `duplicate seq ${e.seq}` })
              continue
            }
            if (e.seq > expected) {
              this.emit({ threadId, runId, kind: 'gap', detail: `expected ${expected}, got ${e.seq}` })
              throw new SeqGapError()
            }
            expected = e.seq + 1

            // 보이는 출력 없이 서버가 "재시도 가능한 실패"를 보내면 화면에 에러를 띄우지 않고 재시도한다.
            if (e.type === 'run.failed' && e.retryable && attempt <= maxRetries && !this.hasVisibleOutput(threadId, runId)) {
              throw new ServerRetryableFailure(e.code, e.message, true, e.retryAfterMs)
            }
            this.track(threadId, runId, e)
            if (isTerminal(e)) sawTerminal = true
            this.enqueue(threadId, e)
          }
          this.flushNow()
          if (sawTerminal || signal.aborted) return
          // 터미널 이벤트 없이 스트림이 닫혔다 = 응답이 끝난 게 아니라 연결이 끝났다
          throw new TransportError('stream_incomplete', '응답이 중간에 끊겼습니다.', true)
        } catch (err) {
          this.flushNow()
          if (signal.aborted) return
          const te =
            err instanceof SeqGapError
              ? new TransportError('stream_incomplete', '이벤트 순서가 어긋났습니다.', true)
              : err instanceof TransportError
                ? err
                : new TransportError('unknown', '알 수 없는 오류가 발생했습니다.', false)

          // ① 첫 출력 전 실패 → 같은 runId로 다시 시작 (서버가 idempotent하게 처리)
          const restart = err instanceof ServerRetryableFailure || (!connected && te.retryable)
          if (restart && attempt <= maxRetries) {
            attempt++
            const delay = Math.max(backoff(attempt), te.retryAfterMs ?? 0)
            this.emit({ threadId, runId, kind: 'retry', detail: `${te.code} → attempt ${attempt} in ${Math.round(delay)}ms` })
            this.dispatch({ type: 'run/retrying', threadId, runId, attempt, retryAt: Date.now() + delay })
            await sleep(delay, signal)
            connected = false
            continue
          }

          // ② 출력이 시작된 뒤 끊김 → 마지막 seq부터 이어받기
          if (connected && te.retryable && te.code !== 'run_gone' && resumes < maxResumes) {
            resumes++
            this.emit({ threadId, runId, kind: 'resume', detail: `${te.code}, after seq ${this.state.threads[threadId]?.activeRun?.lastSeq}` })
            this.dispatch({ type: 'run/resuming', threadId, runId })
            await sleep(backoff(resumes), signal)
            continue
          }

          // ③ 복구 불가
          this.interrupt(threadId, runId, { code: te.code, message: te.message, retryable: te.code !== 'auth_error' && te.code !== 'bad_request' })
          return
        }
      }
    } catch {
      // sleep 중 abort
    } finally {
      if (this.readers.get(runId) === controller) this.readers.delete(runId)
    }
  }

  /** reader가 없는 진행 중 run을 찾아 이어받는다 (새로고침, 화면 복귀, 네트워크 복구) */
  private resumeOrphans() {
    for (const t of Object.values(this.state.threads)) {
      const run = t.activeRun
      if (run && !this.readers.has(run.runId)) {
        this.dispatch({ type: 'run/resuming', threadId: t.id, runId: run.runId })
        void this.drive(t.id, run.runId, null)
      }
    }
  }

  private killRun(runId: string, cancelOnServer: boolean) {
    this.readers.get(runId)?.abort('user')
    this.readers.delete(runId)
    for (const [threadId, events] of this.queue) {
      this.queue.set(threadId, events.filter((e) => e.runId !== runId))
    }
    if (cancelOnServer) void this.opts.transport.cancel(runId)
  }

  private interrupt(threadId: string, runId: string, error: MessageError) {
    this.emit({ threadId, runId, kind: 'interrupted', detail: error.code })
    this.dispatch({ type: 'run/interrupted', threadId, runId, error, now: Date.now() })
  }

  private hasVisibleOutput(threadId: string, runId: string) {
    this.flushNow()
    const run = this.state.threads[threadId]?.activeRun
    if (!run || run.runId !== runId) return false
    return (this.state.threads[threadId].messages[run.assistantId]?.parts.length ?? 0) > 0
  }

  // ── 배칭 ────────────────────────────────────────────────────────

  /**
   * 토큰마다 상태를 바꾸면 초당 수십 번 구독자 전체가 깨어난다.
   * 큐에 모아 프레임당 한 번만 반영한다. "알림"만이 아니라 "스냅샷 자체"를 배칭하므로
   * 어떤 컴포넌트가 스토어를 직접 읽어도 배칭을 우회할 수 없다.
   */
  private enqueue(threadId: string, e: ServerEvent) {
    const list = this.queue.get(threadId) ?? []
    list.push(e)
    this.queue.set(threadId, list)
    if (e.type === 'tool.started') {
      const run = this.state.threads[threadId]?.activeRun
      if (run) this.opts.onToolStarted?.({ threadId, messageId: run.assistantId, callId: e.callId, name: e.name })
    }
    if (isTerminal(e)) return this.flushNow() // 완료/실패는 프레임을 기다리지 않는다
    if (!this.cancelScheduled) this.cancelScheduled = this.opts.scheduler.schedule(() => this.flushNow())
  }

  private flushNow() {
    this.cancelScheduled?.()
    this.cancelScheduled = null
    if (this.queue.size === 0) return
    const batches: EventBatch[] = []
    for (const [threadId, events] of this.queue) if (events.length) batches.push({ threadId, events })
    this.queue.clear()
    if (batches.length) this.dispatch({ type: 'events/received', batches, now: Date.now() })
  }

  // ── 관측 ────────────────────────────────────────────────────────

  private firstOutputSeen = new Set<string>()

  private track(threadId: string, runId: string, e: ServerEvent) {
    if ((e.type === 'text.delta' || e.type === 'tool.started') && !this.firstOutputSeen.has(runId)) {
      this.firstOutputSeen.add(runId)
      this.emit({ threadId, runId, kind: 'first-output', detail: e.type })
    }
    if (e.type === 'run.completed') this.emit({ threadId, runId, kind: 'completed', detail: `finish=${e.finish}` })
    if (e.type === 'run.failed') this.emit({ threadId, runId, kind: 'failed', detail: e.code })
    if (e.type === 'run.cancelled') this.emit({ threadId, runId, kind: 'cancelled' })
  }

  private emit(e: Omit<TelemetryEvent, 'at'>) {
    this.opts.onTelemetry?.({ ...e, at: Date.now() })
  }

  // ── 영속화 ──────────────────────────────────────────────────────

  private persistSoon() {
    const storage = this.opts.storage
    if (!storage || this.persistTimer) return
    // 스트리밍 중 매 프레임 직렬화하지 않도록 디바운스
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(this.state))
      } catch {
        // 용량 초과 등: 영속화는 편의 기능이므로 실패해도 앱은 계속 동작해야 한다
      }
    }, 500)
  }

  private hydrate(): ChatState | null {
    try {
      const raw = this.opts.storage?.getItem(STORAGE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as ChatState
      return parsed && typeof parsed.threads === 'object' && Array.isArray(parsed.threadOrder) ? parsed : null
    } catch {
      return null
    }
  }
}
