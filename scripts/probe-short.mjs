import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript' }
const server = createServer(async (req, res) => { const p = new URL(req.url, 'http://x').pathname === '/' ? '/audit.html' : new URL(req.url, 'http://x').pathname; try { const b = await readFile(join(root, 'repro', p)); res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(b) } catch { res.writeHead(404); res.end() } })
await new Promise(r => server.listen(0, '127.0.0.1', r))
const browser = await chromium.launch({ executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.goto('http://127.0.0.1:' + server.address().port + '/audit.html')
// 首次：不 start，直接手动验证 min-height 不再撑高
await page.evaluate(() => {
  const port = document.querySelector('[data-conversation-scroll]')
  const column = document.querySelector('[data-chat-flow]')
  // 模拟引擎 fill：不应把 scrollHeight 抬到 > clientHeight
  // （无法直接调引擎闭包，这里改为经 __start 短会话走真实路径）
  window.__start('slow-steady', { phases: [{ cps: 50, chars: 30, gapMs: 0 }], foldDelayMs: 60 })
})
// 前 ~300ms 采样 scrollHeight/clientHeight/scrollTop/flowTop
await page.waitForTimeout(90)
const a = await page.evaluate(() => {
  const port = document.querySelector('[data-conversation-scroll]')
  const flow = document.querySelector('[data-chat-flow]')
  return { sh: port.scrollHeight, cl: port.clientHeight, st: Math.round(port.scrollTop), fTop: Math.round(flow.getBoundingClientRect().top), pTop: Math.round(port.getBoundingClientRect().top), flowMin: getComputedStyle(flow).minHeight }
})
console.log('t=90ms', JSON.stringify(a))
await browser.close(); server.close()
