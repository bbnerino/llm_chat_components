import { describe, expect, it } from 'vitest'
import type { ServerEvent, ServerEventPayload } from './protocol'
import { chatReducer, coalesce, initialChatState, toWireHistory } from './reducer'
import type { ChatState, ToolPart } from './types'

// ── 테스트 헬퍼 ─────────────────────────────────────────────────────

const ev = (runId: string, seq: number, payload: ServerEventPayload) => ({ ...payload, runId, seq }) as ServerEvent
const text = (runId: string, seq: number, delta: string) => ev(runId, seq, { type: 'text.delta', delta })
const done = (runId: string, seq: number) => ev(runId, seq, { type: 'run.completed', finish: 'stop' })

function thread(state: ChatState, threadId: string) {
  return chatReducer(state, { type: 'thread/created', threadId, now: 0 })
}
function submit(state: ChatState, threadId: string, runId: string, content = 'hi') {
  return chatReducer(state, {
    type: 'turn/submitted', threadId, runId, content, now: 0,
    userId: `u-${runId}`, assistantId: `a-${runId}`, textId: `t-${runId}`,
  })
}
const receive = (state: ChatState, threadId: string, ...events: ServerEvent[]) =>
  chatReducer(state, { type: 'events/received', batches: [{ threadId, events }], now: 10 })
const msg = (s: ChatState, threadId: string, runId: string) => s.threads[threadId].messages[`a-${runId}`]
const textOfMsg = (s: ChatState, t: string, r: string) =>
  msg(s, t, r).parts.map((p) => (p.type === 'text' ? p.text : `[${p.name}]`)).join('')

// ── 텍스트 스트리밍 ─────────────────────────────────────────────────

describe('streaming text', () => {
  it('appends deltas into one text part and completes', () => {
    let s = submit(thread(initialChatState, 'T'), 'T', 'r1')
    s = receive(s, 'T', text('r1', 1, 'Hel'), text('r1', 2, 'lo'))
    expect(msg(s, 'T', 'r1').parts).toHaveLength(1)
    expect(textOfMsg(s, 'T', 'r1')).toBe('Hello')
    s = receive(s, 'T', done('r1', 3))
    expect(msg(s, 'T', 'r1').status).toBe('done')
    expect(s.threads.T.activeRun).toBeNull()
  })

  it('requires strictly contiguous seq (duplicates and gaps are ignored)', () => {
    let s = submit(thread(initialChatState, 'T'), 'T', 'r1')
    s = receive(s, 'T', text('r1', 1, 'A'), text('r1', 1, 'A'), text('r1', 3, 'C'), text('r1', 2, 'B'))
    expect(textOfMsg(s, 'T', 'r1')).toBe('AB')
    expect(s.threads.T.activeRun?.lastSeq).toBe(2)
  })

  it('drops late events from an aborted run after regenerate', () => {
    let s = submit(thread(initialChatState, 'T'), 'T', 'r1')
    s = receive(s, 'T', text('r1', 1, 'old '))
    s = chatReducer(s, { type: 'run/aborted', threadId: 'T', runId: 'r1', now: 5 })
    s = chatReducer(s, { type: 'run/regenerated', threadId: 'T', assistantId: 'a-r1', runId: 'r2', now: 6 })
    s = receive(s, 'T', text('r1', 2, 'LATE'), text('r2', 1, 'new'))
    expect(textOfMsg(s, 'T', 'r1')).toBe('new') // 같은 메시지 id, 새 run
  })
})

// ── 스레드 격리 ─────────────────────────────────────────────────────

describe('thread isolation', () => {
  it('events of thread A never touch thread B, even with the same runId shape', () => {
    let s = thread(thread(initialChatState, 'A'), 'B')
    s = submit(s, 'A', 'ra')
    s = submit(s, 'B', 'rb')
    s = receive(s, 'B', text('ra', 1, 'leak?')) // A의 run 이벤트가 B 배치로 잘못 들어와도
    expect(msg(s, 'B', 'rb').parts).toHaveLength(0)
    s = receive(s, 'A', text('ra', 1, 'ok'))
    expect(textOfMsg(s, 'A', 'ra')).toBe('ok')
  })

  it('unchanged threads and messages keep their references (memo-friendly)', () => {
    let s = thread(thread(initialChatState, 'A'), 'B')
    s = submit(s, 'A', 'r0')
    s = receive(s, 'A', text('r0', 1, 'x'), done('r0', 2))
    s = submit(s, 'A', 'r1')
    const before = s
    s = receive(s, 'A', text('r1', 1, 'y'))
    expect(s.threads.B).toBe(before.threads.B)
    expect(s.threads.A.messages['a-r0']).toBe(before.threads.A.messages['a-r0'])
    expect(s.threads.A.messageIds).toBe(before.threads.A.messageIds)
    expect(s.threads.A.messages['a-r1']).not.toBe(before.threads.A.messages['a-r1'])
  })
})

// ── tool 생명주기 ───────────────────────────────────────────────────

describe('tool parts', () => {
  const tool = (s: ChatState, callId: string) =>
    msg(s, 'T', 'r1').parts.find((p): p is ToolPart => p.type === 'tool' && p.callId === callId)!

  it('tracks each parallel call by callId, not by position', () => {
    let s = submit(thread(initialChatState, 'T'), 'T', 'r1')
    s = receive(
      s, 'T',
      ev('r1', 1, { type: 'tool.started', callId: 'c1', name: 'get_weather' }),
      ev('r1', 2, { type: 'tool.args.delta', callId: 'c1', delta: '{"city":' }),
      ev('r1', 3, { type: 'tool.started', callId: 'c2', name: 'get_weather' }),
      ev('r1', 4, { type: 'tool.args.delta', callId: 'c1', delta: '"Seoul"}' }),
      ev('r1', 5, { type: 'tool.input.completed', callId: 'c1', args: { city: 'Seoul' } }),
    )
    expect(tool(s, 'c1')).toMatchObject({ state: 'input-available', argsText: '{"city":"Seoul"}' })
    expect(tool(s, 'c2').state).toBe('input-streaming')

    // 결과는 역순으로 도착할 수 있다
    s = receive(
      s, 'T',
      ev('r1', 6, { type: 'tool.failed', callId: 'c2', code: 'city_not_found', message: 'nope' }),
      ev('r1', 7, { type: 'tool.result', callId: 'c1', output: { t: 20 } }),
    )
    expect(tool(s, 'c1').state).toBe('output-available')
    expect(tool(s, 'c2')).toMatchObject({ state: 'output-error', error: { code: 'city_not_found' } })
  })

  it('interleaves text and tools in arrival order', () => {
    let s = submit(thread(initialChatState, 'T'), 'T', 'r1')
    s = receive(
      s, 'T',
      text('r1', 1, '찾아볼게요'),
      ev('r1', 2, { type: 'tool.started', callId: 'c1', name: 'search_wikipedia' }),
      text('r1', 3, '결과는'),
      text('r1', 4, ' 이렇습니다'),
    )
    expect(textOfMsg(s, 'T', 'r1')).toBe('찾아볼게요[search_wikipedia]결과는 이렇습니다')
  })

  it('settles running tools as cancelled when the run is aborted (no eternal spinner)', () => {
    let s = submit(thread(initialChatState, 'T'), 'T', 'r1')
    s = receive(s, 'T', ev('r1', 1, { type: 'tool.started', callId: 'c1', name: 'get_weather' }))
    s = chatReducer(s, { type: 'run/aborted', threadId: 'T', runId: 'r1', now: 1 })
    expect(tool(s, 'c1').state).toBe('cancelled')
  })
})

// ── 재시도 / 이어받기 ───────────────────────────────────────────────

describe('retry and resume', () => {
  it('retry resets the cursor because the server restarts the run from seq 1', () => {
    let s = submit(thread(initialChatState, 'T'), 'T', 'r1')
    s = receive(s, 'T', ev('r1', 1, { type: 'run.started', model: 'm' }))
    s = chatReducer(s, { type: 'run/retrying', threadId: 'T', runId: 'r1', attempt: 2, retryAt: 100 })
    expect(s.threads.T.activeRun).toMatchObject({ lastSeq: 0, phase: 'retrying', retryAt: 100 })
    s = receive(s, 'T', ev('r1', 1, { type: 'run.started', model: 'm' }), text('r1', 2, 'ok'))
    expect(textOfMsg(s, 'T', 'r1')).toBe('ok')
    expect(msg(s, 'T', 'r1').metrics?.attempts).toBe(2)
  })

  it('resume keeps the cursor and continues from lastSeq + 1', () => {
    let s = submit(thread(initialChatState, 'T'), 'T', 'r1')
    s = receive(s, 'T', text('r1', 1, '안녕'), text('r1', 2, '하'))
    s = chatReducer(s, { type: 'run/resuming', threadId: 'T', runId: 'r1' })
    // 서버가 겹치는 구간을 다시 보내도 중복 반영되지 않는다
    s = receive(s, 'T', text('r1', 2, '하'), text('r1', 3, '세요'))
    expect(textOfMsg(s, 'T', 'r1')).toBe('안녕하세요')
    expect(msg(s, 'T', 'r1').metrics?.resumes).toBe(1)
  })
})

// ── 병합 ────────────────────────────────────────────────────────────

describe('coalesce', () => {
  it('merges contiguous deltas into one event spanning seq..seqEnd', () => {
    const out = coalesce([text('r', 1, 'a'), text('r', 2, 'b'), ev('r', 3, { type: 'run.progress', phase: 'tool' }), text('r', 4, 'c')])
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({ delta: 'ab', seq: 1, seqEnd: 2 })
  })

  it('applying coalesced events equals applying them one by one', () => {
    const events = Array.from({ length: 50 }, (_, i) => text('r1', i + 1, String(i % 10)))
    const base = submit(thread(initialChatState, 'T'), 'T', 'r1')
    const batched = receive(base, 'T', ...events)
    const oneByOne = events.reduce((s, e) => receive(s, 'T', e), base)
    expect(textOfMsg(batched, 'T', 'r1')).toBe(textOfMsg(oneByOne, 'T', 'r1'))
  })
})

// ── 이력 ────────────────────────────────────────────────────────────

describe('toWireHistory', () => {
  it('excludes failed answers, keeps aborted partials with their tool parts', () => {
    let s = submit(thread(initialChatState, 'T'), 'T', 'r1', 'q1')
    s = chatReducer(s, { type: 'run/interrupted', threadId: 'T', runId: 'r1', now: 0, error: { code: 'unknown', message: 'x', retryable: true } })
    s = submit(s, 'T', 'r2', 'q2')
    s = receive(
      s, 'T',
      ev('r2', 1, { type: 'tool.started', callId: 'c1', name: 'get_weather' }),
      ev('r2', 2, { type: 'tool.input.completed', callId: 'c1', args: { city: 'Seoul' } }),
    )
    s = chatReducer(s, { type: 'run/aborted', threadId: 'T', runId: 'r2', now: 0 })
    expect(toWireHistory(s.threads.T)).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', parts: [{ type: 'tool', callId: 'c1', name: 'get_weather', args: { city: 'Seoul' }, state: 'cancelled', output: undefined, error: undefined }] },
    ])
  })
})
