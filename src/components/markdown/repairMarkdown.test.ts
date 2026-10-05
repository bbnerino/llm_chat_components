import { describe, expect, it } from 'vitest'
import { repairMarkdownTail } from './repairMarkdown'

describe('repairMarkdownTail', () => {
  it('closes an open code fence', () => {
    expect(repairMarkdownTail('```ts\nconst a = 1')).toBe('```ts\nconst a = 1\n```')
  })

  it('does not touch content inside an open fence', () => {
    expect(repairMarkdownTail('```\nconst s = "**"')).toBe('```\nconst s = "**"\n```')
  })

  it('hides dangling emphasis markers', () => {
    expect(repairMarkdownTail('이건 정말 **')).toBe('이건 정말 ')
    expect(repairMarkdownTail('코드 `')).toBe('코드 ')
  })

  it('closes unbalanced bold that already has content', () => {
    expect(repairMarkdownTail('이건 **중요')).toBe('이건 **중요**')
  })

  it('hides incomplete links instead of flashing raw syntax', () => {
    expect(repairMarkdownTail('참고: [위키')).toBe('참고: ')
    expect(repairMarkdownTail('참고: [위키](https://ko.wiki')).toBe('참고: ')
    expect(repairMarkdownTail('참고: [위키](https://ko.wikipedia.org)')).toBe('참고: [위키](https://ko.wikipedia.org)')
  })

  it('hides a table until its separator row arrives', () => {
    expect(repairMarkdownTail('| 도시 | 기온 |')).toBe('')
    expect(repairMarkdownTail('| 도시 | 기온 |\n|---|---|\n| 서울 | 2')).toContain('| 서울 | 2')
  })
})
