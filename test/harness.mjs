import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** Boot a mock SearXNG instance; `handler` decides each response. */
async function mockInstance(handler) {
  const state = { requests: [], hits: 0 }
  const server = createServer((req, res) => {
    state.hits += 1
    const url = new URL(req.url, 'http://127.0.0.1')
    state.requests.push({ url, headers: req.headers })
    handler(url, res, state)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Mount the plugin against a fake ctx and return the registered provider. */
function mount(config) {
  let provider
  apply({ web: { registerSearchProvider: (value) => { provider = value } } }, config)
  return provider
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const results = [
  { url: 'https://a.example/1', title: 'Alpha <b>bold</b>', content: 'Snippet &amp; more <i>here</i>', publishedDate: '2026-01-02T03:04:05' },
  { url: 'https://a.example/1', title: 'Duplicate', content: 'dup' },
  { url: 'https://b.example/2', title: '', content: '', publishedDate: 'not-a-date' },
  { url: 'ftp://c.example/3', title: 'Bad scheme', content: 'x' },
  { url: 'https://d.example/4', title: 'Delta', content: 'fourth', pubdate: '2025-06-01' },
]

const tests = []
const test = (label, run) => tests.push({ label, run })

test('maps, cleans, dedupes and bounds results', async () => {
  const mock = await mockInstance((url, res) => json(res, { results }))
  try {
    const provider = mount({ baseURL: mock.baseURL })
    assert.equal(provider.id, 'searxng')
    assert.equal(provider.available(), true)

    const out = await provider.search({ query: 'hello world', maxResults: 3 })
    assert.equal(out.sources.length, 3, 'respects maxResults')
    assert.equal(out.truncated, false)

    const [first, second, third] = out.sources
    assert.equal(first.url, 'https://a.example/1')
    assert.equal(first.title, 'Alpha bold', 'strips inline tags')
    assert.equal(first.snippet, 'Snippet & more here', 'decodes entities and strips tags')
    assert.equal(first.publishedAt, '2026-01-02T03:04:05.000Z', 'normalizes to ISO')

    assert.equal(second.url, 'https://b.example/2', 'duplicate URL dropped')
    assert.equal(second.title, undefined, 'empty title omitted')
    assert.equal(second.publishedAt, undefined, 'invalid date dropped')

    assert.equal(third.url, 'https://d.example/4', 'ftp:// URL skipped')
    assert.equal(third.publishedAt, '2025-06-01T00:00:00.000Z', 'falls back to pubdate')

    const sent = mock.state.requests[0].url
    assert.equal(sent.pathname, '/search')
    assert.equal(sent.searchParams.get('format'), 'json')
    assert.equal(sent.searchParams.get('q'), 'hello world')
    assert.equal(sent.searchParams.get('categories'), 'general')
    assert.equal(sent.searchParams.get('safesearch'), '1')
    assert.equal(sent.searchParams.get('pageno'), '1')
    assert.equal(mock.state.requests[0].headers['user-agent'], 'dsh-web-search-searxng/0.1.0')
  } finally {
    await mock.close()
  }
})

test('preserves a base URL path prefix and sends configured params', async () => {
  const mock = await mockInstance((url, res) => json(res, { results: [] }))
  try {
    const provider = mount({
      baseURL: `${mock.baseURL}/searxng/`,
      language: 'zh-CN',
      engines: ['google', 'bing'],
      safesearch: 0,
      token: 'secret-token',
    })
    await provider.search({ query: 'q' })
    const req = mock.state.requests[0]
    assert.equal(req.url.pathname, '/searxng/search', 'keeps the path prefix')
    assert.equal(req.url.searchParams.get('language'), 'zh-CN')
    assert.equal(req.url.searchParams.get('engines'), 'google,bing')
    assert.equal(req.url.searchParams.get('safesearch'), '0')
    assert.equal(req.headers.authorization, 'Bearer secret-token')
  } finally {
    await mock.close()
  }
})

test('caches an identical query', async () => {
  const mock = await mockInstance((url, res) => json(res, { results }))
  try {
    const provider = mount({ baseURL: mock.baseURL, cacheTtlMs: 60_000 })
    await provider.search({ query: 'same', maxResults: 2 })
    await provider.search({ query: 'same', maxResults: 2 })
    assert.equal(mock.state.hits, 1, 'second call served from cache')
    await provider.search({ query: 'same', maxResults: 5 })
    assert.equal(mock.state.hits, 2, 'a different bound is a different cache key')
  } finally {
    await mock.close()
  }
})

test('403 explains the json format and limiter', async () => {
  const mock = await mockInstance((url, res) => {
    res.writeHead(403, { 'content-type': 'text/html' })
    res.end('<h1>Forbidden</h1>')
  })
  try {
    const provider = mount({ baseURL: mock.baseURL })
    await assert.rejects(provider.search({ query: 'x' }), (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_ERROR')
      assert.match(error.message, /HTTP 403/)
      assert.match(error.message, /search\.formats/)
      return true
    })
  } finally {
    await mock.close()
  }
})

test('429 points at the limiter', async () => {
  const mock = await mockInstance((url, res) => {
    res.writeHead(429, { 'content-type': 'text/plain' })
    res.end('Too Many Requests')
  })
  try {
    const provider = mount({ baseURL: mock.baseURL })
    await assert.rejects(provider.search({ query: 'x' }), (error) => {
      assert.match(error.message, /limiter/)
      return true
    })
  } finally {
    await mock.close()
  }
})

test('HTTP 200 with an anti-bot page is reported as degraded', async () => {
  const mock = await mockInstance((url, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>Verifying your browser…</body></html>')
  })
  try {
    const provider = mount({ baseURL: mock.baseURL })
    await assert.rejects(provider.search({ query: 'x' }), (error) => {
      assert.match(error.message, /anti-bot|degraded/)
      return true
    })
  } finally {
    await mock.close()
  }
})

test('JSON without results[] is a protocol violation', async () => {
  const mock = await mockInstance((url, res) => json(res, { error: 'nope' }))
  try {
    const provider = mount({ baseURL: mock.baseURL })
    await assert.rejects(provider.search({ query: 'x' }), (error) => {
      assert.match(error.message, /results\[\]/)
      return true
    })
  } finally {
    await mock.close()
  }
})

test('an empty result set is a success', async () => {
  const mock = await mockInstance((url, res) => json(res, { results: [] }))
  try {
    const provider = mount({ baseURL: mock.baseURL })
    const out = await provider.search({ query: 'nothing' })
    assert.deepEqual(out, { sources: [], truncated: false })
  } finally {
    await mock.close()
  }
})

test('caller cancellation surfaces as WEB_ABORTED', async () => {
  const mock = await mockInstance(() => {
    /* never answers */
  })
  try {
    const provider = mount({ baseURL: mock.baseURL, timeoutMs: 30_000 })
    const controller = new AbortController()
    const pending = provider.search({ query: 'slow' }, controller.signal)
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'WEB_ABORTED')
      return true
    })
  } finally {
    await mock.close()
  }
})

test('a hung instance surfaces as a timeout, not an abort', async () => {
  const mock = await mockInstance(() => {
    /* never answers */
  })
  try {
    const provider = mount({ baseURL: mock.baseURL, timeoutMs: 80 })
    await assert.rejects(provider.search({ query: 'slow' }), (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_ERROR')
      assert.match(error.message, /timed out after 80ms/)
      return true
    })
  } finally {
    await mock.close()
  }
})

test('an invalid base URL makes the provider unavailable', async () => {
  for (const baseURL of ['', '   ', 'ftp://x', 'not a url', 'http://user:pass@host']) {
    const provider = mount({ baseURL })
    assert.equal(provider.available(), false, `rejected ${JSON.stringify(baseURL)}`)
    await assert.rejects(provider.search({ query: 'x' }), (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
      return true
    })
  }
})

test('concurrency stays within the configured bound', async () => {
  let inFlight = 0
  let peak = 0
  const mock = await mockInstance((url, res) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    setTimeout(() => {
      inFlight -= 1
      json(res, { results: [] })
    }, 40)
  })
  try {
    const provider = mount({ baseURL: mock.baseURL, maxConcurrency: 2 })
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((query) => provider.search({ query })),
    )
    assert.ok(peak <= 2, `peak concurrency ${peak} exceeded 2`)
    assert.equal(mock.state.hits, 5, 'every query still reached the instance')
  } finally {
    await mock.close()
  }
})

test('a refused connection names the socket error', async () => {
  const provider = mount({ baseURL: 'http://127.0.0.1:59991', timeoutMs: 5_000 })
  await assert.rejects(provider.search({ query: 'x' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /ECONNREFUSED/, `message was: ${error.message}`)
    return true
  })
})

let failed = 0
for (const { label, run } of tests) {
  try {
    await run()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed === 0 ? 0 : 1)
