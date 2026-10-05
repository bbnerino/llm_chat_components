import { describe, expect, it } from 'vitest'
import { parsePartialJson } from './partialJson'

describe('parsePartialJson', () => {
  it('parses complete JSON as-is', () => {
    expect(parsePartialJson('{"a":1,"b":[1,2]}')).toEqual({ a: 1, b: [1, 2] })
  })

  it('closes an open string value', () => {
    expect(parsePartialJson('{"title":"서울 여행 계')).toEqual({ title: '서울 여행 계' })
  })

  it('drops a dangling key without value', () => {
    expect(parsePartialJson('{"a":"x","b"')).toEqual({ a: 'x' })
    expect(parsePartialJson('{"a":"x","b":')).toEqual({ a: 'x' })
    expect(parsePartialJson('{"a":"x",')).toEqual({ a: 'x' })
  })

  it('does not emit incomplete literals (they could still change)', () => {
    expect(parsePartialJson('{"n":12')).toEqual({})
    expect(parsePartialJson('{"ok":tru')).toEqual({})
    expect(parsePartialJson('{"n":12,')).toEqual({ n: 12 })
  })

  it('closes nested arrays and objects', () => {
    expect(parsePartialJson('{"items":[{"q":"a"},{"q":"b')).toEqual({ items: [{ q: 'a' }, { q: 'b' }] })
  })

  it('never cuts inside an escape sequence', () => {
    expect(parsePartialJson('{"body":"line1\\')).toEqual({ body: 'line1' })
    expect(parsePartialJson('{"body":"line1\\nline2')).toEqual({ body: 'line1\nline2' })
  })

  it('every prefix of a valid JSON yields a value consistent with the final one', () => {
    const full = '{"title":"계획","sections":[{"h":"1일차","items":["경복궁","북촌"]},{"h":"2일차"}],"done":true}'
    for (let i = 1; i <= full.length; i++) {
      const v = parsePartialJson<Record<string, unknown>>(full.slice(0, i))
      // 파싱에 실패하는 접두가 있어도 되지만, 예외를 던지면 안 된다
      if (v && typeof v.title === 'string') expect('계획'.startsWith(v.title)).toBe(true)
    }
    expect(parsePartialJson(full)).toEqual(JSON.parse(full))
  })

  it('returns undefined for empty input', () => {
    expect(parsePartialJson('')).toBeUndefined()
  })
})
