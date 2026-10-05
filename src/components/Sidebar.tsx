import { memo } from 'react'
import { useActiveThreadId, useChatSelector, useRuntime, useThreadOrder } from '../runtime/react'

/**
 * 대화 목록. 응답 생성은 대화를 전환해도 백그라운드에서 계속된다.
 * 각 항목은 자기 제목과 "생성 중" 여부(원시값)만 구독한다.
 */
export function Sidebar() {
  const runtime = useRuntime()
  const order = useThreadOrder()
  return (
    <nav className="sidebar" aria-label="대화 목록">
      <button className="new-thread" onClick={() => runtime.createThread()}>
        + 새 대화
      </button>
      <ul>
        {order.map((id) => (
          <ThreadItem key={id} id={id} />
        ))}
      </ul>
    </nav>
  )
}

const ThreadItem = memo(function ThreadItem({ id }: { id: string }) {
  const runtime = useRuntime()
  const title = useChatSelector((s) => s.threads[id]?.title ?? '')
  const running = useChatSelector((s) => !!s.threads[id]?.activeRun)
  const active = useActiveThreadId() === id
  return (
    <li className={active ? 'active' : ''}>
      <button className="thread-btn" onClick={() => runtime.selectThread(id)} aria-current={active ? 'page' : undefined}>
        {running && <span className="live-dot" aria-label="응답 생성 중" />}
        <span className="thread-title">{title}</span>
      </button>
      <button className="thread-del" onClick={() => runtime.deleteThread(id)} aria-label={`${title} 삭제`}>
        ×
      </button>
    </li>
  )
})
