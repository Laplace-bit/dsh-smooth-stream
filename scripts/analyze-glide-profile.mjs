#!/usr/bin/env node
/** One-off: analyze the painted-advance profile on the stress page — glide vs staircase. */
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(url)
await page.waitForFunction(() => typeof window.__runStressTest === 'function')

await page.evaluate(() => {
  window.__log = []
  const record = () => {
    const port = document.querySelector('[data-conversation-scroll]')
    const row = document.querySelector('[data-chat-anchor-key="assistant-1"]')
    if (port && row) {
      const m = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(row.style.transform || '')
      window.__log.push({
        t: performance.now(),
        st: port.scrollTop,
        shift: m ? Number.parseFloat(m[1]) : 0,
        sh: port.scrollHeight,
      })
    }
    requestAnimationFrame(record)
  }
  requestAnimationFrame(record)
})
await page.evaluate(opts => window.__runStressTest(opts), { cps: 600, domCostMs: 0, scenario: 'steady' })
await new Promise(r => setTimeout(r, 4000))
const log = await page.evaluate(() => window.__log)
await browser.close()
server.close()

// Painted advance = (st - shift): monotonic upward metric matching the verify gate.
const active = log.filter((f, i) => f.st > 10 && i > 0)
const deltas = []
for (let i = 1; i < active.length; i++) {
  const prev = active[i - 1]
  const curr = active[i]
  deltas.push({ t: curr.t - active[0].t, d: (curr.st - curr.shift) - (prev.st - prev.shift), dt: curr.t - prev.t, wrap: curr.sh - prev.sh })
}
const stream = deltas.filter(d => d.wrap >= 0 && d.t < 2200)
const zeros = stream.filter(d => Math.abs(d.d) < 0.3).length
const bigs = stream.filter(d => d.d > 6).length
const mids = stream.filter(d => d.d >= 0.3 && d.d <= 6).length
console.log(`streaming frames=${stream.length}  zero-advance=${zeros}  mid-glide(0.3-6px)=${mids}  big-jump(>6px)=${bigs}`)
console.log('advance profile (px/frame, first 80 streaming frames):')
console.log(stream.slice(0, 80).map(d => d.d.toFixed(1)).join(' '))
const wraps = stream.filter(d => d.wrap > 2)
console.log(`wrap frames: ${wraps.length}, their same-frame advance: ${wraps.slice(0, 12).map(d => d.d.toFixed(1)).join(' ')}`)
