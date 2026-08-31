/**
 * Authoritative over-scroll gate (the user's "无级滚动回弹" detector).
 *
 * The user-visible defect is: during streaming, a reveal commit grows the DOM
 * but `scrollTop` lags the fresh floor for one frame, so the newest text sits
 * BELOW the scrollport bottom (overflow > 0) and then snaps up — "滚动量过多
 * 然后回弹". We gate on the two definitive invariants while the follower OWNS
 * the port:
 *
 *   1. OVERFLOW ≤ 0 — the painted bottom edge of the newest content must never
 *      pass the scrollport's visible bottom.
 *   2. SCROLL-TOP ON FLOOR — `scrollTop` must equal the true floor on every
 *      owned frame (a transient gap = the un-compensated intermediate frame).
 *   3. HEAD MONOTONE — the head content edge (whole-column position) must
 *      advance monotonically, no retrace past a small epsilon.
 *
 * Runs N conversations across the profile matrix on the production-shaped
 * audit host; a clean pass is N consecutive no-violation runs.
 *
 * Usage: node scripts/verify-overflow.mjs [--runs 10] [--profiles a,b] [--headed]
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reproDir = join(root, 'repro')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const PROFILES = (argOf('--profiles', 'slow-steady,fast-sustained,burst-gap,ramp,short-answer')).split(',')
const RUNS = Number(argOf('--runs', '10'))
const HEADFUL = args.includes('--headed')
const OVERFLOW_EPS = 1.0    // painted newest-line may not pass port bottom
const FLOOR_EPS = 1.5       // scrollTop must track floor within this
const HEAD_EPS = 2.0        // whole-column retrace limit

await build({
  entryPoints: [join(reproDir, 'audit.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: join(reproDir, 'audit.bundle.js'),
  loader: { '.css': 'local-css' },
  alias: {
    '@deepseek-ai/dsh-client-ui-primitives': join(reproDir, 'shims/primitives.tsx'),
    '@deepseek-ai/dsh-client-runtime': join(reproDir, 'shims/client-runtime.ts'),
    '@deepseek-ai/dsh-client-runtime/client': join(reproDir, 'shims/client-runtime.ts'),
  },
  jsx: 'automatic',
  logLevel: 'silent',
})
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname === '/' ? '/audit.html' : url.pathname
  try {
    const body = await readFile(join(reproDir, path))
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise(resolveServer => server.listen(0, '127.0.0.1', resolveServer))
const CACHE = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
const candidates = [
  join(CACHE, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
  join(CACHE, 'chromium-1217', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
]
const executablePath = process.env.AUDIT_CHROMIUM ?? candidates.find(existsSync)
const browser = await chromium.launch({
  executablePath,
  headless: !HEADFUL,
  args: ['--force-device-scale-factor=1', '--font-render-hinting=none'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })

// Per-run browser funnel: record owned-frame overflow / floor drift / head edge.
const funnel = `(() => {
  let raf = 0, last = null
  const log = []
  const tick = (now) => {
    raf = requestAnimationFrame(tick)
    const port = document.querySelector('[data-conversation-scroll]')
    if (!port) return
    const dt = last === null ? 16.7 : now - last
    last = now
    const flow = document.querySelector('[data-chat-flow]')
    const status = document.querySelector('[role="status"]')
    const surf = [...(flow?.children ?? [])].filter(
      c => c !== status && c instanceof HTMLElement && c.getClientRects().length > 0,
    )
    const lastS = surf.at(-1)
    const hB = document.querySelector('[data-probe="head"]')?.getBoundingClientRect()
    const pb = port.getBoundingClientRect().bottom
    const lr = lastS?.getBoundingClientRect()
    log.push({
      t: now,
      dt,
      owned: port.hasAttribute('data-follow-owned'),
      top: port.scrollTop,
      floor: Math.max(0, port.scrollHeight - port.clientHeight),
      ovf: lr ? lr.bottom - pb : NaN,
      hd: hB ? hB.bottom : NaN,
    })
  }
  tick(0)
  window.__ovLog = log
})()`
await page.goto('http://127.0.0.1:' + server.address().port + '/audit.html')
await page.waitForSelector('[data-conversation-scroll]')
await page.evaluate(funnel)
const { round } = Math

let failures = 0
let passed = 0
const results = []
for (let run = 1; run <= RUNS; run += 1) {
  const profile = PROFILES[(run - 1) % PROFILES.length]
  await page.evaluate(profileId => window.__start(profileId), profile)
  await page.waitForTimeout(12000)
  const raw = await page.evaluate(() => {
    const report = window.__report()
    return { log: window.__ovLog ?? [], phases: report?.phases ?? [], designedShifts: report?.designedCollapseShiftCount ?? 0 }
  })
  await page.evaluate(funnel)
  const { log, phases } = raw
  const startedT = phases.find(p => p.name === 'started')?.t ?? 0
  const producedT = phases.find(p => p.name === 'produced')?.t ?? Number.POSITIVE_INFINITY
  const foldedT = phases.find(p => p.name === 'folded')?.t ?? Number.POSITIVE_INFINITY
  const drainedT = phases.find(p => p.name === 'drained' && p.t > producedT)?.t ?? producedT
  const warmup = startedT + 350
  // Exclude the DESIGNED completion transitions exactly as the audit does:
  // the produced→drained drain settle, the auto-collapse fold commit+settle,
  // and the produced→settled swap. The over-scroll defect lives in the
  // STREAMING interval.
  const inDesignedCompletion = t => (
    (t >= producedT - 10 && t <= Math.max(drainedT, producedT) + 700)
    || (t >= foldedT && t <= foldedT + 205)
  )
  const inStream = t => t < producedT + 700 && !inDesignedCompletion(t)
  const overflows = []
  const drifts = []
  const headRevs = []
  for (const s of log) {
    if (s.t < warmup || !s.owned || !inStream(s.t)) continue
    if (Number.isFinite(s.ovf) && s.ovf > OVERFLOW_EPS) overflows.push({ t: s.t, ovf: s.ovf, top: s.top, floor: s.floor })
    const d = Math.abs(s.top - s.floor)
    if (d > FLOOR_EPS) drifts.push({ t: s.t, d, top: s.top, floor: s.floor })
  }
  let prevH = null
  let prevDir = 0
  for (const s of log) {
    if (s.t < warmup || !inStream(s.t)) continue
    if (!Number.isFinite(s.hd)) {
      prevH = null
      prevDir = 0
      continue
    }
    const delta = s.hd - (prevH ?? s.hd)
    const dir = Math.abs(delta) <= 0.5 ? 0 : Math.sign(delta)
    if (prevDir !== 0 && dir !== 0 && dir !== prevDir) headRevs.push({ t: s.t, mag: Math.abs(delta), hd: s.hd })
    if (dir !== 0) prevDir = dir
    prevH = s.hd
  }
  const blocking = overflows.length + drifts.length + headRevs.length
  const ok = blocking === 0
  if (ok) passed += 1
  else failures += 1
  results.push({ run, profile, ok, overflows: overflows.length, drifts: drifts.length, headRevs: headRevs.length })
  console.log(`run ${String(run).padStart(2)} ${profile.padEnd(14)} ${ok ? 'PASS' : 'FAIL'}  overflow=${overflows.length} drift=${drifts.length} headRev=${headRevs.length}`)
  if (!ok) {
    for (const o of overflows.slice(0, 5)) console.log(`    · overflow@+${round(o.t)} +${round(o.ovf)}px top=${round(o.top)} floor=${round(o.floor)}`)
    for (const d of drifts.slice(0, 5)) console.log(`    · drift@+${round(d.t)} |${round(d.d)}px| top=${round(d.top)} floor=${round(d.floor)}`)
    for (const h of headRevs.slice(0, 5)) console.log(`    · headRev@+${round(h.t)} |${round(h.mag)}px|`)
  }
}
await browser.close()
server.close()
console.log(`\n${passed}/${RUNS} runs clean (no over-scroll / no rebound).`)
process.exit(failures === 0 ? 0 : 1)
