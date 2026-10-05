import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useActiveRun, useRuntime } from '../runtime/react'

/**
 * 입력창
 *
 * 한글 IME: 조합 중 Enter는 "글자 확정"이지 "전송"이 아니다. 여기서 전송하면 마지막 글자가
 * 중복 전송된다. 그런데 Safari는 확정 Enter의 keydown에서 isComposing을 false로 보고한다.
 * 그래서 세 가지를 함께 본다: isComposing, keyCode 229, compositionend 직후 짧은 유예.
 * 같은 가드를 Escape(중지)에도 건다. 조합을 취소하려던 Esc가 응답을 중지시키면 안 된다(assistant-ui#8199).
 *
 * 구독: 스레드의 activeRun만 구독한다. 입력할 때마다 목록이 리렌더되지 않도록 메시지와 분리한다.
 */
export function Composer({ threadId }: { threadId: string | null }) {
  const runtime = useRuntime()
  const isRunning = useActiveRun(threadId) !== null
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)
  const compositionEndAt = useRef(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  useEffect(() => ref.current?.focus(), [threadId])

  const isComposing = (e: KeyboardEvent) =>
    e.nativeEvent.isComposing || e.keyCode === 229 || composingRef.current || Date.now() - compositionEndAt.current < 50

  const submit = () => {
    if (isRunning || !value.trim()) return
    if (runtime.send(value, threadId ?? undefined)) setValue('')
  }

  const stop = () => {
    if (!threadId) return
    // 아무 출력도 받기 전에 중지했다면 방금 보낸 프롬프트를 입력창에 되돌려준다 (수정해서 다시 보내기 쉽게)
    const restored = runtime.stop(threadId)
    if (restored && !value) setValue(restored)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape' && isRunning) {
      e.preventDefault()
      stop()
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        placeholder="메시지를 입력하세요 (Enter 전송 · Shift+Enter 줄바꿈 · Esc 중지)"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => (composingRef.current = true)}
        onCompositionEnd={() => {
          composingRef.current = false
          compositionEndAt.current = Date.now()
        }}
        aria-label="메시지 입력"
      />
      {isRunning ? (
        <button type="button" className="stop" onClick={stop} aria-label="응답 중지">
          ■ 중지
        </button>
      ) : (
        <button type="submit" disabled={!value.trim()}>
          전송
        </button>
      )}
    </form>
  )
}
