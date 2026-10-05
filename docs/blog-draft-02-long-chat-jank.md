# memo를 썼는데 왜 느렸을까 — AI 채팅이 길어질수록 버벅인 이유와 고친 방법

> 초안 v1. 시리즈 2편.
> 이전 프로젝트 코드는 회사 코드라 그대로 싣지 않고, 문제의 구조만 남겨 단순화했다.
> `[측정]` 표시가 있는 곳은 React Profiler로 실측한 값을 넣을 자리다. 수치 없이 공개하지 않는다.

---

## 들어가며

이전에 AI 에이전트 채팅 화면을 만든 적이 있습니다. 에이전트가 검색하고, 파일을 쓰고, 그 과정을 tool 이벤트로 보내면 프론트엔드가 각 이벤트를 컴포넌트로 바꿔 보여주는 화면이었습니다. Next.js, zustand, react-markdown 조합이었고, 처음 몇 턴은 아무 문제가 없었습니다.

문제는 대화가 길어질 때였습니다. 수십 턴이 쌓이면 새 응답이 올 때마다 화면이 미세하게 끊기고, 입력창의 타이핑까지 늦게 반응했습니다. 짧은 대화로 테스트하면 재현되지 않으니 원인을 찾기 어려웠고, 결국 "AI 응답이 원래 무겁나 보다" 하고 넘어갔습니다.

이번에 스트리밍 채팅 런타임을 처음부터 다시 만들면서 그 코드를 다시 열어봤습니다. 원인은 AI가 아니라 렌더링 구조에 있었습니다. 더 정확히 말하면, **새 이벤트 하나를 처리하는 비용이 "그 이벤트의 크기"가 아니라 "지금까지 쌓인 대화 전체의 크기"에 비례**하고 있었습니다.

이 글에서는 다음을 다룹니다.

- **원인**: 이벤트 하나가 도착했을 때 실제로 어떤 일이 일어났는지, 단계별로
- **결과**: 그것이 왜 "길어질수록 느려지는" 증상으로 나타났는지
- **해결**: 새 런타임에서 같은 실수를 반복하지 않으려고 세운 원칙 다섯 가지와 그 구현
- **검증**: 최적화가 실제로 동작하는지 테스트로 고정한 방법

---

## 1. 질문을 바꾸기: "무엇이 느린가"가 아니라 "비용이 무엇에 비례하는가"

처음에는 "어떤 컴포넌트가 무거운가"를 찾으려 했습니다. 마크다운 파서가 무거운가, shiki 하이라이팅이 무거운가. 하지만 그런 식으로는 "짧을 땐 괜찮고 길어지면 느리다"는 증상을 설명할 수 없습니다. 무거운 컴포넌트는 짧은 대화에서도 무겁기 때문입니다.

질문을 바꿨습니다. **이벤트 하나를 처리할 때 드는 비용은 무엇에 비례하는가?**

- 이상적인 경우: 바뀐 메시지 하나에 비례한다. 대화가 100턴이든 1000턴이든 이벤트 하나의 비용은 같다. O(1)
- 실제 경우: 대화 전체 길이에 비례한다. 이벤트 하나가 O(n)이고, n턴짜리 세션 전체로 보면 O(n²)

O(n²)은 n이 작을 때 O(1)과 구별되지 않습니다. 그래서 짧은 대화로 테스트하면 절대 보이지 않고, 사용자가 실제로 오래 쓸 때 비로소 나타납니다. 이 증상의 정체가 바로 그것이었습니다.

---

## 2. 원인: 이벤트 하나의 여정

에이전트가 tool 결과 이벤트 하나를 보냈을 때, 코드 경로를 따라가면 다음 연쇄가 일어났습니다.

```
SSE 이벤트 1개
 └─ store 업데이트
     │
     ├─ ① 페이지 컴포넌트 전체가 리렌더             ← store 전체 구독
     │
     ├─ ② 모든 메시지 그룹이 리렌더                 ← memo를 무력화하는 getter
     │     └─ 그룹마다 하위 그룹 재계산
     │          └─ tool 그룹마다 effect → setState → 한 번 더 렌더   ← 파생값을 effect로
     │
     ├─ ③ 히스토리 전체의 tool 행이 리렌더          ← tool store 전체 구독
     │
     └─ ④ 문서 전체의 강제 동기 레이아웃            ← 렌더 경로에서 scrollHeight 읽기
```

하나씩 보겠습니다.

### 2-1. selector 없는 구독: "바뀌면 무조건 깨워줘"

```ts
// 단순화한 형태
const { dispatch, getMessageList, appendMessage } = useMessageStore()
```

zustand에서 `useStore()`를 selector 없이 호출하면 **store 전체**를 구독합니다. 꺼낸 것이 함수뿐이어도, store의 어떤 값이 바뀌든 이 훅을 쓰는 컴포넌트가 리렌더됩니다. 이 훅을 페이지 최상단에서 쓰고 있었으니, 이벤트가 올 때마다 페이지 전체가 다시 렌더된 셈입니다.

이것만으로는 치명적이지 않습니다. 하위 컴포넌트가 `memo`로 보호되고 있다면 페이지가 리렌더돼도 실제 작업은 거의 없어야 합니다. 그리고 실제로 하위 컴포넌트는 `memo`로 감싸져 있었습니다. 그런데도 느렸던 이유가 다음 항목입니다.

### 2-2. memo를 무력화하는 getter: 이 글의 핵심

```ts
// store
getMessageList: () => {
  const groups = Object.entries(get().state).map(([id, group]) => ({ ...group })) // 매번 새 객체
  return groups.sort(byCreatedAt)
}

// 훅
return { messageGroups: getMessageList() } // 렌더할 때마다 호출

// 페이지
{messageGroups.map((g) => <MessageGroup key={g.id} group={g} />)} // MessageGroup = memo(...)
```

`MessageGroup`은 `memo`로 감싸져 있었습니다. `memo`는 props를 **얕은 비교(참조 비교)** 해서 같으면 렌더를 건너뜁니다. 그런데 `getMessageList()`가 호출될 때마다 모든 그룹을 `{ ...group }`으로 복사합니다. 내용은 똑같아도 참조는 매번 새것이니, 얕은 비교는 항상 "바뀜"으로 판정합니다.

결과적으로 **변경이 전혀 없는 과거 그룹 수백 개가 이벤트마다 전부 다시 렌더**됐습니다.

이 버그가 무서운 이유는 코드만 보면 최적화된 것처럼 보인다는 점입니다. `memo`도 썼고, `key`도 안정적인 id를 썼습니다. 리뷰에서도 통과합니다. React DevTools Profiler를 켜고 "왜 이 컴포넌트가 렌더됐는가"를 봐야만 드러납니다.

> **내 생각**: `memo`는 혼자서 동작하는 최적화가 아니라 **부모와의 계약**이다. "같은 내용이면 같은 참조를 넘겨주겠다"는 약속을 부모가 지켜야만 의미가 있다. 이 계약을 깨는 코드는 대개 memo를 쓴 컴포넌트가 아니라 멀리 떨어진 store나 훅에 있다.

`[측정]` 30턴 대화에서 이벤트 1개당 렌더된 MessageGroup 수: 이전 __개 / 이후 __개

### 2-3. "최신 여부"를 데이터에 저장한 대가

```ts
// 메시지를 추가할 때마다
const updated = group.messages.map((m) => ({ ...m, isNew: false })) // 기존 메시지 전부 복제
return { ...group, messages: [...updated, { ...newMessage, isNew: true }] }
```

"방금 추가된 메시지인가"를 표시하려고 `isNew` 플래그를 메시지마다 저장했습니다. 새 메시지가 오면 기존 메시지의 `isNew`를 모두 `false`로 바꿔야 하고, 불변 업데이트를 하려면 그룹 안의 메시지를 **전부** 새 객체로 만들어야 합니다. 그 그룹의 `memo(MessageItem)`이 전부 깨집니다.

더 큰 문제는 이 플래그가 여러 의미로 쓰였다는 점입니다. 말풍선 등장 애니메이션, tool 스피너 표시 여부, 파일 패널 자동 열기가 모두 `isNew`로 결정됐습니다. 특히 tool 상태를 "그룹의 마지막 메시지인가"로 **추정**했기 때문에, 병렬 tool 호출 3개 중 마지막 하나만 스피너가 돌고, 실패한 tool에도 성공 체크가 뜨는 버그가 함께 있었습니다.

> **내 생각**: "최신인가", "선택됐는가" 같은 값은 데이터가 아니라 **위치에서 계산되는 값**이다. 메시지 안에 저장하는 순간, 하나가 바뀔 때 전부를 고쳐 써야 한다. `latestId` 하나만 두고 `isLatest = id === latestId`로 계산하면 새 메시지 하나만 만들면 된다.

### 2-4. 파생값을 effect로 계산: 렌더 2배

```tsx
function ToolGroup({ messages }) {
  const [visible, setVisible] = useState([])
  const [files, setFiles] = useState([])
  useEffect(() => {
    setVisible(messages.filter(isVisibleTool))
    setFiles(messages.filter(isFileTool))
  }, [messages])
  // ...
}
```

`messages`로부터 계산할 수 있는 값을 state에 넣고 effect로 동기화했습니다. 흐름은 이렇습니다. 렌더 → 커밋 → effect 실행 → setState → **한 번 더 렌더**. 게다가 2-2 때문에 `messages`가 매번 새 배열이라 effect도 매번 실행됩니다. 히스토리의 모든 tool 그룹이 이벤트마다 두 번씩 렌더됐습니다.

렌더 중에 그냥 계산하면(`useMemo` 또는 변수 하나) 한 번으로 끝납니다. React 공식 문서의 "You Might Not Need an Effect"가 정확히 이 경우입니다.

### 2-5. tool 행마다 store 전체를 구독

```tsx
function ToolRow({ message }) {
  const { getTool } = useToolStore() // selector 없음
  const tool = getTool(message.callId)
  // ...
}
```

2-1과 같은 실수가 행 단위에서 반복됐습니다. tool 응답 하나가 오면 store의 Map이 교체되고, 히스토리에 있는 **모든 tool 행**이 리렌더됩니다. tool 행에는 `memo`도 없었으니 상위 렌더도 그대로 전파됐습니다.

### 2-6. 렌더 경로에서 레이아웃 읽기

```tsx
useEffect(() => {
  const height = container.scrollHeight // ← 레이아웃 읽기
  // prepend 감지, 스크롤 위치 보정 ...
}, [children]) // children은 매 렌더 새 참조 → 매 렌더 실행
```

DOM이 방금 바뀐 직후(커밋 직후)에 `scrollHeight`를 읽으면, 브라우저는 그 값을 알려주기 위해 **즉시 동기 레이아웃**을 수행합니다(forced synchronous layout). 비용은 문서 크기에 비례합니다. 여기에 이벤트마다 `scrollTo({ behavior: 'smooth' })`까지 호출해서, 이전 smooth 스크롤 애니메이션이 끝나기 전에 다음 이벤트가 또 스크롤을 요청하며 화면이 떨렸습니다.

### 2-7. 나머지: 끝없이 커지는 DOM

- 가상화가 없어서 모든 메시지가 DOM에 남습니다. 2-6의 레이아웃 비용이 대화 길이에 따라 계속 커집니다.
- 코드 블록마다 mount 시점에 shiki 하이라이팅을 실행하고 결과를 캐시하지 않았습니다. 인덱스 기반 key(`subgroup-${idx}`) 때문에 이전 페이지를 위에 붙이면 그룹이 remount되고, 하이라이팅을 처음부터 다시 합니다.

### 원인 → 결과 정리

| 원인 | 결과 | 비용이 비례하는 것 |
|---|---|---|
| store 전체 구독 | 이벤트마다 페이지 전체 리렌더 | 페이지 트리 크기 |
| getter가 매번 새 객체 생성 | 과거 그룹의 memo 전부 무력화 | **대화 길이** |
| isNew 일괄 복제 | 현재 그룹의 memo 무력화, tool 상태 추정 버그 | 그룹 크기 |
| 파생값을 effect로 | 모든 tool 그룹 2회 렌더 | **대화 길이 × 2** |
| tool store 전체 구독 | 모든 tool 행 리렌더 | **tool 개수** |
| 렌더마다 scrollHeight 읽기 | 강제 동기 레이아웃 | **DOM 크기** |
| 가상화 없음 | 위 비용들이 계속 증가 | 누적 |

굵게 표시한 항목들이 "대화가 길어질수록"의 정체입니다. 하나하나는 사소해 보이지만, 모두 같은 방향으로 겹쳐서 이벤트 하나의 비용을 대화 길이에 묶어버렸습니다.

---

## 3. 해결: 다섯 가지 원칙

새 런타임에서는 기능을 만들기 전에 원칙부터 정했습니다. 아래 코드는 모두 새 프로젝트(`AI Response Runtime`)에서 가져왔습니다.

### 원칙 1. 바뀐 것만 새 참조, 나머지는 같은 참조

불변 업데이트는 "새로 만드는 것"이 아니라 **"안 바뀐 것을 그대로 두는 것"**이 핵심입니다. 리듀서에 이를 강제하는 헬퍼를 두었습니다.

```ts
function withMessage(t: Thread, id: string, fn: (m: Message) => Message): Thread {
  const m = t.messages[id]
  if (!m) return t
  const next = fn(m)
  return next === m ? t : { ...t, messages: { ...t.messages, [id]: next } }
}
```

토큰이 하나 오면 생성 중인 메시지 하나와, 그것을 담은 스레드 객체만 새로 만들어집니다. 다른 메시지와 다른 스레드는 이전과 **같은 참조**를 유지합니다. 그리고 이 성질을 테스트로 고정했습니다(4장).

### 원칙 2. 구독은 좁게, selector는 기존 참조만 반환

목록은 **id 배열만**, 각 행은 **자기 메시지만** 구독합니다.

```ts
export function useChatSelector<T>(selector: (s: ChatState) => T): T {
  const rt = useRuntime()
  return useSyncExternalStore(rt.subscribe, () => selector(rt.getState()))
}

export const useMessageIds = (threadId: string) =>
  useChatSelector((s) => s.threads[threadId]?.messageIds ?? EMPTY)

export const useMessage = (threadId: string, messageId: string) =>
  useChatSelector((s) => s.threads[threadId]?.messages[messageId])
```

```tsx
function MessageList({ threadId }) {
  const ids = useMessageIds(threadId) // 토큰이 와도 id 배열 참조는 그대로 → 리렌더 없음
  return ids.map((id) => <MessageItem key={id} threadId={threadId} messageId={id} />)
}

const MessageItem = memo(function MessageItem({ threadId, messageId }) {
  const m = useMessage(threadId, messageId) // 자기 메시지가 바뀔 때만 리렌더
  // ...
})
```

원칙 1과 2가 맞물려야 동작합니다. 리듀서가 바뀐 메시지만 새 참조로 만들기 때문에, 스트리밍 중에는 **생성 중인 메시지 행 하나만** selector 결과가 바뀝니다. 대화가 1000턴이어도 토큰 하나에 리렌더되는 행은 하나입니다.

한 가지 규칙을 꼭 지켜야 합니다. **selector 안에서 새 배열이나 객체를 만들면 안 됩니다.** `s => s.messages.filter(...)`처럼 쓰면 매번 새 참조가 나와서 `useSyncExternalStore`가 매번 "바뀜"으로 판정합니다. 이전 프로젝트의 `getMessageList()`와 똑같은 실수를 selector 안에서 반복하게 됩니다. 계산이 필요하면 컴포넌트 안에서 `useMemo`로 합니다.

진행 상태(생각 중, 도구 실행 중) 같은 값도 마찬가지입니다. 모든 행이 구독하면 상태가 바뀔 때 전부 깨어납니다. 그래서 **생성 중인 메시지 안에서만** 상태 컴포넌트를 렌더하고, 그 컴포넌트만 구독하게 했습니다.

```tsx
{live && <RunStatus threadId={threadId} />} // live인 행 하나만 activeRun을 구독
```

### 원칙 3. 파생값은 계산하고, 저장하지 않는다

`isNew`는 없앴습니다. "마지막 메시지인가"는 렌더할 때 위치로 계산합니다.

```tsx
{ids.map((id, i) => <MessageItem key={id} messageId={id} isLast={i === ids.length - 1} />)}
```

tool 상태도 추정하지 않습니다. 서버가 tool 호출 id 단위로 `tool.started → tool.input.completed → tool.result | tool.failed`를 보내고, 리듀서는 그대로 반영합니다. parts를 화면 구조(텍스트 / 작업 묶음 / 결과 카드)로 바꾸는 것도 effect가 아니라 렌더 중 계산입니다.

```tsx
const { segments, footer } = useMemo(() => layoutParts(m.parts, resolveTool), [m.parts])
```

### 원칙 4. 상태 스냅샷을 프레임 단위로 배칭한다

토큰은 초당 수십 개씩 옵니다. 토큰마다 상태를 바꾸면 원칙 1~3을 지켜도 초당 수십 번 렌더가 일어나는데, 모니터는 초당 60번밖에 그리지 못합니다. 그 이상은 아무도 볼 수 없는 작업입니다.

이벤트를 큐에 모았다가 `requestAnimationFrame`마다 한 번만 반영합니다. 중요한 점은 **구독자 알림만이 아니라 상태 스냅샷 자체를** 프레임 단위로 바꾼다는 것입니다. 알림만 늦추면 어떤 컴포넌트가 store를 직접 읽었을 때 배칭을 우회하게 됩니다(vercel/ai #18525에서 실제로 보고된 문제).

한 프레임에 쌓인 연속 delta는 하나로 합칩니다. 토큰 30개가 한 배치로 오면 문자열 이어붙이기를 30번이 아니라 1번만 합니다.

```ts
// 한 프레임 동안 쌓인 [delta "안", delta "녕", delta "하"] → [delta "안녕하"]
export function coalesce(events: ServerEvent[]) { /* ... */ }
```

**여기서 테스트가 버그 하나를 잡았습니다.** 처음에는 병합을 먼저 하고 중복 제거를 나중에 했습니다. 그러자 `[seq 2(중복), seq 3(신규)]`가 seq 2~3 하나로 합쳐진 뒤 "seq 2는 이미 봤다"는 이유로 **통째로** 버려져 새 토큰까지 사라졌습니다. 순서를 바꿔서, 연속된 구간만 먼저 남긴 다음 병합하도록 고쳤습니다.

> **내 생각**: 최적화는 정확성의 경계 **안쪽**에서만 해야 한다. 병합은 "같은 결과를 더 싸게" 내는 것이어야 하는데, 경계 바깥에서 하면 "다른 결과를 더 싸게" 내게 된다. 그래서 "하나씩 적용한 결과 = 병합해서 적용한 결과"를 테스트로 고정했다.

### 원칙 5. 레이아웃은 렌더 경로가 아니라 observer에서 읽는다

스크롤 판단은 scroll 이벤트와 `ResizeObserver` 콜백에서만 합니다. 렌더나 effect에서 `scrollHeight`를 읽지 않습니다.

```ts
const ro = new ResizeObserver(() => {
  if (stickRef.current) toBottom()
  setShowJump(!isAtBottom())
})
ro.observe(content)
ro.observe(scrollContainer) // 입력창이 커져서 컨테이너가 줄어드는 경우까지
```

"바닥에 붙어있기"도 규칙을 정했습니다. 바닥 근처에 있을 때만 따라가고, 사용자가 위로 올려 읽는 중이면 끌어내리지 않습니다. 사용자의 의도는 `scrollTop` 변화가 아니라 wheel·touch·키 입력으로 즉시 감지합니다. 프로그램 스크롤과 같은 프레임에 일어난 사용자 스크롤을 놓치는 문제가 실제로 보고됐기 때문입니다(assistant-ui #8220). 스트리밍 중에는 smooth 대신 즉시 스크롤해서 애니메이션끼리 충돌하지 않게 했습니다.

여기서도 버그를 하나 만났습니다. 바닥에 있는데 "↓ 맨 아래로" 버튼이 사라지지 않았습니다. 높이가 바뀌는 순간 scroll 이벤트가 먼저 와서 "바닥 아님"으로 판정하고, 그 뒤 ResizeObserver가 위치를 보정해도 `scrollTop`이 그대로면 scroll 이벤트가 다시 오지 않았던 것입니다. 위 코드처럼 observer 콜백에서도 상태를 다시 계산해서 해결했습니다.

### 덤: 비용을 화면 크기에 묶기

원칙 1~5로 "이벤트 하나의 비용"은 대화 길이와 무관해졌습니다. 남은 것은 "DOM이 계속 커지는 비용"입니다.

- 화면 밖의 완료된 메시지에 `content-visibility: auto`를 적용해서 레이아웃과 페인트를 건너뛰게 했습니다. CSS 한 줄로 얻는 가장 싼 가상화입니다. 메시지가 수백 개를 넘으면 `@tanstack/react-virtual`의 chat 모드(끝 고정)로 넘어갈 계획입니다.
- 스트리밍 마크다운은 최상위 블록 단위로 쪼개고 블록마다 `memo`합니다. 완성된 블록은 다시 파싱되지 않고 마지막 블록만 바뀝니다. 토큰마다 전체를 다시 파싱하는 O(n²)을 피합니다.
- 코드 하이라이팅은 스트리밍 중에 하지 않습니다. 같은 폰트와 패딩의 plain 코드로 그려서 레이아웃이 흔들리지 않게 했습니다.

---

## 4. 검증: 최적화를 테스트로 고정하기

성능 최적화의 가장 큰 적은 "나중에 누군가 무심코 깨뜨리는 것"입니다. 이전 프로젝트의 `getMessageList()`도 처음부터 그렇게 쓰지는 않았을 겁니다. 그래서 원칙 1을 테스트로 고정했습니다.

```ts
it('unchanged threads and messages keep their references (memo-friendly)', () => {
  // A 스레드의 완료된 메시지, B 스레드가 있는 상태에서
  // A 스레드의 새 메시지에 토큰 하나가 도착하면
  s = receive(s, 'A', text('r1', 1, 'y'))

  expect(s.threads.B).toBe(before.threads.B)                                 // 다른 스레드: 같은 참조
  expect(s.threads.A.messages['a-r0']).toBe(before.threads.A.messages['a-r0']) // 완료된 메시지: 같은 참조
  expect(s.threads.A.messageIds).toBe(before.threads.A.messageIds)           // id 배열: 같은 참조
  expect(s.threads.A.messages['a-r1']).not.toBe(before.threads.A.messages['a-r1']) // 생성 중인 메시지만 새 참조
})
```

누군가 리듀서를 고치다가 "편하게" 전체를 복사하면 이 테스트가 실패합니다. memo의 계약을 코드 리뷰가 아니라 CI가 지킵니다.

병합 최적화도 같은 방식으로 고정했습니다.

```ts
it('applying coalesced events equals applying them one by one', () => {
  const batched = receive(base, 'T', ...events)
  const oneByOne = events.reduce((s, e) => receive(s, 'T', e), base)
  expect(textOf(batched)).toBe(textOf(oneByOne))
})
```

### 실측 `[측정]`

| 지표 (30턴 대화, 토큰 1개 도착 시) | 이전 구조 | 새 구조 |
|---|---|---|
| 리렌더된 메시지 컴포넌트 수 | __ | __ |
| 렌더 시간 (React Profiler, commit) | __ms | __ms |
| 강제 동기 레이아웃 발생 | 있음 | 없음 |
| 100턴에서의 이벤트당 비용 증가율 | __ | __ |

> 측정 방법(예정): 같은 대화 데이터를 두 구조(이전 패턴을 재현한 비교용 컴포넌트 / 새 런타임)에 넣고, React Profiler의 `onRender` 콜백으로 커밋당 렌더 수와 시간을 기록한다. Performance 패널에서 "Forced reflow" 경고 유무를 확인한다.

---

## 마치며

정리하면, 긴 대화가 버벅인 이유는 무거운 컴포넌트 하나가 아니었습니다. **이벤트 하나의 비용을 대화 길이에 묶어버린 여러 개의 작은 결정**이 같은 방향으로 겹친 결과였습니다.

- `memo`는 혼자 동작하지 않는다. 부모가 "같은 내용이면 같은 참조"라는 계약을 지켜야 한다.
- 구독은 좁게. 목록은 id만, 행은 자기 것만. selector는 새 객체를 만들지 않는다.
- "최신인가" 같은 값은 데이터가 아니라 위치에서 계산된다. 저장하는 순간 전부를 고쳐 써야 한다.
- 파생값은 effect로 동기화하지 말고 렌더 중에 계산한다.
- 레이아웃은 렌더 경로가 아니라 observer에서 읽는다.
- 그리고 이 모든 것을 테스트로 고정한다. 최적화는 추가하는 것보다 **깨지지 않게 지키는 것**이 더 어렵다.

돌이켜보면 이전 프로젝트에서 가장 아쉬운 점은 "AI 응답이 원래 무겁나 보다" 하고 넘어간 것입니다. 증상이 "길어질수록"이라는 단서를 줬을 때, 곧바로 "비용이 무엇에 비례하는가"를 물었어야 했습니다. 다음 글에서는 이 런타임에 장애 재현 패널을 붙여, 네트워크·모델·도구·프로토콜 계층에서 실제로 나는 장애를 하나씩 재현하고 복구하는 과정을 다룹니다.

읽어주셔서 감사합니다.
