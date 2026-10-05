import { memo, useState } from 'react'
import { countRender } from '../lib/renderCounter'
import type { ToolPart } from '../runtime/types'
import { fallbackTool, isRunning, useToolArgs, type ToolUI } from '../tools/registry'
import { toolRegistry } from '../tools/views'

export const resolveTool = (name: string): ToolUI => toolRegistry[name] ?? fallbackTool

function StateIcon({ part }: { part: ToolPart }) {
  if (isRunning(part)) return <span className="spinner" aria-label="실행 중" />
  if (part.state === 'output-error') return <span className="state-icon err" aria-label="실패">!</span>
  if (part.state === 'cancelled') return <span className="state-icon muted" aria-label="취소됨">–</span>
  return <span className="state-icon ok" aria-label="완료">✓</span>
}

interface SlotProps {
  part: ToolPart
  threadId: string
  messageId: string
}

/** pinned / footer tool: 레지스트리의 View를 그대로 그린다 */
export const ToolSlot = memo(function ToolSlot({ part, threadId, messageId }: SlotProps) {
  countRender('ToolSlot')
  const ui = resolveTool(part.name)
  const args = useToolArgs(part, ui)
  const output = ui.isOutput ? (ui.isOutput(part.output) ? part.output : undefined) : part.output
  if (!ui.View) return null
  return <ui.View part={part} args={args} output={output} threadId={threadId} messageId={messageId} />
})

const StepRow = memo(function StepRow({ part, threadId, messageId }: SlotProps) {
  countRender('StepRow')
  const ui = resolveTool(part.name)
  const args = useToolArgs(part, ui)
  const [expanded, setExpanded] = useState(false)
  const output = ui.isOutput ? (ui.isOutput(part.output) ? part.output : undefined) : part.output
  const expandable = !!ui.View && part.state === 'output-available'
  return (
    <li className={`step step-${part.state}`}>
      <button className="step-head" onClick={() => expandable && setExpanded((v) => !v)} aria-expanded={expandable ? expanded : undefined} disabled={!expandable}>
        <StateIcon part={part} />
        <span className="step-icon">{ui.icon}</span>
        <span className="step-label">{ui.label(args, part)}</span>
        {expandable && <span className="chev">{expanded ? '▴' : '▾'}</span>}
      </button>
      {part.state === 'output-error' && <p className="step-error">{part.error?.message}</p>}
      {expanded && ui.View && (
        <div className="step-body">
          <ui.View part={part} args={args} output={output} threadId={threadId} messageId={messageId} />
        </div>
      )}
    </li>
  )
})

/**
 * 연속된 step tool 묶음. 실행 중에는 자동으로 펼치고, 끝나면 자동으로 접는다.
 * 사용자가 한 번이라도 직접 열고 닫으면 그 선택을 존중한다(null = 자동).
 */
export const ToolSteps = memo(function ToolSteps({ parts, threadId, messageId }: { parts: ToolPart[]; threadId: string; messageId: string }) {
  countRender('ToolSteps')
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const running = parts.filter(isRunning).length
  const failed = parts.filter((p) => p.state === 'output-error').length
  const open = userOpen ?? running > 0

  return (
    <div className="steps">
      <button className="steps-head" onClick={() => setUserOpen(!open)} aria-expanded={open}>
        {running > 0 ? <span className="spinner" /> : <span className="state-icon ok">✓</span>}
        <span>
          작업 {parts.length}개 {running > 0 ? '진행 중' : '완료'}
          {failed > 0 && <em className="steps-failed"> · 실패 {failed}</em>}
        </span>
        <span className="chev">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <ul className="steps-list">
          {parts.map((p) => (
            <StepRow key={p.callId} part={p} threadId={threadId} messageId={messageId} />
          ))}
        </ul>
      )}
    </div>
  )
})
