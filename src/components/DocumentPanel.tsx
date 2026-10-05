import { useToolPart } from '../runtime/react'
import { isRunning, useToolArgs } from '../tools/registry'
import { DocumentBody, toolRegistry } from '../tools/views'
import { useChatUI, type DocRef } from './ChatUIContext'

/**
 * 문서 패널. create_document의 인자(문서 본문)가 스트리밍되는 동안 부분 JSON을 파싱해 실시간으로 그린다.
 * 패널은 tool part 하나만 구독하므로, 같은 대화의 다른 메시지가 바뀌어도 리렌더되지 않는다.
 */
export function DocumentPanel({ doc }: { doc: DocRef }) {
  const { closeDocument } = useChatUI()
  const part = useToolPart(doc.threadId, doc.messageId, doc.callId)
  const args = useToolArgs<{ title: string; content: string }>(part ?? EMPTY_PART, toolRegistry.create_document)

  if (!part) {
    return (
      <div className="doc-panel">
        <div className="panel-head">
          <span>문서를 찾을 수 없습니다</span>
          <button onClick={closeDocument}>닫기</button>
        </div>
      </div>
    )
  }

  return (
    <div className="doc-panel">
      <div className="panel-head">
        <span className="panel-status">{isRunning(part) ? <><span className="spinner" /> 작성 중</> : part.state === 'cancelled' ? '작성 중단됨' : '완료'}</span>
        <div>
          <button onClick={closeDocument} aria-label="문서 닫기">닫기</button>
        </div>
      </div>
      <DocumentBody part={part} args={args} />
    </div>
  )
}

const EMPTY_PART = { type: 'tool', callId: '', name: '', argsText: '', state: 'cancelled' } as const
