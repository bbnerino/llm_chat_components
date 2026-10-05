/**
 * 새 런타임: 실제 리듀서와 실제 컴포넌트를 그대로 쓴다.
 * ChatRuntime 대신 상태를 직접 dispatch하는 작은 스토어를 꽂는다 (네트워크 없이 이벤트 주입).
 */
import { MessageList } from '../src/components/MessageList'
import type { ChatRuntime } from '../src/runtime/ChatRuntime'
import type { ServerEvent } from '../src/runtime/protocol'
import { RuntimeProvider } from '../src/runtime/react'
import { chatReducer, initialChatState } from '../src/runtime/reducer'
import type { ChatAction, ChatState } from '../src/runtime/types'

export class BenchStore {
  private state: ChatState = initialChatState
  private listeners = new Set<() => void>()
  getState = () => this.state
  subscribe = (l: () => void) => { this.listeners.add(l); return () => this.listeners.delete(l) }
  dispatch(action: ChatAction) {
    const prev = this.state
    this.state = chatReducer(prev, action)
    if (prev !== this.state) this.listeners.forEach((l) => l())
  }
  receive(threadId: string, events: ServerEvent[]) {
    this.dispatch({ type: 'events/received', batches: [{ threadId, events }], now: Date.now() })
  }
  reset() { this.state = initialChatState; this.listeners.forEach((l) => l()) }
}

export function ModernPage({ store, threadId }: { store: BenchStore; threadId: string }) {
  return (
    <RuntimeProvider runtime={store as unknown as ChatRuntime}>
      <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
        <MessageList threadId={threadId} />
      </div>
    </RuntimeProvider>
  )
}
