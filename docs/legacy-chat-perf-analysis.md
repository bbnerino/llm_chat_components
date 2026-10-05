# 이전 프로젝트: 채팅이 길어질수록 버벅인 이유

> 대상: `decaseo-fe` (Next.js 15 + zustand + react-markdown)
> 방법: 정적 코드 분석. 인증과 백엔드 의존성 때문에 실제 실행해서 프로파일링하지는 못했으므로, 아래 비용은 코드 경로를 따라 추론한 것이다.

## 한 줄 요약

**새 이벤트 하나를 처리하는 비용이 "그 이벤트의 크기"가 아니라 "지금까지 쌓인 대화 전체의 크기"에 비례했다.**
대화가 n턴이면 이벤트 한 개에 O(n)의 작업이 일어나고, 세션 전체로 보면 O(n²)이다. 짧은 대화에선 티가 안 나다가 길어질수록 점점 느려지는 전형적인 패턴이다.

---

## 이벤트 1개가 도착했을 때 실제로 일어나는 일

SSE 이벤트 하나(예: tool 응답)가 오면 아래 연쇄가 대화 전체를 대상으로 돈다.

```
SSE 이벤트
 └─ appendToolMessage() / updateToolMessage() / clearStreamingMessage() / setAuthor()
     │
     ├─ ① 페이지 전체 리렌더
     │     useMessageGroupStore()를 selector 없이 구독 → store가 바뀌면 무조건
     │
     ├─ ② getMessageList()가 모든 그룹을 새 객체로 복사 → memo(MessageGroupComponent) 전부 무력화
     │     └─ 그룹마다 subGroups useMemo 재계산 → 새 배열
     │          └─ ToolMessageGroup(memo 없음) 전부 리렌더
     │               └─ useEffect([messages]) 실행 → setState 2번 → 한 번 더 리렌더
     │                    └─ ToolMessageContent(memo 없음) 전부 2번씩 리렌더
     │
     ├─ ③ 모든 tool row가 tool store 전체를 구독
     │     tool 하나가 갱신돼도 히스토리 전체의 tool row가 리렌더
     │
     └─ ④ ChatContainer의 useEffect([children])가 매 렌더마다 실행
           container.scrollHeight를 읽음 → 문서 전체의 강제 동기 레이아웃(reflow)
           + scrollTo({behavior:"smooth"}) 매 이벤트
```

DOM은 가상화 없이 계속 늘어나기 때문에 ④의 reflow 비용도 대화 길이에 비례한다.

---

## 원인별 상세 (근거 코드)

### ① selector 없는 store 구독 — 페이지 전체가 모든 변경에 반응

```ts
// hooks/use-chat.ts:86-93
const { dispatch, getMessageList, appendUserMessage, appendSystemMessage, ... } = useMessageGroupStore();
```

zustand에서 `useStore()`를 selector 없이 호출하면 **store 전체**를 구독한다. 꺼낸 것이 함수뿐이어도, `state`가 바뀔 때마다 이 훅을 쓰는 페이지 컴포넌트 전체가 리렌더된다.

### ② 렌더 중에 새 객체를 만드는 getter — memo를 전부 무력화

```ts
// store/message-group.ts:292-297
getMessageList: () => {
  const groups = Object.entries(state).map(([id, group]) => ({ ...group }));  // 매번 새 객체
  return groups.sort(...)
}

// hooks/use-chat.ts:566
return { messageGroups: getMessageList(), ... }   // 렌더마다 호출
```

`MessageGroupComponent`는 `memo`로 감싸져 있지만, props인 `messageGroup`이 렌더마다 **내용이 같아도 참조가 다른 새 객체**다. memo의 얕은 비교는 항상 "바뀜"으로 판정하므로, 변경이 없는 과거 그룹 수백 개도 매번 다시 렌더된다.

> 이 버그가 무서운 이유: 코드만 보면 `memo`를 썼으니 최적화된 것처럼 보인다. 프로파일러를 켜야만 보인다.

### ②-b append할 때마다 그룹 내 모든 메시지 복제

```ts
// store/message-group.ts:146 (APPEND_* 액션마다 동일)
const updatedMessages = existingGroup.messages.map((msg) => ({ ...msg, isNew: false }));
```

`isNew` 플래그 하나를 끄려고 그룹 안의 모든 메시지를 새 객체로 만든다. `memo(MessageItem)`이 현재 그룹에서는 전부 깨진다. 덤으로 `Message` 클래스 인스턴스가 평범한 객체로 바뀐다.

### ②-c 파생 값을 useEffect + setState로 계산 — 렌더 2배

```ts
// components/chat/message/group/tool-message-group.tsx:21-45
const [filteredMessages, setFilteredMessages] = useState([]);
const [fileMessages, setFileMessages] = useState([]);
useEffect(() => {
  // messages를 필터링해서
  setFilteredMessages(_otherMessages);
  setFileMessages(_fileMessages);
}, [messages]);
```

`messages`(②에서 매번 새 배열)가 바뀔 때마다 렌더 → effect → setState → **한 번 더 렌더**한다. 이것이 히스토리의 모든 tool 그룹에서 일어난다. 렌더 중에 바로 계산하면(`useMemo` 또는 그냥 변수) 한 번으로 끝난다. 같은 패턴이 `ReasoningContentMessage`와 `FileMessage`에도 있다.

### ③ tool store 전체 구독

```ts
// components/chat/message/tool-message/tool-message.tsx:43, :87
const { getToolMessage } = useToolMessagesStore();   // selector 없음
const storeToolMessage = getToolMessage(message);    // 비반응형 get()
```

tool row 하나하나가 store 전체를 구독한다. tool 응답 하나가 오면 `new Map(...)`으로 store가 교체되고, **히스토리에 있는 tool row가 전부** 리렌더된다. `ToolMessageContent`에도 memo가 없어서 상위 렌더도 그대로 전파된다.

올바른 형태는 이것이다.

```ts
const tool = useToolMessagesStore((s) => s.toolMessages.get(id))   // 자기 id만 구독
```

### ④ 매 렌더마다 강제 레이아웃

```ts
// components/chat/chat-container.tsx:58-90
useEffect(() => {
  const childrenArray = Children.toArray(children);
  const currentScrollHeight = container.scrollHeight;   // ← layout read
  ...
}, [children]);   // children은 매 렌더 새 참조 → 매 렌더 실행
```

DOM이 방금 바뀐 직후(commit 직후)에 `scrollHeight`를 읽으면, 브라우저는 그 값을 알려주려고 **즉시 동기 레이아웃**을 수행한다. 문서가 길수록 비싸다. 거기에 이벤트마다 `scrollTo({ behavior: 'smooth' })`(use-chat.ts:331)와 페이지의 `setTimeout(scrollToBottom, 100)`이 겹친다. smooth 스크롤 애니메이션이 진행되는 중에 다음 이벤트가 또 스크롤을 요청하면 애니메이션끼리 싸우면서 화면이 떨린다.

같은 파일에서 `onTopReach={() => fetchNewEvents()}`가 인라인 함수라 IntersectionObserver도 매 렌더 disconnect/재생성된다(chat-container.tsx:184).

### ⑤ 가상화 없음 + 무거운 블록

- 모든 메시지가 DOM에 계속 남는다. 위의 비용들이 전부 "DOM 크기 × 이벤트 수"로 커진다.
- 코드 블록마다 shiki `codeToHtml`을 mount 시점에 비동기 실행하고, 결과를 캐시하지 않는다(code-block.tsx:42-53). index 기반 key(`subgroup-${idx}`) 때문에 이전 페이지를 prepend하면 그룹이 remount되고, 하이라이팅을 처음부터 다시 한다.
- 히스토리를 불러올 때 `csv_upsert` 결과가 N개면 mount effect에서 워크스페이스 refetch가 N번 일어난다(csv-message.tsx:10-12).

---

## 해결 방법

| 원인 | 해결 | 효과 |
|---|---|---|
| ① 전체 구독 | selector로 필요한 조각만 구독. 페이지는 **메시지 id 배열**만 구독 (`useStore(s => s.ids, shallow)`) | 내용이 바뀌어도 id 목록이 같으면 페이지는 리렌더되지 않음 |
| ② 렌더 중 새 객체 | 정렬된 목록은 store 안에 상태로 유지하거나 selector + `shallow`로 메모이즈. **변경되지 않은 그룹은 참조를 유지**한다 | 과거 그룹 memo가 실제로 동작 |
| ②-b isNew 일괄 복제 | "최신" 여부는 메시지에 저장하지 말고 `latestId` 하나로 판단 (`isLatest = id === latestId`) | append 시 새 메시지 1개만 생성 |
| ②-c effect로 파생값 | 렌더 중 계산 (`useMemo` 또는 그냥 변수) | 렌더 절반으로 |
| ③ tool store 전체 구독 | 각 row는 자기 id만 구독 + `memo` | tool 갱신 시 해당 row 1개만 리렌더 |
| ④ 매 렌더 layout read | 스크롤 판단은 **scroll 이벤트**와 **ResizeObserver**에서만. 바닥 근처일 때만 따라가기. smooth 대신 즉시 스크롤(스트리밍 중) | 렌더 경로에서 강제 reflow 제거 |
| ⑤ DOM 무한 증가 | 긴 대화는 가상화(`@tanstack/react-virtual`)하거나, 최소한 화면 밖 메시지에 `content-visibility: auto` | 레이아웃/페인트 비용이 화면 크기에 비례 |
| ⑤ shiki | lazy load + 결과 캐시(코드 문자열 → HTML) + 취소 플래그. 스트리밍 중엔 하이라이트 생략, 완료 후 1회 | 반복 하이라이팅 제거 |

### 원칙으로 정리하면

1. **"변경된 것만 새 참조, 나머지는 같은 참조"** — 불변 업데이트의 핵심은 새로 만드는 게 아니라 *안 바뀐 걸 그대로 두는 것*이다.
2. **구독은 좁게** — 컴포넌트는 자기가 그리는 데이터만 구독한다. 목록은 id만, 행은 자기 행만.
3. **파생값은 계산하고, 저장하지 않는다** — `isNew`, `filteredMessages` 같은 건 state가 아니다.
4. **렌더 경로에서 레이아웃을 읽지 않는다** — 읽기는 이벤트/observer 콜백에서.
5. **비용은 화면에 보이는 양에 비례해야 한다** — 대화 길이에 비례하면 언젠가 반드시 느려진다.

---

## 이 프로젝트(AI Response Runtime)에서는

- reducer가 바뀐 메시지 1개만 새 객체로 만들고 나머지는 참조를 유지한다 → `memo(MessageItem)`이 실제로 동작.
- 콜백은 `useCallback` + `stateRef`로 고정해서 memo를 깨지 않는다.
- 스크롤은 `ResizeObserver` + scroll 이벤트에서만 판단하고, 바닥 근처일 때만 따라간다.
- 토큰은 rAF로 프레임당 1회만 반영한다.

다음 단계에서 이 원칙을 tool parts, 멀티 세션, 긴 대화 가상화까지 확장하고, **"이전 방식 vs 개선 방식" 렌더 횟수를 실측하는 벤치마크**를 넣어 블로그에 수치로 싣는다.
