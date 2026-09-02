#!/usr/bin/env node
/** One-off: verify completion settle closes the gap with zero text motion, and pad reclaim on re-stream. */
import { chromium } from 'playwright-core'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({
  entryPoints: [join(root, 'repro', 'stress-120fps.tsx')],
  bundle: true, format: 'esm', platform: 'browser',
  outfile: join(root, 'repro', 'stress-120fps.bundle.js'),
  loader: { '.css': 'local-css' },
  alias: {
    '@deepseek-ai/dsh-client-ui-primitives': join(root, 'repro', 'shims', 'primitives.tsx'),
    '@deepseek-ai/dsh-client-runtime': join(root, 'repro', 'shims', 'client-runtime.ts'),
    '@deepseek-ai/dsh-client-runtime/client': join(root, 'repro', 'shims', 'client-runtime.ts'),
  },
  jsx: 'automatic', logLevel: 'silent', write: false,
})
const files = new Map(bundle.outputFiles.map(f => [f.path, f.contents]))
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (req, res) => {
  const p = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/^\//, '') || 'stress-120fps.html'
  const fp = join(root, 'repro', p)
  const mem = files.get(fp)
  if (mem !== undefined) { res.writeHead(200, { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(mem); return }
  if (existsSync(fp)) { res.writeHead(200, { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(await readFile(fp)); return }
  res.writeHead(404); res.end()
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/stress-120fps.html`
const exe = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync)
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--force-device-scale-factor=1'] })

async function runScenario(page, label) {
  await page.evaluate(() => { window.__samples = [] })
  await page.evaluate(() => {
    let last = null
    const record = () => {
      const port = document.querySelector('[data-conversation-scroll]')
      const user = document.querySelector('[data-chat-anchor-key="user-1"]')
      const status = document.querySelector('[data-chat-flow] > [role="status"]')
      const text = document.querySelector('[data-chat-anchor-key="assistant-1"]')
      if (port && status && text) {
        window.__samples.push({
          t: performance.now(),
          textBottom: text.getBoundingClientRect().bottom,
          statusTop: status.getBoundingClientRect().top,
          userTop: user ? user.getBoundingClientRect().top : null,
          mTop: status.style.marginTop,
          mBottom: status.style.marginBottom,
          st: port.scrollTop,
        })
      }
      requestAnimationFrame(record)
    }
    if (!window.__recording) { window.__recording = true; requestAnimationFrame(record) }
  })
  await page.evaluate(opts => window.__runStressTest(opts), { cps: 600, domCostMs: 0, scenario: 'steady' })
  await new Promise(r => setTimeout(r, 5200))
  const s = await page.evaluate(() => window.__samples)
  const active = s.filter(f => f.st > 10)
  let maxTextMove = 0
  let maxDownUser = 0
  const tail = active.slice(-60)
  for (let i = 1; i < tail.length; i++) {
    maxTextMove = Math.max(maxTextMove, Math.abs(tail[i].textBottom - tail[i - 1].textBottom))
    if (tail[i].userTop !== null && tail[i - 1].userTop !== null) {
      maxDownUser = Math.max(maxDownUser, tail[i].userTop - tail[i - 1].userTop)
    }
  }
  const last = active.at(-1)
  const pre = active.at(-90) ?? active[0]
  const gapEnd = last.statusTop - last.textBottom
  const gapBefore = pre.statusTop - pre.textBottom
  console.log(`${label}:`)
  console.log(`  归位前间隙=${gapBefore.toFixed(1)}px → 归位后间隙=${gapEnd.toFixed(1)}px`)
  console.log(`  状态行 marginTop='${last.mTop}' marginBottom='${last.mBottom}'`)
  console.log(`  收尾窗口文本底边最大波动=${maxTextMove.toFixed(2)}px (期望≈0)`)
  console.log(`  收尾窗口用户消息最大下移=${maxDownUser.toFixed(2)}px (期望≤0.35)`)
  return { gapEnd, mBottom: last.mBottom }
}

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(url)
await page.waitForFunction(() => typeof window.__runStressTest === 'function')
const r1 = await runScenario(page, '第 1 轮流式+收尾')
const r2 = await runScenario(page, '第 2 轮流式+收尾 (pad 回收检查)')
if (Number.parseFloat(r2.mBottom) > r1.mBottom.length ? false : false) {}
await browser.close()
server.close()
const mb1 = Number.parseFloat(r1.mBottom) || 0
const mb2 = Number.parseFloat(r2.mBottom) || 0
console.log(`\npad 累积检查: 第1轮 marginBottom=${mb1.toFixed(1)}px, 第2轮=${mb2.toFixed(1)}px → ${Math.abs(mb1 - mb2) < 1 ? '✓ 无累积' : '✗ 累积! gapEnd2=' + r2.gapEnd.toFixed(1)}`)
