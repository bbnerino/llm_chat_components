import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useActiveRun, useMessageIds } from '../runtime/react'
import { MessageItem } from './MessageItem'

const BOTTOM_THRESHOLD = 48

/**
 * 메시지 목록 + "바닥에 붙어있기" 스크롤
 *
 * 구독: 메시지 id 배열만 구독한다. 토큰이 들어와 메시지 내용이 바뀌어도
 *       id 배열의 참조는 그대로라 이 컴포넌트는 리렌더되지 않는다.
 *
 * 스크롤 규칙 (오픈소스에서 보고된 엣지 케이스 반영)
 *  - 바닥 근처일 때만 따라간다. 위로 올려 읽는 중이면 끌어내리지 않는다.
 *  - 사용자의 "위로 가려는 의도"는 scrollTop 변화가 아니라 wheel/touch/키 입력으로 즉시 감지한다.
 *    프로그램 스크롤과 같은 프레임에 일어난 사용자 스크롤을 놓치는 문제(assistant-ui#8220) 대응.
 *  - 높이 변화는 DOM 변경 없이도 생긴다(이미지 로드, 접기/펼치기, 폰트). 콘텐츠와 컨테이너를
 *    ResizeObserver로 감시한다. 입력창이 커져 컨테이너가 줄어드는 경우도 포함(use-stick-to-bottom#40).
 *  - 스크롤 위치는 렌더 경로에서 읽지 않는다. 읽으면 강제 동기 레이아웃이 일어난다.
 */
export function MessageList({ threadId }: { threadId: string }) {
  const ids = useMessageIds(threadId)
  const isRunning = useActiveRun(threadId) !== null
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const toBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return

    const isAtBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD
    const onScroll = () => {
      const atBottom = isAtBottom()
      if (atBottom) stickRef.current = true
      setShowJump(!atBottom)
    }
    const unstick = () => {
      stickRef.current = false
    }
    const onWheel = (e: WheelEvent) => e.deltaY < 0 && unstick()
    const onKey = (e: KeyboardEvent) => ['PageUp', 'ArrowUp', 'Home'].includes(e.key) && unstick()

    // 높이가 바뀌는 순간 scroll 이벤트가 먼저 와서 "바닥 아님"으로 판정할 수 있다.
    // 그 뒤 위치를 보정해도 scrollTop이 그대로면 scroll 이벤트가 다시 오지 않으므로, 여기서도 상태를 맞춘다.
    const ro = new ResizeObserver(() => {
      if (stickRef.current) toBottom()
      setShowJump(!isAtBottom())
    })
    ro.observe(content)
    ro.observe(el)

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchmove', unstick, { passive: true })
    el.addEventListener('keydown', onKey)
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchmove', unstick)
      el.removeEventListener('keydown', onKey)
    }
  }, [toBottom])

  // 새 turn이 시작되면(메시지 수 증가) 위를 보고 있었더라도 바닥으로 간다.
  useLayoutEffect(() => {
    stickRef.current = true
    toBottom()
  }, [ids.length, toBottom])

  return (
    <div className="message-scroll" ref={scrollRef} tabIndex={-1}>
      {/* 스트리밍 텍스트를 live region에 넣으면 스크린리더가 토큰마다 읽거나 아예 놓친다.
          목록은 aria-live="off", 상태 변화는 별도의 StatusAnnouncer가 알린다. */}
      <div className="message-list" ref={contentRef} role="log" aria-live="off" aria-busy={isRunning}>
        {ids.length === 0 && <EmptyState />}
        {ids.map((id, i) => (
          <MessageItem key={id} threadId={threadId} messageId={id} isLast={i === ids.length - 1} />
        ))}
      </div>
      {showJump && (
        <button
          className="jump"
          onClick={() => {
            stickRef.current = true
            toBottom(true)
          }}
        >
          {isRunning ? '↓ 새 응답 보기' : '↓ 맨 아래로'}
        </button>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="empty">
      <h2>무엇이든 물어보세요</h2>
      <p>검색·날씨·문서 작성 도구를 쓸 수 있어요. 오른쪽 패널에서 연결 끊김, 503 같은 장애를 직접 재현해볼 수 있어요.</p>
      <ul>
        <li>부산이랑 서울 날씨 비교해줘</li>
        <li>해운대가 어떤 곳인지 위키백과로 알려줘</li>
        <li>부산 2박 3일 여행 계획서 써줘</li>
      </ul>
    </div>
  )
}
