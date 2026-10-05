import type { FaultMode } from '../runtime/protocol'

/**
 * 장애 재현 가이드: 각 장애가 실제로 언제 생기고, 이 런타임이 어떤 경로로 풀어내는지.
 * 단계(actor)는 요청이 지나가는 계층 순서대로 적는다.
 */

export type Actor = '서버' | 'Transport' | '런타임' | '리듀서' | 'UI'

export interface FaultGuide {
  title: string
  layer: string
  when: string
  ifIgnored: string
  steps: { actor: Actor; text: string }[]
  check: string[]
  code: string[]
}

export const FAULT_GUIDES: Record<Exclude<FaultMode, 'none'>, FaultGuide> = {
  'fail-before-first-token': {
    title: '첫 출력 전 503',
    layer: '네트워크 · 인프라',
    when: '모델 서버가 과부하이거나 배포 중이거나 게이트웨이가 일시적으로 실패해서, 첫 토큰이 나오기 전에 HTTP 5xx가 돌아오는 경우입니다.',
    ifIgnored:
      '사용자가 같은 질문을 직접 다시 보내야 합니다. 재시도를 넣더라도 간격이 고정이면, 동시에 실패한 클라이언트들이 같은 순간에 몰려 서버가 다시 쓰러집니다(thundering herd).',
    steps: [
      { actor: '서버', text: '503을 반환합니다. run은 만들어지지 않습니다.' },
      { actor: 'Transport', text: '재시도 가능한(retryable) TransportError로 바꿉니다.' },
      { actor: '런타임', text: '서버에 run이 생겼다는 확인을 아직 받지 못했고, 보이는 출력도 없습니다. 그래서 "다시 시작" 경로로 갑니다.' },
      { actor: '런타임', text: '지수 백오프에 full jitter를 더한 시간만큼 기다립니다. 실패한 클라이언트들의 재시도 시점이 흩어집니다.' },
      { actor: '리듀서', text: 'run/retrying: lastSeq를 0으로 되돌리고 attempts를 1 올립니다.' },
      { actor: '런타임', text: '같은 runId로 다시 POST합니다. 서버는 runId 기준으로 idempotent하게 처리하므로, 이전 요청이 실제로 도달했었더라도 이중으로 과금되지 않습니다.' },
    ],
    check: ['telemetry에 `retry  overloaded → attempt 2 in …ms`가 찍힙니다.', '답변 아래 메트릭에 "재시도 1회"가 표시됩니다.'],
    code: ['src/runtime/ChatRuntime.ts · drive() ① 분기, backoff()', 'server/index.ts · handleStart() idempotency'],
  },

  'rate-limit': {
    title: '429 Rate limit',
    layer: '네트워크 · 인프라',
    when: '분당 요청 수나 토큰 한도를 넘은 경우입니다. 서버는 Retry-After 헤더로 언제 다시 시도하면 되는지 알려줍니다.',
    ifIgnored: '즉시 다시 시도하면 또 429가 나고 한도만 더 소모합니다. 사용자는 왜 실패했는지, 언제 다시 되는지 알 수 없습니다.',
    steps: [
      { actor: '서버', text: '429와 함께 `Retry-After: 3`을 보내고, body에는 retryAfterMs를 담습니다.' },
      { actor: 'Transport', text: 'TransportError에 retryAfterMs를 그대로 실어 보냅니다.' },
      { actor: '런타임', text: '대기 시간을 max(백오프, retryAfterMs)로 정합니다. 서버가 알려준 시간보다 일찍 재시도하지 않습니다.' },
      { actor: '리듀서', text: 'run/retrying에 retryAt(재시도 예정 시각)을 기록합니다.' },
      { actor: 'UI', text: 'RetryCountdown이 "3초 후 다시 시도합니다"를 보여줍니다. 250ms 타이머는 이 컴포넌트에만 있어서 다른 행은 리렌더되지 않습니다.' },
      { actor: '서버', text: '한도 초과(insufficient_quota)는 quota_exceeded로 따로 분류하고 재시도하지 않습니다. 기다려도 풀리지 않기 때문입니다.' },
    ],
    check: ['카운트다운 문구가 보입니다.', 'telemetry에 `retry  rate_limited → attempt 2 in ~3000ms`가 찍힙니다.'],
    code: ['server/openai.ts · normalizeHttpError(), parseRetryAfter()', 'src/components/MessageItem.tsx · RetryCountdown'],
  },

  'drop-mid-stream': {
    title: '응답 중 연결 끊김',
    layer: '네트워크 · 인프라',
    when: '모바일에서 와이파이가 LTE로 바뀔 때, 로드밸런서의 idle timeout, 노트북 덮개를 닫을 때, 백그라운드 탭이 정지될 때 생깁니다.',
    ifIgnored:
      '받던 답변이 사라지거나, 처음부터 다시 생성합니다. 다시 생성하면 비용이 두 배가 되고 이미 읽은 내용이 바뀝니다.',
    steps: [
      { actor: '서버', text: '12번째 토큰 직후 소켓을 끊습니다. run 자체는 서버 메모리에서 계속 진행되고, 이벤트는 seq와 함께 로그에 쌓입니다.' },
      { actor: 'Transport', text: '개발 환경의 프록시는 끊김을 브라우저에 전달하지 않습니다. 대신 heartbeat(2초)가 7초 동안 오지 않으면 idle watchdog이 stream_stalled를 냅니다.' },
      { actor: '런타임', text: '이미 이벤트를 받은 run이므로 "다시 시작"이 아니라 "이어받기" 경로로 갑니다.' },
      { actor: '런타임', text: 'GET /runs/:id/events?after=lastSeq를 요청합니다. 서버는 그 이후 로그를 재생한 다음 실시간 구독으로 넘어갑니다.' },
      { actor: '리듀서', text: 'seq === lastSeq + 1인 이벤트만 반영합니다. 재생 구간이 겹쳐도 텍스트가 중복되지 않습니다.' },
    ],
    check: [
      'telemetry에 `resume  stream_stalled, after seq 14`가 찍힙니다.',
      '서버 로그에 `resume after seq 14`가 찍힙니다.',
      '메트릭에 "이어받기 1회"가 표시되고, 텍스트에 중복이나 누락이 없습니다.',
    ],
    code: ['server/runs.ts · Run(log, subscribe)', 'server/index.ts · attach(), handleResume()', 'src/lib/sse/parseSSE.ts · idle watchdog', 'src/runtime/ChatRuntime.ts · drive() ② 분기'],
  },

  'proxy-buffering': {
    title: '프록시 버퍼링',
    layer: '네트워크 · 인프라',
    when: 'nginx의 proxy_buffering, gzip/compression 미들웨어, 일부 CDN이 SSE 응답을 모아서 한꺼번에 내보내는 경우입니다.',
    ifIgnored:
      '토큰이 몇 초씩 멈췄다가 쏟아집니다. 버퍼링 시간이 길면 heartbeat도 버퍼에 갇혀서, 연결이 살아 있는데 watchdog이 끊겼다고 오판합니다.',
    steps: [
      { actor: '서버', text: '원인 제거: `X-Accel-Buffering: no`와 `Cache-Control: no-transform`을 보내고, 첫 바이트(`: connected`)를 즉시 씁니다.' },
      { actor: '서버', text: '이 재현에서는 이벤트와 heartbeat를 모아서 2.5초마다 몰아서 보냅니다.' },
      { actor: '런타임', text: '이벤트가 덩어리로 와도 rAF 배칭으로 프레임당 한 번만 상태를 바꿉니다.' },
      { actor: '리듀서', text: 'coalesce가 연속된 delta 수십 개를 하나로 합칩니다. 문자열 이어붙이기는 한 번만 일어납니다.' },
      { actor: 'Transport', text: 'watchdog 임계값(7초)을 버퍼링 주기보다 길게 잡아서 오탐하지 않게 합니다.' },
    ],
    check: ['텍스트가 덩어리 단위로 나타나지만 에러나 이어받기는 발생하지 않습니다.'],
    code: ['server/index.ts · attach() 응답 헤더', 'src/runtime/reducer.ts · coalesce()', 'src/runtime/ChatRuntime.ts · enqueue(), flushNow()'],
  },

  'server-restart': {
    title: '응답 중 서버 재시작',
    layer: '네트워크 · 인프라',
    when: '배포, 크래시, 오토스케일링으로 BFF 프로세스가 바뀐 경우입니다. 메모리에 있던 run 로그가 사라지고, 요청이 다른 인스턴스로 가도 같은 문제가 생깁니다.',
    ifIgnored: '이어받기를 끝없이 재시도하거나, 화면이 영원히 "이어받는 중"에 머뭅니다.',
    steps: [
      { actor: '서버', text: '소켓을 끊고, 메모리의 run과 로그를 삭제합니다. 재시작을 흉내 내는 것입니다.' },
      { actor: 'Transport', text: 'watchdog이 stream_stalled를 냅니다.' },
      { actor: '런타임', text: '이어받기를 시도합니다. 서버가 404 run_gone(retryable: false)을 돌려줍니다.' },
      { actor: '런타임', text: '재시도할 수 없는 에러이므로 ③ "복구 불가" 경로로 가서, 이어받기를 더 시도하지 않습니다.' },
      { actor: '리듀서', text: 'run/interrupted: 받은 부분은 남기고 에러 상태로 확정합니다.' },
      { actor: 'UI', text: '"서버에서 이 응답을 더 이상 이어받을 수 없습니다"와 "다시 시도"(새 run)를 보여줍니다.' },
    ],
    check: ['telemetry에 `resume` 다음 `interrupted  run_gone`이 찍힙니다.', '부분 응답과 에러 안내가 함께 보입니다.'],
    code: ['server/index.ts · handleResume() 404', 'src/runtime/ChatRuntime.ts · drive() ③ 분기', '근본 해결: 로그를 Redis Streams 같은 외부 저장소로 옮기기(로드맵)'],
  },

  'mid-stream-error': {
    title: '응답 도중 모델 에러',
    layer: '모델',
    when: '모델이 스트리밍 도중 내부 오류나 과부하를 낸 경우입니다(Anthropic 529처럼). HTTP 상태는 이미 200이고, 에러는 스트림 안의 이벤트로 옵니다.',
    ifIgnored:
      '`response.ok`만 검사하는 코드는 이 에러를 놓쳐서 화면이 영원히 로딩 상태로 남습니다. 반대로 받은 텍스트를 지우고 에러 메시지로 덮어쓰는 구현도 흔합니다.',
    steps: [
      { actor: '서버', text: 'agent loop가 스트림 안의 error / response.failed를 run.failed로 정규화합니다.' },
      { actor: '런타임', text: 'retryable이지만 이미 보이는 출력이 있으므로 자동 재시도하지 않습니다. 사용자가 읽던 내용이 바뀌면 혼란스럽기 때문입니다.' },
      { actor: '리듀서', text: 'status를 error로 바꾸되 부분 텍스트는 유지하고, 진행 중이던 tool은 cancelled로 확정합니다.' },
      { actor: 'UI', text: '"위 내용은 끊기기 전까지 받은 부분 응답입니다"와 "다시 시도"를 보여줍니다.' },
      { actor: '리듀서', text: '다음 요청의 이력(toWireHistory)에서는 실패한 답변을 뺍니다.' },
    ],
    check: ['telemetry에 `failed  overloaded`가 찍히고, 그 뒤에 retry가 없습니다.', '부분 텍스트가 그대로 남아 있습니다.'],
    code: ['server/runs.ts · runAgent() 스트림 에러 처리', 'server/openai.ts · normalizeStreamError()', 'src/runtime/ChatRuntime.ts · ServerRetryableFailure 조건'],
  },

  'length-limit': {
    title: '출력 길이 제한',
    layer: '모델',
    when: 'max_output_tokens에 도달한 경우입니다(Responses API의 `response.incomplete`). 추론 모델은 추론에 토큰을 다 써서 답이 비어 버리기도 합니다.',
    ifIgnored: '잘린 답을 정상 완료로 보여줍니다. 사용자는 답이 잘렸다는 것을 모릅니다.',
    steps: [
      { actor: '서버', text: 'incomplete를 completed와 구분해서 `run.completed { finish: "length" }`로 보냅니다.' },
      { actor: '리듀서', text: 'message.finish에 이유를 저장합니다. 상태는 done입니다.' },
      { actor: 'UI', text: '"답변이 길이 제한으로 잘렸습니다"와 "이어서 작성" 버튼을 보여줍니다.' },
      { actor: '런타임', text: '"이어서 작성"은 새 턴입니다. 잘린 답이 이력에 포함되므로 모델이 이어서 씁니다.' },
    ],
    check: ['노란색 안내가 보입니다.', 'telemetry에 `completed  finish=length`가 찍힙니다.'],
    code: ['server/runs.ts · response.incomplete 처리', 'src/components/MessageItem.tsx · finish === "length"'],
  },

  'context-length': {
    title: '컨텍스트 초과',
    layer: '모델',
    when: '대화가 모델의 컨텍스트 창보다 길어진 경우입니다. 400 context_length_exceeded가 돌아옵니다.',
    ifIgnored: '재시도해도 같은 결과입니다. 자동 재시도 루프가 있으면 요청만 낭비합니다.',
    steps: [
      { actor: '서버', text: '400을 code: context_length_exceeded, retryable: false로 정규화합니다.' },
      { actor: '런타임', text: '재시도하지 않습니다. 요청은 딱 한 번만 나갑니다.' },
      { actor: '리듀서', text: 'run/interrupted로 에러 상태를 확정합니다.' },
      { actor: 'UI', text: '"다시 시도" 대신 "새 대화 시작" 버튼을 보여줍니다. 에러 코드에 따라 다음 행동을 다르게 제안합니다.' },
    ],
    check: ['요청이 한 번만 나갑니다(telemetry에 retry 없음).', '"새 대화 시작" 버튼이 보입니다.'],
    code: ['server/openai.ts · normalizeHttpError()', 'src/components/MessageItem.tsx · ErrorBlock', '개선 방향: 서버에서 토큰을 세고 오래된 턴을 요약하거나 잘라내기'],
  },

  'tool-failure': {
    title: '외부 API 타임아웃',
    layer: '도구',
    when: '도구가 호출하는 외부 API가 느리거나 장애이거나, 모델이 잘못된 인자를 넘긴 경우입니다.',
    ifIgnored:
      'tool 하나 때문에 run 전체가 멈추거나 실패합니다. 이전 프로젝트에서는 실패한 tool에도 성공 체크가 떴습니다.',
    steps: [
      { actor: '서버', text: 'tool 실행에 타임아웃(8초)을 겁니다. AbortSignal.any로 사용자 중지와 타임아웃 중 먼저 오는 쪽에서 끊습니다.' },
      { actor: '서버', text: '실패는 `tool.failed { callId }`로 해당 tool에만 기록합니다.' },
      { actor: '서버', text: '실패 내용을 function_call_output으로 모델에 돌려줍니다. 모델은 다시 시도하거나, 실패를 설명하면서 답변을 이어갑니다.' },
      { actor: '리듀서', text: 'tool part를 callId로 찾아 output-error로 바꿉니다. 병렬로 호출된 다른 tool에는 영향이 없습니다.' },
      { actor: 'UI', text: '해당 단계만 빨간 느낌표와 사유를 보여주고, 나머지 답변은 정상으로 렌더링합니다.' },
    ],
    check: ['tool마다 `tool.failed`가 찍히고, run은 completed로 끝납니다.', '"작업 N개 완료 · 실패 N"이 표시됩니다.'],
    code: ['server/tools.ts · getJson() 타임아웃', 'server/runs.ts · tool 병렬 실행', 'src/components/ToolParts.tsx · StateIcon'],
  },

  'protocol-noise': {
    title: '중복 · 미지 이벤트',
    layer: '프로토콜',
    when: '재연결할 때 재생 구간이 겹쳐 같은 이벤트가 두 번 오는 경우, 서버가 새 이벤트 타입을 먼저 배포해서 구버전 클라이언트가 모르는 타입을 받는 경우입니다.',
    ifIgnored: '텍스트가 "안녕안녕"처럼 중복됩니다. 모르는 타입을 받은 클라이언트가 멈추기도 합니다(CopilotKit #3323).',
    steps: [
      { actor: '런타임', text: 'isKnownEvent가 아니면 무시하고 telemetry에 기록합니다.' },
      { actor: '런타임', text: 'seq가 기대값보다 작으면 중복으로 보고 무시합니다. 기대값보다 크면 구멍으로 보고 이어받기를 합니다.' },
      { actor: '리듀서', text: '한 번 더 seq === lastSeq + 1인지 확인합니다. 런타임과 리듀서의 이중 방어입니다.' },
      { actor: '리듀서', text: '연속된 구간만 먼저 남긴 다음 병합합니다. 순서를 반대로 하면 새 토큰까지 버려지는데, 이 버그는 테스트로 잡았습니다.' },
    ],
    check: ['telemetry에 `ignored  duplicate seq N`과 `ignored  unknown type "…"`가 찍힙니다.', '텍스트는 깨끗합니다.'],
    code: ['src/runtime/protocol.ts · isKnownEvent()', 'src/runtime/ChatRuntime.ts · drive() 이벤트 검증', 'src/runtime/reducer.ts · contiguous()'],
  },

  slow: {
    title: '느린 스트림',
    layer: '속도',
    when: '모델이 느리거나, 추론이 길거나, 혼잡한 시간대인 경우입니다. 사용자가 기다리다가 중지하거나 위로 스크롤해서 앞부분을 읽습니다.',
    ifIgnored:
      '중지해도 서버는 생성을 계속해서 과금됩니다. 앞부분을 읽고 있는 사용자를 새 토큰이 올 때마다 스크롤이 끌어내립니다.',
    steps: [
      { actor: '런타임', text: '중지(Esc/버튼)하면 먼저 큐를 flush합니다. 사용자가 본 마지막 글자와 저장된 마지막 글자가 같아집니다.' },
      { actor: '런타임', text: '로컬 reader를 abort하고 POST /cancel을 보냅니다. 연결을 끊는 것과 중지는 다르게 처리합니다.' },
      { actor: '서버', text: '업스트림 OpenAI 요청을 abort하고 run.cancelled를 남깁니다. 과금이 멈춥니다.' },
      { actor: 'UI', text: '출력이 나오기 전에 중지했다면 방금 보낸 프롬프트를 입력창에 되돌려줍니다.' },
      { actor: 'UI', text: '스크롤은 바닥 근처에 있을 때만 따라갑니다. 위로 올리면(wheel/touch) 즉시 따라가기를 멈추고 "새 응답 보기" 버튼을 띄웁니다.' },
    ],
    check: ['서버 로그에 `cancel (user)`가 찍힙니다.', 'telemetry에 `aborted`가 찍힙니다.', '위로 스크롤하면 화면이 끌려 내려가지 않습니다.'],
    code: ['src/runtime/ChatRuntime.ts · stop()', 'server/runs.ts · Run.cancel()', 'src/components/MessageList.tsx · stick-to-bottom'],
  },
}
