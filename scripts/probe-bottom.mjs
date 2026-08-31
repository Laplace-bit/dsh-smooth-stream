/**
 * Bottom-edge rebound detector.
 *
 * The user-reported defect is "over-scroll then bounce back a little
 * displacement" (无级滚动出现滚动量过多然后回弹): during streaming the flow's
 * painted bottom edge leaves its pinned rest position and then reverses
 * direction a few px. The production audit thresholds (abrupt UP snap > 16px,
 * settle-focused) are too coarse to catch this small mid-stream rebound.
 *
 * This probe drives one conversation and records, at sub-frame fidelity, the
 * painted bottom edge of the LAST flow surface relative to the scrollport
 * bottom (`gap` = flowBottomViewportY − portBottomViewportY). While pinned and
 * following, that gap should be constant (0, or a small held runway such that
 * the top of the flow is what grows; the bottom stays put). A rebound appears
 * as non-monotonic motion: the gap changes by more than an epsilon in one
 * direction, then reverses by more than that epsilon.
 *
 * We also record the engine's painted compositor shift separately so a reversal
 * can be attributed to scrollTop vs. transform vs. layout growth.
 *
 * Usage: node scripts/probe-bottom.mjs [profileId] [--track=bottom|shift|top]
 */
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
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

const profile = process.argv[2] ?? 'slow-steady'
const track = process.argv.find(a => a.startsWith('--track='))?.split('=')[1] ?? 'bottom'

const CACHE = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
const candidates = [
  join(CACHE, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
  join(CACHE, 'chromium-1217', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
]
const executablePath = process.env.AUDIT_CHROMIUM ?? candidates.find(existsSync)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--force-device-scale-factor=1', '--font-render-hinting=none'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })

// Install a high-frequency bottom-edge sampler via injected function.
await page.goto('http://127.0.0.1:' + server.address().port + '/audit.html')
await page.evaluate((trackName) => {
  window.__bottomTrack = trackName
  window.__bottomLog = []
  let raf = 0
  let prev = performance.now()
  const sample = () => {
    raf = requestAnimationFrame(sample)
    const now = performance.now()
    const dt = now - prev
    prev = now
    const port = document.querySelector('[data-conversation-scroll]')
    if (port === null) return
    const portBottom = port.getBoundingClientRect().bottom
    // Last flow surface = last direct child of flow (assistant message) minus status
    const flow = document.querySelector('[data-chat-flow]')
    const surfaces = [...(flow?.children ?? [])].filter(c => c !== document.querySelector('[role="status"]') && c.getClientRects().length > 0 && c instanceof HTMLElement)
    const last = surfaces.at(-1)
    if (last === undefined) return
    const rect = last.getBoundingClientRect()
    const shiftOf = (el) => Number(/translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform ?? '')?.[1] ?? 0)
    // gap = how far the flow's painted bottom sits BELOW the scrollport bottom.
    // (positive = bottom edge hangs below the port = content pushed down past
    //  the pinned floor; that is an over-scroll.)
    // NOTE: getBoundingClientRect() already applies the compositor transform,
    // so we use rect.bottom directly — adding shift again would double-count
    // the canceled runway and manufacture a swing that is not visible. `sft`
    // is recorded separately for attribution only.
    const gap = rect.bottom - portBottom
    // THE invariant: while a bottom-pinned message grows, its TOP edge stays at
    // a fixed viewport Y (new lines appear below; the top never moves). A
    // reversal of `topEdge` is an unambiguous visible bounce.
    const topEdge = rect.top
    const head = document.querySelector('[data-probe="head"]')?.getBoundingClientRect()
    window.__bottomLog.push({
      t: now, dt, top: port.scrollTop, h: port.scrollHeight, cl: port.clientHeight,
      gap, sft: shiftOf(last), topEdge,
      headTop: head !== undefined && head !== null ? head.bottom : NaN,
      floor: port.scrollHeight - port.clientHeight,
      active: port.hasAttribute('data-follow-owned'),
    })
  }
  sample()
}, track)
await page.waitForSelector('[data-conversation-scroll]')
await page.evaluate((pid) => window.__start(pid), profile)
await page.waitForTimeout(12000)
const data = await page.evaluate(() => window.__bottomLog ?? [])
await browser.close(); server.close()

// ---- analysis: find local-extremum overshoots of the painted bottom edge ----
//
// The painted bottom edge Y tracks `gap`, which while correctly pinned should
// be a slowly-varying setpoint (runway open/close is designed and sub-line
// paced). A genuine rebound = a LOCAL EXTREMUM: the edge moves at least `EPS`
// away from its recent value, then moves BACK through the origin by at least
// `RETURN` px while still pinned. That "--then-returns--" shape is the
// over-scroll-then-bounce signature. The designed runway open is a smooth
// drift, not a spike-and-return; a fast overshoot that snaps back is the bug.
const samples = data
const EPS = 1.8      // px excursion that constitutes a move
const RETURN = 1.2   // px the signal must return before we call it a rebound
const { round } = Math

// ---- primary: reversals of the message TOP EDGE (unambiguous visible wobble) ----
// The top edge of the last message sits at a constant viewport Y while the
// message grows downward at the pinned floor. Its sole legitimate motion is a
// slow upward drift as text fills (which lowers it? no: at the floor the top is
// fixed). Any reversal past EPS = a bounce.
const topReversals = []
let prevTop = null
let prevTopDir = 0
for (let i = 0; i < samples.length; i++) {
  const s = samples[i]
  if (!Number.isFinite(s.topEdge)) { prevTop = null; prevTopDir = 0; continue }
  const d = s.topEdge - (prevTop ?? s.topEdge)
  const dir = Math.abs(d) <= 0.6 ? 0 : Math.sign(d)
  if (prevTopDir !== 0 && dir !== 0 && dir !== prevTopDir) {
    topReversals.push({ idx: i, t: s.t, mag: Math.abs(d), topEdge: s.topEdge })
  }
  if (dir !== 0) prevTopDir = dir
  prevTop = s.topEdge
}
console.log(`== topEdge (last message) reversals: ${topReversals.length} (EPS=0.6) ==`)
for (const r of topReversals.slice(0, 25)) {
  const ctx = samples.slice(Math.max(0, r.idx - 3), r.idx + 4).map(s => `gap=${round(s.gap * 10) / 10} topE=${s.topEdge.toFixed(1)} sft=${s.sft.toFixed(1)} tap=${s.top} flr=${s.floor}`)
  console.log(`  rev@t+${round(r.t)} :: ${ctx.join('  |  ')}`)
}

// ---- whole-column visible wobble: reversals of the HEAD content edge ----
// While bottom-pinned, the head message's bottom edge advances UP monotonically
// (new content pins below it). A reversal = the whole column retraced = the
// "over-scroll then rebound" the user sees. `headBottom` (viewport Y, shrinks
// as we scroll up) is the leading edge of the visible column.
const headReversals = []
{
  let prev = null, prevDir = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    if (!Number.isFinite(s.headTop)) { prev = null; prevDir = 0; continue }
    // `headTop` holds the viewport Y of the head message bottom (leading edge).
    // Shrinking Y = column advancing up = normal pinned follow.
    const d = s.headTop - (prev ?? s.headTop)
    const dir = Math.abs(d) <= 0.6 ? 0 : Math.sign(d)
    if (prevDir !== 0 && dir !== 0 && dir !== prevDir) {
      headReversals.push({ idx: i, t: s.t, mag: Math.abs(d), headTop: s.headTop })
    }
    if (dir !== 0) prevDir = dir
    prev = s.headTop
  }
}
console.log(`== head content-edge reversals: ${headReversals.length} (EPS=0.6) ==`)
const headCtx = (r) => samples.slice(Math.max(0, r.idx - 3), r.idx + 4).map(s => `hd=${s.headTop.toFixed(1)} gap=${round(s.gap * 10) / 10} sft=${s.sft.toFixed(1)} tap=${s.top}`)
for (const r of headReversals.slice(0, 30)) console.log(`  rev@t+${round(r.t)} m=${r.mag.toFixed(1)} :: ${headCtx(r).join('  |  ')}`)

// two-pass: find turning points by discrete sign of first difference
let dirs = []
for (let i = 1; i < samples.length; i++) {
  const d = samples[i].gap - samples[i - 1].gap
  if (Math.abs(d) < 0.15) dirs.push(0); else dirs.push(Math.sign(d))
}
// An extremum index E: dirs[E-1] != dirs[E] (sign change), both nonzero.
// Record extremum value + index.
const radius = 5
const extrema = []
for (let i = 1; i < dirs.length; i++) {
  if (dirs[i - 1] === 0 || dirs[i] === 0 || dirs[i - 1] === dirs[i]) continue
  extrema.push({ idx: i, kind: dirs[i - 1] > 0 ? 'peak' : 'trough' })
}
// For each extremum, measure excursion from just before the swing to the
// extremum, and check it then returns through the near baseline.
const rebounds = []
for (const ex of extrema) {
  const lo = Math.max(0, ex.idx - radius)
  const hi = Math.min(samples.length - 1, ex.idx + radius)
  // baseline = median of samples around extremum, excluding the swing leg
  const v = samples[ex.idx].gap
  const extremumIsHigh = ex.kind === 'peak'
  // Among samples within radius, how far are we from the *opposite* side?
  // The rebound is real if the extremum departs from the ambient by > midway.
  let oppositeMin = Infinity, oppositeMax = -Infinity
  for (let k = lo; k <= hi; k++) {
    const g = samples[k].gap
    if (extremumIsHigh) oppositeMin = Math.min(oppositeMin, g)
    else oppositeMax = Math.max(oppositeMax, g)
  }
  const departure = extremumIsHigh ? Math.abs(v - oppositeMin) : Math.abs(oppositeMax - v)
  // After the extremum, does it return toward the opposite side by RETURN px?
  let returned = false
  const endIdx = Math.min(samples.length - 1, ex.idx + radius + 6)
  for (let k = ex.idx + 1; k <= endIdx; k++) {
    const g = samples[k].gap
    const travelled = extremumIsHigh ? (v - g) : (g - v)
    if (travelled >= RETURN) { returned = true; break }
  }
  if (departure >= EPS && returned) {
    const ctx = samples.slice(Math.max(0, ex.idx - 3), ex.idx + 4)
    rebounds.push({ idx: ex.idx, t: samples[ex.idx].t, kind: ex.kind, departure: round(departure * 10) / 10, gap: round(v * 10) / 10, ctx })
  }
}
// de-dup: keep only rebounds separated by >= 12 samples (same event)
const dedup = []
for (const r of rebounds) {
  if (dedup.length === 0 || r.idx - dedup[dedup.length - 1].idx >= 12) dedup.push(r)
}

console.log(`profile=${profile} track=${track} samples=${samples.length} reboundEvents=${dedup.length}`)
console.log(`scrollTop range=${round(Math.min(...samples.map(s => s.top)))}..${round(Math.max(...samples.map(s => s.top)))} maxFloor=${round(Math.max(0, ...samples.map(s => s.floor)))}`)
console.log(`gap range=${samples.reduce((a, s) => Math.round(Math.min(a, s.gap)), 1e9)}..${round(Math.max(...samples.map(s => s.gap)))}`)
if (dedup.length > 0) {
  for (const r of dedup.slice(0, 20)) {
    const stamps = r.ctx.map(s => `t=${round(s.t)} tap=${round(s.top)} gap=${round(s.gap * 10) / 10} sft=${round(s.sft * 10) / 10} flr=${round(s.floor)}`)
    console.log(`  [${r.kind}] t+${round(r.t)} dep=${r.departure}px gap=${r.gap} :: ${stamps.join('  ')}`)
  }
} else {
  console.log('  no overshoot-rebound events past threshold')
}
// coarse painted-bottom-edge trace: `gap` (viewport-space, constant setpoint expected while pinned)
console.log('gap trace (every 6th frame):')
console.log(samples.filter((_, i) => i % 6 === 0).map(s => `${Math.round(s.t)}:${round(s.gap * 10) / 10}`).join(' '))