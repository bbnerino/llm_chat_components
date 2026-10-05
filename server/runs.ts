/**
 * Run 매니저 + Agent loop
 *
 * 핵심 결정: run의 생명주기를 HTTP 연결에서 분리한다.
 *
 *   v1: 연결 = run. 연결이 끊기면(모바일 백그라운드, 와이파이→LTE, 프록시 타임아웃) 응답도 끝.
 *   v2: run은 서버 메모리에서 독립적으로 진행되고, 모든 이벤트를 seq와 함께 로그에 쌓는다.
 *       연결은 그 로그를 "구독"하는 창일 뿐이다. 끊기면 after=<seq>로 다시 구독하면 된다.
 *
 * 그러면 "연결 끊김"과 "사용자 중지"를 구분해야 한다.
 *   - 끊김: 아무것도 하지 않는다. (다시 붙으러 올 것이다)
 *   - 중지: POST /cancel → 업스트림 abort → run.cancelled
 *   - 영영 안 돌아옴(탭 닫음): 구독자 0명 상태로 일정 시간 지나면 reaper가 취소 → 토큰 과금 방지
 */
import { readSSE } from '../src/lib/sse/parseSSE.ts'
import type { FaultMode, FinishReason, ServerEvent, ServerEventPayload, WireMessage } from '../src/runtime/protocol.ts'
import { isTerminal } from '../src/runtime/protocol.ts'
import { normalizeHttpError, normalizeStreamError, toResponsesInput } from './openai.ts'
import { TOOLS, TOOL_DEFINITIONS, ToolExecutionError } from './tools.ts'

const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'
const API_KEY = process.env.OPENAI_API_KEY!
const MAX_STEPS = 6
const ORPHAN_TIMEOUT_MS = 30_000
const RETAIN_FINISHED_MS = 5 * 60_000

const SYSTEM_PROMPT = `You are a helpful assistant. Answer in the same language as the user.
- Use search_wikipedia for factual questions and cite sources inline like [1], [2] matching result order.
- Use get_weather for weather questions.
- Use create_document only when the user asks for a deliverable (plan, report, essay, document). After creating it, reply with 1-2 sentences only.
- Use get_current_time when the answer depends on today's date.
- At the end of every answer, call suggest_followups with 2-3 short follow-up questions in the user's language. Never write follow-up questions in the answer text itself; the UI renders them from the tool.
- Tools are invoked only through function calling. Never write tool syntax such as "functions.suggest_followups(...)" or "suggest_followups" in the answer text.
Keep answers concise and use Markdown.`

type Listener = (e: ServerEvent) => void

export class Run {
  readonly id: string
  readonly threadId: string
  readonly log: ServerEvent[] = []
  readonly abort = new AbortController()
  readonly fault: FaultMode
  status: 'running' | 'completed' | 'failed' | 'cancelled' = 'running'
  /** 텍스트/tool 등 "사용자에게 보이는" 이벤트가 하나라도 나갔는지 (재시도 가능 여부 판단) */
  hasVisibleOutput = false
  finishedAt?: number
  detachedAt: number | null = Date.now()
  private listeners = new Set<Listener>()

  constructor(id: string, threadId: string, fault: FaultMode) {
    this.id = id
    this.threadId = threadId
    this.fault = fault
  }

  emit(payload: ServerEventPayload) {
    if (this.status !== 'running') return
    const event = { ...payload, runId: this.id, seq: this.log.length + 1 } as ServerEvent
    this.log.push(event)
    if (event.type === 'text.delta' || event.type === 'tool.started') this.hasVisibleOutput = true
    if (isTerminal(event)) {
      this.status = event.type === 'run.completed' ? 'completed' : event.type === 'run.failed' ? 'failed' : 'cancelled'
      this.finishedAt = Date.now()
    }
    for (const l of this.listeners) l(event)
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    this.detachedAt = null
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.detachedAt = Date.now()
    }
  }

  get subscriberCount() {
    return this.listeners.size
  }

  cancel(reason: string) {
    if (this.status !== 'running') return
    console.log(`[run ${this.id.slice(0, 8)}] cancel (${reason})`)
    this.emit({ type: 'run.cancelled' })
    this.abort.abort(reason)
  }
}

export const runs = new Map<string, Run>()

/** 고아 run 정리: 아무도 구독하지 않는 진행 중 run은 취소, 끝난 run은 일정 시간 후 삭제 */
setInterval(() => {
  const now = Date.now()
  for (const [id, run] of runs) {
    if (run.status === 'running' && run.detachedAt && now - run.detachedAt > ORPHAN_TIMEOUT_MS) {
      run.cancel('orphaned: no subscriber')
    }
    if (run.finishedAt && now - run.finishedAt > RETAIN_FINISHED_MS) runs.delete(id)
  }
}, 5_000).unref()

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })

type InputItem = ReturnType<typeof toResponsesInput>[number]

/** Agent loop: 모델 호출 → tool 실행 → 결과를 붙여 다시 모델 호출 … (최대 MAX_STEPS) */
export async function runAgent(run: Run, messages: WireMessage[]) {
  const { signal } = run.abort
  const log = (...a: unknown[]) => console.log(`[run ${run.id.slice(0, 8)}]`, ...a)
  const input: InputItem[] = toResponsesInput(messages)
  const usage = { inputTokens: 0, outputTokens: 0 }
  let finish: FinishReason = 'stop'

  run.emit({ type: 'run.started', model: MODEL })

  try {
    let textDeltas = 0
    for (let step = 0; step < MAX_STEPS; step++) {
      run.emit({ type: 'run.progress', phase: 'thinking' })
      const stepAbort = new AbortController()
      const stepSignal = AbortSignal.any([signal, stepAbort.signal])

      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          instructions: SYSTEM_PROMPT,
          input,
          tools: TOOL_DEFINITIONS,
          parallel_tool_calls: true,
          stream: true,
          store: false,
        }),
        signal: stepSignal,
      })

      if (!res.ok || !res.body) {
        const err = await normalizeHttpError(res)
        log('upstream http error', res.status, err.code)
        run.emit({ type: 'run.failed', ...err })
        return
      }

      // item_id → 호출 정보. 병렬 호출은 item_id(=output_index)로 구분된다.
      const calls = new Map<string, { callId: string; name: string; args: string }>()
      let generating = false

      streaming: for await (const msg of readSSE(res.body, { signal: stepSignal })) {
        const data = JSON.parse(msg.data)
        switch (data.type) {
          case 'response.output_item.added':
            if (data.item?.type === 'function_call') {
              calls.set(data.item.id, { callId: data.item.call_id, name: data.item.name, args: '' })
              run.emit({ type: 'tool.started', callId: data.item.call_id, name: data.item.name })
            }
            break
          case 'response.function_call_arguments.delta': {
            const c = calls.get(data.item_id)
            if (!c) break
            c.args += data.delta
            run.emit({ type: 'tool.args.delta', callId: c.callId, delta: data.delta })
            break
          }
          case 'response.function_call_arguments.done': {
            const c = calls.get(data.item_id)
            if (!c) break
            c.args = data.arguments
            run.emit({ type: 'tool.input.completed', callId: c.callId, args: safeParse(c.args) })
            break
          }
          case 'response.output_text.delta':
          case 'response.refusal.delta':
            if (!generating) {
              generating = true
              run.emit({ type: 'run.progress', phase: 'generating' })
            }
            if (run.fault === 'slow') await sleep(100, signal)
            run.emit({ type: 'text.delta', delta: data.delta })
            textDeltas++
            // 모델 장애 재현: HTTP는 이미 200인데 스트림 안에서 에러가 온다
            if (run.fault === 'mid-stream-error' && textDeltas === 15) {
              stepAbort.abort()
              log('fault: model error mid-stream')
              run.emit({ type: 'run.failed', code: 'overloaded', message: '모델 처리 중 오류가 발생했습니다.', retryable: true })
              return
            }
            // 출력 길이 제한 재현: response.incomplete(max_output_tokens)와 같은 결과
            if (run.fault === 'length-limit' && textDeltas === 25) {
              stepAbort.abort()
              log('fault: output length limit')
              finish = 'length'
              break streaming
            }
            break
          case 'response.completed':
            addUsage(usage, data.response?.usage)
            break
          case 'response.incomplete': {
            addUsage(usage, data.response?.usage)
            const reason = data.response?.incomplete_details?.reason
            finish = reason === 'content_filter' ? 'content_filter' : 'length'
            break
          }
          case 'response.failed':
          case 'error': {
            const err = normalizeStreamError(data.response?.error ?? data.error ?? data)
            log('stream error', err.code)
            run.emit({ type: 'run.failed', ...err })
            return
          }
          // 그 외 이벤트(response.created, content_part.* …)는 UI에 의미가 없으므로 버린다.
        }
      }

      if (calls.size === 0 || finish !== 'stop') break

      // ── tool 실행 (병렬) ──
      run.emit({ type: 'run.progress', phase: 'tool' })
      const executed = await Promise.all(
        [...calls.values()].map(async (c) => {
          const args = safeParse(c.args)
          const tool = TOOLS[c.name]
          let output: unknown
          try {
            if (!tool) throw new ToolExecutionError('unknown_tool', `알 수 없는 도구: ${c.name}`)
            if (run.fault === 'tool-failure' && !tool.terminal) {
              await sleep(1500, signal)
              throw new ToolExecutionError('tool_timeout', '외부 API 응답이 너무 늦습니다.')
            }
            output = await tool.execute(args, signal)
            run.emit({ type: 'tool.result', callId: c.callId, output })
          } catch (err) {
            if (signal.aborted) throw err
            const e = err instanceof ToolExecutionError ? err : new ToolExecutionError('tool_error', String(err))
            output = { error: e.code, message: e.message }
            run.emit({ type: 'tool.failed', callId: c.callId, code: e.code, message: e.message })
          }
          return { c, output, terminal: tool?.terminal ?? false }
        }),
      )

      // 결과를 다음 모델 호출의 입력에 붙인다.
      for (const { c, output } of executed) {
        input.push({ type: 'function_call', call_id: c.callId, name: c.name, arguments: c.args })
        input.push({ type: 'function_call_output', call_id: c.callId, output: JSON.stringify(output) })
      }

      // 표시 전용 tool(후속 질문 등)만 호출됐다면 모델을 한 번 더 부를 필요가 없다 → 왕복 1회 절약
      if (executed.every((x) => x.terminal)) break
    }

    run.emit({ type: 'run.completed', finish, usage })
    log(`completed (${run.log.length} events, finish=${finish})`)
  } catch (err) {
    if (signal.aborted) return // cancel()이 이미 run.cancelled를 기록했다
    log('agent error', err)
    run.emit({ type: 'run.failed', code: 'upstream_error', message: '응답 생성 중 오류가 발생했습니다.', retryable: !run.hasVisibleOutput })
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s || '{}')
  } catch {
    return {}
  }
}

function addUsage(acc: { inputTokens: number; outputTokens: number }, u: any) {
  if (!u) return
  acc.inputTokens += u.input_tokens ?? 0
  acc.outputTokens += u.output_tokens ?? 0
}
