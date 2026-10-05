# AI Response Runtime

OpenAI 스트리밍 응답(SSE)을 끝까지 믿을 수 있는 채팅 상태로 바꾸는 React 런타임 & 컴포넌트.
"채팅 UI를 만든다"보다 **"끝을 알 수 없는 이벤트 흐름에서 중지·재시도·재생성·이어받기가 꼬이지 않게 하려면 무엇이 필요한가"** 에 집중한다.

```bash
cp .env.example .env   # OPENAI_API_KEY 입력
npm install
npm run dev            # BFF(:8787) + Vite(:5173)
npm test               # 49 tests
```

## 기능

- 텍스트와 tool 호출이 섞인 응답을 **parts** 단위로 스트리밍한다. 검색, 날씨, 문서 작성, 후속 질문 tool이 있다.
- tool마다 컴포넌트를 연결하는 **레지스트리**가 있다. 표시 위치는 단계 접기, 본문 카드 고정, 하단, 숨김 중에서 선언한다.
- 문서 작성 tool은 인자를 **부분 JSON**으로 파싱해서 사이드 패널에 실시간으로 그린다.
- **멀티 대화**를 지원한다. 대화를 전환해도 응답 생성은 백그라운드에서 계속된다. 대화 목록은 localStorage와 URL에 동기화된다.
- 아래 경우에 **이어받기(resume)**를 한다: 연결이 끊겼을 때, 새로고침했을 때, 탭으로 돌아왔을 때, 네트워크가 복구됐을 때.
- **장애 재현 패널**에서 503, 429, 응답 중 끊김, 느린 스트림을 재현할 수 있고, 런타임 telemetry도 볼 수 있다.

## 아키텍처

```
Browser                                                   BFF (server/)                     OpenAI
┌────────────────────────────────────────────┐          ┌──────────────────────────────┐   ┌─────────┐
│ Components ─ selector로 좁게 구독            │          │ Run (서버 메모리)              │   │Responses│
│   MessageList(ids) · MessageItem(id)       │  POST    │  - agent loop (tool 실행)     │◀─▶│ API     │
│   ToolSteps · ToolSlot ← tool registry     │ /runs    │  - 이벤트 로그 (seq)           │SSE│ stream  │
│ ChatRuntime (React 바깥)                   │─────────▶│  - 연결과 분리된 수명           │   └─────────┘
│   - run 소유, rAF 배칭, 재시도/이어받기       │◀─────────│ attach(연결) = 로그 구독       │
│   - visibilitychange/online/새로고침 복구    │   SSE    │  - heartbeat, 끊김 ≠ 취소      │
│ chatReducer (순수) ─ 스레드별 격리          │  GET     │ POST /cancel → 업스트림 abort  │
│ ChatTransport (어댑터) · SSEParser(공유)    │ /events  │ reaper: 구독자 없는 run 취소   │
└────────────────────────────────────────────┘ ?after=n └──────────────────────────────┘
```

| 계층 | 파일 | 책임 |
|---|---|---|
| Protocol | `src/runtime/protocol.ts` | run.* / text.delta / tool.* 이벤트 계약. 모든 이벤트에 `runId`와 `seq`가 붙는다 |
| BFF | `server/index.ts`, `runs.ts` | run 수명을 연결에서 분리하고 이벤트 로그를 남긴다. 같은 runId로 다시 시작하면 기존 run에 붙고(idempotent), cancel과 고아 run 정리를 맡는다 |
| 이력 정리 | `server/openai.ts` | 짝 없는 tool 호출을 정리해서 대화가 벽돌이 되지 않게 한다. HTTP와 스트림 에러를 하나의 형식으로 맞춘다 |
| SSE Parser | `src/lib/sse/parseSSE.ts` | WHATWG 스펙을 따르는 증분 파서. UTF-8 경계와 idle watchdog을 처리한다. 서버와 클라이언트가 같은 코드를 쓴다 |
| Runtime | `src/runtime/ChatRuntime.ts` | run을 소유한다. 배칭, 재시도와 이어받기, 수명 이벤트, 영속화를 맡는다 |
| Reducer | `src/runtime/reducer.ts` | 스레드별로 상태를 격리한다. 연속된 seq만 받아들이고, delta를 병합하고, tool 생명주기를 관리한다 |
| React | `src/runtime/react.tsx` | `useSyncExternalStore`를 기반으로 selector 훅을 제공한다 |
| Tools UI | `src/tools/*` | 레지스트리, 부분 인자 파싱, tool별 View |
| Markdown | `src/components/markdown/*` | 블록 단위로 memo하고 미완성 꼬리를 보정한다. 원격 이미지와 위험한 URL은 차단한다 |

## 신뢰성 설계

이 표는 실제로 보고된 문제(`docs/research-streaming-chat-pitfalls.md`)와 직접 재현해서 확인한 것을 근거로 한다.

| 상황 | 처리 | 근거 |
|---|---|---|
| 중지 후 재생성했는데 이전 run의 delta가 도착 | `runId`가 다르면 무시 | |
| 중복되거나 구멍 난 이벤트 | `seq === lastSeq+1`만 반영한다. 구멍이 생기면 이어받기 | |
| 첫 출력 전 503/429 | 지수 백오프와 jitter를 적용하고 `Retry-After`를 지킨다. 같은 runId로 다시 시작해도 서버가 idempotent하게 처리해서 이중 과금이 없다 | |
| 출력이 시작된 뒤 끊김 | 다시 생성하지 않고 마지막 seq부터 이어받는다 | vercel/ai #11865 |
| 프록시가 끊김을 브라우저에 전달하지 않음 | heartbeat(2s)와 idle watchdog(7s)으로 감지한 뒤 이어받는다 | 직접 재현 |
| 완료 이벤트 없이 스트림이 종료 | 끊김으로 간주하고 이어받는다 | |
| 새로고침, 탭 복귀, 네트워크 복구 | 저장된 `lastSeq`부터 이어받는다 | vercel/ai #11865 |
| 사용자 중지 | 명시적으로 cancel을 보낸다. 연결이 끊긴 것만으로는 취소로 보지 않는다. 구독자가 없는 run은 30초 뒤 정리한다 | Ably "stop vs disconnect", vercel/ai #10719 |
| tool 실행 중 중지한 뒤 다음 메시지 전송 | 짝 없는 function_call에 "취소됨" 결과를 합성해서 400을 막는다 | vercel/ai #18425, 직접 재현 |
| 대화 전환 중 스트림이 섞임 | 상태를 스레드별로 격리하고 reader를 React 바깥에 둔다 | vercel/ai #696, #5015 |
| 모르는 이벤트 타입 | 무시한다 | CopilotKit #3323 |
| 외부 API가 응답하지 않음 | tool별 타임아웃을 두고, tool 하나만 실패로 처리한다 | |
| 응답 길이 제한, 콘텐츠 필터 | `finish`를 구분해서 표시한다 | OpenAI `response.incomplete` |

## 렌더링 / UX

- **좁은 구독**: 목록은 id 배열만, 각 행은 자기 메시지만 구독한다. 스트리밍 중에는 생성 중인 메시지 하나만 리렌더된다. 이전 프로젝트의 문제 분석은 `docs/legacy-chat-perf-analysis.md`에 있다.
- **스냅샷 배칭**: 알림만이 아니라 상태 스냅샷 자체를 프레임당 1회만 바꾼다. 연속된 delta는 병합해서 문자열 이어붙이기도 1회로 줄인다.
- **스트리밍 Markdown**:
  - 블록 단위로 memo해서 O(n²) 재파싱을 피한다.
  - 미완성 펜스, 링크, 표는 꼬리를 보정한다.
  - `singleTilde: false`로 "17~23도"가 취소선이 되지 않게 한다.
- **보안**: raw HTML은 렌더링하지 않고, 링크는 http(s)와 mailto만 허용하며, 원격 이미지는 링크로만 보여준다(데이터 유출 방지).
- **스크롤**:
  - wheel, touch, 키 입력으로 사용자 의도를 감지한다.
  - 콘텐츠와 컨테이너 크기를 ResizeObserver로 감시한다.
  - 화면 밖 메시지는 `content-visibility: auto`로 레이아웃 비용을 줄인다.
- **한글 IME**: `isComposing`, keyCode 229, compositionend 직후 유예를 함께 본다. Esc에도 같은 가드를 건다.
- **접근성**: 목록은 `aria-live="off"`로 두고, 생성 시작·완료·실패 같은 상태 전이만 별도 status 영역에서 알린다.

## 다음 단계

- [ ] 코드 하이라이팅: 블록이 닫힌 뒤 lazy shiki를 적용하고 결과를 캐시
- [ ] 메시지 트리(`parentId`)로 편집과 분기 지원
- [ ] 멀티 탭 동기화 (BroadcastChannel + Web Locks)
- [ ] 이벤트 로그를 Redis Streams로 옮겨 다중 인스턴스 지원
- [ ] Human-in-the-loop 승인 tool (`awaiting_approval` 상태)
- [ ] telemetry를 Sentry와 메트릭으로 연결
