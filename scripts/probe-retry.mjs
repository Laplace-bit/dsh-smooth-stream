/**
 * Retry-row mount jitter detector.
 *
 * The user reports residual scroll jitter that is most visible when the host
 * mounts a "已重试模型请求" (model-retry) foreign flow sibling: a `<details
 * class="retryRow">` keyed node inserted into `[data-chat-flow]` while a reply
 * is streaming or between turns. Such a mount is NOT a reveal commit, so the
 * `onRevealCommit → notifyFollowCommit` same-task correction does not fire; the
 * follower relies on ResizeObserver, whose callback may land a frame after
 * paint. Painted content then sits at the old shift for one frame and micro-
 * bounces when the follower catches up.
 *
 * This probe runs the real follow engine (the demo HostConversation) at a
 * chosen arrival rate, then mid-stream injects a faithful retry row
 * (`<details class="retryRow"><summary>…`) as a direct `data-chat-flow` child,
 * and records at sub-frame fidelity the painted bottom edge of the flowing
 * content (`gap`), the scrollTop-vs-floor drift, and the head content edge.
 * Any painted edge that reverses past a small epsilon across the mount is a
 * visible jitter.
 *
 * Usage: node scripts/probe-retry.mjs [cps] [costMs] [--headful]
 */
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
const CPS = Number(process.argv[2] ?? 1200)
const COST = Number(process.argv[3] ?? 20)
const CACHE = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
const candidates = [join(CACHE, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'), join(CACHE, 'chromium-1217', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')]
const executablePath = process.env.AUDIT_CHROMIUM ?? candidates.find(existsSync)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--force-device-scale-factor=1', '--font-render-hinting=none'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.goto('http://127.0.0.1:' + server.address().port + '/index.html')
await page.evaluate(() => {
  window.__retryLog = []
  window.__retryInjected = false
  let raf = 0, last = null, t0 = 0
  const tick = (now) => { raf = requestAnimationFrame(tick)
    const port = document.querySelector('[data-conversation-scroll]'); if (port === null) return
    const dt = last === null ? 16.7 : now - last; last = now; t0 ||= now
    const flow = document.querySelector('[data-chat-flow]')
    const a1 = flow?.querySelector('[data-chat-anchor-key="a1"]')?.getBoundingClientRect()
    const pb = port.getBoundingClientRect().bottom
    const headEl = document.querySelector('[data-chat-anchor-key="u1"]')?.getBoundingClientRect()
    // newest streamed line = bottom of the streaming text inside a1
    const st = flow?.querySelector('.streamText')?.getBoundingClientRect()
    const shiftOf = (el) => { const t = el?.style?.transform ?? ''; const m = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(t); return m ? Number(m[1]) : 0 }
    const a1El = flow?.querySelector('[data-chat-anchor-key="a1"]')
    window.__retryLog.push({ t: now - t0, dt, top: port.scrollTop, floor: Math.max(0, port.scrollHeight - port.clientHeight), gap: a1 ? a1.bottom - pb : NaN, stB: st ? st.bottom - pb : NaN, hdB: headEl ? headEl.bottom : NaN, sft: shiftOf(a1El), injected: window.__retryInjected })
  }
  tick(0)
  window.__injectRetry = (mode) => {
    const flow = document.querySelector('[data-chat-flow]')
    if (flow === null) return
    const seat = document.createElement('div')
    seat.className = 'flowItem'
    // Host ChatNodeSeat wraps every node in an ANCHORED flow item, including the
    // retry row — so this is a keyed sibling, not an un-keyed foreign row.
    seat.dataset.chatAnchorKey = 'retry-1'
    seat.dataset.chatFlowKey = 'retry-1'
    seat.dataset.chatFlowKind = 'model-retry'
    const d = document.createElement('details')
    d.className = 'retryRow'
    d.dataset.active = mode !== 'started' ? '' : undefined
    const s = document.createElement('summary')
    s.className = 'retrySummary'
    const span = document.createElement('span')
    span.className = 'retryText'
    span.setAttribute('role', 'status')
    span.textContent = mode === 'started'
      ? '已重试模型请求（2/2） · 4s'
      : '正在重试模型请求（1/2） · 3s'
    s.appendChild(span)
    d.appendChild(s)
    // faithful host CSS (from MessageItem.module.css); seat wraps the row
    d.style.color = '#667085'; d.style.fontSize = '13px'; d.style.lineHeight = '20px'
    s.style.display = 'inline-flex'; s.style.alignItems = 'center'; s.style.padding = '2px 0'; s.style.gap = '7px'
    seat.appendChild(d)
    const a1 = flow.querySelector('[data-chat-anchor-key="a1"]')
    flow.insertBefore(seat, a1)
    window.__retryInjected = true
  }
  window.__retryDetailsOpen = () => {
    const row = document.querySelector('[data-chat-flow-key="retry-1"] details')
    if (row === null) return
    row.open = true // reveals the retryDetails grid → +~40px, like user expanding
  }
})
// configure cps + cost, start
await page.evaluate(([cps, cost]) => {
  const ranges = [...document.querySelectorAll('input[type=range]')]
  const set = (range, v) => { const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value'); p.set.call(range, v); range.dispatchEvent(new Event('input', { bubbles: true })) }
  set(ranges[0], cps); set(ranges[1], cost)
  document.querySelector('button.primary').click()
}, [CPS, COST])
// Retry-TURN sequence (the host's realistic repro): stream message A for a
// while, STOP it (turn ends), mount the retry row as an anchored sibling, then
// START a fresh stream (message B = the retried reply) and watch its tail.
await page.waitForTimeout(2500)
await page.evaluate(() => { document.querySelectorAll('button').forEach(b => { if (b.textContent.includes('停止')) b.click() }) })
await page.waitForTimeout(400)
const injectedAt = await page.evaluate(() => { window.__injectRetry('started'); return window.__retryLog.at(-1)?.t ?? 0 })
await page.waitForTimeout(300)
const restartedAt = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('开始')); b?.click(); return window.__retryLog.at(-1)?.t ?? 0 })
await page.waitForTimeout(6000)
await page.evaluate(() => { document.querySelectorAll('button').forEach(b => { if (b.textContent.includes('停止')) b.click() }) })
await page.waitForTimeout(1500)
const vLogStart = injectedAt
const log = await page.evaluate(() => window.__retryLog ?? [])
// window covers scheduled mount → started → details-open (+post)
const vLog = await page.evaluate((at) => (window.__retryLog ?? []).filter(s => s.t >= at - 50 && s.t <= at + 650), vLogStart)
await browser.close(); server.close()

const { round } = Math
console.log(`cps=${CPS} cost=${COST} inject@+${round(injectedAt)} restart@+${round(restartedAt)} samples=${log.length} window=${vLog.length}`)
// 1. gap / stB reversal across injection
const window = vLog
let revs = [], prevG = null, prevDir = 0
for (const s of window) {
  if (!Number.isFinite(s.stB)) { prevG = null; prevDir = 0; continue }
  const d = s.stB - (prevG ?? s.stB)
  const dir = Math.abs(d) <= 0.5 ? 0 : Math.sign(d)
  if (prevDir !== 0 && dir !== 0 && dir !== prevDir) revs.push({ t: s.t, mag: Math.abs(d), stB: s.stB, sft: s.sft, top: s.top, floor: s.floor, gap: s.gap })
  if (dir !== 0) prevDir = dir
  prevG = s.stB
}
// 2. scrollTop drift
let drifts = window.filter(s => Math.abs(s.top - s.floor) > 1.5).map(s => ({ t: s.t, d: Math.abs(s.top - s.floor), top: s.top, floor: s.floor }))
console.log(`stairstep stB reversals: ${revs.length}; scrollTop drifts: ${drifts.length}`)
console.log('injection window (tail gap = newest text vs port bottom):')
const every = window.length > 60 ? Math.ceil(window.length / 60) : 1
console.log(window.filter((_, i) => i % every === 0).map(s => `t+${round(s.t)} gap=${round(s.gap)} stB=${round(s.stB)} sft=${round(s.sft)} tp=${round(s.top)} flr=${round(s.floor)} hdB=${round(s.hdB)} inj=${s.injected ? 1 : 0}`).join('\n  '))
if (drifts.length > 0 || revs.length > 0) {
  console.log('sample revs:')
  for (const r of revs.slice(0, 8)) console.log(`  rev@+${round(r.t)} m=${round(r.mag)} stB=${round(r.stB)} sft=${round(r.sft)} :: top=${round(r.top)} floor=${round(r.floor)}`)
  for (const d of drifts.slice(0, 8)) console.log(`  drift@+${round(d.t)} |${round(d.d)}px| top=${round(d.top)} floor=${round(d.floor)}`)
}