/**
 * BFF에서 실행되는 tool들.
 *
 * 각 tool은 (1) 모델에게 보낼 JSON Schema 정의와 (2) 실제 실행 함수로 구성된다.
 * 실행 함수는 반드시 AbortSignal을 받는다 — 사용자가 중지하면 진행 중인 외부 API 호출도 끊어야 한다.
 * 결과는 "UI가 그릴 구조화 데이터"이고, 모델에게는 같은 데이터를 JSON 문자열로 돌려준다.
 */

export class ToolExecutionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

interface ToolDef {
  definition: {
    type: 'function'
    name: string
    description: string
    parameters: Record<string, unknown>
    strict: true
  }
  execute: (args: any, signal: AbortSignal) => Promise<unknown>
  /** 결과를 모델에게 돌려줄 필요가 없는 표시 전용 tool. 이것만 호출됐다면 agent loop를 끝낸다. */
  terminal?: boolean
}

const UA = { 'User-Agent': 'ai-response-runtime-demo/0.1' }

const TOOL_TIMEOUT_MS = 8_000

/**
 * 외부 API가 응답하지 않으면 tool 하나가 run 전체를 붙잡는다.
 * 사용자 중지(signal)와 타임아웃 중 먼저 오는 쪽으로 끊는다.
 */
async function getJson(url: string, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.any([signal, AbortSignal.timeout(TOOL_TIMEOUT_MS)]) }).catch((err) => {
    if (signal.aborted) throw err
    throw new ToolExecutionError(
      err?.name === 'TimeoutError' ? 'tool_timeout' : 'network_error',
      err?.name === 'TimeoutError' ? '외부 API 응답이 너무 늦습니다.' : '외부 API에 연결할 수 없습니다.',
    )
  })
  if (!res.ok) throw new ToolExecutionError('upstream_error', `외부 API 오류 (HTTP ${res.status})`)
  return res.json()
}

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

// WMO weather code → 한국어 요약
const WMO: Record<number, string> = {
  0: '맑음', 1: '대체로 맑음', 2: '구름 조금', 3: '흐림', 45: '안개', 48: '서리 안개',
  51: '약한 이슬비', 53: '이슬비', 55: '강한 이슬비', 61: '약한 비', 63: '비', 65: '강한 비',
  71: '약한 눈', 73: '눈', 75: '강한 눈', 80: '소나기', 81: '소나기', 82: '강한 소나기', 95: '뇌우',
}

export const TOOLS: Record<string, ToolDef> = {
  search_wikipedia: {
    definition: {
      type: 'function',
      name: 'search_wikipedia',
      description: '위키백과에서 사실 정보를 검색한다. 사실 확인이 필요한 질문에 사용하고, 답변에 출처를 인용한다.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '검색어' },
          lang: { type: 'string', enum: ['ko', 'en'], description: '위키백과 언어' },
        },
        required: ['query', 'lang'],
        additionalProperties: false,
      },
      strict: true,
    },
    async execute({ query, lang }: { query: string; lang: 'ko' | 'en' }, signal) {
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=4&srsearch=${encodeURIComponent(query)}`
      const data = await getJson(url, signal)
      const results = (data.query?.search ?? []).map((r: any) => ({
        title: r.title,
        snippet: stripHtml(r.snippet),
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
      }))
      if (results.length === 0) throw new ToolExecutionError('no_results', `"${query}"에 대한 검색 결과가 없습니다.`)
      return { query, results }
    },
  },

  get_weather: {
    definition: {
      type: 'function',
      name: 'get_weather',
      description: '도시의 현재 날씨와 3일 예보를 조회한다. 도시 이름은 영어로 전달한다 (예: Seoul, Busan).',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '영문 도시명' } },
        required: ['city'],
        additionalProperties: false,
      },
      strict: true,
    },
    async execute({ city }: { city: string }, signal) {
      const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=ko&name=${encodeURIComponent(city)}`, signal)
      const place = geo.results?.[0]
      if (!place) throw new ToolExecutionError('city_not_found', `"${city}" 도시를 찾을 수 없습니다.`)
      const w = await getJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
          '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m' +
          '&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=3',
        signal,
      )
      return {
        city: place.name,
        country: place.country,
        current: {
          temperature: w.current.temperature_2m,
          humidity: w.current.relative_humidity_2m,
          wind: w.current.wind_speed_10m,
          summary: WMO[w.current.weather_code] ?? '알 수 없음',
        },
        daily: w.daily.time.map((date: string, i: number) => ({
          date,
          max: w.daily.temperature_2m_max[i],
          min: w.daily.temperature_2m_min[i],
          summary: WMO[w.daily.weather_code[i]] ?? '알 수 없음',
        })),
      }
    },
  },

  create_document: {
    definition: {
      type: 'function',
      name: 'create_document',
      description:
        '사용자가 문서, 계획서, 보고서, 글 등 "결과물"을 요청할 때 마크다운 문서를 작성한다. 짧은 답변에는 사용하지 않는다. 문서를 만든 뒤에는 채팅에 한두 문장으로만 요약한다.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '문서 제목' },
          content: { type: 'string', description: '마크다운 본문' },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
      strict: true,
    },
    // 문서 자체는 arguments로 이미 전달됐다. 실행은 "저장"에 해당한다.
    async execute({ title, content }: { title: string; content: string }) {
      return { documentId: crypto.randomUUID(), title, chars: content.length }
    },
  },

  suggest_followups: {
    definition: {
      type: 'function',
      name: 'suggest_followups',
      description: '답변을 마친 뒤 사용자가 이어서 물어볼 만한 후속 질문 2~3개를 제안한다. 매 답변의 마지막에 한 번 호출한다.',
      parameters: {
        type: 'object',
        properties: { questions: { type: 'array', items: { type: 'string' }, description: '짧은 후속 질문들' } },
        required: ['questions'],
        additionalProperties: false,
      },
      strict: true,
    },
    async execute({ questions }: { questions: string[] }) {
      return { questions: questions.slice(0, 3) }
    },
    terminal: true,
  },

  get_current_time: {
    definition: {
      type: 'function',
      name: 'get_current_time',
      description: '현재 날짜와 시간(Asia/Seoul)을 조회한다. "오늘", "내일" 등 날짜 계산이 필요할 때 사용한다.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      strict: true,
    },
    async execute() {
      return { now: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) }
    },
  },
}

export const TOOL_DEFINITIONS = Object.values(TOOLS).map((t) => t.definition)
