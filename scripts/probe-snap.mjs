import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript' }
const server = createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname === '/' ? '/audit.html' : new URL(req.url, 'http://x').pathname
  try { const b = await readFile(join(root, 'repro', p)); res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(b) } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const browser = await chromium.launch({ executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.goto('http://127.0.0.1:' + server.address().port + '/audit.html')
await page.evaluate(() => window.__start('slow-steady'))
await page.waitForFunction(() => window.__reportReady === true, null, { timeout: 60000, polling: 250 }).catch(() => {})
const report = await page.evaluate(() => window.__report())
console.log('violations:', report.violations.length)
console.log('=== regressions ===')
for (const v of report.violations.filter(v => v.kind === 'regression').slice(0, 3)) console.log(`t=${Math.round(v.t)} ${v.detail}`)
console.log('=== apply slices around first regression ===')
console.log((report.applySlices?.[0] ?? '(none)').split('\n').join('\n'))
await browser.close(); server.close()
