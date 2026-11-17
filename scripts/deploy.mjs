#!/usr/bin/env node
// 构建静态产物并部署到 Cloudflare Workers（静态资源模式）。
// 用法：pnpm deploy   /   pnpm deploy -- --dry-run
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const publicDir = path.join(root, 'public')
const isWindows = process.platform === 'win32'
// 直接在 node 里跑时不会自动带上 node_modules/.bin，手动补进 PATH
const binPath = path.join(root, 'node_modules', '.bin')

/** 同步执行命令，失败即退出 */
const run = (bin, args, env = {}) => {
  const result = spawnSync(bin, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
    env: {
      ...process.env,
      PATH: `${binPath}${path.delimiter}${process.env.PATH ?? ''}`,
      ...env,
    },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// 1. 干净构建（rspack 的 output.clean 只清空输出目录，这里先删一次避免残留）
rmSync(dist, { recursive: true, force: true })
run('rspack', ['build', '-c', 'rspack.config.ts'], { NODE_ENV: 'production' })

// 2. 把 public/ 下的部署附加文件（_headers、_redirects 等）拷进产物目录
if (existsSync(publicDir)) {
  mkdirSync(dist, { recursive: true })
  for (const entry of readdirSync(publicDir, { withFileTypes: true })) {
    cpSync(path.join(publicDir, entry.name), path.join(dist, entry.name), { recursive: true })
  }
}

// 3. 部署（--build-only 只构建不部署）
const args = process.argv.slice(2)
if (args.includes('--build-only')) {
  console.log('构建完成（--build-only，跳过部署）')
  process.exit(0)
}
run('npx', ['--yes', 'wrangler@4', 'deploy', ...args])
