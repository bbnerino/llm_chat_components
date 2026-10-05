import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { ChatRuntime } from './ChatRuntime'
import type { ChatState, Message, ToolPart } from './types'

const RuntimeContext = createContext<ChatRuntime | null>(null)

export function RuntimeProvider({ runtime, children }: { runtime: ChatRuntime; children: ReactNode }) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>
}

export function useRuntime() {
  const rt = useContext(RuntimeContext)
  if (!rt) throw new Error('RuntimeProvider가 필요합니다.')
  return rt
}

/**
 * 좁은 구독.
 *
 * 이전 프로젝트에서 긴 대화가 버벅인 핵심 원인은 "store 전체 구독"과 "렌더마다 새 객체를 만드는 getter"였다.
 * 여기서는 각 컴포넌트가 자기가 그리는 조각만 선택하고, selector는 반드시 상태 안의 기존 참조나
 * 원시값을 반환한다. (selector에서 새 배열/객체를 만들면 매번 "바뀜"으로 판정돼 무한 렌더가 된다.)
 */
export function useChatSelector<T>(selector: (s: ChatState) => T): T {
  const rt = useRuntime()
  return useSyncExternalStore(rt.subscribe, () => selector(rt.getState()))
}

const EMPTY: string[] = []

export const useActiveThreadId = () => useChatSelector((s) => s.activeThreadId)
export const useThreadOrder = () => useChatSelector((s) => s.threadOrder)
export const useMessageIds = (threadId: string | null) =>
  useChatSelector((s) => (threadId ? (s.threads[threadId]?.messageIds ?? EMPTY) : EMPTY))
export const useMessage = (threadId: string, messageId: string): Message | undefined =>
  useChatSelector((s) => s.threads[threadId]?.messages[messageId])
export const useActiveRun = (threadId: string | null) =>
  useChatSelector((s) => (threadId ? (s.threads[threadId]?.activeRun ?? null) : null))
export const useToolPart = (threadId: string, messageId: string, callId: string): ToolPart | undefined =>
  useChatSelector((s) => {
    const m = s.threads[threadId]?.messages[messageId]
    return m?.parts.find((p): p is ToolPart => p.type === 'tool' && p.callId === callId)
  })
