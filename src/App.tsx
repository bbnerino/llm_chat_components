import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChatUIContext, type DocRef } from './components/ChatUIContext'
import { Composer } from './components/Composer'
import { DevPanel } from './components/DevPanel'
import { DocumentPanel } from './components/DocumentPanel'
import { MessageList } from './components/MessageList'
import { Sidebar } from './components/Sidebar'
import { StatusAnnouncer } from './components/StatusAnnouncer'
import { ChatRuntime, type TelemetryEvent } from './runtime/ChatRuntime'
import type { FaultMode } from './runtime/protocol'
import { RuntimeProvider, useActiveRun, useActiveThreadId, useRuntime } from './runtime/react'
import { createSSETransport } from './runtime/transport'

function safeStorage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export default function App() {
  const faultRef = useRef<FaultMode>('none')
  const telemetryRef = useRef<(e: TelemetryEvent) => void>(() => {})
  const toolStartedRef = useRef<(info: DocRef & { name: string }) => void>(() => {})

  // 런타임은 앱 수명 동안 하나. 콜백은 ref를 거쳐 최신 상태를 읽는다.
  const [runtime] = useState(
    () =>
      new ChatRuntime({
        transport: createSSETransport('/api'),
        storage: safeStorage(),
        getFault: () => faultRef.current,
        onTelemetry: (e) => telemetryRef.current(e),
        onToolStarted: (info) => toolStartedRef.current({ ...info }),
      }),
  )
  useEffect(() => runtime.start(), [runtime])

  return (
    <RuntimeProvider runtime={runtime}>
      <Shell faultRef={faultRef} telemetryRef={telemetryRef} toolStartedRef={toolStartedRef} />
    </RuntimeProvider>
  )
}

interface ShellProps {
  faultRef: React.MutableRefObject<FaultMode>
  telemetryRef: React.MutableRefObject<(e: TelemetryEvent) => void>
  toolStartedRef: React.MutableRefObject<(info: DocRef & { name: string }) => void>
}

function Shell({ faultRef, telemetryRef, toolStartedRef }: ShellProps) {
  const runtime = useRuntime()
  const threadId = useActiveThreadId()
  const run = useActiveRun(threadId)
  const [fault, setFault] = useState<FaultMode>('none')
  const [log, setLog] = useState<TelemetryEvent[]>([])
  const [openDoc, setOpenDoc] = useState<DocRef | null>(null)
  const [tab, setTab] = useState<'doc' | 'dev'>('dev')

  faultRef.current = fault
  telemetryRef.current = useCallback((e: TelemetryEvent) => {
    setLog((prev) => [...prev.slice(-199), e])
    if (import.meta.env.DEV) console.debug('[runtime]', e.kind, e.runId.slice(0, 8), e.detail ?? '')
  }, [])

  // 문서 작성 tool이 "시작되는 순간" 패널을 연다. 마운트 effect가 아니라 이벤트 처리 시점의 부수효과.
  toolStartedRef.current = (info) => {
    if (info.name === 'create_document' && info.threadId === runtime.getState().activeThreadId) {
      setOpenDoc({ threadId: info.threadId, messageId: info.messageId, callId: info.callId })
      setTab('doc')
    }
  }

  // URL 동기화: #<threadId>
  useEffect(() => {
    const fromHash = location.hash.slice(1)
    if (fromHash && runtime.getState().threads[fromHash]) runtime.selectThread(fromHash)
  }, [runtime])
  useEffect(() => {
    if (threadId) history.replaceState(null, '', `#${threadId}`)
  }, [threadId])

  const ui = useMemo(
    () => ({
      openDoc,
      openDocument: (ref: DocRef) => {
        setOpenDoc(ref)
        setTab('doc')
      },
      closeDocument: () => {
        setOpenDoc(null)
        setTab('dev')
      },
    }),
    [openDoc],
  )

  const phase = run ? (run.phase === 'generating' ? 'streaming' : run.phase) : 'idle'

  return (
    <ChatUIContext.Provider value={ui}>
      <div className="layout">
        <Sidebar />
        <main className="chat">
          <header>
            <h1>AI Response Runtime</h1>
            <span className={`status ${run ? 'on' : ''}`}>{phase}</span>
          </header>
          {/* key로 대화 전환 시 목록을 새로 마운트 → 스크롤 상태가 이전 대화에서 넘어오지 않는다 */}
          {threadId ? <MessageList key={threadId} threadId={threadId} /> : <NoThread />}
          <Composer threadId={threadId} />
          <StatusAnnouncer threadId={threadId} />
        </main>
        <aside className="side">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'doc'} disabled={!openDoc} onClick={() => setTab('doc')}>
              문서
            </button>
            <button role="tab" aria-selected={tab === 'dev'} onClick={() => setTab('dev')}>
              런타임
            </button>
          </div>
          {tab === 'doc' && openDoc ? (
            <DocumentPanel doc={openDoc} />
          ) : (
            <DevPanel fault={fault} onFaultChange={setFault} log={log} onClear={() => setLog([])} />
          )}
        </aside>
      </div>
    </ChatUIContext.Provider>
  )
}

function NoThread() {
  return (
    <div className="message-scroll">
      <div className="empty">
        <h2>무엇이든 물어보세요</h2>
        <p>메시지를 보내면 새 대화가 시작됩니다.</p>
      </div>
    </div>
  )
}
