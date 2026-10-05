import { useEffect, useRef, useState } from 'react'
import { useActiveRun, useChatSelector } from '../runtime/react'

/**
 * 스크린리더용 상태 알림. 스트리밍 텍스트 대신 "상태 전이"만 읽어준다.
 *   생성 시작 → "응답 생성 중", 완료 → "응답 완료", 실패 → 에러 문구, 중지 → "중지됨"
 */
export function StatusAnnouncer({ threadId }: { threadId: string | null }) {
  const run = useActiveRun(threadId)
  const lastStatus = useChatSelector((s) => {
    const t = threadId ? s.threads[threadId] : undefined
    const lastId = t?.messageIds.at(-1)
    return lastId ? t?.messages[lastId]?.status : undefined
  })
  const [text, setText] = useState('')
  const prevRunning = useRef(false)

  useEffect(() => {
    const running = run !== null
    let next = ''
    if (running && !prevRunning.current) next = '응답 생성 중'
    else if (running && run.phase === 'resuming') next = '연결이 끊겨 이어받는 중'
    else if (!running && prevRunning.current) {
      next = lastStatus === 'done' ? '응답 완료' : lastStatus === 'aborted' ? '응답 중지됨' : lastStatus === 'error' ? '응답 생성 실패' : ''
    }
    prevRunning.current = running
    if (!next) return
    // 같은 문구가 반복돼도 다시 읽히도록 비웠다가 채운다
    setText('')
    const id = setTimeout(() => setText(next), 100)
    return () => clearTimeout(id)
  }, [run, lastStatus])

  return (
    <div className="sr-only" role="status" aria-live="polite">
      {text}
    </div>
  )
}
