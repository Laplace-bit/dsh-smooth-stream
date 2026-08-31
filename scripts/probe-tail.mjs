/**
 * Completion-tail stability probe.
 *
 * The user-visible invariant during the completion sequence is that the TAIL
 * of the answer text (the last streamed content, which the reader watches)
 * must not oscillate: produced → live→settled swap → think collapse → fold →
 * settle tail. The new auto-collapse anchors on the last visible message, so
 * the HEAD may legitimately translate; the TAIL must not rebound.
 *
 * This captures the painted bottom edge of the assistant message across the
 * whole completion window at sub-frame resolution and classifies any
 * oscillation past a small epsilon.
 *
 * Usage: node scripts/probe-tail.mjs [profileId] [--runs N]
 */
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reproDir = join(root, 'repro')
const MIME = { '.html': 'text/html', '.js': 'text/javascript' }
const server = createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname === '/' ? '/audit.html' : new URL(req.url, 'http://x').pathname
  try { const b = await readFile(join(reproDir, p)); res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(b) } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const profile = process.argv[2] ?? 'short-answer'
const runArg = process.argv.indexOf('--runs'); const RUNS = runArg >= 0 ? Number(process.argv[runArg + 1]) : 1
const foldArg = process.argv.indexOf('--fold'); const FOLD = foldArg >= 0 ? Number(process.argv[foldArg + 1]) : undefined
const swapArg = process.argv.indexOf('--swap'); const SWAP = swapArg >= 0 ? Number(process.argv[swapArg + 1]) : undefined
const CACHE = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
const candidates = [join(CACHE, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'), join(CACHE, 'chromium-1217', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')]
const executablePath = process.env.AUDIT_CHROMIUM ?? candidates.find(existsSync)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--force-device-scale-factor=1', '--font-render-hinting=none'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.goto('http://127.0.0.1:' + server.address().port + '/audit.html')
await page.evaluate(() => {
  window.__tailLog = []
  let raf = 0, last = null
  const tick = (now) => { raf = requestAnimationFrame(tick)
    const port = document.querySelector('[data-conversation-scroll]'); if (port === null) return
    const dt = last === null ? 16.7 : now - last; last = now
    const flow = document.querySelector('[data-chat-flow]')
    // assistant message painted bottom edge = the tail the reader watches
    const a1 = flow?.querySelector('[data-chat-anchor-key="a1"]')
    const rect = a1?.getBoundingClientRect()
    const pb = port.getBoundingClientRect().bottom
    const status = document.querySelector('[role="status"]')
    window.__tailLog.push({ t: now, dt, tail: rect ? rect.bottom : NaN, portB: pb, gap: rect ? rect.bottom - pb : NaN, top: port.scrollTop, floor: Math.max(0, port.scrollHeight - port.clientHeight), sh: port.scrollHeight, owned: port.hasAttribute('data-follow-owned'), run: parseFloat(status?.style.marginTop ?? '') || 0 })
  }
  tick(0)
})
for (let run = 1; run <= RUNS; run += 1) {
  await page.evaluate(([pid, fold, swap]) => {
    const overrides = {}
    if (fold !== undefined) overrides.foldDelayMs = fold
    if (swap !== undefined) overrides.swapDeltaPx = swap
    window.__start(pid, overrides)
  }, [profile, FOLD, SWAP])
  await page.waitForTimeout(10000)
  const raw = await page.evaluate(() => ({ log: window.__tailLog ?? [], phases: window.__report()?.phases ?? [] }))
  await page.evaluate(() => { window.__tailLog = [] })
  const { log, phases } = raw
  const { round } = Math
  const producedT = phases.find(p => p.name === 'produced')?.t ?? 0
  const foldedT = phases.find(p => p.name === 'folded')?.t ?? 0
  const drainedT = phases.find(p => p.name === 'drained')?.t ?? 0
  console.log(`run ${run} phases: ` + phases.map(p => `${p.name}@${round(p.t)}`).join(' '))
  // tail reversal detection within the whole completion window
  let revs = [], prev = null, prevDir = 0
  for (const s of log) {
    if (!Number.isFinite(s.tail)) { prev = null; prevDir = 0; continue }
    const d = s.tail - (prev ?? s.tail)
    const dir = Math.abs(d) <= 0.6 ? 0 : Math.sign(d)
    if (prevDir !== 0 && dir !== 0 && dir !== prevDir) revs.push({ t: s.t, mag: Math.abs(d), tail: s.tail, gap: s.gap })
    if (dir !== 0) prevDir = dir
    prev = s.tail
  }
  console.log(`  tail reversals: ${revs.length}`)
  for (const r of revs.slice(0, 12)) {
    const idx = log.findIndex(s => s.t === r.t)
    const ctx = log.slice(Math.max(0, idx - 3), idx + 4).map(s => `t=${round(s.t)} tail=${round(s.tail)} gap=${round(s.gap)} sh=${round(s.sh)} top=${round(s.top)} flr=${round(s.floor)} run=${s.run.toFixed(0)}`)
    console.log(`    rev@+${round(r.t)} m=${round(r.mag)} :: ` + ctx.join(' | '))
  }
  // completion-window trace at fine grain
  const from = Math.max(0, producedT - 100)
  console.log('  completion window (produced-100ms → +900ms):')
  const win = log.filter(s => s.t >= from && s.t <= producedT + 900)
  const every = win.length > 60 ? Math.ceil(win.length / 60) : 1
  console.log('    ' + win.filter((_, i) => i % every === 0).map(s => `${round(s.t)}ms tail=${round(s.tail)} gap=${round(s.gap)} run=${s.run.toFixed(0)} tp=${round(s.top)} flr=${round(s.floor)} owned=${s.owned?1:0}`).join('\n    '))
}
await browser.close(); server.close()