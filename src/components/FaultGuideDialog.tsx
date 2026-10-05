import { useEffect, useRef } from 'react'
import type { FaultMode } from '../runtime/protocol'
import { FAULT_GUIDES } from './faultGuide'

/** `코드` 표기를 인라인 코드로 */
function Inline({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/).map((t, i) => (t.startsWith('`') ? <code key={i}>{t.slice(1, -1)}</code> : t))}</>
}

/** 장애 설명 팝업. 네이티브 <dialog>: 포커스 가두기·Esc 닫기·배경 비활성화를 브라우저가 처리한다. */
export function FaultGuideDialog({ fault, onClose }: { fault: Exclude<FaultMode, 'none'> | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const guide = fault ? FAULT_GUIDES[fault] : null

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (guide && !el.open) {
      el.showModal()
      el.scrollTop = 0
    }
    if (!guide && el.open) el.close()
  }, [guide])

  return (
    <dialog
      ref={ref}
      className="fault-dialog"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()} // 바깥(backdrop) 클릭으로 닫기
      aria-labelledby="fault-dialog-title"
    >
      {guide && (
        <div className="fault-dialog-inner">
          <header>
            <span className="fault-layer">{guide.layer}</span>
            {/* showModal()은 autofocus 요소(없으면 첫 포커스 가능 요소)에 포커스한다.
                맨 아래 버튼이 받으면 그 위치로 스크롤된 채 열리므로, 제목이 첫 포커스를 받게 한다. */}
            <h2 id="fault-dialog-title" tabIndex={-1} autoFocus>
              {guide.title}
            </h2>
          </header>

          <section>
            <h3>언제 생기나</h3>
            <p><Inline text={guide.when} /></p>
          </section>

          <section>
            <h3>처리하지 않으면</h3>
            <p><Inline text={guide.ifIgnored} /></p>
          </section>

          <section>
            <h3>이렇게 풀어갑니다</h3>
            <ol className="fault-steps">
              {guide.steps.map((s, i) => (
                <li key={i}>
                  <span className={`actor actor-${s.actor}`}>{s.actor}</span>
                  <span><Inline text={s.text} /></span>
                </li>
              ))}
            </ol>
          </section>

          <section>
            <h3>확인할 것</h3>
            <ul>
              {guide.check.map((c, i) => (
                <li key={i}><Inline text={c} /></li>
              ))}
            </ul>
          </section>

          <section>
            <h3>관련 코드</h3>
            <ul className="fault-code">
              {guide.code.map((c, i) => (
                <li key={i}>
                  <code>{c}</code>
                </li>
              ))}
            </ul>
          </section>

          <footer>
            <span>이 장애가 선택됐습니다. 메시지를 보내서 확인해보세요.</span>
            <button onClick={onClose}>확인</button>
          </footer>
        </div>
      )}
    </dialog>
  )
}
