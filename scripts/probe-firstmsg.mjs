/* 验证：新会话短内容下 min-height 撑高 scrollHeight -> 幻影 floor */
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname === '/' ? '/audit.html' : new URL(req.url, 'http://x').pathname
  try { const b = await readFile(join(root, 'repro', p)); res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(b) } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const browser = await chromium.launch({ executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.goto('http://127.0.0.1:' + server.address().port + '/audit.html')
// 未 start：直接手测 min-height 对 scrollHeight 的影响
const manual = await page.evaluate(() => {
  const port = document.querySelector('[data-conversation-scroll]')
  const column = document.querySelector('[data-chat-flow]')
  const scroll = document.querySelector('.scroll')
  const cl = port.clientHeight
  const base = { sh0: port.scrollHeight, cl, scrollPadding: getComputedStyle(scroll).paddingBottom }
  column.style.minHeight = cl + 'px'
  const sh1 = port.scrollHeight
  column.style.minHeight = ''
  return { ...base, shAfterMinHeight: sh1, phantomFloor: sh1 - cl }
})
console.log('manual:', JSON.stringify(manual))
await browser.close(); server.close()
