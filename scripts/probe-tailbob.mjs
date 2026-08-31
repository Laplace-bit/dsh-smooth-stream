/**
 * Tail-edge stability probe.
 *
 * The newest visible line may breathe by one line while the reader is pinned:
 * uniform motion and perfectly fixed bottom whitespace cannot both hold across
 * a discrete wrap. This gate rejects larger multi-line rebounds while allowing
 * that documented one-line tradeoff.
 *
 * We measure, at frame fidelity, `st = newest-visible-line bottom − port
 * bottom` (the streamText block's painted bottom, which already includes the
 * follower's compositor shift). A frame step or short-window amplitude beyond
 * one ordinary line is a visible tail bob rather than expected breathing.
 *
 * Usage: node scripts/probe-tailbob.mjs [cps] [costMs]
 */
import { chromium } from 'playwright-core'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, resolve, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = await build({
  entryPoints: [join(root, 'repro/main.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  loader: { '.css': 'local-css' },
  alias: {
    '@deepseek-ai/dsh-client-ui-primitives': join(root, 'repro/shims/primitives.tsx'),
    '@deepseek-ai/dsh-client-runtime': join(root, 'repro/shims/client-runtime.ts'),
    '@deepseek-ai/dsh-client-runtime/client': join(root, 'repro/shims/client-runtime.ts'),
  },
  outdir: 'probe-output',
  write: false,
  logLevel: 'silent',
})
const generated = new Map(bundle.outputFiles.map(file => [`/${basename(file.path)}`, file.contents]))
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname === '/' ? '/index.html' : new URL(req.url, 'http://x').pathname
  try {
    const generatedPath = path === '/bundle.js' ? '/main.js' : path === '/bundle.css' ? '/main.css' : path
    const body = generated.get(generatedPath) ?? await readFile(join(root, 'repro', path))
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise(resolveServer => server.listen(0, '127.0.0.1', resolveServer))
const CPS = Number(process.argv[2] ?? 1200)
const COST = Number(process.argv[3] ?? 20)
const CACHE = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
const candidates = [
  join(CACHE, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
  join(CACHE, 'chromium-1217', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
]
const executablePath = process.env.AUDIT_CHROMIUM ?? candidates.find(existsSync)
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--force-device-scale-factor=1', '--font-render-hinting=none'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.goto('http://127.0.0.1:' + server.address().port + '/index.html')
await page.evaluate(() => {
  window.__tbLog = []
  let raf = 0
  let last = null
  const shiftOf = el => {
    const match = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el?.style?.transform ?? '')
    return match ? Number(match[1]) : 0
  }
  const tick = now => {
    raf = requestAnimationFrame(tick)
    const port = document.querySelector('[data-conversation-scroll]')
    if (port === null) return
    const dt = last === null ? 16.7 : now - last
    last = now
    const anchor = document.querySelector('[data-chat-anchor-key="a1"]')
    const stream = document.querySelector('.streamText')?.getBoundingClientRect()
    const pb = port.getBoundingClientRect().bottom
    window.__tbLog.push({
      t: now,
      dt,
      st: stream ? stream.bottom - pb : NaN,
      sft: shiftOf(anchor),
      top: port.scrollTop,
      floor: Math.max(0, port.scrollHeight - port.clientHeight),
    })
  }
  tick(0)
})
await page.evaluate(([cps, cost]) => {
  const ranges = [...document.querySelectorAll('input[type=range]')]
  const set = (range, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    descriptor.set.call(range, value)
    range.dispatchEvent(new Event('input', { bubbles: true }))
  }
  set(ranges[0], cps)
  set(ranges[1], cost)
  document.querySelector('button.primary').click()
}, [CPS, COST])
await page.waitForTimeout(9000)
await page.evaluate(() => {
  for (const button of document.querySelectorAll('button')) {
    if (button.textContent.includes('停止')) button.click()
  }
})
await page.waitForTimeout(2000)
const log = await page.evaluate(() => window.__tbLog ?? [])
await browser.close()
server.close()

const { round } = Math
const STABLE_AFTER_MS = 2000
const FRAME_STEP_LIMIT_PX = 30
const WINDOW_AMPLITUDE_LIMIT_PX = 32
// Exclude the initial ownership/overflow ramp; this gate targets steady tail bob.
const samples = log.filter(s => s.t >= STABLE_AFTER_MS && s.t <= 9000 && Number.isFinite(s.st))
if (samples.length === 0) {
  console.log('no streaming samples')
  process.exit(1)
}
// Amplitude: peak-to-trough of st within a sliding 4-frame window.
let maxReversal = 0
let maxAmpl = 0
let maxAmpAt = 0
for (let i = 1; i < samples.length; i += 1) {
  const d = Math.abs(samples[i].st - samples[i - 1].st)
  if (d > maxReversal) maxReversal = d
  const lo = Math.max(0, i - 3)
  const hi = Math.min(samples.length - 1, i + 3)
  let mn = Infinity
  let mx = -Infinity
  for (let k = lo; k <= hi; k += 1) {
    if (samples[k].st < mn) mn = samples[k].st
    if (samples[k].st > mx) mx = samples[k].st
  }
  const amp = mx - mn
  if (amp > maxAmpl) {
    maxAmpl = amp
    maxAmpAt = samples[i].t
  }
}
// Reversals: non-monotone retrace after a real move.
let revs = 0
let lastEdgeValue = null
for (const s of samples) {
  if (lastEdgeValue === null) {
    lastEdgeValue = s.st
    continue
  }
  if (Math.abs(s.st - lastEdgeValue) >= 0.7) revs += 1
  lastEdgeValue = s.st
}
console.log(`cps=${CPS} cost=${COST} streamingSamples=${samples.length}`)
console.log(`tail st range=${round(Math.min(...samples.map(s => s.st)))}..${round(Math.max(...samples.map(s => s.st)))} px (position, more-negative = higher on screen)`)
console.log(`max frame-to-frame |Δst|=${round(maxReversal * 10) / 10}px  max 7-frame amplitude=${round(maxAmpl * 10) / 10}px @t=${round(maxAmpAt)}`)
console.log(`count of frames where st moved ≥0.7px: ${revs}`)
// Settled tail amplitude (exclude the startup ramp: t > 2000ms).
const settled = samples.filter(s => s.t > 2000)
if (settled.length > 0) {
  let mn = Infinity
  let mx = -Infinity
  let sum = 0
  for (const s of settled) {
    if (s.st < mn) mn = s.st
    if (s.st > mx) mx = s.st
    sum += s.st
  }
  console.log(`SETTLED tail stB: min=${round(mn * 10) / 10} max=${round(mx * 10) / 10} amplitude=${round((mx - mn) * 10) / 10}px mean=${round(sum / settled.length * 10) / 10}`)
  console.log('settled st every 6th:')
  console.log(settled.filter((_, i) => i % 6 === 0).map(s => `${round(s.t)}:${round(s.st * 10) / 10}`).join(' '))
}
console.log('tail st every 6th frame (streaming):')
console.log(samples.filter((_, i) => i % 6 === 0).map(s => `${round(s.t)}:${round(s.st * 10) / 10}`).join(' '))
const passed = maxReversal <= FRAME_STEP_LIMIT_PX && maxAmpl <= WINDOW_AMPLITUDE_LIMIT_PX
console.log(`acceptance: frameStep<=${FRAME_STEP_LIMIT_PX}px amplitude<=${WINDOW_AMPLITUDE_LIMIT_PX}px ${passed ? 'PASS' : 'FAIL'}`)
if (!passed) {
  const context = samples.filter(sample => Math.abs(sample.t - maxAmpAt) <= 100)
  console.log('failure context:')
  console.log(context.map(sample => (
    `${round(sample.t - maxAmpAt)}ms st=${round(sample.st * 10) / 10} sft=${round(sample.sft * 10) / 10} `
    + `top=${round(sample.top * 10) / 10} floor=${round(sample.floor * 10) / 10}`
  )).join('\n'))
}
process.exit(passed ? 0 : 1)
