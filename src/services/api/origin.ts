/** 构建期注入的公开 API 地址，默认 https://api.deepseek.com；本地开发可走开发服务器代理 */
export const API_ORIGIN: string = __API_ORIGIN__

/** Anthropic 兼容接口的前缀，内置模型与缓存拉取都用它 */
export const ANTHROPIC_BASE_URL = `${API_ORIGIN}/anthropic/v1`
