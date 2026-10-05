# memo를 썼는데 왜 느렸을까

> 예전에 만든 AI 채팅이 길어지면 버벅였던 이유, 그리고 다시 만들면서 어떻게 안 그러게 했는지.
> 예전 코드는 회사 코드라 그대로 안 싣고, 같은 구조를 재현한 비교용 구현으로 측정했어요. 수치는 전부 `bench/main.tsx`로 잰 거고 원본은 `docs/bench-results.json`에 있어요.

---

예전에 AI 에이전트 채팅 화면을 하나 만들었어요. 에이전트가 검색하고 파일 쓰고, 그 과정을 tool 이벤트로 보내면 프론트가 이벤트마다 컴포넌트로 바꿔 보여주는 화면. Next.js, zustand, react-markdown. 처음 몇 턴은 아무 문제 없었어요.

대화가 길어지면 달랐어요. 수십 턴 쌓이면 새 응답 올 때마다 화면이 미세하게 끊기고, 입력창 타이핑까지 늦게 반응했어요. 짧게 테스트하면 재현이 안 되니까 원인을 못 찾았고, 결국 "AI 응답이 원래 좀 무거운가 보다" 하고 넘어갔어요. 지금 생각하면 좀 창피해요.

이번에 런타임을 처음부터 다시 만들면서 그 코드를 다시 열어봤어요. AI가 무거운 게 아니었어요. 렌더링 구조였어요. 정확히는, **이벤트 하나 처리하는 비용이 그 이벤트 크기가 아니라 지금까지 쌓인 대화 전체 크기에 비례**하고 있었어요.

---

## 질문을 바꾸기

처음엔 "어떤 컴포넌트가 무거운가"를 찾으려 했어요. 마크다운 파서? shiki? 근데 그걸로는 "짧을 땐 괜찮고 길어지면 느리다"가 설명이 안 돼요. 무거운 컴포넌트는 짧은 대화에서도 무거워야 하니까.

질문을 바꿨어요. **이벤트 하나 처리할 때 비용이 뭐에 비례하나.**

이상적이면 바뀐 메시지 하나에 비례해요. 대화가 100턴이든 1000턴이든 이벤트 하나 비용은 같아요. O(1). 실제로는 대화 전체 길이에 비례했어요. 이벤트 하나가 O(n)이고, n턴짜리 세션 전체로 보면 O(n²).

O(n²)은 n이 작을 때 O(1)이랑 구별이 안 돼요. 그래서 짧게 테스트하면 절대 안 보이고, 사용자가 진짜 오래 쓸 때 나타나요. 증상의 정체가 이거였어요.

---

## 이벤트 하나의 여정

에이전트가 tool 결과 하나를 보냈을 때, 코드 경로를 따라가면 이런 연쇄가 일어났어요.

```
SSE 이벤트 1개
 └─ store 업데이트
     ├─ ① 페이지 컴포넌트 전체 리렌더              ← store 전체 구독
     ├─ ② 모든 메시지 그룹 리렌더                  ← memo를 무력화하는 getter
     │     └─ tool 그룹마다 effect → setState → 한 번 더   ← 파생값을 effect로
     ├─ ③ 히스토리 전체의 tool 행 리렌더           ← tool store 전체 구독
     └─ ④ 문서 전체 강제 동기 레이아웃              ← 렌더 경로에서 scrollHeight 읽기
```

하나씩 볼게요.

### ① selector 없는 구독

```ts
const { dispatch, getMessageList, appendMessage } = useMessageStore()
```

zustand에서 `useStore()`를 selector 없이 부르면 store 전체를 구독해요. 꺼낸 게 함수뿐이어도, store 어디가 바뀌든 이 훅 쓰는 컴포넌트가 리렌더돼요. 이걸 페이지 최상단에서 쓰고 있었으니 이벤트마다 페이지 전체가 다시 렌더된 거예요.

이것만으론 치명적이진 않아요. 아래 컴포넌트들이 `memo`로 막혀 있으면 페이지가 리렌더돼도 실제 일은 거의 없어야 하니까. 그리고 실제로 memo로 감싸져 있었어요. 그런데도 느렸던 이유가 다음이에요.

### ② memo를 무력화하는 getter

이게 이 글의 핵심이에요.

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

`MessageGroup`은 memo예요. memo는 props를 얕은 비교(참조 비교)해서 같으면 렌더를 건너뛰어요. 근데 `getMessageList()`가 호출될 때마다 모든 그룹을 `{ ...group }`으로 복사해요. 내용은 똑같아도 참조는 매번 새거니까 얕은 비교는 항상 "바뀜"이에요.

그래서 **아무것도 안 바뀐 과거 그룹 수백 개가 이벤트마다 전부 다시 렌더**됐어요.

이게 무서운 게, 코드만 보면 최적화된 것처럼 보여요. memo도 썼고 key도 안정적인 id예요. 리뷰에서도 통과해요. React DevTools Profiler 켜고 "이 컴포넌트 왜 렌더됐어?"를 봐야만 드러나요.

memo는 혼자 동작하는 최적화가 아니에요. **부모와의 계약**이에요. "같은 내용이면 같은 참조 넘겨줄게"를 부모가 지켜야 의미가 있어요. 그리고 이 계약을 깨는 코드는 보통 memo 쓴 컴포넌트가 아니라 저 멀리 store나 훅에 있어요.

실제로 재봤어요. 30턴 대화에서 이벤트 하나가 왔을 때 렌더된 메시지 그룹 수: **31개 전부.** 바뀐 건 마지막 하나인데요. (측정 방법은 맨 아래)

### "최신 여부"를 데이터에 저장한 대가

```ts
// 메시지 추가할 때마다
const updated = group.messages.map((m) => ({ ...m, isNew: false })) // 기존 메시지 전부 복제
return { ...group, messages: [...updated, { ...newMessage, isNew: true }] }
```

"방금 온 메시지인가"를 표시하려고 메시지마다 `isNew`를 저장했어요. 새 메시지 오면 기존 것들 isNew를 다 false로 바꿔야 하고, 불변 업데이트하려면 그룹 안 메시지를 **전부** 새 객체로 만들어야 해요. 그 그룹의 `memo(MessageItem)`이 다 깨져요.

더 큰 문제는 이 플래그가 여러 뜻으로 쓰였다는 거예요. 말풍선 등장 애니메이션, tool 스피너 표시, 파일 패널 자동 열기가 전부 isNew로 결정됐어요. 특히 tool 상태를 "그룹의 마지막 메시지인가"로 추정했기 때문에, 병렬 tool 3개 중 마지막 하나만 스피너 돌고 실패한 tool에도 성공 체크 뜨는 버그가 같이 있었어요.

"최신인가", "선택됐나" 같은 건 데이터가 아니라 **위치에서 계산되는 값**이에요. 메시지 안에 저장하는 순간 하나 바뀔 때 전부 고쳐 써야 해요. `latestId` 하나만 두고 `isLatest = id === latestId`로 계산하면 새 메시지 하나만 만들면 돼요.

### 파생값을 effect로

```tsx
function ToolGroup({ messages }) {
  const [visible, setVisible] = useState([])
  const [files, setFiles] = useState([])
  useEffect(() => {
    setVisible(messages.filter(isVisibleTool))
    setFiles(messages.filter(isFileTool))
  }, [messages])
}
```

`messages`에서 계산할 수 있는 값을 state에 넣고 effect로 동기화했어요. 렌더 → 커밋 → effect → setState → **한 번 더 렌더**. 게다가 ② 때문에 messages가 매번 새 배열이라 effect도 매번 돌아요. 히스토리의 모든 tool 그룹이 이벤트마다 두 번씩 렌더됐어요. 그냥 렌더 중에 계산하면(useMemo든 변수든) 한 번으로 끝나요. React 문서의 "You Might Not Need an Effect"가 딱 이 경우예요.

### ③ tool 행마다 store 전체 구독

```tsx
function ToolRow({ message }) {
  const { getTool } = useToolStore() // selector 없음
  const tool = getTool(message.callId)
}
```

①이랑 같은 실수가 행 단위에서 반복됐어요. tool 응답 하나 오면 store의 Map이 통째로 교체되고, 히스토리의 **모든 tool 행**이 리렌더돼요. tool 행엔 memo도 없어서 상위 렌더도 그대로 내려왔고요.

### ④ 렌더 경로에서 레이아웃 읽기

```tsx
useEffect(() => {
  const height = container.scrollHeight // ← 레이아웃 읽기
  // prepend 감지, 스크롤 보정...
}, [children]) // children은 매 렌더 새 참조 → 매 렌더 실행
```

DOM 바뀐 직후에 `scrollHeight`를 읽으면 브라우저가 그 값 알려주려고 **즉시 동기 레이아웃**을 해요. 문서 클수록 비싸요. 거기에 이벤트마다 `scrollTo({ behavior: 'smooth' })`까지 불러서, 이전 smooth 애니메이션 끝나기 전에 다음 이벤트가 또 스크롤 요청하면서 화면이 떨렸어요.

### 나머지

가상화가 없어서 메시지가 전부 DOM에 남아요. ④ 비용이 대화 길이 따라 계속 커져요. 코드 블록마다 mount 시점에 shiki 돌리고 캐시 안 해요. 인덱스 기반 key(`subgroup-${idx}`) 때문에 이전 페이지를 위에 붙이면 그룹이 remount되고 하이라이팅을 처음부터 다시 해요.

### 정리하면

| 원인 | 비용이 비례하는 것 |
|---|---|
| store 전체 구독 | 페이지 트리 크기 |
| getter가 매번 새 객체 | **대화 길이** |
| isNew 일괄 복제 | 그룹 크기 |
| 파생값을 effect로 | **대화 길이 × 2** |
| tool store 전체 구독 | **tool 개수** |
| 렌더마다 scrollHeight | **DOM 크기** |
| 가상화 없음 | 전부 누적 |

굵은 것들이 "길어질수록"의 정체예요. 하나하나는 사소해 보이는데, 전부 같은 방향으로 겹쳐서 이벤트 하나 비용을 대화 길이에 묶어버렸어요.

---

## 이번엔 어떻게 했나

새 런타임에선 기능 만들기 전에 원칙부터 정했어요. 아래 코드는 전부 새 프로젝트 거예요.

### 바뀐 것만 새 참조, 나머지는 같은 참조

불변 업데이트는 "새로 만드는 것"이 아니라 **"안 바뀐 걸 그대로 두는 것"**이에요. 리듀서에 이걸 강제하는 헬퍼를 뒀어요.

```ts
function withMessage(t: Thread, id: string, fn: (m: Message) => Message): Thread {
  const m = t.messages[id]
  if (!m) return t
  const next = fn(m)
  return next === m ? t : { ...t, messages: { ...t.messages, [id]: next } }
}
```

토큰 하나 오면 생성 중인 메시지 하나랑 그걸 담은 스레드 객체만 새로 만들어져요. 다른 메시지, 다른 스레드는 이전이랑 같은 참조예요. 그리고 이 성질을 테스트로 박아뒀어요(아래).

### 구독은 좁게, selector는 기존 참조만

목록은 **id 배열만**, 각 행은 **자기 메시지만** 구독해요.

```ts
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
  const m = useMessage(threadId, messageId) // 자기 메시지 바뀔 때만
})
```

앞 원칙이랑 맞물려야 돼요. 리듀서가 바뀐 메시지만 새 참조로 만드니까, 스트리밍 중엔 **생성 중인 행 하나만** selector 결과가 바뀌어요. 1000턴이어도 토큰 하나에 리렌더되는 행은 하나예요.

지켜야 할 게 하나 있어요. **selector 안에서 새 배열이나 객체를 만들면 안 돼요.** `s => s.messages.filter(...)` 이러면 매번 새 참조라 `useSyncExternalStore`가 매번 "바뀜"으로 판정해요. 예전의 `getMessageList()`랑 똑같은 실수를 selector 안에서 하는 거예요. 계산이 필요하면 컴포넌트 안에서 useMemo로.

진행 상태(생각 중, 도구 실행 중) 같은 것도 마찬가지예요. 모든 행이 구독하면 상태 바뀔 때 다 깨어나요. 그래서 **생성 중인 메시지 안에서만** 상태 컴포넌트를 렌더하고 그것만 구독하게 했어요.

```tsx
{live && <RunStatus threadId={threadId} />} // live인 행 하나만 activeRun을 구독
```

### 파생값은 계산하고 저장하지 않기

isNew는 없앴어요. "마지막인가"는 렌더할 때 위치로.

```tsx
{ids.map((id, i) => <MessageItem key={id} messageId={id} isLast={i === ids.length - 1} />)}
```

tool 상태도 추정 안 해요. 서버가 callId 단위로 `tool.started → tool.input.completed → tool.result | tool.failed`를 보내고 리듀서는 그대로 반영해요. parts를 화면 구조(텍스트 / 작업 묶음 / 결과 카드)로 바꾸는 것도 effect가 아니라 렌더 중 계산이에요.

```tsx
const { segments, footer } = useMemo(() => layoutParts(m.parts, resolveTool), [m.parts])
```

### 상태 스냅샷을 프레임 단위로

토큰은 초당 수십 개 와요. 토큰마다 상태를 바꾸면 위 원칙 다 지켜도 초당 수십 번 렌더예요. 모니터는 초당 60번밖에 못 그리니까 그 이상은 아무도 못 보는 일이에요.

이벤트를 큐에 모았다가 `requestAnimationFrame`마다 한 번만 반영해요. 중요한 건 **구독자 알림만이 아니라 상태 스냅샷 자체를** 프레임 단위로 바꾼다는 거예요. 알림만 늦추면 어떤 컴포넌트가 store를 직접 읽었을 때 배칭을 우회해요. vercel/ai #18525에서 실제로 있었던 버그예요.

한 프레임에 쌓인 연속 delta는 하나로 합쳐요. 토큰 30개가 한 배치면 문자열 이어붙이기를 30번이 아니라 1번만.

```ts
// [delta "안", delta "녕", delta "하"] → [delta "안녕하"]
export function coalesce(events: ServerEvent[]) { /* ... */ }
```

여기서 테스트가 버그를 하나 잡았어요. 처음엔 합치기를 먼저 하고 중복 제거를 나중에 했거든요. 그러니까 `[seq 2(중복), seq 3(신규)]`가 seq 2~3 하나로 합쳐진 다음, "seq 2는 이미 봤음"이라고 **통째로** 버려져서 새 토큰까지 날아갔어요. 순서를 바꿔서 연속 구간만 먼저 남기고 그다음 합치게 했어요. 최적화는 정확성 경계 **안쪽**에서만 해야 돼요. "하나씩 적용 = 합쳐서 적용"을 테스트로 박아뒀어요.

### 레이아웃은 observer에서

스크롤 판단은 scroll 이벤트랑 `ResizeObserver` 콜백에서만 해요. 렌더나 effect에서 `scrollHeight` 안 읽어요.

```ts
const ro = new ResizeObserver(() => {
  if (stickRef.current) toBottom()
  setShowJump(!isAtBottom())
})
ro.observe(content)
ro.observe(scrollContainer) // 입력창이 커져서 컨테이너가 줄어드는 경우까지
```

"바닥에 붙어있기"도 규칙을 정했어요. 바닥 근처일 때만 따라가고, 위로 올려서 읽는 중이면 안 끌어내려요. 사용자 의도는 scrollTop 변화가 아니라 wheel/touch/키 입력으로 바로 감지해요. 프로그램 스크롤이랑 같은 프레임에 일어난 사용자 스크롤을 놓치는 문제가 실제로 보고돼 있어서요(assistant-ui #8220). 스트리밍 중엔 smooth 대신 즉시 스크롤. 애니메이션끼리 안 싸우게.

여기서도 버그 하나. 바닥에 있는데 "↓ 맨 아래로" 버튼이 안 사라졌어요. 높이가 바뀌는 순간 scroll 이벤트가 먼저 와서 "바닥 아님"으로 찍고, 그 뒤 ResizeObserver가 위치를 보정해도 scrollTop이 그대로면 scroll 이벤트가 다시 안 와요. 위 코드처럼 observer 콜백에서도 상태를 다시 계산해서 해결.

### 덤

위 원칙들로 "이벤트 하나 비용"은 대화 길이랑 무관해졌어요. 남은 건 "DOM이 계속 커지는 비용"이에요.

화면 밖 완료된 메시지에 `content-visibility: auto`를 걸어서 레이아웃이랑 페인트를 건너뛰게 했어요. CSS 한 줄로 얻는 제일 싼 가상화. 메시지가 수백 개 넘으면 `@tanstack/react-virtual`의 chat 모드로 갈 생각이에요.

스트리밍 마크다운은 최상위 블록 단위로 쪼개고 블록마다 memo해요. 완성된 블록은 다시 파싱 안 되고 마지막 블록만 바뀌어요. 코드 하이라이팅은 스트리밍 중엔 안 해요. 같은 폰트, 같은 패딩의 plain 코드로 그려서 레이아웃이 안 흔들리게.

---

## 테스트로 박기

성능 최적화의 제일 큰 적은 "나중에 누가 무심코 깨뜨리는 것"이에요. 예전의 `getMessageList()`도 처음부터 그렇게 쓰진 않았을 거예요. 그래서 첫 번째 원칙을 테스트로 박았어요.

```ts
it('unchanged threads and messages keep their references (memo-friendly)', () => {
  // A 스레드에 완료된 메시지가 있고, B 스레드가 있는 상태에서
  // A의 새 메시지에 토큰 하나가 오면
  s = receive(s, 'A', text('r1', 1, 'y'))

  expect(s.threads.B).toBe(before.threads.B)                                 // 다른 스레드: 같은 참조
  expect(s.threads.A.messages['a-r0']).toBe(before.threads.A.messages['a-r0']) // 완료된 메시지: 같은 참조
  expect(s.threads.A.messageIds).toBe(before.threads.A.messageIds)           // id 배열: 같은 참조
  expect(s.threads.A.messages['a-r1']).not.toBe(before.threads.A.messages['a-r1']) // 생성 중인 것만 새 참조
})
```

누가 리듀서 고치다가 "편하게" 전체 복사하면 이게 깨져요. memo의 계약을 코드 리뷰가 아니라 CI가 지켜요.

### 실측

말로만 하면 안 되니까 재봤어요. 예전 구조를 그대로 재현한 비교용 구현(`bench/legacy.tsx`)이랑 새 런타임(실제 리듀서와 컴포넌트)에 똑같은 대화를 넣고, 마지막 턴에 이벤트를 40개 흘리면서 이벤트 하나당 렌더된 컴포넌트 수와 시간을 쟀어요. 각 컴포넌트에 카운터를 심고, React Profiler의 `actualDuration`이랑 `flushSync` 전후 벽시계를 기록했어요. JIT 워밍업 한 바퀴 돌리고 3라운드 중앙값이에요.

| 이벤트 1개당 | 10턴 | 30턴 | 100턴 |
|---|---|---|---|
| **이전 구조** 렌더된 컴포넌트 | 53.5 | 113.5 | 323.5 |
| **새 구조** 렌더된 컴포넌트 | 1 | 1 | 1 |
| 이전 구조 벽시계 중앙값 / p95 | 0.5 / 0.7 ms | 1.0 / 1.2 ms | 2.9 / 5.5 ms |
| 새 구조 벽시계 중앙값 / p95 | 0.1 / 0.2 ms | 0.1 / 0.2 ms | 0.2 / 0.4 ms |
| 이전 구조 강제 레이아웃 읽기 | 1회 | 1회 | 1회 |
| 새 구조 강제 레이아웃 읽기 | 0 | 0 | 0 |

이전 구조의 323.5개를 쪼개보면 이래요. 페이지 1 + 메시지 그룹 101(전부) + tool 그룹 200(100개 × effect 때문에 2번) + 메시지 아이템 21.5(마지막 그룹 안에서 isNew 복제로 전부). 위에서 코드 읽고 추론한 거랑 정확히 일치해요.

새 구조는 10턴이든 100턴이든 **1개**예요. 생성 중인 메시지 행 하나. 턴 수가 열 배가 돼도 숫자가 안 변해요. 이게 "비용이 대화 길이에 비례하지 않는다"의 실측이에요.

시간 수치는 절대값보다 추세를 보세요. 숨긴 탭에서 돌려서 페인트 비용이 빠져 있고(그래서 이전 구조의 강제 레이아웃 비용이 실제보다 작게 잡혀요), 기계도 빠른 편이에요. 그래도 이전 구조는 10 → 30 → 100턴에서 0.5 → 1.0 → 2.9ms로 선형으로 늘고, 새 구조는 0.1 → 0.1 → 0.2로 평평해요. 느린 기기에서 턴이 수백 개 쌓이면 이 차이가 프레임을 떨어뜨리는 차이가 돼요.

### 벤치가 잡은 버그

솔직히 처음 돌렸을 땐 새 구조가 **2개**였어요. 메시지 행 하나 + 목록 하나. 목록은 id 배열만 구독한다고 글에 써놓고선, 코드에선 "실행 중인가"를 알려고 `activeRun` 객체를 통째로 선택하고 있었어요. 토큰이 올 때마다 `lastSeq`가 바뀌니까 객체 참조가 바뀌고, 목록이 매번 깨어났어요. memo된 행들이 막아줘서 비용은 거의 없었지만, 글이랑 코드가 달랐던 거죠. `!!activeRun`으로 boolean만 선택하게 고쳤고, 그다음부터 1개예요. 측정 안 했으면 몰랐을 거예요.

---|---|---|
| 리렌더된 메시지 컴포넌트 수 | __ | __ |
| 커밋 시간 (React Profiler) | __ms | __ms |
| 강제 동기 레이아웃 | 있음 | 없음 |

> 측정 방법(예정): 같은 대화 데이터를 두 구조에 넣고 Profiler `onRender`로 커밋당 렌더 수랑 시간 기록. Performance 패널에서 Forced reflow 경고 유무.

---

돌이켜보면 제일 아쉬운 건 "AI 응답이 원래 무거운가 보다" 하고 넘어간 거예요. "길어질수록"이라는 단서를 받았을 때 바로 "비용이 뭐에 비례하지?"를 물었어야 했어요. 그 질문 하나면 됐는데.
