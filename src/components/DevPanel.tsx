import { useState } from 'react'
import type { TelemetryEvent } from '../runtime/ChatRuntime'
import type { FaultMode } from '../runtime/protocol'
import { FaultGuideDialog } from './FaultGuideDialog'

interface Props {
  fault: FaultMode
  onFaultChange: (f: FaultMode) => void
  log: TelemetryEvent[]
  onClear: () => void
}

const FAULT_GROUPS: { group: string; options: { value: FaultMode; label: string; hint: string }[] }[] = [
  {
    group: '',
    options: [{ value: 'none', label: '정상', hint: '' }],
  },
  {
    group: '네트워크 · 인프라',
    options: [
      { value: 'fail-before-first-token', label: '첫 출력 전 503', hint: '자동 재시도(지수 백오프)' },
      { value: 'rate-limit', label: '429 Rate limit', hint: 'Retry-After 카운트다운 후 재시도' },
      { value: 'drop-mid-stream', label: '응답 중 연결 끊김', hint: '받은 seq부터 이어받기' },
      { value: 'proxy-buffering', label: '프록시 버퍼링', hint: '토큰이 2.5초마다 덩어리로 도착' },
      { value: 'server-restart', label: '응답 중 서버 재시작', hint: '로그 유실 → 이어받기 불가(run_gone)' },
    ],
  },
  {
    group: '모델',
    options: [
      { value: 'mid-stream-error', label: '응답 도중 모델 에러', hint: '200 이후 스트림 내 에러 → 부분 응답 보존' },
      { value: 'length-limit', label: '출력 길이 제한', hint: '잘린 답변 → 이어서 작성' },
      { value: 'context-length', label: '컨텍스트 초과', hint: '재시도 무의미 → 새 대화 유도' },
    ],
  },
  {
    group: '도구',
    options: [{ value: 'tool-failure', label: '외부 API 타임아웃', hint: 'tool 단위 실패, 답변은 계속' }],
  },
  {
    group: '프로토콜',
    options: [{ value: 'protocol-noise', label: '중복 · 미지 이벤트', hint: '무시되고 telemetry에 기록' }],
  },
  {
    group: '속도',
    options: [{ value: 'slow', label: '느린 스트림', hint: '배칭 · 스크롤 · 중지 확인' }],
  },
]

/** 관측성 패널: 장애 주입 + 런타임 telemetry */
export function DevPanel({ fault, onFaultChange, log, onClear }: Props) {
  const t0 = log[0]?.at ?? 0
  const [guide, setGuide] = useState<Exclude<FaultMode, 'none'> | null>(null)

  // 이미 선택된 항목을 다시 눌러도 설명이 열리도록 onChange가 아니라 onClick에서 처리한다
  const pick = (f: FaultMode) => {
    onFaultChange(f)
    setGuide(f === 'none' ? null : f)
  }

  return (
    <div className="devpanel">
      <FaultGuideDialog fault={guide} onClose={() => setGuide(null)} />
      <section>
        <h3>장애 재현</h3>
        {FAULT_GROUPS.map((g) => (
          <fieldset key={g.group || 'none'} className="fault-group">
            {g.group && <legend>{g.group}</legend>}
            {g.options.map((o) => (
              <label key={o.value} className="fault-option">
                <input type="radio" name="fault" checked={fault === o.value} onChange={() => {}} onClick={() => pick(o.value)} />
                <span>
                  {o.label}
                  {o.hint && <small>{o.hint}</small>}
                </span>
              </label>
            ))}
          </fieldset>
        ))}
        <p className="hint">항목을 누르면 처리 흐름 설명이 열립니다. 스트리밍 중에 새로고침하거나 다른 대화로 이동해도 응답은 이어집니다.</p>
      </section>
      <section className="log">
        <h3>
          Runtime events <button onClick={onClear}>clear</button>
        </h3>
        <ol>
          {log.map((e, i) => (
            <li key={i} className={`k-${e.kind}`}>
              <span className="t">+{((e.at - t0) / 1000).toFixed(2)}s</span>
              <span className="r">{e.runId.slice(0, 4)}</span>
              <b>{e.kind}</b>
              {e.detail && <span className="d">{e.detail}</span>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
