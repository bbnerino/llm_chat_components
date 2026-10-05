# AI 응답은 "데이터"가 아니라 "이벤트 스트림"이다 — 스트리밍 채팅 런타임을 바닥부터 만들며 배운 것

> 초안 v1. 코드는 전부 이 저장소(`src/runtime`, `src/lib/sse`, `server`)에서 발췌했고, 스크린샷 자리는 `[스크린샷: ...]`로 표시했습니다.

## 들어가며

프론트엔드에서 다루는 데이터는 대부분 "요청하면 한 번에 돌아오는 것"이었습니다. `fetch`를 하고, `await`를 하고, 돌아온 JSON을 상태에 넣으면 끝이었습니다. TanStack Query 같은 도구는 이 모델 위에서 캐시와 재검증을 멋지게 해결해줍니다.

그런데 LLM의 응답은 이 모델에 맞지 않습니다. 응답은 수십 초에 걸쳐 수백 개의 조각으로 도착하고, 도착하는 도중에 사용자가 중지할 수 있고, 중지한 뒤 다시 생성할 수 있고, 그 사이에 이전 요청의 조각이 늦게 도착할 수도 있습니다. "데이터를 받아서 보여준다"가 아니라 **"끝을 알 수 없는 이벤트의 흐름을 사용자가 믿을 수 있는 상태로 바꾼다"**가 문제의 정의가 됩니다.

이 글은 OpenAI Responses API를 SSE로 받아 React 화면에 그리는 채팅 런타임을 라이브러리 없이 직접 만들면서, 이 문제를 어떻게 쪼갰고 어디서 틀렸는지를 정리한 기록입니다. 다루는 내용은 다음과 같습니다:

- **전송 계층**: 왜 `EventSource`를 버리고 SSE 파서를 직접 썼는가
- **상태 계층**: 늦게 도착한 이벤트로부터 UI를 지키는 두 개의 숫자(runId, seq)
- **복구 정책**: 재시도해도 되는 순간과 절대 안 되는 순간을 가르는 기준
- **실제로 겪은 장애**: heartbeat를 보내고 있었는데도 화면이 영원히 멈춘 이유
- **렌더링**: 초당 수십 번 들어오는 토큰을 React가 버티게 하는 방법

Vercel AI SDK나 OpenAI ChatKit을 쓰면 이 중 상당수는 공짜로 얻습니다. 그럼에도 직접 만든 이유는 하나입니다. 이 추상화들이 **무엇을 대신 결정해주고 있는지** 모르면, 추상화가 깨지는 순간(그리고 프로덕션에서는 반드시 깨집니다) 손을 댈 수가 없기 때문입니다.

---

## 1. 전체 구조: 세 개의 경계

구현에 들어가기 전에 전체 그림을 먼저 그렸습니다. 핵심은 "어디에 경계를 긋는가"였습니다.

```
Browser                                         BFF                              OpenAI
┌──────────────────────────────────────┐       ┌─────────────────────────┐      ┌──────────┐
│ Components                           │       │ API 키 보관               │      │ Responses│
│   ▲ state            │ actions       │       │ 업스트림 SSE 파싱          │◀────▶│ API      │
│ useChatRuntime                       │ POST  │ 도메인 이벤트로 정규화      │ SSE  │ (stream) │
│   AbortController · retry · 배칭      │──────▶│ runId + seq 부여          │      └──────────┘
│ chatReducer (순수 함수)               │◀──────│ heartbeat · 끊김 시 abort  │
│ ChatTransport (어댑터)               │  SSE  └─────────────────────────┘
│ SSEParser ← 서버와 같은 코드          │
└──────────────────────────────────────┘
```

경계는 세 군데입니다.

**① 브라우저와 OpenAI 사이에 BFF를 둔다.** API 키를 숨기기 위한 것만은 아닙니다. 더 중요한 이유는 **벤더 이벤트를 우리 도메인 이벤트로 번역하는 지점**이 필요했기 때문입니다. OpenAI Responses API는 `response.created`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta` … 열 가지가 넘는 이벤트를 보냅니다. 이걸 UI까지 그대로 흘려보내면 UI 코드가 OpenAI의 스키마에 종속됩니다. BFF는 이것을 네 가지로 압축합니다.

```ts
// src/runtime/protocol.ts
export type ServerEvent =
  | { type: 'run.started';       runId: string; seq: number; model: string }
  | { type: 'message.delta';     runId: string; seq: number; delta: string }
  | { type: 'message.completed'; runId: string; seq: number; usage?: {...} }
  | { type: 'run.failed';        runId: string; seq: number; code: string; message: string; retryable: boolean }
```

UI는 이 네 가지만 압니다. 내일 모델을 Claude로 바꾸더라도 BFF의 `switch`문 하나만 수정하면 됩니다. 그리고 모든 이벤트에 `runId`와 `seq`가 붙어 있는데, 이 두 숫자가 이 글의 주인공입니다. 뒤에서 자세히 다룹니다.

**② 런타임과 전송 방식 사이에 어댑터를 둔다.** 훅과 리듀서는 "`ServerEvent`의 비동기 스트림"만 알고, 그것이 SSE인지 WebSocket인지 테스트용 가짜 스트림인지 모릅니다.

```ts
// src/runtime/transport.ts
export interface ChatTransport {
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ServerEvent>
}
```

인터페이스가 이렇게 작은 것이 의도입니다. `AsyncIterable`과 `AbortSignal`, 두 개의 표준 프리미티브만 쓰기 때문에 테스트에서는 `async function*`으로 이벤트를 흘려주면 그만입니다. 여러 화면이나 제품이 같은 런타임을 공유하면서 전송 계층만 갈아끼울 수 있는 지점이기도 합니다.

**③ 상태 변경은 순수 함수 하나에 가둔다.** 비동기 코드(fetch, 재시도, 타이머)는 전부 훅에 있고, 상태를 바꾸는 코드는 전부 리듀서에 있습니다. 훅은 "무슨 일이 일어났는지"를 액션으로 알리기만 하고, 그 일이 상태에 어떤 의미인지는 리듀서가 결정합니다. 이 분리 덕분에 가장 까다로운 시나리오들을 네트워크 없이 테스트할 수 있었습니다.

---

## 2. 전송 계층: EventSource를 버린 이유

SSE라고 하면 보통 `new EventSource(url)`을 떠올립니다. 자동 재연결도 해주고 `Last-Event-ID`도 알아서 보내줍니다. 그런데 채팅에는 쓸 수 없습니다. **`EventSource`는 GET만 지원하고 요청 바디를 실을 수 없습니다.** 대화 이력을 서버에 보내야 하는데, 이걸 쿼리스트링에 넣을 수는 없습니다.

그래서 `fetch` + `ReadableStream`으로 바디를 직접 읽고 SSE를 직접 파싱해야 합니다. 여기서부터 "SSE는 간단한 텍스트 프로토콜"이라는 생각이 틀렸다는 걸 알게 됩니다.

### 청크는 이벤트 경계를 모른다

네트워크 청크는 `data: {...}\n\n` 단위로 깔끔하게 오지 않습니다. TCP는 바이트 스트림이고, 이벤트 하나가 두 청크에 걸치거나 청크 하나에 이벤트 세 개가 들어있는 것이 보통입니다.

```
청크 1: 'event: message.delta\ndata: {"delta":"안'
청크 2: '녕"}\n\nevent: message.delta\nda'
청크 3: 'ta: {"delta":"하세요"}\n\n'
```

파서는 마지막 미완성 줄을 버퍼에 들고 있다가 다음 청크와 이어 붙여야 합니다. 그리고 이 로직이 맞는지 확인하는 가장 확실한 방법은, 하나의 정상 스트림을 **가능한 모든 위치에서 두 조각으로 잘라 넣어도 결과가 같은지** 보는 것입니다.

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

이 테스트를 쓰고 나서야 안심이 됐습니다. 특정 케이스를 고른 것이 아니라 경계 전체를 순회하기 때문입니다.

### 한글은 3바이트다

더 미묘한 문제가 있습니다. 바이트 청크를 문자열로 바꿀 때 `new TextDecoder().decode(chunk)`를 그냥 쓰면, "안"(UTF-8로 3바이트)의 두 번째 바이트에서 청크가 잘렸을 때 `�`가 찍힙니다. 영어로만 테스트하면 절대 못 잡는 버그입니다.

```ts
const decoder = new TextDecoder()
// { stream: true }: 미완성 바이트를 디코더가 들고 있다가 다음 청크와 합친다
for (const msg of parser.feed(decoder.decode(value, { stream: true }))) yield msg
```

이것도 "안"의 중간에서 바이트를 잘라 넣는 테스트로 고정했습니다.

### CRLF가 두 청크에 걸치면

스펙상 줄 끝은 `\n`, `\r\n`, `\r` 셋 다 허용됩니다. 그러면 `\r`로 끝나는 청크가 왔을 때, 이것이 줄 끝인지 아니면 다음 청크의 `\n`과 합쳐질 CRLF의 절반인지 알 수 없습니다. 파서는 버퍼 끝의 `\r`을 보류하고 다음 청크를 기다려야 합니다. 이런 세부사항은 WHATWG 스펙을 읽기 전에는 떠올리지도 못했습니다.

### 파서를 서버와 공유한다

이 파서를 만들고 나니 BFF에서도 똑같은 일을 해야 한다는 걸 깨달았습니다. BFF는 OpenAI의 SSE를 읽어서 다시 SSE로 씁니다. 같은 코드를 두 번 쓰지 않고 `src/lib/sse/parseSSE.ts` 하나를 Node와 브라우저 양쪽에서 import합니다. 양쪽 다 Web Streams 표준(`ReadableStream`, `TextDecoder`)만 쓰기 때문에 가능했습니다. 플랫폼 전용 API를 피한 것이 여기서 보상을 줬습니다.

---

## 3. 상태 계층: 스트리밍 UI의 버그는 전부 "늦게 도착한 이벤트"다

파서가 이벤트를 꺼내주면, 이제 그 이벤트로 상태를 바꿔야 합니다. 처음에는 단순하게 생각했습니다. `delta`가 오면 마지막 메시지에 이어 붙이면 되지 않을까.

이 단순한 생각이 어디서 깨지는지 시나리오를 적어봤습니다.

1. 사용자가 질문을 보냈다. 토큰이 들어온다.
2. 마음에 안 들어서 **중지**를 눌렀다.
3. 바로 **재생성**을 눌렀다. 새 요청이 나간다.
4. 그런데 2번에서 끊은 연결의 마지막 청크가 **지금** 도착했다.

4번의 `delta`는 "마지막 메시지에 이어 붙이기" 로직에서 보면 완벽히 정상적인 이벤트입니다. 결과는 새 답변 앞에 이전 답변의 꼬리가 섞여 들어가는 것입니다. 사용자는 영문을 모릅니다.

비슷한 시나리오가 더 있습니다.

- 네트워크 재시도 중 같은 이벤트가 두 번 도착해서 텍스트가 중복된다.
- 메시지를 삭제했는데 그 메시지의 스트림이 계속 도착해서 삭제된 메시지가 되살아난다.
- 탭이 백그라운드에 있다가 돌아왔을 때 이벤트 순서가 뒤바뀌어 처리된다.

이 모든 버그의 공통점은 **"이 이벤트가 지금의 상태에 속하는가?"를 묻지 않았다**는 것입니다.

### 두 개의 숫자: runId와 seq

해결은 모든 이벤트에 "소속"과 "순번"을 붙이는 것입니다. 생성 요청 한 번을 **run**이라 부르고, 클라이언트가 `runId`를 발급해서 요청에 실어 보냅니다. BFF는 이 run 안에서 이벤트마다 1부터 증가하는 `seq`를 붙입니다.

리듀서는 이벤트를 받을 때 두 가지만 확인합니다.

```ts
// src/runtime/reducer.ts
function applyEvent(state: ChatState, event: ServerEvent, now: number): ChatState {
  const run = state.activeRun
  // (1) run 경계: 이미 끝났거나 교체된 run의 이벤트는 버린다.
  if (!run || event.runId !== run.runId) return state
  // (2) 순서/중복: seq가 역행하거나 같으면 버린다.
  if (event.seq <= run.lastSeq) return state
  // ...
}
```

이 여섯 줄이 위의 시나리오를 전부 막습니다. 중지하면 `activeRun`이 `null`이 되므로 늦은 이벤트는 (1)에서 버려집니다. 재생성하면 새 `runId`가 생기므로 이전 run의 이벤트는 (1)에서 버려집니다. 중복 이벤트는 (2)에서 버려집니다. 메시지를 삭제할 때 그 메시지가 `activeRun`에 속해 있으면 `activeRun`을 함께 지우므로 (1)에서 버려집니다.

### 왜 클라이언트가 runId를 발급하는가

서버가 발급하는 것이 자연스러워 보이지만, 그러면 **첫 응답이 올 때까지 클라이언트는 이 요청을 식별할 수 없습니다.** 사용자가 "전송" 직후 "중지"를 누르는 경우, 서버 응답이 오기 전에 취소해야 하는데 식별자가 없으면 어느 run을 취소하는지 표현할 수 없습니다. 클라이언트가 `crypto.randomUUID()`로 만들어 보내면 요청을 보내는 순간부터 상태에 `activeRun`을 기록할 수 있습니다.

### 왜 재시도하면 seq가 리셋되는가

처음에는 재시도해도 `lastSeq`를 유지했습니다. 그러자 재시도가 영원히 아무것도 반영하지 않는 버그가 생겼습니다. 재시도는 **새 HTTP 연결**이고, BFF는 연결마다 writer를 새로 만들기 때문에 seq가 다시 1부터 시작합니다. 클라이언트의 `lastSeq`는 이전 연결 기준이라 새 연결의 이벤트가 전부 "역행"으로 보인 것입니다. 그래서 `run/retrying` 액션에서 `lastSeq`를 0으로 돌립니다.

이게 가능한 이유는 **자동 재시도를 "첫 토큰을 받기 전"으로 제한**했기 때문입니다. 토큰을 하나도 못 받았다면 이전 연결의 seq는 의미가 없습니다. 만약 토큰을 받은 뒤에도 재시도를 허용했다면 `Last-Event-ID`로 이어받기를 구현해야 하고, 그러면 BFF가 run별로 이벤트를 버퍼링해야 합니다. 이 복잡도를 지금 단계에서는 의도적으로 피했습니다. (다음 글의 주제입니다.)

### 결정론: 같은 이벤트면 같은 상태

리듀서를 순수 함수로 유지하기 위해 한 가지를 더 했습니다. 시간을 액션에 실어 보냅니다.

```ts
dispatch({ type: 'events/received', events, now: performance.now() })
```

리듀서 안에서 `Date.now()`를 부르면 같은 입력에 다른 출력이 나옵니다. TTFT(첫 토큰까지의 시간) 같은 메트릭을 상태에 기록하려면 시간이 필요한데, 그걸 바깥에서 주입하면 리듀서는 여전히 순수합니다. 그래서 이런 테스트가 가능합니다.

```ts
it('is deterministic: same events → same state', () => {
  const events = [delta('r1', 1, 'a'), delta('r1', 3, 'c'), delta('r1', 2, 'b'), completed('r1', 4)]
  const run = () => receive(submit(initialChatState, 'r1'), ...events)
  expect(run()).toEqual(run())
})
```

### 메시지 상태 머신

메시지 하나의 생애는 이렇게 정리됐습니다.

```
pending ──delta──▶ streaming ──completed──▶ done
   │                  ├──사용자 중지──▶ aborted
   └──────실패/끊김────┴──────────────▶ error (retryable 여부 포함)
```

`aborted`와 `error`를 구분한 것이 중요했습니다. 둘 다 "끝까지 못 받은 답변"이지만 의미가 다릅니다. `aborted`는 사용자가 **보고 나서 멈춘** 것이고, `error`는 **보여주다 실패한** 것입니다. 이 차이는 다음 요청의 컨텍스트를 만들 때 드러납니다.

```ts
export function toWireHistory(messages: Message[]) {
  return messages
    .filter((m) => m.role === 'user' || m.status === 'done' || (m.status === 'aborted' && m.content))
    .map((m) => ({ role: m.role, content: m.content }))
}
```

사용자가 중지한 부분 답변은 사용자가 실제로 읽은 내용이므로 모델에게도 보냅니다. 그래야 "아까 거기까지 말했잖아"가 통합니다. 반면 에러로 끊긴 부분 답변은 사용자가 신뢰하지 않는 내용이므로 컨텍스트에서 뺍니다. 이 결정은 기술적이라기보다 제품적인 것인데, 리듀서 밖의 작은 함수 하나에 격리해두어 바꾸기 쉽게 했습니다.

### 재생성의 경계

재생성에는 두 가지 전략이 있습니다. ChatGPT처럼 **분기**를 만들어 "2/3" 식으로 왔다갔다하게 하거나, 대상 메시지 **이후를 전부 잘라내는** 것입니다. 저는 잘라내기를 골랐습니다. 분기는 메시지 모델을 트리로 바꿔야 하고, 그 복잡도가 이 글의 주제(이벤트 → 상태)와 무관하기 때문입니다. 다만 "재생성하면 이후 대화가 사라진다"는 것은 UI에서 명확히 알려야 하는 결정이고, 지금은 마지막 assistant 메시지에만 재생성 버튼을 노출하는 것으로 회피했습니다.

---

## 4. 복구 정책: 재시도해도 되는 순간과 안 되는 순간

실패는 세 종류로 나뉘었습니다.

| 시점 | 예 | 처리 |
|---|---|---|
| 연결 전 | 네트워크 오류, DNS 실패 | 자동 재시도 |
| 첫 토큰 전 | 503, 429, 업스트림 타임아웃 | 자동 재시도 |
| 첫 토큰 후 | 스트림 중 끊김 | **자동 재시도 금지**, 부분 응답 유지 + 수동 복구 |

기준은 **"사용자가 이미 무언가를 봤는가"**입니다. 토큰이 하나도 안 보인 상태에서 조용히 재시도하는 것은 사용자에게 아무 영향이 없습니다. 하지만 세 문단을 읽고 있는데 뒤에서 조용히 다시 생성해서 내용이 바뀌면, 사용자는 자기 눈을 의심하게 됩니다. 이 경우에는 받은 데까지 보여주고, "여기까지가 끊기기 전 내용입니다"라고 말하고, 다시 시도할지를 사용자가 결정하게 해야 합니다.

```ts
// src/runtime/useChatRuntime.ts
if (te.retryable && !receivedDelta && attempt <= maxRetries) {
  const delay = backoff(attempt)
  dispatch({ type: 'run/retrying', runId, attempt: attempt + 1 })
  await sleep(delay, signal)
  continue
}
```

`retryable`은 BFF가 결정합니다. 429와 5xx는 재시도 가능, 4xx(잘못된 요청, 인증 실패)는 불가능입니다. 재시도해봐야 같은 결과가 나올 에러를 재시도하면 서버 부하만 늘립니다.

### 백오프에 jitter를 넣는 이유

```ts
const backoff = (attempt: number) => Math.random() * Math.min(4000, 300 * 2 ** attempt)
```

지수 백오프만 쓰면, 서버가 잠깐 죽었다 살아날 때 그 순간 실패한 모든 클라이언트가 **정확히 같은 시각**에 재시도합니다. 서버는 다시 쓰러지고, 이것이 반복됩니다(thundering herd). `Math.random()`을 곱해 재시도 시각을 흩뿌리는 것(full jitter)만으로 이 문제가 사라집니다. 한 줄이지만 없으면 장애를 키우는 한 줄입니다.

### 중지는 끝까지 전파되어야 한다

사용자가 중지 버튼을 누르면 무슨 일이 일어나야 할까요. 화면이 멈추는 것은 당연하고, **OpenAI가 토큰 생성을 멈춰야** 합니다. 그렇지 않으면 사용자는 안 보는 답변에 과금이 계속됩니다.

이것은 `AbortController`의 체인으로 해결됩니다.

```
사용자 클릭 → controller.abort()
  → fetch 취소 → 브라우저가 TCP 연결 종료
    → BFF: res.on('close') 발화 → upstreamAbort.abort()
      → OpenAI fetch 취소 → 생성 중단
```

BFF 쪽 코드는 이렇습니다.

```ts
// server/index.ts
res.on('close', () => {
  if (!res.writableFinished) {
    log('client disconnected → abort upstream')
    upstreamAbort.abort()
  }
})
```

`writableFinished` 체크가 필요한 이유는, 정상 완료 후에도 `close`가 발화하기 때문입니다. 이미 다 보냈으면 abort할 것이 없습니다. 실제로 중지를 누르고 BFF 로그를 보면 `client disconnected → abort upstream`이 찍히는 것을 확인했습니다. 이 로그 한 줄을 보기 위해 체인의 모든 고리가 맞물려야 합니다.

[스크린샷: 느린 스트림 모드에서 Esc로 중지 → BFF 로그에 abort upstream]

---

## 5. 실제로 겪은 장애: heartbeat를 보내고 있었는데 화면이 멈췄다

여기서부터가 이 글을 쓰게 된 이유입니다.

장애 상황을 재현하기 위해 BFF에 "장애 재현" 모드를 넣었습니다. 요청에 `fault: 'drop-mid-stream'`을 실으면 BFF가 15번째 토큰에서 `res.destroy()`로 소켓을 끊어버립니다. 아무 이벤트도 보내지 않고 TCP 연결만 죽이는, 가장 더러운 종류의 실패입니다. 클라이언트에서는 `reader.read()`가 reject될 것이고, transport가 이걸 `stream_interrupted` 에러로 바꿀 것이고, UI에 "다시 시도" 버튼이 뜰 것이라고 예상했습니다.

실제로는 **화면이 영원히 "streaming" 상태에 멈췄습니다.** 커서가 깜빡이고, 상태 배지는 streaming이고, 아무 일도 일어나지 않았습니다.

[스크린샷: 15토큰에서 멈춘 채 streaming 배지가 켜져 있는 화면]

BFF 로그에는 분명히 `fault: destroying socket mid-stream`과 `client disconnected → abort upstream`이 찍혀 있었습니다. 서버는 끊었습니다. 그런데 브라우저는 몰랐습니다.

### 원인: 프록시가 끊김을 삼켰다

개발 환경에서 브라우저는 Vite 개발 서버(:5173)에 요청하고, Vite가 `/api`를 BFF(:8787)로 프록시합니다. BFF가 소켓을 끊으면 Vite 프록시가 그것을 감지하지만, **브라우저와의 연결은 끊지 않았습니다.** 프록시 입장에서 응답은 "아직 진행 중"이고, 업스트림이 사라졌다는 사실을 다운스트림에 전달할 의무가 없었던 것입니다.

"개발 서버 문제네"로 넘길 수 있었지만, 그러지 않았습니다. 프로덕션에서 브라우저와 BFF 사이에는 nginx, 클라우드 로드밸런서, CDN이 끼어듭니다. 이들 중 하나라도 같은 동작을 하면 똑같은 장애가 납니다. 그리고 실제로 LB의 idle timeout, nginx의 `proxy_buffering`은 SSE 운영에서 가장 흔한 함정으로 알려져 있습니다. 재현 가능한 로컬 환경에서 이걸 만난 것은 운이 좋은 편이었습니다.

### 깨달음: heartbeat는 절반이다

처음 BFF를 만들 때 15초마다 `: ping` 주석을 보내는 heartbeat를 넣어두었습니다. 프록시의 idle timeout으로 연결이 끊기는 것을 막기 위해서였습니다. 그런데 이 장애를 겪고 나서야 heartbeat의 의미를 절반만 이해하고 있었다는 걸 알았습니다.

heartbeat는 **"연결을 살려두는 것"**과 **"연결이 죽었음을 알아채는 것"** 두 가지 역할을 합니다. 전자는 서버가 보내기만 하면 됩니다. 후자는 **클라이언트가 세고 있어야** 성립합니다. 서버가 3초마다 심장박동을 보내는데 클라이언트가 "마지막 박동이 언제였지?"를 묻지 않으면, 심장이 멈춰도 아무도 모릅니다.

### 해결: idle watchdog

`readSSE`에 "이 시간 동안 바이트가 하나도 오지 않으면 끊긴 것으로 판단한다"는 감시자를 넣었습니다.

```ts
// src/lib/sse/parseSSE.ts
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
```

두 가지를 신경 썼습니다. 첫째, 타이머는 `reader.read()`를 기다리는 동안에만 걸립니다. 소비자가 이벤트를 처리하느라 느린 것과 네트워크가 조용한 것은 다른 문제입니다. 둘째, heartbeat 주석도 "바이트"이므로 타이머를 리셋합니다. 파서는 주석을 버리지만 watchdog은 봅니다. 그래서 heartbeat 간격(3초)과 watchdog 임계(10초)는 짝을 이룹니다. 박동 세 번을 연속으로 놓치면 사망 선고입니다.

이렇게 고치고 다시 재현하자 10초 뒤에 `stream_stalled` 에러가 떴고, 받은 15토큰은 그대로 남았으며, "다시 시도" 버튼이 나타났습니다.

[스크린샷: 부분 응답 + "서버 응답이 멈췄습니다" + 다시 시도 버튼, 우측 로그에 +11315ms interrupted stream_stalled]

### 그리고 한 번 더: 터미널 이벤트 없는 정상 종료

watchdog을 넣고 나서 한 가지 더 눈에 띄었습니다. 프록시가 끊김을 "깔끔하게" 전달하는 경우, 즉 소켓이 에러 없이 정상 종료(`done: true`)되는 경우입니다. 이때 클라이언트는 `message.completed`도 `run.failed`도 받지 못한 채 `for await` 루프가 그냥 끝납니다. 에러가 아니므로 `catch`에도 안 걸립니다.

```ts
// 터미널 이벤트 없이 스트림이 "정상 종료"되는 경우도 비정상으로 취급해야 한다.
if (!sawTerminal && !signal.aborted) {
  dispatch({ type: 'run/interrupted', runId, error: { code: 'stream_incomplete', ... } })
}
```

"스트림이 끝났다"와 "응답이 끝났다"는 다른 사건입니다. 후자는 서버가 명시적으로 말해줘야 하고, 말해주지 않았다면 실패로 간주해야 합니다. 이 규칙을 세우고 나니 프로토콜에 `message.completed`가 왜 반드시 있어야 하는지가 분명해졌습니다. 완료는 추론하는 것이 아니라 선언되는 것입니다.

---

## 6. 렌더링: 초당 수십 번의 토큰을 React가 버티게 하기

상태가 올바르게 바뀐다고 끝이 아닙니다. 그 상태를 그리는 비용이 있습니다.

### 토큰마다 dispatch하면 어떻게 되는가

OpenAI는 초당 수십 개의 delta를 보냅니다. delta마다 `dispatch`하면 초당 수십 번 리듀서가 돌고, 수십 번 리렌더가 일어납니다. 모니터는 초당 60번밖에 그리지 못하므로 그 이상의 렌더는 **사용자가 볼 수 없는 작업**입니다.

그래서 이벤트를 큐에 모았다가 `requestAnimationFrame`마다 한 번만 반영합니다.

```ts
const enqueue = useCallback((event: ServerEvent) => {
  queueRef.current.push(event)
  if (isTerminal(event)) return flush()           // 완료/실패는 즉시
  if (scheduledRef.current !== null) return        // 이미 예약됨
  scheduledRef.current = document.hidden
    ? { id: window.setTimeout(flush, 50), kind: 'timeout' }
    : { id: requestAnimationFrame(flush), kind: 'raf' }
}, [flush])
```

두 가지 예외가 있습니다. 완료/실패 이벤트는 프레임을 기다리지 않고 즉시 반영합니다. 사용자가 "중지" 버튼이 "전송" 버튼으로 바뀌는 것을 한 프레임이라도 빨리 봐야 하기 때문입니다. 그리고 탭이 백그라운드에 있으면 브라우저가 rAF를 멈추기 때문에 `setTimeout`으로 대체합니다. 그렇지 않으면 백그라운드 탭에서 큐가 무한히 쌓이다가 돌아오는 순간 한꺼번에 터집니다.

중지할 때도 `flush()`를 먼저 부릅니다. 큐에 남은 토큰을 화면에 반영한 뒤 `aborted`로 바꿔야, 사용자가 본 마지막 글자와 상태에 저장된 마지막 글자가 일치합니다.

### 메시지 하나만 리렌더되게 하기

리듀서가 불변 업데이트를 하므로, 스트리밍 중에는 **생성 중인 메시지 객체 하나만** 참조가 바뀝니다. `MessageItem`을 `memo`로 감싸면 나머지 메시지는 props 비교에서 걸러집니다. 단, 이 최적화는 콜백 props(`onRegenerate`, `onDelete`)의 참조가 안정적일 때만 작동합니다. 훅에서 모든 콜백을 `useCallback`으로 고정하고, 콜백 안에서는 `stateRef`로 최신 상태를 읽는 방식을 썼습니다. 콜백이 state에 의존하면 매 렌더마다 새 함수가 되어 memo가 무력화되기 때문입니다.

### 스크롤: 따라갈 때와 따라가지 말아야 할 때

스트리밍 중 스크롤은 "항상 바닥으로"가 아닙니다. 사용자가 위로 올려 이전 답변을 읽고 있는데 새 토큰마다 바닥으로 끌어내리면 아무것도 읽을 수 없습니다.

규칙은 하나입니다. **바닥 근처(48px 이내)에 있을 때만 따라간다.** 위로 올라가면 따라가기를 멈추고 "↓ 새 응답 보기" 버튼을 띄웁니다. 사용자가 새 메시지를 보내면 어디에 있었든 바닥으로 보냅니다(자기가 보낸 메시지는 봐야 하니까).

높이 변화 감지에는 `ResizeObserver`를 썼습니다. 메시지 배열이 바뀔 때만 스크롤하면, 같은 메시지의 텍스트가 길어져 줄바꿈이 생기는 경우를 놓칩니다. 콘텐츠 영역의 크기 자체를 감시해야 모든 경우를 잡습니다.

### 한글 입력과 Enter

한국어 사용자에게는 치명적인 버그가 하나 있습니다. 한글을 입력하고 Enter를 치면 **마지막 글자가 두 번 전송**되거나, 조합 중이던 글자가 날아갑니다. IME가 글자를 조합하는 동안의 Enter는 "조합 확정"이지 "전송"이 아니기 때문입니다.

```ts
if (e.nativeEvent.isComposing || e.keyCode === 229) return
```

`isComposing`이 표준이고, `keyCode 229`는 일부 브라우저에서 조합 중임을 나타내는 레거시 값입니다. 둘 다 확인해야 안전합니다.

### 스크린리더

`role="log"`와 `aria-live="polite"`를 메시지 목록에 붙이면 스크린리더가 새 메시지를 읽어줍니다. 그런데 스트리밍 중에는 토큰마다 읽으려 들어서 쓸 수 없는 소음이 됩니다. 스트리밍 중에는 `aria-busy={true}`로 낭독을 보류하고, 완료되면 한 번에 읽게 합니다.

---

## 7. 관측성: 보이지 않으면 고칠 수 없다

이 모든 흐름은 네트워크 탭으로는 보이지 않습니다. 재시도가 몇 번 일어났는지, 첫 토큰까지 얼마나 걸렸는지, 늦은 이벤트가 몇 개 버려졌는지는 런타임만 압니다. 그래서 런타임이 자기 상태 전이를 바깥으로 알리는 `onTelemetry` 훅을 뚫었습니다.

```ts
export interface TelemetryEvent {
  at: number
  runId: string
  kind: 'request' | 'first-token' | 'retry' | 'completed' | 'failed' | 'aborted' | 'interrupted' | 'stale-dropped'
  detail?: string
}
```

지금은 화면 오른쪽 DevPanel에 그대로 보여주지만, 같은 훅에 Sentry breadcrumb을 붙이면 "사용자가 에러를 봤을 때 그 직전 10초 동안 런타임에서 무슨 일이 있었는지"가 그대로 남습니다. 각 메시지에는 TTFT, 총 소요 시간, 출력 토큰 수, 시도 횟수를 기록해서 답변 아래 작게 표시합니다.

[스크린샷: 503 → retry → 성공한 답변 아래 "gpt-4.1-mini · TTFT 2347ms · 3.0s · 186 tok · 2 attempts"]

장애 재현와 이 패널을 같이 보면, "첫 토큰 전 503" 모드에서 `request → retry(http_503 → attempt 2 in 219ms) → first-token → completed`가 순서대로 찍히는 것을 눈으로 확인할 수 있습니다. 재시도 정책을 설명하는 데 이 로그 네 줄이 어떤 문장보다 낫습니다.

---

## 마치며

처음 질문으로 돌아가면, LLM 응답은 데이터가 아니라 이벤트 스트림이었습니다. 그 전제를 받아들이자 설계가 따라왔습니다.

- 이벤트에는 **소속(runId)과 순번(seq)**이 있어야 한다. 이 둘이 없으면 "늦게 도착한 이벤트"를 구분할 수 없고, 스트리밍 UI의 버그 대부분은 여기서 나온다.
- 상태 전이는 **순수 함수 하나**에 가둔다. 비동기 코드와 분리해야 가장 까다로운 시나리오를 네트워크 없이 테스트할 수 있다.
- 재시도의 기준은 **"사용자가 이미 봤는가"**다. 보기 전에는 조용히, 본 뒤에는 묻고 나서.
- heartbeat는 **보내는 쪽과 세는 쪽**이 있어야 완성된다. 서버가 아무리 성실해도 클라이언트가 묻지 않으면 끊김을 모른다.
- 완료는 **추론이 아니라 선언**이다. 스트림이 끝난 것과 응답이 끝난 것은 다른 사건이다.

이 중 어느 것도 Vercel AI SDK가 해주지 않는 것은 아닙니다. 하지만 직접 만들고 나니, 그 라이브러리의 `useChat`이 왜 `stop()`을 주는지, 왜 `onError`와 `onFinish`가 따로 있는지, 스트림 프로토콜에 왜 `finish` 파트가 명시적으로 있는지가 보입니다. 추상화를 쓰더라도 무엇이 추상화되었는지 아는 것과 모르는 것은, 장애가 났을 때 전혀 다른 엔지니어를 만듭니다.

다음 글에서는 지금 의도적으로 미룬 두 가지를 다룰 예정입니다. `Last-Event-ID`로 끊긴 지점부터 이어받기(BFF에 run 버퍼가 필요해지고, "재시도는 첫 토큰 전에만"이라는 규칙이 바뀝니다), 그리고 `**굵게**`가 그대로 보이는 지금의 화면을 스트리밍 Markdown으로 바꾸기(닫히지 않은 코드펜스를 어떻게 그릴 것인가)입니다.

코드는 전부 공개되어 있습니다. 읽어주셔서 감사합니다.

---

### 부록: 이 글에서 다룬 실패 시나리오와 테스트

| 시나리오 | 방어 | 테스트 |
|---|---|---|
| 이벤트가 청크 경계에서 잘림 | 증분 파서 + 버퍼 | 모든 위치에서 2분할 순회 |
| 한글이 바이트 중간에서 잘림 | `TextDecoder({stream:true})` | "안" 2번째 바이트에서 분할 |
| CRLF가 두 청크에 걸침 | 버퍼 끝 `\r` 보류 | `'a\r'` + `'\n\r'` + `'\n'` |
| 중지 → 재생성 → 이전 run의 delta 도착 | runId 가드 | `drops late events from an aborted run` |
| 중복/역순 이벤트 | seq 가드 | `ignores duplicated and out-of-order events` |
| 삭제된 메시지의 스트림이 계속 도착 | 삭제 시 activeRun 해제 | `deleting the active turn stops accepting its events` |
| 재시도 후 seq 리셋 | `run/retrying` | `resets seq on retry` |
| 프록시가 끊김을 삼킴 | idle watchdog | `throws when the stream goes silent` |
| heartbeat만 오는 긴 침묵 | 주석도 바이트로 취급 | `heartbeat comments keep the stream alive` |
| 터미널 이벤트 없는 정상 종료 | `sawTerminal` 체크 | (훅 레벨, 다음 단계에서 추가 예정) |
