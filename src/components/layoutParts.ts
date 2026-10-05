import type { Part, TextPart, ToolPart } from '../runtime/types'
import type { ToolUI } from '../tools/registry'

export type Segment =
  | { kind: 'text'; key: string; part: TextPart }
  | { kind: 'steps'; key: string; parts: ToolPart[] }
  | { kind: 'pinned'; key: string; part: ToolPart }

/**
 * parts(서버가 보낸 순서) → 화면 구조
 *
 *  - 연속된 step tool은 하나의 "작업 N개" 묶음으로 접는다. (과정은 접고, 결과는 펼친다)
 *  - pinned tool은 순서 그대로 본문 흐름에 카드로 둔다. 접힌 묶음 안에 결과물이 숨지 않게.
 *  - footer tool은 응답 맨 아래로 모은다.
 *  - hidden tool은 버린다.
 *
 * key는 첫 part의 id/callId로 고정한다. 인덱스를 key로 쓰면 앞에 무언가 끼어들 때
 * 묶음이 다시 마운트되면서 사용자가 펼쳐둔 상태가 사라진다. (이전 프로젝트의 `subgroup-${idx}`)
 */
export function layoutParts(parts: Part[], resolve: (name: string) => ToolUI): { segments: Segment[]; footer: ToolPart[] } {
  const segments: Segment[] = []
  const footer: ToolPart[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) segments.push({ kind: 'text', key: part.id, part })
      continue
    }
    const placement = resolve(part.name).placement
    if (placement === 'hidden') continue
    if (placement === 'footer') {
      footer.push(part)
      continue
    }
    if (placement === 'pinned') {
      segments.push({ kind: 'pinned', key: part.callId, part })
      continue
    }
    const last = segments.at(-1)
    if (last?.kind === 'steps') last.parts.push(part)
    else segments.push({ kind: 'steps', key: part.callId, parts: [part] })
  }
  return { segments, footer }
}
