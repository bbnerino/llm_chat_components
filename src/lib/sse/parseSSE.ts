/**
 * WHATWG SSE 스펙(https://html.spec.whatwg.org/multipage/server-sent-events.html)을
 * 따르는 증분(incremental) 파서.
 *
 * EventSource는 GET만 지원하고 헤더/바디를 실을 수 없어서, 채팅처럼 POST로
 * 대화 이력을 보내야 하는 경우엔 fetch + ReadableStream으로 직접 파싱해야 한다.
 *
 * 네트워크 청크는 이벤트 경계와 무관하게 잘려서 온다:
 *   "data: {\"a\":" | "1}\n\nda" | "ta: ..."
 * 그래서 마지막 미완성 줄은 버퍼에 남겨두고 다음 청크와 이어 붙인다.
 * 서버(OpenAI 업스트림 파싱)와 클라이언트(BFF 스트림 파싱)가 같은 파서를 공유한다.
 */

export interface SSEMessage {
  event: string
  data: string
  id?: string
  retry?: number
}

export class SSEParser {
  private buffer = ''
  private dataLines: string[] = []
  private eventType = ''
  private lastEventId: string | undefined
  private retry: number | undefined
  private isFirstChunk = true

  /** 청크를 넣으면 이번 청크로 완성된 이벤트들을 돌려준다. */
  feed(chunk: string): SSEMessage[] {
    if (this.isFirstChunk) {
      // 스트림 맨 앞의 BOM은 무시한다.
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1)
      this.isFirstChunk = false
    }
    this.buffer += chunk

    const out: SSEMessage[] = []
    // 줄 끝은 CRLF, LF, CR 세 가지 모두 허용된다.
    const lineRe = /\r\n|\r|\n/g
    let start = 0
    let match: RegExpExecArray | null
    while ((match = lineRe.exec(this.buffer))) {
      // 버퍼가 '\r'로 끝나면 다음 청크의 '\n'과 합쳐 CRLF일 수 있으니 보류한다.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break
      const line = this.buffer.slice(start, match.index)
      start = match.index + match[0].length
      const msg = this.processLine(line)
      if (msg) out.push(msg)
    }
    this.buffer = this.buffer.slice(start)
    return out
  }

  /** 스트림이 끝났을 때 호출. 스펙상 빈 줄로 끝나지 않은 마지막 이벤트는 버린다. */
  flush(): void {
    this.buffer = ''
    this.dataLines = []
    this.eventType = ''
  }

  private processLine(line: string): SSEMessage | null {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return null // 주석 (heartbeat 용도)

    const colon = line.indexOf(':')
    let field: string
    let value: string
    if (colon === -1) {
      field = line
      value = ''
    } else {
      field = line.slice(0, colon)
      value = line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
    }

    switch (field) {
      case 'event':
        this.eventType = value
        break
      case 'data':
        this.dataLines.push(value)
        break
      case 'id':
        if (!value.includes('\0')) this.lastEventId = value
        break
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value)
        break
    }
    return null
  }

  private dispatch(): SSEMessage | null {
    if (this.dataLines.length === 0) {
      this.eventType = ''
      return null
    }
    const msg: SSEMessage = {
      event: this.eventType || 'message',
      data: this.dataLines.join('\n'),
      id: this.lastEventId,
      retry: this.retry,
    }
    this.dataLines = []
    this.eventType = ''
    return msg
  }
}

export class SSEIdleTimeoutError extends Error {
  constructor(ms: number) {
    super(`No data received for ${ms}ms`)
    this.name = 'SSEIdleTimeoutError'
  }
}

export interface ReadSSEOptions {
  signal?: AbortSignal
  /**
   * 이 시간 동안 바이트가 하나도 오지 않으면(heartbeat 주석 포함) 연결이 죽었다고 판단한다.
   * 중간 프록시가 업스트림 끊김을 브라우저에 전달하지 않으면, 클라이언트는 영원히
   * "스트리밍 중"으로 멈춰 있게 된다. heartbeat는 서버가 보내고, 감시는 클라이언트가 해야 완성된다.
   */
  idleTimeoutMs?: number
}

/** ReadableStream<Uint8Array> → SSEMessage 비동기 이터레이터 */
export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  { signal, idleTimeoutMs }: ReadSSEOptions = {},
): AsyncGenerator<SSEMessage> {
  const parser = new SSEParser()
  // 한글은 UTF-8로 3바이트라 청크 경계에서 잘릴 수 있다.
  // { stream: true }면 디코더가 미완성 바이트를 들고 있다가 다음 청크와 합쳐준다. (없으면 '�' 깨짐)
  const decoder = new TextDecoder()
  const reader = body.getReader()
  const onAbort = () => reader.cancel().catch(() => {})
  signal?.addEventListener('abort', onAbort, { once: true })

  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    while (true) {
      // 네트워크를 기다리는 동안에만 타이머를 건다. (소비자가 이벤트를 처리하는 시간은 제외)
      if (idleTimeoutMs) {
        idleTimer = setTimeout(() => {
          timedOut = true
          reader.cancel().catch(() => {})
        }, idleTimeoutMs)
      }
      const { value, done } = await reader.read()
      clearTimeout(idleTimer)
      if (timedOut) throw new SSEIdleTimeoutError(idleTimeoutMs!)
      if (done) break
      for (const msg of parser.feed(decoder.decode(value, { stream: true }))) yield msg
    }
  } finally {
    clearTimeout(idleTimer)
    signal?.removeEventListener('abort', onAbort)
    parser.flush()
    reader.releaseLock()
  }
}
