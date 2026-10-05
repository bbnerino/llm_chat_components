# SSE, 직접 파싱해보니 간단하지 않았다

> 4번째 글 후보 (짧은 글). 채팅에 EventSource를 못 쓰는 이유와, fetch로 SSE를 직접 파싱할 때 밟는 것들.
> 코드는 `src/lib/sse/parseSSE.ts`, 테스트는 `parseSSE.test.ts`.

---

스트리밍 채팅을 만들면서 SSE를 직접 파싱하게 됐어요. "그냥 `data:` 줄 자르면 되는 거 아냐?" 했는데 아니었어요. 짧게 정리해요.

## EventSource를 못 쓰는 이유

SSE 하면 `new EventSource(url)`이죠. 재연결도 알아서 하고 `Last-Event-ID`도 알아서 보내줘요. 근데 채팅엔 못 써요. **GET만 되고 바디를 못 실어요.** 대화 이력을 서버에 보내야 하는데 그걸 쿼리스트링에 넣을 순 없잖아요.

그래서 `fetch` + `ReadableStream`으로 바디를 직접 읽고 SSE를 직접 파싱해야 해요. 여기서부터 "SSE 별거 없네"가 깨지기 시작해요.

### 청크는 이벤트 경계를 모른다

네트워크 청크가 `data: {...}\n\n` 단위로 예쁘게 오지 않아요. TCP는 그냥 바이트 흐름이라, 이벤트 하나가 두 청크에 걸치거나 한 청크에 세 개가 들어있는 게 보통이에요.

```
청크 1: 'event: text.delta\ndata: {"delta":"안'
청크 2: '녕"}\n\nevent: text.delta\nda'
청크 3: 'ta: {"delta":"하세요"}\n\n'
```

파서가 마지막 미완성 줄을 들고 있다가 다음 청크랑 이어 붙여야 해요. 이게 맞게 됐는지 확인하려고 쓴 테스트가 이거예요. 정상 스트림 하나를 **가능한 모든 위치**에서 둘로 잘라 넣어도 결과가 같은지.

```ts
// src/lib/sse/parseSSE.test.ts
it('handles events split at arbitrary chunk boundaries', () => {
  const raw = 'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y":2}\n\n'
  for (let i = 1; i < raw.length; i++) {
    const p = new SSEParser()
    const out = [...p.feed(raw.slice(0, i)), ...p.feed(raw.slice(i))]
    expect(out.map((m) => [m.event, m.data])).toEqual([['a', '{"x":1}'], ['b', '{"y":2}']])
  }
})
```

케이스 몇 개 골라서 넣는 게 아니라 경계를 전부 도니까, 이게 통과하고 나서야 마음이 놓였어요.

### 한글은 3바이트

바이트를 문자열로 바꿀 때 `new TextDecoder().decode(chunk)`를 그냥 쓰면, "안"(UTF-8로 3바이트)의 두 번째 바이트에서 청크가 잘렸을 때 `�`가 찍혀요. 영어로만 테스트하면 평생 못 잡아요.

```ts
const decoder = new TextDecoder()
// { stream: true }: 미완성 바이트를 디코더가 들고 있다가 다음 청크와 합친다
for (const msg of parser.feed(decoder.decode(value, { stream: true }))) yield msg
```

이것도 "안" 중간에서 바이트를 자르는 테스트로 박아뒀어요.

### CRLF가 두 청크에 걸치면

스펙상 줄 끝은 `\n`, `\r\n`, `\r` 셋 다 돼요. 그럼 `\r`로 끝나는 청크가 왔을 때, 이게 줄 끝인지 다음 청크의 `\n`이랑 합쳐질 CRLF 반쪽인지 알 수가 없어요. 버퍼 끝의 `\r`을 보류하고 다음 청크를 기다려야 해요. WHATWG 스펙 읽기 전엔 생각도 못 했던 거예요.

### 파서는 서버랑 같이 씀

BFF도 OpenAI한테서 SSE를 읽고 다시 SSE로 써요. 같은 거 두 번 짜기 싫어서 `parseSSE.ts` 하나를 Node랑 브라우저에서 같이 import해요. 양쪽 다 Web Streams 표준만 써서 가능했어요.

이 파서에는 idle watchdog도 들어 있어요. 일정 시간 바이트가 하나도 안 오면 끊긴 걸로 보는 건데, "연결이 소리 없이 죽는" 장애를 겪고 넣었어요. 그 얘기는 에러 처리 글에서 따로 해요.

---
