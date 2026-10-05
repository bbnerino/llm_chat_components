import { useChatUI } from '../components/ChatUIContext'
import { StreamingMarkdown } from '../components/markdown/StreamingMarkdown'
import { useRuntime } from '../runtime/react'
import { defineTool, isRunning, type ToolUI, type ToolViewProps } from './registry'

// ── 검색 ────────────────────────────────────────────────────────────

interface SearchArgs { query: string; lang: 'ko' | 'en' }
interface SearchOutput { query: string; results: { title: string; snippet: string; url: string }[] }

const isSearchOutput = (v: unknown): v is SearchOutput => Array.isArray((v as SearchOutput)?.results)

function SearchResults({ output }: ToolViewProps<SearchArgs, SearchOutput>) {
  if (!output) return null
  return (
    <ol className="citations">
      {output.results.map((r, i) => (
        <li key={r.url}>
          <a href={r.url} target="_blank" rel="noopener noreferrer nofollow">
            <span className="cite-no">{i + 1}</span>
            <span className="cite-title">{r.title}</span>
          </a>
          <p>{r.snippet}</p>
        </li>
      ))}
    </ol>
  )
}

// ── 날씨 ────────────────────────────────────────────────────────────

interface WeatherArgs { city: string }
interface WeatherOutput {
  city: string
  country: string
  current: { temperature: number; humidity: number; wind: number; summary: string }
  daily: { date: string; max: number; min: number; summary: string }[]
}

const isWeatherOutput = (v: unknown): v is WeatherOutput => typeof (v as WeatherOutput)?.current?.temperature === 'number'

function WeatherCard({ part, args, output }: ToolViewProps<WeatherArgs, WeatherOutput>) {
  if (part.state === 'output-error') {
    return <div className="tool-card tool-card-error">⚠️ {args?.city} 날씨를 가져오지 못했습니다 · {part.error?.message}</div>
  }
  if (part.state === 'cancelled') {
    return <div className="tool-card skeleton">{args?.city ?? ''} 날씨 조회가 중지되었습니다</div>
  }
  if (!output) {
    return (
      <div className="tool-card weather skeleton" aria-busy>
        <span className="spinner" /> {args?.city ?? '도시'} 날씨 조회 중…
      </div>
    )
  }
  const day = (d: string) => new Date(d).toLocaleDateString('ko-KR', { weekday: 'short', month: 'numeric', day: 'numeric' })
  return (
    <div className="tool-card weather">
      <div className="weather-now">
        <div>
          <div className="weather-city">{output.city} <small>{output.country}</small></div>
          <div className="weather-summary">{output.current.summary}</div>
        </div>
        <div className="weather-temp">{Math.round(output.current.temperature)}°</div>
      </div>
      <div className="weather-meta">습도 {output.current.humidity}% · 바람 {output.current.wind}km/h</div>
      <div className="weather-days">
        {output.daily.map((d) => (
          <div key={d.date}>
            <span>{day(d.date)}</span>
            <b>{Math.round(d.max)}° / {Math.round(d.min)}°</b>
            <small>{d.summary}</small>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 문서 ────────────────────────────────────────────────────────────

interface DocArgs { title: string; content: string }
interface DocOutput { documentId: string; title: string; chars: number }

function DocumentCard({ part, args, threadId, messageId }: ToolViewProps<DocArgs, DocOutput>) {
  const { openDocument, openDoc } = useChatUI()
  const writing = part.state === 'input-streaming'
  const isOpen = openDoc?.callId === part.callId
  const preview = (args?.content ?? '').split('\n').filter(Boolean).at(-1) ?? ''
  return (
    <button
      className={`tool-card doc-card ${isOpen ? 'is-open' : ''}`}
      onClick={() => openDocument({ threadId, messageId, callId: part.callId })}
    >
      <span className="doc-icon">{writing ? <span className="spinner" /> : '📄'}</span>
      <span className="doc-body">
        <span className="doc-title">{args?.title || '제목 작성 중…'}</span>
        <span className="doc-sub">
          {writing ? `작성 중 · ${(args?.content ?? '').length.toLocaleString()}자` : part.state === 'cancelled' ? '작성 중단됨' : `${(args?.content ?? '').length.toLocaleString()}자 · 클릭해서 보기`}
        </span>
        {writing && preview && <span className="doc-preview">{preview.slice(0, 80)}</span>}
      </span>
    </button>
  )
}

/** 사이드 패널에서 문서 전체를 보여준다. 인자가 스트리밍되는 동안 실시간으로 써진다. */
export function DocumentBody({ part, args }: { part: ToolViewProps<DocArgs>['part']; args: Partial<DocArgs> | undefined }) {
  return (
    <article className="doc-panel-body">
      <h1>{args?.title || '제목 작성 중…'}</h1>
      <StreamingMarkdown text={args?.content ?? ''} streaming={isRunning(part)} />
    </article>
  )
}

// ── 후속 질문 ───────────────────────────────────────────────────────

interface FollowupArgs { questions: string[] }

function FollowupChips({ args, threadId }: ToolViewProps<FollowupArgs>) {
  const runtime = useRuntime()
  const questions = (args?.questions ?? []).filter((q): q is string => typeof q === 'string' && q.length > 0)
  if (questions.length === 0) return null
  return (
    <div className="followups" role="group" aria-label="후속 질문">
      {questions.map((q) => (
        <button key={q} onClick={() => runtime.send(q, threadId)}>
          {q}
        </button>
      ))}
    </div>
  )
}

// ── 레지스트리 ──────────────────────────────────────────────────────

export const toolRegistry: Record<string, ToolUI> = {
  search_wikipedia: defineTool<SearchArgs, SearchOutput>({
    placement: 'step',
    icon: '🔎',
    label: (a, p) =>
      p.state === 'output-error' ? `검색 실패 · ${a?.query ?? ''}` : isRunning(p) ? `위키백과 검색 중 · ${a?.query ?? ''}` : `위키백과 검색 · ${a?.query ?? ''}`,
    View: SearchResults,
    isOutput: isSearchOutput,
  }),
  get_weather: defineTool<WeatherArgs, WeatherOutput>({
    placement: 'pinned',
    icon: '🌤',
    label: (a) => `날씨 · ${a?.city ?? ''}`,
    View: WeatherCard,
    isOutput: isWeatherOutput,
  }),
  create_document: defineTool<DocArgs, DocOutput>({
    placement: 'pinned',
    icon: '📄',
    streamArgs: true, // 인자(문서 본문) 자체가 콘텐츠 → 부분 파싱해서 실시간으로 보여준다
    label: (a) => `문서 · ${a?.title ?? ''}`,
    View: DocumentCard,
  }),
  suggest_followups: defineTool<FollowupArgs, unknown>({
    placement: 'footer',
    icon: '💬',
    streamArgs: true,
    label: () => '후속 질문',
    View: FollowupChips,
  }),
  get_current_time: defineTool({ placement: 'hidden', icon: '🕒', label: () => '현재 시각 확인' }),
}
