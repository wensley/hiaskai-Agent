/**
 * Cloudflare Worker：静态站点 + 第三方模型转发。
 *
 * - 其余路径交给 Static Assets（dist 里的 SPA 产物）
 * - /api/<vendor>/* 转发到对应上游的 OpenAI 兼容接口，API Key 只存在 Worker secret 里，
 *   浏览器里不出现，也顺带解决了上游没有 CORS、网页端直连会 Failed to fetch 的问题
 */
type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** wrangler secret put AMD_API_KEY */
  AMD_API_KEY?: string
  AMD_API_ORIGIN?: string
  /** wrangler secret put OPENCODE_API_KEY */
  OPENCODE_API_KEY?: string
  OPENCODE_API_ORIGIN?: string
}

type ProxyRoute = {
  /** 站点上的路径前缀，例如 /api/oc */
  prefix: string
  /** 上游根地址，转发时把前缀换成它 */
  origin: string
  key?: string
  label: string
}

const DEFAULT_AMD_ORIGIN = 'https://developer.amd.com.cn/radeon/api/v1'
const DEFAULT_OPENCODE_ORIGIN = 'https://myapi.222532.xyz/v1'
const ALLOWED_METHODS = new Set(['GET', 'POST', 'OPTIONS'])

const routes = (env: Env): ProxyRoute[] => [
  {
    prefix: '/api/amd',
    origin: env.AMD_API_ORIGIN || DEFAULT_AMD_ORIGIN,
    key: env.AMD_API_KEY,
    label: 'AMD',
  },
  {
    prefix: '/api/oc',
    origin: env.OPENCODE_API_ORIGIN || DEFAULT_OPENCODE_ORIGIN,
    key: env.OPENCODE_API_KEY,
    label: 'OpenCode',
  },
]

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

const matchRoute = (pathname: string, env: Env): { route: ProxyRoute; rest: string } | null => {
  for (const route of routes(env)) {
    if (pathname === route.prefix) {
      return { route, rest: '' }
    }
    if (pathname.startsWith(`${route.prefix}/`)) {
      return { route, rest: pathname.slice(route.prefix.length) }
    }
  }
  return null
}

const proxyToUpstream = async (
  request: Request,
  url: URL,
  route: ProxyRoute,
  rest: string
): Promise<Response> => {
  if (!ALLOWED_METHODS.has(request.method)) {
    return json(405, { error: { message: `Method ${request.method} not allowed` } })
  }
  // 同域部署下浏览器不会发预检，这里兼容自定义域名或外部调用
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }
  if (!isSameOrigin(request)) {
    return json(403, { error: { message: 'Forbidden origin' } })
  }
  if (!route.key) {
    return json(500, {
      error: { message: `${route.label} proxy is not configured: missing API key secret` },
    })
  }

  const upstreamUrl = route.origin.replace(/\/+$/, '') + rest + url.search
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${route.key}`)
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
      error: {
        message: `${route.label} upstream unreachable: ${error instanceof Error ? error.message : String(error)}`,
      },
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
    const matched = matchRoute(url.pathname, env)
    if (matched) {
      return proxyToUpstream(request, url, matched.route, matched.rest)
    }
    return env.ASSETS.fetch(request)
  },
}
