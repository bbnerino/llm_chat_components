/**
 * BFF (Backend For Frontend)
 *
 *   POST /api/runs                     run 시작 (같은 runId면 기존 run에 붙음 = idempotent)
 *   GET  /api/runs/:runId/events?after  이어받기 (로그 재생 후 실시간 구독)
 *   POST /api/runs/:runId/cancel       사용자 중지
 *
 * 역할
 *  - OPENAI_API_KEY를 브라우저에 노출하지 않는다.
 *  - OpenAI 이벤트를 도메인 이벤트로 정규화한다(runs.ts).
 *  - 연결마다 heartbeat를 보낸다. 클라이언트 watchdog이 이걸로 "살아있음"을 판단한다.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import type { ServerEvent, StartRunRequest } from '../src/runtime/protocol.ts'
import { isTerminal } from '../src/runtime/protocol.ts'
import { Run, runAgent, runs } from './runs.ts'

// Node의 Happy Eyeballs는 주소당 연결 시도를 250ms만 기다린다. 해외 API(RTT 400ms)는 IPv4도
// 그 안에 연결되지 않고, IPv6가 막힌 환경이면 둘 다 실패해 ETIMEDOUT이 된다(curl은 정상).
net.setDefaultAutoSelectFamilyAttemptTimeout(2_000)

const PORT = Number(process.env.BFF_PORT ?? 8787)
// 클라이언트 idle 타임아웃(7s)보다 충분히 짧아야 한다.
const HEARTBEAT_MS = 2_000

if (!process.env.OPENAI_API_KEY) {
  console.error('[bff] OPENAI_API_KEY가 없습니다. .env를 확인하세요.')
  process.exit(1)
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/**
 * 하나의 HTTP 연결을 run 로그에 붙인다: after 이후 이벤트를 재생하고, 이후는 실시간으로 흘린다.
 * 연결이 끊겨도 run은 취소하지 않는다. (끊김 ≠ 중지)
 *
 * 전송 계층 장애 재현도 여기서 한다. 모델/도구 장애는 runs.ts의 agent loop에서.
 */
function attach(res: ServerResponse, run: Run, after: number, { initial = false } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx 버퍼링 비활성화
  })

  const tag = `[run ${run.id.slice(0, 8)}]`
  const fault = run.fault
  let closed = false
  let textDeltas = 0

  // 프록시 버퍼링 재현: 쓰기를 모아뒀다가 주기적으로 한꺼번에 내보낸다 (heartbeat도 같이 갇힌다)
  const buffered: string[] = []
  const flushTimer = fault === 'proxy-buffering' ? setInterval(() => flushBuffer(), 2_500) : null
  const flushBuffer = () => {
    if (buffered.length && !closed) res.write(buffered.splice(0).join(''))
  }
  const raw = (chunk: string) => {
    if (closed) return
    if (flushTimer) buffered.push(chunk)
    else res.write(chunk)
  }
  const frame = (e: { type: string; seq: number }) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`

  const close = (how: 'end' | 'destroy') => {
    if (closed) return
    if (how === 'end') flushBuffer()
    closed = true
    if (flushTimer) clearInterval(flushTimer)
    how === 'end' ? res.end() : res.destroy()
  }

  const write = (e: ServerEvent) => {
    if (closed) return
    raw(frame(e))

    // 프로토콜 노이즈: 이벤트를 가끔 두 번 보내고, 클라이언트가 모르는 타입을 섞는다
    if (fault === 'protocol-noise' && e.seq % 7 === 0) {
      raw(frame(e))
      raw(frame({ type: 'response.reasoning_summary.delta', seq: e.seq, runId: run.id, delta: '...' } as never))
    }

    if (e.type === 'text.delta') textDeltas++
    if (initial && fault === 'drop-mid-stream' && textDeltas === 12) {
      console.log(`${tag} fault: destroying socket at seq ${e.seq} (run keeps going)`)
      return close('destroy')
    }
    if (initial && fault === 'server-restart' && textDeltas === 12) {
      // 서버 프로세스가 죽었다가 뜬 상황: 메모리의 run과 로그가 사라진다
      console.log(`${tag} fault: simulating server restart at seq ${e.seq} (run log lost)`)
      run.abort.abort('server restart')
      runs.delete(run.id)
      return close('destroy')
    }
    if (isTerminal(e)) close('end')
  }

  // 첫 바이트를 즉시 보내 "연결 성공"과 "모델이 느림"을 클라이언트가 구분할 수 있게 한다.
  raw(': connected\n\n')
  for (const e of run.log) if (e.seq > after) write(e)
  if (closed || run.status !== 'running') return close('end')

  const unsubscribe = run.subscribe(write)
  const heartbeat = setInterval(() => raw(': ping\n\n'), HEARTBEAT_MS)
  res.on('close', () => {
    closed = true
    clearInterval(heartbeat)
    if (flushTimer) clearInterval(flushTimer)
    unsubscribe()
  })
}

async function handleStart(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson<StartRunRequest>(req)
  const { runId, threadId, messages, fault = 'none' } = body

  const existing = runs.get(runId)
  // idempotency: 이미 진행 중이거나 끝난 run이면 새로 호출하지 않고 붙는다 → 재시도해도 이중 과금 없음.
  // 단, 보이는 출력 없이 "재시도 가능한 실패"로 끝난 run은 같은 id로 다시 시작할 수 있다.
  if (existing && !(existing.status === 'failed' && !existing.hasVisibleOutput)) {
    console.log(`[run ${runId.slice(0, 8)}] idempotent attach`)
    return attach(res, existing, 0)
  }

  if (fault === 'fail-before-first-token') {
    return json(res, 503, { code: 'overloaded', message: 'Simulated 503', retryable: true })
  }
  if (fault === 'rate-limit') {
    return json(res, 429, { code: 'rate_limited', message: 'Simulated 429', retryable: true, retryAfterMs: 3000 }, { 'Retry-After': '3' })
  }
  if (fault === 'context-length') {
    return json(res, 400, { code: 'context_length_exceeded', message: '대화가 너무 길어 더 이상 이어갈 수 없습니다.', retryable: false })
  }

  const run = new Run(runId, threadId, fault)
  runs.set(runId, run)
  console.log(`[run ${runId.slice(0, 8)}] start (${messages.length} messages, fault=${fault})`)
  void runAgent(run, messages)
  attach(res, run, 0, { initial: true })
}

function handleResume(res: ServerResponse, runId: string, after: number) {
  const run = runs.get(runId)
  if (!run) return json(res, 404, { code: 'run_gone', message: '이어받을 응답이 서버에 없습니다.', retryable: false })
  console.log(`[run ${runId.slice(0, 8)}] resume after seq ${after} (log=${run.log.length}, ${run.status})`)
  attach(res, run, after)
}

function handleCancel(res: ServerResponse, runId: string) {
  runs.get(runId)?.cancel('user')
  json(res, 200, { ok: true })
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const m = url.pathname.match(/^\/api\/runs\/([^/]+)\/(events|cancel)$/)
  const fail = (err: unknown) => {
    console.error('[bff] unhandled', err)
    if (!res.headersSent) json(res, 500, { code: 'unknown', message: 'BFF error', retryable: true })
  }

  if (req.method === 'POST' && url.pathname === '/api/runs') return void handleStart(req, res).catch(fail)
  if (req.method === 'GET' && m?.[2] === 'events') return handleResume(res, m[1], Number(url.searchParams.get('after') ?? 0))
  if (req.method === 'POST' && m?.[2] === 'cancel') return handleCancel(res, m[1])
  json(res, 404, { code: 'not_found' })
}).listen(PORT, () => console.log(`[bff] listening on :${PORT} (model=${process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'})`))
