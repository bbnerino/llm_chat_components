import { describe, expect, it } from 'vitest'
import { toResponsesInput } from './openai.ts'

/**
 * "중지 한 번에 대화가 벽돌이 되는" 문제의 회귀 테스트.
 * 실제 API에 짝 없는 function_call을 보내면 `400 No tool output found for function call`이 난다(직접 확인).
 */
describe('toResponsesInput (history sanitization)', () => {
  it('pairs every function_call with an output', () => {
    const items = toResponsesInput([
      { role: 'user', content: '서울 날씨' },
      {
        role: 'assistant',
        parts: [
          { type: 'tool', callId: 'ok', name: 'get_weather', args: { city: 'Seoul' }, state: 'output-available', output: { t: 20 } },
          { type: 'tool', callId: 'failed', name: 'get_weather', args: { city: 'X' }, state: 'output-error', error: 'city_not_found' },
          { type: 'tool', callId: 'stopped', name: 'get_weather', args: { city: 'Busan' }, state: 'cancelled' },
        ],
      },
    ])
    const calls = items.filter((i) => 'type' in i && i.type === 'function_call').map((i) => (i as { call_id: string }).call_id)
    const outputs = items.filter((i) => 'type' in i && i.type === 'function_call_output').map((i) => (i as { call_id: string }).call_id)
    expect(calls).toEqual(['ok', 'failed', 'stopped'])
    expect(outputs).toEqual(calls)
    expect(JSON.stringify(items.at(-1))).toContain('cancelled_by_user')
  })

  it('drops tool calls whose arguments never finished streaming', () => {
    const items = toResponsesInput([
      { role: 'user', content: '문서 써줘' },
      { role: 'assistant', parts: [{ type: 'text', text: '작성할게요' }, { type: 'tool', callId: 'c', name: 'create_document', state: 'input-streaming' }] },
    ])
    expect(items).toEqual([
      { role: 'user', content: '문서 써줘' },
      { role: 'assistant', content: '작성할게요' },
    ])
  })

  it('skips empty assistant text', () => {
    expect(toResponsesInput([{ role: 'assistant', parts: [{ type: 'text', text: '  ' }] }])).toEqual([])
  })
})
