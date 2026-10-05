import { describe, expect, it } from 'vitest'
import { ChatRuntime, type Scheduler } from './ChatRuntime'
import type { ServerEvent, ServerEventPayload, StartRunRequest } from './protocol'
import { textOf } from './reducer'
import { TransportError, type ChatTransport } from './transport'

/**
 * 런타임 통합 테스트: 실제 네트워크 대신 "시나리오를 연주하는" 가짜 transport를 꽂는다.
 * transport 어댑터 경계 덕분에 끊김·재시도·이어받기를 결정론적으로 재현할 수 있다.
 */

const syncScheduler: Scheduler = { schedule: (fn) => (queueMicrotask(fn), () => {}) }

type Script = (ctx: { runId: string; after: number; kind: 'start' | 'resume' }) => AsyncGenerator<ServerEvent>

function fakeTransport(script: Script) {
  const calls: { kind: 'start' | 'resume' | 'cancel'; after?: number }[] = []
  const transport: ChatTransport = {
    start(req: StartRunRequest) {
      calls.push({ kind: 'start' })
      return script({ runId: req.runId, after: 0, kind: 'start' })
    },
    resume(runId, after) {
      calls.push({ kind: 'resume', after })
      return script({ runId, after, kind: 'resume' })
    },
    async cancel() {
      calls.push({ kind: 'cancel' })
    },
  }
  return { transport, calls }
}

/** 하나의 run 로그를 정의하고, after 이후만 내보내는 헬퍼 */
function log(runId: string, payloads: ServerEventPayload[]) {
  return payloads.map((p, i) => ({ ...p, runId, seq: i + 1 }) as ServerEvent)
}

async function settle(rt: ChatRuntime, threadId: string, timeout = 3000) {
  const start = Date.now()
  while (rt.getState().threads[threadId]?.activeRun) {
    if (Date.now() - start > timeout) throw new Error('run did not settle')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const lastAssistant = (rt: ChatRuntime, threadId: string) => {
  const t = rt.getState().threads[threadId]
  return t.messages[t.messageIds.at(-1)!]
}

describe('ChatRuntime', () => {
  it('resumes from the last seq after a mid-stream disconnect', async () => {
    let dropped = false
    const { transport, calls } = fakeTransport(async function* ({ runId, after }) {
      const events = log(runId, [
        { type: 'run.started', model: 'm' },
        { type: 'text.delta', delta: '안녕' },
        { type: 'text.delta', delta: '하세요' },
        { type: 'run.completed', finish: 'stop' },
      ])
      for (const e of events.filter((e) => e.seq > after)) {
        if (e.seq === 3 && !dropped) {
          dropped = true
          throw new TransportError('network_error', 'socket closed', true)
        }
        yield e
      }
    })
    const rt = new ChatRuntime({ transport, scheduler: syncScheduler })
    const tid = rt.createThread()
    rt.send('hi', tid)
    await settle(rt, tid)

    const m = lastAssistant(rt, tid)
    expect(textOf(m)).toBe('안녕하세요')
    expect(m.status).toBe('done')
    expect(m.metrics?.resumes).toBe(1)
    expect(calls).toEqual([{ kind: 'start' }, { kind: 'resume', after: 2 }])
  })

  it('treats a stream that ends without a terminal event as a disconnect and resumes', async () => {
    let first = true
    const { transport, calls } = fakeTransport(async function* ({ runId, after }) {
      const events = log(runId, [{ type: 'text.delta', delta: 'a' }, { type: 'text.delta', delta: 'b' }, { type: 'run.completed', finish: 'stop' }])
      for (const e of events.filter((e) => e.seq > after)) {
        if (first && e.seq === 2) {
          first = false
          return // 정상 종료처럼 보이지만 완료 이벤트가 없다 (프록시가 끊김을 "깔끔하게" 전달한 경우)
        }
        yield e
      }
    })
    const rt = new ChatRuntime({ transport, scheduler: syncScheduler })
    const tid = rt.createThread()
    rt.send('hi', tid)
    await settle(rt, tid)
    expect(textOf(lastAssistant(rt, tid))).toBe('ab')
    expect(calls.map((c) => c.kind)).toEqual(['start', 'resume'])
  })

  it('retries the start (not resume) when it fails before any output, honoring retryAfterMs', async () => {
    let attempt = 0
    const { transport, calls } = fakeTransport(async function* ({ runId }) {
      attempt++
      if (attempt === 1) throw new TransportError('rate_limited', '429', true, 20)
      yield* log(runId, [{ type: 'text.delta', delta: 'ok' }, { type: 'run.completed', finish: 'stop' }])
    })
    const rt = new ChatRuntime({ transport, scheduler: syncScheduler })
    const tid = rt.createThread()
    rt.send('hi', tid)
    await settle(rt, tid)
    const m = lastAssistant(rt, tid)
    expect(textOf(m)).toBe('ok')
    expect(m.metrics?.attempts).toBe(2)
    expect(calls.map((c) => c.kind)).toEqual(['start', 'start'])
  })

  it('silently retries a retryable server failure that happened before visible output', async () => {
    let attempt = 0
    const { transport } = fakeTransport(async function* ({ runId }) {
      attempt++
      if (attempt === 1) {
        yield* log(runId, [{ type: 'run.started', model: 'm' }, { type: 'run.failed', code: 'overloaded', message: 'busy', retryable: true }])
        return
      }
      yield* log(runId, [{ type: 'run.started', model: 'm' }, { type: 'text.delta', delta: 'recovered' }, { type: 'run.completed', finish: 'stop' }])
    })
    const rt = new ChatRuntime({ transport, scheduler: syncScheduler })
    const tid = rt.createThread()
    rt.send('hi', tid)
    await settle(rt, tid)
    const m = lastAssistant(rt, tid)
    expect(m.status).toBe('done')
    expect(textOf(m)).toBe('recovered')
  })

  it('stop() cancels on the server, keeps already-received text, and restores the prompt only if nothing arrived', async () => {
    const { transport, calls } = fakeTransport(async function* ({ runId }) {
      yield* log(runId, [{ type: 'text.delta', delta: '부분' }])
      await new Promise(() => {}) // 영원히 대기
    })
    const rt = new ChatRuntime({ transport, scheduler: syncScheduler })
    const tid = rt.createThread()
    rt.send('질문', tid)
    await new Promise((r) => setTimeout(r, 10))
    const restored = rt.stop(tid)
    const m = lastAssistant(rt, tid)
    expect(m.status).toBe('aborted')
    expect(textOf(m)).toBe('부분')
    expect(restored).toBeUndefined()
    expect(calls.at(-1)?.kind).toBe('cancel')
  })

  it('keeps streaming into the original thread after the user switches threads', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { transport } = fakeTransport(async function* ({ runId }) {
      yield* log(runId, [{ type: 'text.delta', delta: 'A의 ' }])
      await gate
      yield { type: 'text.delta', delta: '답변', runId, seq: 2 } as ServerEvent
      yield { type: 'run.completed', finish: 'stop', runId, seq: 3 } as ServerEvent
    })
    const rt = new ChatRuntime({ transport, scheduler: syncScheduler })
    const a = rt.createThread()
    rt.send('q', a)
    await new Promise((r) => setTimeout(r, 10))
    const b = rt.createThread() // 사용자가 다른 대화로 이동
    release()
    await settle(rt, a)
    expect(textOf(lastAssistant(rt, a))).toBe('A의 답변')
    expect(rt.getState().threads[b].messageIds).toHaveLength(0)
    expect(rt.getState().activeThreadId).toBe(b)
  })

  it('ignores duplicated and unknown events but records them in telemetry', async () => {
    const kinds: string[] = []
    const { transport } = fakeTransport(async function* ({ runId }) {
      const [a, b, done] = log(runId, [{ type: 'text.delta', delta: '깨끗' }, { type: 'text.delta', delta: '한 텍스트' }, { type: 'run.completed', finish: 'stop' }])
      yield a
      yield a // 중복
      yield { type: 'response.reasoning_summary.delta', runId, seq: 2 } as unknown as ServerEvent // 모르는 타입
      yield b
      yield done
    })
    const rt = new ChatRuntime({ transport, scheduler: syncScheduler, onTelemetry: (e) => kinds.push(`${e.kind}:${e.detail ?? ''}`) })
    const tid = rt.createThread()
    rt.send('hi', tid)
    await settle(rt, tid)
    expect(textOf(lastAssistant(rt, tid))).toBe('깨끗한 텍스트')
    expect(kinds.filter((k) => k.startsWith('ignored'))).toEqual(['ignored:duplicate seq 1', 'ignored:unknown type "response.reasoning_summary.delta"'])
  })

  it('does not auto-retry a non-retryable error (context length) and surfaces it', async () => {
    let calls = 0
    const { transport } = fakeTransport(async function* () {
      calls++
      throw new TransportError('context_length_exceeded', 'too long', false)
    })
    const rt = new ChatRuntime({ transport, scheduler: syncScheduler })
    const tid = rt.createThread()
    rt.send('hi', tid)
    await settle(rt, tid)
    expect(calls).toBe(1)
    expect(lastAssistant(rt, tid).error?.code).toBe('context_length_exceeded')
  })

  it('stops resuming when the server lost the run (run_gone)', async () => {
    const { transport, calls } = fakeTransport(async function* ({ runId, kind }) {
      if (kind === 'resume') throw new TransportError('run_gone', 'gone', false)
      yield* log(runId, [{ type: 'text.delta', delta: '부분' }])
      throw new TransportError('stream_stalled', 'stalled', true)
    })
    const rt = new ChatRuntime({ transport, scheduler: syncScheduler })
    const tid = rt.createThread()
    rt.send('hi', tid)
    await settle(rt, tid)
    const m = lastAssistant(rt, tid)
    expect(m.error?.code).toBe('run_gone')
    expect(textOf(m)).toBe('부분') // 받은 부분은 보존
    expect(calls.map((c) => c.kind)).toEqual(['start', 'resume'])
  })

  it('rejects a second send while a run is active (single-flight)', () => {
    const { transport } = fakeTransport(async function* () {
      await new Promise(() => {})
    })
    const rt = new ChatRuntime({ transport, scheduler: syncScheduler })
    const tid = rt.createThread()
    expect(rt.send('one', tid)).toBe(true)
    expect(rt.send('two', tid)).toBe(false)
    expect(rt.getState().threads[tid].messageIds).toHaveLength(2)
  })

  it('resumes a persisted in-flight run after a reload', async () => {
    const storage = new Map<string, string>()
    const store = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) }
    const events = (runId: string) => log(runId, [{ type: 'text.delta', delta: '새로' }, { type: 'text.delta', delta: '고침' }, { type: 'run.completed', finish: 'stop' }])

    // 1) 첫 페이지: 첫 토큰을 받은 뒤 멈춘 상태로 저장
    const first = fakeTransport(async function* ({ runId }) {
      yield events(runId)[0]
      await new Promise(() => {})
    })
    const rt1 = new ChatRuntime({ transport: first.transport, scheduler: syncScheduler, storage: store })
    const tid = rt1.createThread()
    rt1.send('q', tid)
    await new Promise((r) => setTimeout(r, 600)) // 디바운스 저장 대기

    // 2) 새로고침: 같은 저장소로 새 런타임 → start()가 이어받기
    const second = fakeTransport(async function* ({ runId, after }) {
      yield* events(runId).filter((e) => e.seq > after)
    })
    const rt2 = new ChatRuntime({ transport: second.transport, scheduler: syncScheduler, storage: store })
    rt2.start()
    await settle(rt2, tid)
    expect(second.calls[0]).toEqual({ kind: 'resume', after: 1 })
    expect(textOf(lastAssistant(rt2, tid))).toBe('새로고침')
  })
})
