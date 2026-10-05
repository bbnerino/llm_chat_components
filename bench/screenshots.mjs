/**
 * 블로그용 스크린샷을 로컬 Chrome(headless)으로 찍는다.
 * 전제: `npm run dev`가 떠 있을 것 (BFF + Vite).
 *   node bench/screenshots.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdir } from 'node:fs/promises'

const URL = 'http://localhost:5173/'
const OUT = 'docs/images'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ONLY = new Set(process.argv.slice(2))
const want = (name) => ONLY.size === 0 || ONLY.has(name)

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--window-size=1440,900'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.evaluate(() => { localStorage.clear(); location.hash = '' })
  await page.reload({ waitUntil: 'networkidle0' })

  const input = 'textarea[aria-label="메시지 입력"]'
  const send = async (text) => {
    await page.click(input)
    await page.type(input, text)
    await page.keyboard.press('Enter')
  }
  const newThread = () => page.click('.new-thread')
  const selectFault = (value) => page.evaluate((v) => {
    const r = [...document.querySelectorAll('input[name=fault]')][v]
    r.click()
    return r.closest('label').textContent
  }, value)
  const closeDialog = () => page.keyboard.press('Escape')
  const shot = (name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, ...opts })
  const waitIdle = async (max = 40000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < max) {
      const idle = await page.evaluate(() => document.querySelector('.status')?.textContent === 'idle')
      if (idle) return
      await sleep(300)
    }
  }

  // fault 라디오 순서: 0 정상, 1 503, 2 429, 3 끊김, 4 프록시, 5 서버재시작, 6 모델에러, 7 길이, 8 컨텍스트, 9 tool, 10 프로토콜, 11 느림

  // ── C-1. tool이 섞인 응답 ──
  if (want('c-tools-response')) {
    await selectFault(0); await closeDialog()
    await send('부산이랑 서울 날씨 비교하고, 해운대가 어떤 곳인지 위키백과로 알려줘')
    await waitIdle()
    await sleep(500)
    await shot('c-tools-response')
    console.log('c-tools-response')
  }

  // ── C-2. 문서가 패널에서 써지는 중 ──
  if (want('c-document-panel')) {
  await newThread()
  await send('부산 2박 3일 여행 계획서 써줘. 일차별 표도 넣고, 각 장소 설명도 자세히')
  // 문서 패널이 열리고 본문이 어느 정도 쌓일 때까지
  await page.waitForSelector('.doc-panel-body', { timeout: 30000 })
  for (let i = 0; i < 60; i++) {
    const len = await page.evaluate(() => document.querySelector('.doc-panel-body')?.textContent.length ?? 0)
    const idle = await page.evaluate(() => document.querySelector('.status')?.textContent === 'idle')
    if (len > 400 || idle) break
    await sleep(250)
  }
  await shot('c-document-panel')
  console.log('c-document-panel')
  await waitIdle()
  }

  await page.click('[role=tab]:nth-child(2)') // 런타임 탭
  await sleep(300)

  // ── B-1. 장애 재현 패널 ──
  if (want('b-fault-panel')) {
    const aside = await page.$('.side')
    await aside.screenshot({ path: `${OUT}/b-fault-panel.png` })
    console.log('b-fault-panel')
  }

  // ── B-2. 팝업 ──
  if (want('b-fault-dialog')) {
    await selectFault(3) // 응답 중 연결 끊김
    await page.waitForSelector('dialog[open]')
    await sleep(300)
    await shot('b-fault-dialog')
    console.log('b-fault-dialog')
    await closeDialog()
  }

  // ── B-3. 끊김 → 이어받기 성공 ──
  if (want('b-resume-success')) {
    await selectFault(3); await closeDialog()
    await newThread()
    await send('SSE 재연결에서 Last-Event-ID가 하는 역할을 3문단으로 설명해줘 (도구 쓰지 말고)')
    await waitIdle(60000)
    await sleep(300)
    await page.hover('.msg-assistant:last-of-type .assistant-body') // 메트릭 행(이어받기 1회)이 보이도록
    await sleep(300)
    await shot('b-resume-success')
    console.log('b-resume-success')
  }

  // ── B-4. 서버 재시작 → run_gone ──
  if (want('b-run-gone')) {
    await selectFault(5); await closeDialog()
    await newThread()
    await send('HTTP 캐시 헤더를 자세히 설명해줘 (도구 쓰지 말고)')
    await waitIdle(60000)
    await sleep(500)
    await shot('b-run-gone')
    console.log('b-run-gone')
  }

  // ── B-5. 429 카운트다운 ──
  if (want('b-retry-countdown')) {
    await selectFault(2); await closeDialog()
    await newThread()
    await send('React 렌더링 최적화 방법 3가지만 짧게')
    await page.waitForSelector('.run-status.retry', { timeout: 10000 })
    await sleep(600)
    await shot('b-retry-countdown')
    console.log('b-retry-countdown')
    await waitIdle(60000)
  }

  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
