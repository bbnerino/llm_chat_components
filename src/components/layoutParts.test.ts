import { describe, expect, it } from 'vitest'
import type { Part } from '../runtime/types'
import type { Placement, ToolUI } from '../tools/registry'
import { layoutParts } from './layoutParts'

const placements: Record<string, Placement> = { search: 'step', weather: 'pinned', followups: 'footer', clock: 'hidden' }
const resolve = (name: string) => ({ placement: placements[name] ?? 'step', icon: '', label: () => name }) as ToolUI
const tool = (callId: string, name: string): Part => ({ type: 'tool', callId, name, argsText: '', state: 'output-available' })
const text = (id: string, t: string): Part => ({ type: 'text', id, text: t })

describe('layoutParts', () => {
  it('groups consecutive step tools, keeps pinned inline, moves footer to the end, hides hidden', () => {
    const { segments, footer } = layoutParts(
      [text('t1', '찾아볼게요'), tool('c1', 'search'), tool('c2', 'clock'), tool('c3', 'search'), tool('w', 'weather'), text('t2', '결과'), tool('f', 'followups')],
      resolve,
    )
    expect(segments.map((s) => [s.kind, s.key])).toEqual([
      ['text', 't1'],
      ['steps', 'c1'],
      ['pinned', 'w'],
      ['text', 't2'],
    ])
    expect(segments[1].kind === 'steps' && segments[1].parts.map((p) => p.callId)).toEqual(['c1', 'c3'])
    expect(footer.map((p) => p.callId)).toEqual(['f'])
  })

  it('uses stable keys so a growing group is not remounted', () => {
    const a = layoutParts([tool('c1', 'search')], resolve).segments[0].key
    const b = layoutParts([tool('c1', 'search'), tool('c2', 'search')], resolve).segments[0].key
    expect(a).toBe(b)
  })
})
