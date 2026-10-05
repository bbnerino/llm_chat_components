import { describe, expect, it } from 'vitest'
import { readSSE, SSEIdleTimeoutError, SSEParser } from './parseSSE'

describe('SSEParser', () => {
  it('parses a basic event', () => {
    const p = new SSEParser()
    expect(p.feed('event: ping\ndata: hello\n\n')).toEqual([{ event: 'ping', data: 'hello', id: undefined, retry: undefined }])
  })

  it('handles events split at arbitrary chunk boundaries', () => {
    const raw = 'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y":2}\n\n'
    // 모든 위치에서 두 조각으로 잘라도 결과가 같아야 한다.
    for (let i = 1; i < raw.length; i++) {
      const p = new SSEParser()
      const out = [...p.feed(raw.slice(0, i)), ...p.feed(raw.slice(i))]
      expect(out.map((m) => [m.event, m.data])).toEqual([
        ['a', '{"x":1}'],
        ['b', '{"y":2}'],
      ])
    }
  })

  it('supports CRLF, including CR and LF arriving in different chunks', () => {
    const p = new SSEParser()
    const out = [...p.feed('data: a\r'), ...p.feed('\n\r'), ...p.feed('\n')]
    expect(out).toHaveLength(1)
    expect(out[0].data).toBe('a')
  })

  it('joins multi-line data with \\n and ignores comments', () => {
    const p = new SSEParser()
    const out = p.feed(': heartbeat\ndata: line1\ndata: line2\n\n')
    expect(out[0].data).toBe('line1\nline2')
  })

  it('does not dispatch events without data and drops trailing incomplete event on flush', () => {
    const p = new SSEParser()
    expect(p.feed('event: empty\n\n')).toEqual([])
    expect(p.feed('data: incomplete')).toEqual([])
    p.flush()
    expect(p.feed('\n\n')).toEqual([])
  })

  it('tracks id and strips leading BOM', () => {
    const p = new SSEParser()
    const out = p.feed('﻿id: r1:3\ndata: x\n\n')
    expect(out[0].id).toBe('r1:3')
  })
})

describe('readSSE', () => {
  it('decodes multibyte characters split across byte chunks', async () => {
    const bytes = new TextEncoder().encode('data: 안녕하세요\n\n')
    // "안"(3바이트) 중간에서 자른다.
    const chunks = [bytes.slice(0, 7), bytes.slice(7)]
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        chunks.forEach((ch) => c.enqueue(ch))
        c.close()
      },
    })
    const out = []
    for await (const m of readSSE(body)) out.push(m.data)
    expect(out).toEqual(['안녕하세요'])
  })
})

describe('readSSE idle watchdog', () => {
  it('throws when the stream goes silent (e.g. proxy never forwards the close)', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: first\n\n'))
        // 이후 아무것도 보내지 않고 닫지도 않는다.
      },
    })
    const got: string[] = []
    await expect(
      (async () => {
        for await (const m of readSSE(body, { idleTimeoutMs: 30 })) got.push(m.data)
      })(),
    ).rejects.toBeInstanceOf(SSEIdleTimeoutError)
    expect(got).toEqual(['first'])
  })

  it('heartbeat comments keep the stream alive', async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 15))
          c.enqueue(enc.encode(': ping\n\n'))
        }
        c.enqueue(enc.encode('data: done\n\n'))
        c.close()
      },
    })
    const got: string[] = []
    for await (const m of readSSE(body, { idleTimeoutMs: 40 })) got.push(m.data)
    expect(got).toEqual(['done'])
  })
})
