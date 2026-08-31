/**
 * Completion-handoff rebound capture.
 *
 * Root-causes the "over-scroll then rebound at completion" defect: at the
 * producer-complete handoff, the compositor shift clears and scrollTop drops
 * ~150px in one frame (the head content edge moves ~110px then returns). This
 * probe drives a fast profile and dumps a dense, per-frame log of the engine's
 * scrollTop, floor, shift, and stretchable runway across the settlement window
 * so the exact sequence of writes can be read.
 *
 * Usage: node scripts/probe-handoff.mjs [profileId]
 */
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript' }
const server = createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname === '/' ? '/audit.html' : new URL(req.url, 'http://x').pathname
  try { const b = await readFile(join(root, 'repro', p)); res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(b) } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const profile = process.argv[2] ?? 'fast-sustained'
const CACHE = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
const candidates = [
  join(CACHE, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
  join(CACHE, 'chromium-1217', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
]
const executablePath = process.env.AUDIT_CHROMIUM ?? candidates.find(existsSync)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--force-device-scale-factor=1', '--font-render-hinting=none'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.goto('http://127.0.0.1:' + server.address().port + '/audit.html')
await page.evaluate(() => {
  window.__handoffLog = []
  let raf = 0
  const start = performance.now()
  const sample = () => {
    raf = requestAnimationFrame(sample)
    const port = document.querySelector('[data-conversation-scroll]')
    if (port === null) return
    const flow = document.querySelector('[data-chat-flow]')
    const surfaces = [...(flow?.children ?? [])].filter(c => c.getClientRects().length > 0 && c instanceof HTMLElement && c !== document.querySelector('[role="status"]'))
    const last = surfaces.at(-1)
    const shiftOf = (el) => el === undefined ? NaN : Number(/translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform ?? '')?.[1] ?? 0)
    const status = document.querySelector('[role="status"]')
    const portRect = port.getBoundingClientRect()
    const head = document.querySelector('[data-probe="head"]')?.getBoundingClientRect()
    const engine = window.__debugState?.()
    window.__handoffLog.push({
      t: performance.now() - start,
      tap: port.scrollTop,
      floor: port.scrollHeight - port.clientHeight,
      sh: port.scrollHeight,
      cl: port.clientHeight,
      sft: shiftOf(last),
      run: parseFloat(status?.style.marginTop ?? '') || 0,
      hdB: head !== undefined && head !== null ? Math.round(head.bottom) : NaN,
      owned: port.hasAttribute('data-follow-owned'),
      lag: engine?.followLagPx ?? NaN,
      cap: engine?.followCapacityPx ?? NaN,
      rsv: engine?.followReservePx ?? NaN,
      scale: engine?.followRevealScale ?? NaN,
      following: engine?.followFollowing ?? false,
      constr: engine?.followConstrained ?? false,
      active: engine?.followActive ?? false,
    })
  }
  sample()
})
await page.evaluate((pid) => window.__start(pid), profile)
await page.waitForTimeout(12000)
const log = await page.evaluate(() => window.__handoffLog ?? [])
const phases = await page.evaluate(() => {
  try { return (window.__report()?.phases ?? []) } catch { return [] }
})
await browser.close(); server.close()

const { round } = Math
console.log('phase markers:', phases.map(p => `${p.name}@${round(p.t)}`).join(' '))
console.log(`profile=${profile} samples=${log.length}`)
console.log('=== produced marker & following window ===')
// print frames sector by sector at fine grain, labeled by follow state transitions
let lastState = ''
const seen = new Set()
for (let i = 0; i < log.length; i++) {
  const s = log[i]
  const state = `${s.owned ? 'owned' : s.following ? 'follow' : 'free'}|${s.following ? 'F' : 'f'}|${s.constr ? 'C' : '-'}`
  if (state !== lastState) {
    console.log(`--- ${round(s.t)}ms state→${state} ---`)
    lastState = state
  }
  // print every frame near a following→free transition, else decimate
  const transitionZone = state !== lastState
  const sampleEvery = s.t > 6000 || transitionZone ? 1 : 3
  if (i % sampleEvery === 0) {
    console.log(
      `${String(i).padStart(4)} ${String(round(s.t)).padStart(6)}ms tap=${String(s.tap).padStart(5)} flr=${String(s.floor).padStart(5)} sh=${String(s.sh).padStart(5)} `
      + `sft=${s.sft.toFixed(1).padStart(6)} run=${s.run.toFixed(1).padStart(5)} hdB=${s.hdB} owned=${s.owned ? 1 : 0} `
      + `lag=${round(s.lag)} cap=${round(s.cap)} rsv=${s.rsv.toFixed(1).padStart(5)} scale=${s.scale.toFixed(2)} constr=${s.constr ? 1 : 0} active=${s.active ? 1 : 0}`,
    )
  }
}