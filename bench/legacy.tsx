/**
 * 이전 프로젝트의 렌더링 구조를 그대로 재현한 비교용 구현.
 * (회사 코드가 아니라 구조만 옮긴 것. docs/legacy-chat-perf-analysis.md의 패턴 ①~④)
 *
 *  ① store를 selector 없이 통째로 구독
 *  ② getMessageList()가 호출마다 모든 그룹을 새 객체로 복사 → memo 무력화
 *     + append마다 그룹 안 모든 메시지를 {...m, isNew:false}로 복제
 *  ②-c 파생값(필터링)을 useEffect + setState로 계산 → 렌더 2회
 *  ③ tool 행마다 tool store 전체 구독
 *  ④ useEffect([children])에서 scrollHeight 읽기 + 매 이벤트 smooth scrollTo
 */
import { Children, memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { StreamingMarkdown } from '../src/components/markdown/StreamingMarkdown'
import { countRender } from '../src/lib/renderCounter'

export interface LegacyMsg {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content?: string
  callId?: string
  isNew: boolean
}
interface Group { invocation_id: string; messages: LegacyMsg[]; createdAt: number }

// ── message store (①, ②) ──────────────────────────────────────────
let state: Record<string, Group> = {}
let version = 0
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

export const legacyStore = {
  reset() { state = {}; version++; toolMap = new Map(); notify() },
  subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l) },
  // selector 없이 통째로 구독하는 것을 재현: 스냅샷이 매번 바뀌는 version 객체
  getSnapshot: () => version,
  append(groupId: string, msg: Omit<LegacyMsg, 'isNew'>) {
    const g = state[groupId]
    if (g) {
      // 기존 메시지 전부 복제 (isNew:false)
      const updated = g.messages.map((m) => ({ ...m, isNew: false }))
      state = { ...state, [groupId]: { ...g, messages: [...updated, { ...msg, isNew: true }] } }
    } else {
      state = { ...state, [groupId]: { invocation_id: groupId, messages: [{ ...msg, isNew: true }], createdAt: Date.now() + Object.keys(state).length } }
    }
    version++
    notify()
  },
  // 호출마다 모든 그룹을 새 객체로 복사 + 정렬
  getMessageList(): Group[] {
    return Object.entries(state).map(([, g]) => ({ ...g })).sort((a, b) => a.createdAt - b.createdAt)
  },
}

// ── tool store (③) ────────────────────────────────────────────────
let toolMap = new Map<string, { name: string; result?: unknown }>()
let toolVersion = 0
const toolListeners = new Set<() => void>()
export const legacyToolStore = {
  subscribe(l: () => void) { toolListeners.add(l); return () => toolListeners.delete(l) },
  getSnapshot: () => toolVersion,
  update(id: string, data: { name: string; result?: unknown }) {
    const next = new Map(toolMap)
    next.set(id, { ...next.get(id), ...data })
    toolMap = next
    toolVersion++
    toolListeners.forEach((l) => l())
  },
  get: (id: string) => toolMap.get(id),
}

function useLegacyStore() { return useSyncExternalStore(legacyStore.subscribe, legacyStore.getSnapshot) }
function useLegacyToolStore() { return useSyncExternalStore(legacyToolStore.subscribe, legacyToolStore.getSnapshot) }

// ── components ────────────────────────────────────────────────────
const MessageItem = memo(function MessageItem({ message }: { message: LegacyMsg }) {
  countRender('legacy:MessageItem')
  if (message.role === 'user') return <div className="bubble-user">{message.content}</div>
  return <StreamingMarkdown text={message.content ?? ''} streaming={false} />
})

const ToolRow = memo(function ToolRow({ message }: { message: LegacyMsg }) {
  countRender('legacy:ToolRow')
  useLegacyToolStore() // ③ tool store 전체 구독
  const tool = legacyToolStore.get(message.callId!)
  return <li>{message.isNew ? '⏳' : '✓'} {tool?.name ?? message.callId}</li>
})

function ToolGroup({ messages }: { messages: LegacyMsg[] }) {
  countRender('legacy:ToolGroup')
  // ②-c 파생값을 effect + setState로
  const [visible, setVisible] = useState<LegacyMsg[]>([])
  useEffect(() => { setVisible(messages.filter((m) => m.role === 'tool')) }, [messages])
  if (visible.length === 0) return null
  return <ul className="steps-list">{visible.map((m) => <ToolRow key={m.id} message={m} />)}</ul>
}

const MessageGroup = memo(function MessageGroup({ group }: { group: Group }) {
  countRender('legacy:MessageGroup')
  const subGroups = useMemo(() => {
    const out: { role: string; messages: LegacyMsg[] }[] = []
    for (const m of group.messages) {
      const last = out.at(-1)
      if (last && last.role === m.role) last.messages.push(m)
      else out.push({ role: m.role, messages: [m] })
    }
    return out
  }, [group])
  return (
    <div className="msg">
      {subGroups.map((sg, idx) =>
        sg.role === 'tool'
          ? <ToolGroup key={`subgroup-${idx}`} messages={sg.messages} />
          : <div key={`subgroup-${idx}`}>{sg.messages.map((m) => <MessageItem key={m.id} message={m} />)}</div>,
      )}
    </div>
  )
})

function ChatContainer({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const prevCount = useRef(0)
  // ④ children은 매 렌더 새 참조 → 매 렌더 실행 → scrollHeight 읽기(강제 레이아웃) + smooth scrollTo
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const count = Children.toArray(children).length
    const h = el.scrollHeight
    ;(window as any).__layoutReads = ((window as any).__layoutReads ?? 0) + 1
    if (count > prevCount.current) el.scrollTo({ top: h, behavior: 'smooth' })
    prevCount.current = count
  }, [children])
  return <div ref={ref} className="message-scroll" style={{ height: 600 }}>{children}</div>
}

export function LegacyPage() {
  countRender('legacy:Page')
  useLegacyStore() // ① 통째로 구독
  const groups = legacyStore.getMessageList() // ② 렌더마다 새 객체
  return (
    <ChatContainer>
      <div className="message-list">
        {groups.map((g) => <MessageGroup key={g.invocation_id} group={g} />)}
      </div>
    </ChatContainer>
  )
}
