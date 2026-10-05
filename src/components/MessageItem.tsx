import { memo, useEffect, useMemo, useState } from 'react'
import { textOf } from '../runtime/reducer'
import { useActiveRun, useMessage, useRuntime } from '../runtime/react'
import type { Message } from '../runtime/types'
import { layoutParts } from './layoutParts'
import { StreamingMarkdown } from './markdown/StreamingMarkdown'
import { resolveTool, ToolSlot, ToolSteps } from './ToolParts'

interface Props {
  threadId: string
  messageId: string
  isLast: boolean
}

/**
 * 메시지 한 줄. 자기 메시지만 구독한다(useMessage).
 * 스트리밍 중에는 리듀서가 생성 중인 메시지 하나만 새 객체로 만들기 때문에,
 * 나머지 수백 개의 행은 selector 결과가 같아 아예 렌더되지 않는다.
 */
export const MessageItem = memo(function MessageItem({ threadId, messageId, isLast }: Props) {
  const m = useMessage(threadId, messageId)
  if (!m) return null
  return m.role === 'user' ? <UserMessage m={m} threadId={threadId} /> : <AssistantMessage m={m} threadId={threadId} isLast={isLast} />
})

function UserMessage({ m, threadId }: { m: Message; threadId: string }) {
  const runtime = useRuntime()
  return (
    <article className="msg msg-user">
      <h3 className="sr-only">사용자</h3>
      <div className="bubble">{textOf(m)}</div>
      <div className="actions">
        <button onClick={() => runtime.deleteTurn(threadId, m.id)}>삭제</button>
      </div>
    </article>
  )
}

function AssistantMessage({ m, threadId, isLast }: { m: Message; threadId: string; isLast: boolean }) {
  const runtime = useRuntime()
  const live = m.status === 'pending' || m.status === 'streaming'
  const { segments, footer } = useMemo(() => layoutParts(m.parts, resolveTool), [m.parts])
  const lastTextKey = segments.findLast((s) => s.kind === 'text')?.key

  return (
    <article className={`msg msg-assistant msg-${m.status}`} aria-busy={live}>
      <h3 className="sr-only">어시스턴트</h3>
      <div className="assistant-body">
        {segments.map((s) =>
          s.kind === 'text' ? (
            <StreamingMarkdown key={s.key} text={s.part.text} streaming={live && s.key === lastTextKey && segments.at(-1)?.key === s.key} />
          ) : s.kind === 'steps' ? (
            <ToolSteps key={s.key} parts={s.parts} threadId={threadId} messageId={m.id} />
          ) : (
            <ToolSlot key={s.key} part={s.part} threadId={threadId} messageId={m.id} />
          ),
        )}

        {/* 진행 상태는 생성 중인 메시지에서만 구독한다 → 다른 행은 phase 변화에 깨어나지 않는다 */}
        {live && <RunStatus threadId={threadId} />}

        {m.status === 'done' && m.finish === 'length' && (
          <Notice tone="warn" text="답변이 길이 제한으로 잘렸습니다.">
            <button onClick={() => runtime.send('이어서 계속 작성해줘', threadId)}>이어서 작성</button>
          </Notice>
        )}
        {m.status === 'done' && m.finish === 'content_filter' && <Notice tone="muted" text="콘텐츠 정책에 따라 답변 일부가 생략되었습니다." />}
        {m.status === 'aborted' && <div className="tag">중지됨</div>}
        {m.status === 'error' && m.error && <ErrorBlock m={m} threadId={threadId} />}

        {m.status === 'done' && footer.map((p) => <ToolSlot key={p.callId} part={p} threadId={threadId} messageId={m.id} />)}
      </div>

      {!live && (
        <div className="actions">
          {isLast && <button onClick={() => runtime.regenerate(threadId, m.id)}>재생성</button>}
          <button onClick={() => runtime.deleteTurn(threadId, m.id)}>삭제</button>
          <Metrics m={m} />
        </div>
      )}
    </article>
  )
}

const PHASE_TEXT = {
  connecting: '연결 중',
  thinking: '생각 중',
  tool: '도구 실행 중',
  generating: '',
  resuming: '연결이 끊겨 이어받는 중',
  retrying: '',
} as const

function RunStatus({ threadId }: { threadId: string }) {
  const run = useActiveRun(threadId)
  if (!run || run.phase === 'generating') return null
  if (run.phase === 'retrying') return <RetryCountdown retryAt={run.retryAt} />
  return (
    <div className="run-status">
      <span className="dots"><i /><i /><i /></span> {PHASE_TEXT[run.phase]}…
    </div>
  )
}

function RetryCountdown({ retryAt }: { retryAt?: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [])
  const left = Math.max(0, Math.ceil(((retryAt ?? now) - now) / 1000))
  return (
    <div className="run-status retry">
      <span className="spinner" /> 일시적인 오류 · {left > 0 ? `${left}초 후 다시 시도합니다` : '다시 시도하는 중'}
    </div>
  )
}

const ERROR_HINT: Partial<Record<string, string>> = {
  rate_limited: '요청이 몰려 있습니다. 잠시 후 다시 시도해주세요.',
  quota_exceeded: 'API 사용 한도를 초과했습니다.',
  context_length_exceeded: '대화가 너무 길어졌습니다. 새 대화에서 이어가 주세요.',
  run_gone: '서버에서 이 응답을 더 이상 이어받을 수 없습니다.',
  stream_stalled: '서버 응답이 멈췄습니다.',
}

function ErrorBlock({ m, threadId }: { m: Message; threadId: string }) {
  const runtime = useRuntime()
  const e = m.error!
  return (
    <div className="error" role="alert">
      <strong>{ERROR_HINT[e.code] ?? e.message}</strong>
      <code>{e.code}</code>
      {m.parts.length > 0 && <p>위 내용은 끊기기 전까지 받은 부분 응답입니다.</p>}
      <div className="error-actions">
        {e.code === 'context_length_exceeded' ? (
          <button onClick={() => runtime.createThread()}>새 대화 시작</button>
        ) : (
          e.retryable && <button onClick={() => runtime.regenerate(threadId, m.id)}>다시 시도</button>
        )}
      </div>
    </div>
  )
}

function Notice({ tone, text, children }: { tone: 'warn' | 'muted'; text: string; children?: React.ReactNode }) {
  return (
    <div className={`notice notice-${tone}`}>
      <span>{text}</span>
      {children}
    </div>
  )
}


function Metrics({ m }: { m: Message }) {
  const x = m.metrics
  if (!x) return null
  const ttft = x.firstTokenAt && x.firstTokenAt - x.requestedAt
  const total = x.endedAt && x.endedAt - x.requestedAt
  return (
    <span className="metrics">
      {[
        x.model,
        ttft ? `첫 출력 ${(ttft / 1000).toFixed(1)}s` : null,
        total ? `총 ${(total / 1000).toFixed(1)}s` : null,
        x.outputTokens ? `${x.outputTokens} tok` : null,
        x.attempts > 1 ? `재시도 ${x.attempts - 1}회` : null,
        x.resumes > 0 ? `이어받기 ${x.resumes}회` : null,
      ]
        .filter(Boolean)
        .join(' · ')}
    </span>
  )
}
