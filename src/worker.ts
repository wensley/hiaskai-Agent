/**
 * Cloudflare Worker：静态站点 + 模型转发。
 *
 * - 其余路径交给 Static Assets（dist 里的 SPA 产物）
 * - /api/amd/* 转发到 developer.amd.com.cn 的 OpenAI 兼容接口，
 *   API Key 只存在 Worker secret 里，浏览器里不出现，也就绕开了上游没有 CORS 的问题
 */
type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** wrangler secret put AMD_API_KEY */
  AMD_API_KEY?: string
  /** 上游根地址，默认 AMD 的 Radeon 网关 */
  AMD_API_ORIGIN?: string
}

const PROXY_PREFIX = '/api/amd'
const DEFAULT_ORIGIN = 'https://developer.amd.com.cn/radeon/api/v1'
const ALLOWED_METHODS = new Set(['GET', 'POST', 'OPTIONS'])

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

/** 同源校验：带了 Origin 时必须与站点同源，避免别人的网页拿我们的额度 */
const isSameOrigin = (request: Request): boolean => {
  const origin = request.headers.get('Origin')
  if (!origin) {
    return true
  }
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}

/** 只允许带鉴权与内容类型，其他头（尤其来源的 Authorization）一律不带 */
const proxyToUpstream = async (request: Request, url: URL, env: Env): Promise<Response> => {
  if (!ALLOWED_METHODS.has(request.method)) {
    return json(405, { error: { message: `Method ${request.method} not allowed` } })
  }
  // 浏览器预检：同域部署下不会走到这里，兼容自定义域名时顺手支持
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }
  if (!isSameOrigin(request)) {
    return json(403, { error: { message: 'Forbidden origin' } })
  }
  const key = env.AMD_API_KEY
  if (!key) {
    return json(500, { error: { message: 'AMD_API_KEY is not configured for this Worker' } })
  }

  const base = (env.AMD_API_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '')
  const upstreamUrl = base + url.pathname.slice(PROXY_PREFIX.length) + url.search

  const headers = new Headers()
  headers.set('Authorization', `Bearer ${key}`)
  const contentType = request.headers.get('Content-Type')
  if (contentType) {
    headers.set('Content-Type', contentType)
  }
  const accept = request.headers.get('Accept')
  if (accept) {
    headers.set('Accept', accept)
  }

  const init: RequestInit = { method: request.method, headers }
  if (request.method !== 'GET' && request.body) {
    // 流式请求体必须半双工，否则 Workers 会报错
    init.body = request.body
    ;(init as RequestInit & { duplex: 'half' }).duplex = 'half'
  }

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, init)
  } catch (error) {
    return json(502, {
      error: { message: `upstream unreachable: ${error instanceof Error ? error.message : String(error)}` },
    })
  }

  // SSE 原样透传：不能缓冲，否则首字延迟会退化成整段返回
  const responseHeaders = new Headers()
  const upstreamType = upstream.headers.get('Content-Type')
  if (upstreamType) {
    responseHeaders.set('Content-Type', upstreamType)
  }
  responseHeaders.set('Cache-Control', 'no-store')
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}

// Cloudflare 模块化 Worker 必须默认导出一个带 fetch 的对象
// eslint-disable-next-line import/no-default-export
// oxlint-disable-next-line import/no-default-export
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === PROXY_PREFIX || url.pathname.startsWith(`${PROXY_PREFIX}/`)) {
      return proxyToUpstream(request, url, env)
    }
    return env.ASSETS.fetch(request)
  },
}
