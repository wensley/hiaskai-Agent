# 部署到 Cloudflare Workers

纯静态 SPA，用 Workers 的静态资源（Static Assets）托管：不上传任何 Worker 脚本，产物目录 `dist/` 直接由边缘网络分发，免费套餐即可。

- 线上地址：<https://hiaskai.com>（同时绑定 `www.hiaskai.com`）
- Worker 名称：`deepseek-agent`
- 账号：Ron cloudflare account（`767e0bbdd96c7ddf9fe63d0d41908fc2`）
- 域名区域：`hiaskai.com`（已托管在 Cloudflare，NS 为 adrian / clyde.ns.cloudflare.com）

## 一次性准备

```sh
pnpm install          # 会一并装上 wrangler
npx wrangler login    # 已登录可跳过
```

## 发布

```sh
pnpm deploy           # 构建 dist/ + 拷贝 public/ 附加文件 + wrangler deploy
pnpm deploy -- --dry-run   # 只校验不推送
```

构建产物约 8.5 MB / 271 个文件，全部带内容哈希，可长期缓存。`scripts/deploy.mjs` 负责：

1. 清空 `dist/`，以 `NODE_ENV=production` 跑 `rspack build`
2. 把 `public/` 里的东西（`_headers` 等）拷进 `dist/`
3. 调用 `wrangler deploy`

## 配置说明

`wrangler.jsonc`：

- `assets.directory: ./dist` —— 静态资源目录
- `not_found_handling: single-page-application` —— 未命中路径回退到 `index.html`
- `routes` —— `hiaskai.com` 与 `www.hiaskai.com` 走 `custom_domain`，证书由 Cloudflare 自动签发、续期
- `observability.enabled` —— 打开 Workers 观测日志

`public/_headers` 里放了响应头：安全头 + `/static/*` 一年强缓存 + `/index.html` 回源校验。

## 自定义模型与 CORS

「模型接入」里添加的第三方模型由浏览器**直连**服务商，不经过 Worker，所以：

- 服务商必须允许跨域（返回 `Access-Control-Allow-Origin`），OpenRouter、OpenAI、DeepSeek 官方都支持；自建网关记得放行站点域名。
- Key 存在访问者自己的 `localStorage` 里，不会上传到 Worker 或任何后端。
- 想统一代理出口（隐藏 Key、绕过 CORS）时，在 `wrangler.jsonc` 里加一个 `main` 入口做转发，再把「接口地址」改成该路由。

## 注意事项

- **根域不能残留已有 A / AAAA / CNAME 记录**。绑定 `custom_domain` 时若根域上还有外部记录（例如指向 Vercel 的 A 记录），会报 `code 100117: Hostname already has externally managed DNS records`，必须先删掉旧记录再部署。
- 前端直接请求 `https://api.deepseek.com`（`__API_ORIGIN__`），该接口会回显请求的 `Origin` 并允许 CORS，因此不需要额外的代理 Worker。API Key 存在浏览器 `localStorage`，不经过任何自建后端。
- 想把 API 出口换到自建域名，改 `rspack.config.ts` 里 `createConfig({ apiOrigin })` 的默认值即可。
- 回滚：`wrangler rollback`（静态资源版本级回滚）。
