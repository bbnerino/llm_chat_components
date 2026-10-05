import { createContext, useContext } from 'react'

export interface DocRef {
  threadId: string
  messageId: string
  callId: string
}

interface ChatUIValue {
  openDoc: DocRef | null
  openDocument: (ref: DocRef) => void
  closeDocument: () => void
}

export const ChatUIContext = createContext<ChatUIValue>({
  openDoc: null,
  openDocument: () => {},
  closeDocument: () => {},
})

export const useChatUI = () => useContext(ChatUIContext)
