import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname === '/' ? '/index.html' : new URL(req.url, 'http://x').pathname
  try { const b = await readFile(join(root, 'repro', p)); res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(b) } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))

const CACHE = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
const candidates = [join(CACHE, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'), join(CACHE, 'chromium-1217', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')]
const executablePath = process.env.AUDIT_CHROMIUM ?? candidates.find(existsSync)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--force-device-scale-factor=1', '--font-render-hinting=none'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.goto('http://127.0.0.1:' + server.address().port + '/index.html')
await page.evaluate(() => {
  window.__demoLog = []
  let raf = 0, last = null
  const tick = (now) => { raf = requestAnimationFrame(tick)
    const port = document.querySelector('[data-conversation-scroll]'); if (port === null) return
    const dt = last === null ? 16.7 : now - last; last = now
    const flow = document.querySelector('[data-chat-flow]')
    const head = document.querySelector('[data-chat-anchor-key="u1"]')?.getBoundingClientRect()
    const a1 = document.querySelector('[data-chat-anchor-key="a1"]')
    const sft = (el) => el ? Number(/translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform ?? '')?.[1] ?? 0) : NaN
    const status = document.querySelector('[role="status"]')
    const pb = port.getBoundingClientRect().bottom
    const a1r = a1?.getBoundingClientRect()
    // overflow = how far the last message's painted bottom sits BELOW the
    // scrollport bottom — the demo's own "文字超出视口底" metric = over-scroll.
    const overflow = a1r ? a1r.bottom - pb : NaN
    // streamText = the actual newest revealed text line; its painted bottom is
    // what the reader watches. Its un-shifted rect (remove compositor transform).
    const st = document.querySelector('.streamText')?.getBoundingClientRect()
    const shiftOf2 = (el) => el ? Number(/translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform ?? '')?.[1] ?? 0) : NaN
    const aftSt = a1 // newest text rides the a1 shift
    window.__demoLog.push({ t: now, dt, top: port.scrollTop, floor: Math.max(0, port.scrollHeight - port.clientHeight), sh: port.scrollHeight, owned: port.hasAttribute('data-follow-owned'), hdH: head ? head.bottom : NaN, sft: sft(a1), run: parseFloat(status?.style.marginTop ?? '') || 0, overflow, stBottom: st ? st.bottom : NaN, stTop: st ? st.top : NaN })
  }
  tick(0)
})
// set cps + render cost via the range inputs, then click start
const DEMO_CPS = Number(process.env.DEMO_CPS ?? 2000)
const DEMO_COST = Number(process.env.DEMO_COST ?? 26)
await page.evaluate(([cpsArg, costArg]) => {
  const ranges = [...document.querySelectorAll('input[type=range]')] // [cps, renderCost]
  const set = (range, v) => { const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value'); d.set.call(range, v); range.dispatchEvent(new Event('input', { bubbles: true })) }
  set(ranges[0], cpsArg)
  set(ranges[1], costArg)
  document.querySelector('button.primary').click()
}, [DEMO_CPS, DEMO_COST])
await page.waitForTimeout(8000)
await page.evaluate(() => { document.querySelectorAll('button').forEach(b => { if (b.textContent.includes('停止')) b.click() }) })
await page.waitForTimeout(3000)
const log = await page.evaluate(() => window.__demoLog ?? [])
await browser.close(); server.close()

const { round } = Math
// head edge reversals (whole-column wobble)
let revs = [], prevH = null, prevDir = 0
for (const s of log) {
  if (!Number.isFinite(s.hdH)) { prevH = null; prevDir = 0; continue }
  const d = s.hdH - (prevH ?? s.hdH)
  const dir = Math.abs(d) <= 0.6 ? 0 : Math.sign(d)
  if (prevDir !== 0 && dir !== 0 && dir !== prevDir) revs.push({ t: s.t, mag: Math.abs(d), hdH: s.hdH, top: s.top, floor: s.floor, sft: s.sft })
  if (dir !== 0) prevDir = dir
  prevH = s.hdH
}
// scrollTop drift (top vs floor)
let drifts = []
for (const s of log) { if (Math.abs(s.top - s.floor) > 1.5) drifts.push({ t: s.t, d: Math.abs(s.top - s.floor), top: s.top, floor: s.floor }) }
console.log(`samples=${log.length} headRevs=${revs.length} scrollDrifts=${drifts.length}`)
console.log('head rev sample ctx:')
for (const r of revs.slice(0, 10)) {
  const idx = log.findIndex(s => s.t === r.t)
  const ctx = log.slice(Math.max(0, idx - 2), idx + 3).map(s => `t=${round(s.t)} hd=${round(s.hdH)} top=${round(s.top)} flr=${round(s.floor)} sft=${round(s.sft)}`)
  console.log(`  rev@${round(r.t)} m=${round(r.mag)} :: ${ctx.join('  |  ')}`)
}
console.log('scroll drift sample:')
for (const d of drifts.slice(0, 10)) {
  const idx = log.findIndex(s => s.t === d.t)
  const ctx = log.slice(Math.max(0, idx - 2), idx + 3).map(s => `t=${round(s.t)} top=${round(s.top)} flr=${round(s.floor)} hd=${round(s.hdH)} owned=${s.owned?1:0}`)
  console.log(`  drift@${round(d.t)} |${round(d.d)}px| :: ${ctx.join('  |  ')}`)
}
// overflow analysis — the user's "文字超出视口底" over-scroll metric
const overflowMax = log.map(s => s.overflow).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), -Infinity)
console.log(`overflow max=${round(overflowMax)}px (positive = text pushed past the port bottom = over-scroll)`)
if (overflowMax > 2) {
  const ev = log.filter(s => Number.isFinite(s.overflow) && s.overflow > 2).slice(0, 8)
  console.log('over-scroll events (painted bottom past port bottom):')
  for (const s of ev) {
    const idx = log.findIndex(x => x.t === s.t)
    const ctx = log.slice(Math.max(0, idx - 3), idx + 4).map(x => `t=${round(x.t)} ovf=${round(x.overflow)} tp=${round(x.top)} flr=${round(x.floor)} sft=${round(x.sft)} owned=${x.owned?1:0}`)
    console.log(`  @${round(s.t)} :: ` + ctx.join(' | '))
  }
}
// coarse trace
console.log('head-edge trace (every 10th):', log.filter((_, i) => i % 10 === 0).map(s => `${round(s.t)}:${round(s.hdH)}`).join(' '))