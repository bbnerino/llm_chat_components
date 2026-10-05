/**
 * 벤치마크용 렌더 카운터. 개발 빌드에서 `window.__renders`가 있을 때만 센다.
 * 프로덕션 빌드에서는 `import.meta.env.DEV`가 false라 호출 자체가 제거된다.
 */
declare global {
  interface Window {
    __renders?: Record<string, number>
  }
}

export function countRender(name: string) {
  if (!import.meta.env.DEV) return
  const r = typeof window !== 'undefined' ? window.__renders : undefined
  if (r) r[name] = (r[name] ?? 0) + 1
}
