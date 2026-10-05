/**
 * 벤치마크: "이벤트 1개가 도착했을 때" 렌더되는 컴포넌트 수와 커밋 시간.
 *
 * 두 구조에 같은 대화(N턴, 턴마다 user + assistant(텍스트 + tool 2개))를 넣고,
 * 마지막 턴에 이벤트를 하나씩 주입하면서 React Profiler로 측정한다.
 *
 *  - 이전 구조: 토큰 스트리밍이 없었으므로 "이벤트 1개 = 새 말풍선 1개"
 *  - 새 구조:   "이벤트 1개 = text.delta 1개"
 * 둘 다 "서버 이벤트 하나가 도착해 상태가 한 번 바뀌는" 상황이다.
 */
import { Profiler, StrictMode, type ProfilerOnRenderCallback } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import type { ServerEvent, ServerEventPayload } from '../src/runtime/protocol'
import { LegacyPage, legacyStore, legacyToolStore } from './legacy'
import { BenchStore, ModernPage } from './modern'

const TEXT = '부산은 오늘 맑고 기온은 20도 안팎이에요. 해운대는 부산 해운대구에 있는 해수욕장으로, 여름이면 많은 관광객이 찾아요.'
const EVENTS_PER_RUN = 40

let commitMs = 0
let wallMs = 0
const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => { commitMs += actualDuration }
/** flushSync 전후 벽시계: 렌더 + 커밋 + 동기 flush된 effect와 그로 인한 재렌더까지 포함 */
const timed = (fn: () => void) => { const t0 = performance.now(); flushSync(fn); wallMs += performance.now() - t0 }

// 숨김 탭에서는 rAF가 멈추고 setTimeout은 1초로 throttle된다. MessageChannel 매크로태스크는 throttle되지 않는다.
const nextFrame = () =>
  new Promise<void>((r) => {
    if (!document.hidden) return requestAnimationFrame(() => r())
    const ch = new MessageChannel()
    ch.port1.onmessage = () => r()
    ch.port2.postMessage(null)
  })
const resetCounters = () => { window.__renders = {}; (window as any).__layoutReads = 0; commitMs = 0; wallMs = 0 }
const snapshot = () => ({ renders: { ...window.__renders }, layoutReads: (window as any).__layoutReads as number, commitMs, wallMs })

// ── 이전 구조 ────────────────────────────────────────────────────
async function benchLegacy(turns: number) {
  legacyStore.reset()
  const root = createRoot(document.getElementById('legacy')!)
  flushSync(() => root.render(<Profiler id="legacy" onRender={onRender}><LegacyPage /></Profiler>))

  for (let t = 0; t < turns; t++) {
    const g = `g${t}`
    flushSync(() => legacyStore.append(g, { id: `u${t}`, role: 'user', content: `질문 ${t}` }))
    for (let k = 0; k < 2; k++) {
      const callId = `c${t}-${k}`
      flushSync(() => legacyToolStore.update(callId, { name: k ? 'get_weather' : 'search_wikipedia' }))
      flushSync(() => legacyStore.append(g, { id: `tc${t}-${k}`, role: 'tool', callId }))
      flushSync(() => legacyToolStore.update(callId, { name: k ? 'get_weather' : 'search_wikipedia', result: { ok: true } }))
      flushSync(() => legacyStore.append(g, { id: `tr${t}-${k}`, role: 'tool', callId }))
    }
    flushSync(() => legacyStore.append(g, { id: `a${t}`, role: 'assistant', content: TEXT }))
    await nextFrame() // 턴마다 React가 정리할 시간을 준다 (nested update 한도 회피)
  }
  await nextFrame()

  // 측정: 마지막 턴에 이벤트(말풍선) EVENTS_PER_RUN개
  const g = `g${turns}`
  flushSync(() => legacyStore.append(g, { id: `u${turns}`, role: 'user', content: '마지막 질문' }))
  await nextFrame()
  const samples = []
  for (let i = 0; i < EVENTS_PER_RUN; i++) {
    resetCounters()
    timed(() => legacyStore.append(g, { id: `e${i}`, role: 'assistant', content: TEXT.slice(0, 10 + i) }))
    await nextFrame()
    samples.push(snapshot())
  }
  root.unmount()
  return samples
}

// ── 새 구조 ──────────────────────────────────────────────────────
async function benchModern(turns: number) {
  const store = new BenchStore()
  const threadId = 'T'
  store.dispatch({ type: 'thread/created', threadId, now: 0 })
  const ev = (runId: string, seq: number, p: ServerEventPayload) => ({ ...p, runId, seq }) as ServerEvent

  const root = createRoot(document.getElementById('modern')!)
  flushSync(() => root.render(<Profiler id="modern" onRender={onRender}><ModernPage store={store} threadId={threadId} /></Profiler>))

  for (let t = 0; t < turns; t++) {
    const runId = `r${t}`
    flushSync(() => store.dispatch({ type: 'turn/submitted', threadId, runId, content: `질문 ${t}`, now: 0, userId: `u${t}`, assistantId: `a${t}`, textId: `x${t}` }))
    flushSync(() => store.receive(threadId, [
      ev(runId, 1, { type: 'tool.started', callId: `c${t}-0`, name: 'search_wikipedia' }),
      ev(runId, 2, { type: 'tool.input.completed', callId: `c${t}-0`, args: { query: 'q', lang: 'ko' } }),
      ev(runId, 3, { type: 'tool.started', callId: `c${t}-1`, name: 'get_weather' }),
      ev(runId, 4, { type: 'tool.input.completed', callId: `c${t}-1`, args: { city: 'Busan' } }),
      ev(runId, 5, { type: 'tool.result', callId: `c${t}-0`, output: { query: 'q', results: [] } }),
      ev(runId, 6, { type: 'tool.result', callId: `c${t}-1`, output: { city: 'Busan', country: 'KR', current: { temperature: 20, humidity: 50, wind: 3, summary: '맑음' }, daily: [] } }),
      ev(runId, 7, { type: 'text.delta', delta: TEXT }),
      ev(runId, 8, { type: 'run.completed', finish: 'stop' }),
    ]))
    await nextFrame()
  }
  await nextFrame()

  const runId = `r${turns}`
  flushSync(() => store.dispatch({ type: 'turn/submitted', threadId, runId, content: '마지막 질문', now: 0, userId: `u${turns}`, assistantId: `a${turns}`, textId: `x${turns}` }))
  await nextFrame()
  const samples = []
  for (let i = 0; i < EVENTS_PER_RUN; i++) {
    resetCounters()
    timed(() => store.receive(threadId, [ev(runId, i + 1, { type: 'text.delta', delta: TEXT.slice(i * 2, i * 2 + 2) })]))
    await nextFrame()
    samples.push(snapshot())
  }
  root.unmount()
  return samples
}

function summarize(samples: ReturnType<typeof snapshot>[]) {
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const names = new Set(samples.flatMap((s) => Object.keys(s.renders)))
  const renders: Record<string, number> = {}
  for (const n of names) renders[n] = +avg(samples.map((s) => s.renders[n] ?? 0)).toFixed(1)
  const total = +avg(samples.map((s) => Object.values(s.renders).reduce((a, b) => a + b, 0))).toFixed(1)
  // 첫 샘플은 워밍업 효과가 있어 시간 평균에서 제외
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
  const median = (xs: number[]) => sorted(xs)[Math.floor(xs.length / 2)]
  const body = samples.slice(1) // 첫 샘플은 워밍업
  return {
    renders,
    totalRenders: total,
    commitMedianMs: +median(body.map((s) => s.commitMs)).toFixed(2),
    wallMedianMs: +median(body.map((s) => s.wallMs)).toFixed(2),
    wallP95Ms: +sorted(body.map((s) => s.wallMs))[Math.floor(body.length * 0.95)].toFixed(2),
    layoutReads: +avg(samples.map((s) => s.layoutReads)).toFixed(1),
  }
}

type Summary = ReturnType<typeof summarize>
function medianOfRounds(rounds: Summary[]): Summary {
  const pick = (f: (r: Summary) => number) => { const xs = rounds.map(f).sort((a, b) => a - b); return xs[Math.floor(xs.length / 2)] }
  return { ...rounds[0], commitMedianMs: pick((r) => r.commitMedianMs), wallMedianMs: pick((r) => r.wallMedianMs), wallP95Ms: pick((r) => r.wallP95Ms) }
}

async function run() {
  const ROUNDS = 3
  const out: Record<string, unknown> = { userAgent: navigator.userAgent, eventsPerRun: EVENTS_PER_RUN, rounds: ROUNDS, hidden: document.hidden, ts: new Date().toISOString() }
  // 워밍업 (JIT): 결과는 버린다
  await benchLegacy(30); await benchModern(30)
  for (const turns of [10, 30, 100]) {
    const L: Summary[] = [], M: Summary[] = []
    for (let r = 0; r < ROUNDS; r++) { L.push(summarize(await benchLegacy(turns))); M.push(summarize(await benchModern(turns))) }
    out[`legacy_${turns}`] = medianOfRounds(L)
    out[`modern_${turns}`] = medianOfRounds(M)
  }
  ;(window as any).__benchResult = out
  document.getElementById('out')!.textContent = JSON.stringify(out, null, 2)
}

document.getElementById('run')!.addEventListener('click', () => void run())
;(window as any).__runBench = run
// StrictMode는 일부러 끈다: 개발 모드 이중 렌더가 수치를 왜곡한다
void StrictMode
