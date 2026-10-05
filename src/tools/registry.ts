import { useMemo, type ComponentType } from 'react'
import { parsePartialJson } from '../lib/partialJson'
import type { ToolPart } from '../runtime/types'

/**
 * Tool → UI 레지스트리
 *
 * 이전 프로젝트는 tool 렌더링을 if 체인과 여러 개의 이름 배열(IGNORE_TOOLS, SEARCH_TOOLS,
 * FILE_WRITE_TOOLS…)로 분기했고, tool 상태는 "그룹의 마지막 메시지인가(isNew)"로 추정했다.
 * 그 결과 병렬 호출 시 마지막 하나만 스피너가 돌았고, 실패해도 성공 체크가 떴다.
 *
 * 여기서는
 *  - tool 하나 = 레지스트리 항목 하나. 표시 방식(placement), 라벨, 컴포넌트를 한 곳에 선언한다.
 *  - 상태는 추정하지 않는다. 서버가 callId 단위로 보내는 상태(ToolPart.state)를 그대로 쓴다.
 *  - 새 tool을 추가해도 렌더링 코드는 바뀌지 않는다. 모르는 tool은 fallback으로 그린다.
 */

export type Placement =
  /** "작업 N개" 접이식 목록 안의 한 줄 (검색처럼 과정에 가까운 것) */
  | 'step'
  /** 본문 흐름 안에 카드로 고정 (날씨, 문서처럼 결과물 자체인 것) */
  | 'pinned'
  /** 응답이 끝난 뒤 맨 아래 (후속 질문 칩) */
  | 'footer'
  /** 그리지 않음 (현재 시각 조회 같은 내부 도구) */
  | 'hidden'

export interface ToolViewProps<A = unknown, O = unknown> {
  part: ToolPart
  /** 확정된 인자, 또는 스트리밍 중이면 지금까지 받은 만큼의 부분 인자 */
  args: Partial<A> | undefined
  output: O | undefined
  threadId: string
  messageId: string
}

export interface ToolUI<A = any, O = any> {
  placement: Placement
  icon: string
  /** 상태별 라벨. 스트리밍 중에도 부분 인자로 구체적인 문구를 만든다 ("검색 중 · 해운대") */
  label: (args: Partial<A> | undefined, part: ToolPart) => string
  /** 인자가 스트리밍되는 동안 부분 파싱할지. 문서 작성처럼 인자 자체가 콘텐츠인 tool만 켠다. */
  streamArgs?: boolean
  /** 확장 영역(step) 또는 카드(pinned/footer) */
  View?: ComponentType<ToolViewProps<A, O>>
  /** 결과 shape 검증. 서버가 보낸 output은 unknown이므로 경계에서 확인한다. */
  isOutput?: (v: unknown) => v is O
}

export function defineTool<A, O>(ui: ToolUI<A, O>): ToolUI<A, O> {
  return ui
}

const humanize = (name: string) => name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export const fallbackTool: ToolUI = {
  placement: 'step',
  icon: '🔧',
  label: (_a, part) => humanize(part.name),
}

/**
 * 인자는 "화면이 필요로 할 때만" 파싱한다.
 * 모든 delta마다 모든 tool의 인자를 다시 파싱하면 그 자체가 O(n²)이 된다.
 */
export function useToolArgs<A>(part: ToolPart, ui: ToolUI<A>): Partial<A> | undefined {
  return useMemo(() => {
    if (part.args !== undefined) return part.args as Partial<A>
    if (!ui.streamArgs || !part.argsText) return undefined
    return parsePartialJson<Partial<A>>(part.argsText)
  }, [part.args, part.argsText, ui.streamArgs])
}

export function isRunning(part: ToolPart) {
  return part.state === 'input-streaming' || part.state === 'input-available'
}
