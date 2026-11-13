/**
 * SearXNG search provider for the DeepSeek Harness web seam (`ctx.web`).
 *
 * Deliberately imports nothing. A profile plugin that imports `@deepseek-ai/*`
 * packages has to pin their exact versions, and every DSH release then breaks
 * it. This one only uses the platform (`fetch`, `AbortSignal`, `URL`), so it
 * keeps working across DSH upgrades.
 */

export const name = 'web-search-searxng'
export const inject = ['web']

const PROVIDER_ID = 'searxng'
const USER_AGENT = 'dsh-web-search-searxng/0.1.0'

/** Anti-bot interstitials some instances answer with HTTP 200 instead of JSON. */
const ANTI_BOT_RE =
  /(verifying your browser|making sure you.?re not a bot|checking you are not a bot|just a moment|enable javascript|anubis|captcha|browser verification)/i

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Error carrying the seam's machine-routable `code`. */
class SearchError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

/** Resolve the configured instance root to a validated base URL, or undefined. */
function normalizeBaseURL(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let url
  try {
    url = new URL(value.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

/** Build the `/search` endpoint, preserving any path prefix on the base URL. */
function searchEndpoint(base, params) {
  const url = new URL(base.href)
  // A root base URL keeps pathname "/", so strip slashes before joining or the
  // result is "//search", which URL parsers read as a protocol-relative host.
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
  }
  return url
}

/** Strip tags and decode the handful of entities SearXNG snippets actually use. */
function cleanText(value) {
  if (typeof value !== 'string') return undefined
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body) => {
      const key = body.toLowerCase()
      if (ENTITIES[key] !== undefined) return ENTITIES[key]
      const code = key.startsWith('#x')
        ? Number.parseInt(key.slice(2), 16)
        : key.startsWith('#')
          ? Number.parseInt(key.slice(1), 10)
          : Number.NaN
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ' '
      try {
        return String.fromCodePoint(code)
      } catch {
        return ' '
      }
    })
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? undefined : text
}

/** Normalize a provider-supplied publication date to ISO-8601, or drop it. */
function toIsoDate(value) {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (raw === '') return undefined
  // SearXNG serializes a naive Python datetime. `Date.parse` would read it in
  // the host's timezone, so the same result would render differently on every
  // machine; pin naive datetimes to UTC instead.
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(raw)
  const parsed = Date.parse(naive ? `${raw.replace(' ', 'T')}Z` : raw)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

/** Accept only absolute http(s) result URLs. */
function httpUrl(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function positiveInt(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.floor(number), max)
}

/**
 * Surface the useful half of a fetch failure. Node reports a refused
 * connection as `TypeError: fetch failed` and hides `ECONNREFUSED` in `cause`,
 * which is exactly the detail a wrong `baseURL` needs.
 */
function describeError(error) {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  if (cause instanceof Error) {
    const code = typeof cause.code === 'string' ? cause.code : undefined
    return code === undefined ? `${error.message} (${cause.message})` : `${error.message} (${code})`
  }
  return error.message
}

/** Bound concurrent upstream requests: one query fans out to several engines. */
function createLimiter(max) {
  let active = 0
  const waiting = []
  const release = () => {
    active -= 1
    const next = waiting.shift()
    if (next !== undefined) next()
  }
  return async (run) => {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve))
    active += 1
    try {
      return await run()
    } finally {
      release()
    }
  }
}

/** Small TTL cache: the same query usually repeats across adjacent turns. */
function createCache(ttlMs, maxEntries) {
  const entries = new Map()
  return {
    get(key) {
      const hit = entries.get(key)
      if (hit === undefined) return undefined
      if (hit.expires <= Date.now()) {
        entries.delete(key)
        return undefined
      }
      entries.delete(key)
      entries.set(key, hit)
      return hit.value
    },
    set(key, value) {
      if (ttlMs <= 0) return
      entries.set(key, { value, expires: Date.now() + ttlMs })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
    },
  }
}

/** Read config once per search so a saved change applies to the next call. */
function readConfig(raw) {
  const config = raw ?? {}
  return {
    baseURL: normalizeBaseURL(config.baseURL),
    token: typeof config.token === 'string' ? config.token : '',
    language: typeof config.language === 'string' ? config.language : '',
    safesearch: config.safesearch === undefined ? 1 : Number(config.safesearch),
    categories: typeof config.categories === 'string' ? config.categories : 'general',
    engines: Array.isArray(config.engines) ? config.engines.filter((e) => typeof e === 'string' && e !== '') : [],
    timeoutMs: positiveInt(config.timeoutMs, 20_000, 120_000),
    maxResults: positiveInt(config.maxResults, 10, 50),
    cacheTtlMs: Number.isFinite(Number(config.cacheTtlMs)) ? Math.max(0, Number(config.cacheTtlMs)) : 60_000,
    cacheEntries: positiveInt(config.cacheEntries, 100, 1_000),
    maxConcurrency: positiveInt(config.maxConcurrency, 2, 16),
    debug: config.debug === true,
  }
}

/** One SearXNG request. Returns the raw JSON payload. */
async function requestSearXNG(config, query, limit, signal, run) {
  const endpoint = searchEndpoint(config.baseURL, {
    q: query,
    format: 'json',
    categories: config.categories,
    language: config.language,
    safesearch: Number.isFinite(config.safesearch) ? config.safesearch : 1,
    engines: config.engines.length > 0 ? config.engines.join(',') : '',
    pageno: 1,
  })

  const headers = { accept: 'application/json', 'user-agent': USER_AGENT }
  if (config.token !== '') headers.authorization = `Bearer ${config.token}`

  return run(async () => {
    const deadline = AbortSignal.timeout(config.timeoutMs)
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])

    let response
    try {
      response = await fetch(endpoint, { method: 'GET', redirect: 'error', headers, signal: combined })
    } catch (error) {
      if (signal?.aborted === true) {
        throw new SearchError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      }
      if (deadline.aborted) {
        throw new SearchError(`SearXNG timed out after ${config.timeoutMs}ms`, 'WEB_PROVIDER_ERROR', { cause: error })
      }
      throw new SearchError(
        `SearXNG request failed: ${describeError(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }

    const text = await response.text().catch(() => '')

    if (!response.ok) {
      const hint =
        response.status === 403
          ? ' — is `search.formats` missing `json` in settings.yml, or is the limiter blocking this client?'
          : response.status === 429
            ? ' — the SearXNG limiter is throttling this client; set `server.limiter: false` or allowlist the address.'
            : ''
      const detail = cleanText(text.slice(0, 300))
      throw new SearchError(
        `SearXNG HTTP ${response.status}${hint}${detail === undefined ? '' : ` (${detail})`}`,
        'WEB_PROVIDER_ERROR',
      )
    }

    try {
      return JSON.parse(text)
    } catch (error) {
      const contentType = response.headers.get('content-type') ?? ''
      const degraded =
        /text\/html/i.test(contentType) || ANTI_BOT_RE.test(text.slice(0, 4096))
      throw new SearchError(
        degraded
          ? 'SearXNG answered HTTP 200 with an HTML/anti-bot page instead of JSON — the instance is degraded, not misconfigured.'
          : `SearXNG returned non-JSON (content-type: ${contentType === '' ? 'unknown' : contentType})`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  })
}

/** Map a SearXNG payload onto the seam's source shape. */
function mapPayload(payload, limit) {
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    throw new SearchError('SearXNG response has no results[] array — not a SearXNG API response?', 'WEB_PROVIDER_ERROR')
  }

  const sources = []
  const seen = new Set()
  for (const item of payload.results) {
    if (sources.length >= limit) break
    if (item === null || typeof item !== 'object') continue
    const url = httpUrl(item.url)
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = cleanText(item.title)
    const snippet = cleanText(item.content)
    const publishedAt = toIsoDate(item.publishedDate) ?? toIsoDate(item.pubdate)
    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  return sources
}

export function apply(ctx, rawConfig) {
  const initial = readConfig(rawConfig)
  const cache = createCache(initial.cacheTtlMs, initial.cacheEntries)
  const limit = createLimiter(initial.maxConcurrency)

  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    title: 'SearXNG',
    description: {
      en: 'Self-hosted metasearch. Free and unmetered; result quality depends on the upstream engines.',
      zh: '自建元搜索，免费且不限量；结果质量取决于上游引擎。',
    },

    // Cheap local check only — the seam calls this during provider selection.
    available: () => readConfig(rawConfig).baseURL !== undefined,

    // Keyless, so a valid endpoint is the only readiness requirement.
    ready: async () => readConfig(rawConfig).baseURL !== undefined,

    async search(request, signal) {
      const config = readConfig(rawConfig)
      if (config.baseURL === undefined) {
        throw new SearchError(
          'SearXNG baseURL is missing or invalid; set an absolute http(s) URL such as http://127.0.0.1:8080',
          'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
        )
      }

      const requested = Number(request?.maxResults)
      const bound = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : config.maxResults
      const wanted = Math.min(bound, 50)
      const key = `${request.query}\u0000${wanted}`

      const cached = cache.get(key)
      if (cached !== undefined) return { sources: cached, truncated: false }

      const payload = await requestSearXNG(config, request.query, wanted, signal, limit)
      const sources = mapPayload(payload, wanted)

      if (config.debug) {
        const down = Array.isArray(payload.unresponsive_engines) ? payload.unresponsive_engines : []
        if (down.length > 0) {
          console.warn(`[searxng] unresponsive engines: ${down.map((e) => (Array.isArray(e) ? e[0] : e)).join(', ')}`)
        }
      }

      cache.set(key, sources)
      return { sources, truncated: false }
    },
  })
}
