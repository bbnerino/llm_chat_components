/**
 * 스트리밍 중인 tool arguments(불완전한 JSON)를 "지금까지 확정된 만큼" 파싱한다.
 *
 * 모델은 tool arguments를 토큰 단위로 흘려보낸다:
 *   '{"title":"서울 여행 계'  →  '{"title":"서울 여행 계획","body":"# 1일'  → ...
 * 매번 JSON.parse를 하면 끝날 때까지 전부 예외다. 그래서 문서 작성 같은 tool은
 * "다 받을 때까지 스피너"만 보여주게 되는데, 그러면 스트리밍의 의미가 사라진다.
 *
 * 전략: 문자열을 한 번 훑으며 열린 괄호/문자열 상태를 스택으로 추적하고,
 * 끝에서 "닫는 토큰을 보충"한 뒤 JSON.parse한다. 보충이 불가능한 꼬리
 * (키만 있고 값이 없음, 쉼표로 끝남, 이스케이프 중간 등)는 잘라낸다.
 *
 * 결과는 항상 "완성본의 접두(prefix)"를 의미하는 값이므로 UI가 안심하고 그릴 수 있다.
 */
export function parsePartialJson<T = unknown>(input: string): T | undefined {
  const text = input.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    // 아래에서 복구 시도
  }

  const stack: ('{' | '[')[] = []
  let inString = false
  let escaped = false
  // 마지막으로 "안전하게 자를 수 있는" 위치와 그 시점의 스택 스냅샷
  let safeEnd = 0
  let safeStack: ('{' | '[')[] = []
  let safeInString = false

  const markSafe = (end: number, str: boolean) => {
    safeEnd = end
    safeStack = [...stack]
    safeInString = str
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = false
        markSafe(i + 1, false)
        continue
      }
      // 문자열 내부의 일반 문자: 여기서 잘라도 '"'만 보충하면 된다.
      // 단, \uXXXX가 끝나기 전에 잘리면 안 되므로 이스케이프 중간은 제외(위에서 처리)
      markSafe(i + 1, true)
      continue
    }
    switch (ch) {
      case '"':
        inString = true
        markSafe(i + 1, true)
        break
      case '{':
      case '[':
        stack.push(ch)
        markSafe(i + 1, false)
        break
      case '}':
      case ']':
        stack.pop()
        markSafe(i + 1, false)
        break
      case ',':
      case ':':
        // 여기서 끝나면 값이 비어있는 상태 → 이 지점은 안전하지 않다(직전 safe 유지)
        break
      default:
        // 숫자/true/false/null 리터럴은 완성 여부를 알 수 없으므로 끝나는 지점에서만 safe
        if (/\s/.test(ch)) break
        if (/[\d.eE+\-a-z]/.test(ch)) {
          const next = text[i + 1]
          if (next === undefined) break // 리터럴이 끝나지 않았을 수 있다 ("tru", "12" → "123"?)
          if (!/[\d.eE+\-a-z]/.test(next)) markSafe(i + 1, false)
        }
    }
  }

  let candidate = text.slice(0, safeEnd)
  if (safeInString) candidate += '"'
  candidate = candidate.replace(/[,:\s]+$/, '')
  // 객체 안에서 키 문자열만 있고 값이 없는 꼬리 제거: {"a":1,"b"  →  {"a":1
  if (safeStack.at(-1) === '{') candidate = candidate.replace(/,?\s*"(?:[^"\\]|\\.)*"$/, (m) => (isKeyPosition(candidate, m) ? '' : m))
  candidate = candidate.replace(/[,:\s]+$/, '')

  for (let i = safeStack.length - 1; i >= 0; i--) candidate += safeStack[i] === '{' ? '}' : ']'

  try {
    return JSON.parse(candidate) as T
  } catch {
    return undefined
  }
}

/** 꼬리 문자열이 객체의 "키" 자리인지(= 바로 앞이 '{' 또는 ',') 판정 */
function isKeyPosition(full: string, tail: string): boolean {
  const before = full.slice(0, full.length - tail.length).trimEnd()
  const prev = tail.trimStart().startsWith(',') ? ',' : before.at(-1)
  return prev === '{' || prev === ','
}
