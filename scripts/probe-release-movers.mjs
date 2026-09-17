#!/usr/bin/env node
/**
 * READ-ONLY probe: during the completion handoff's bounded pad release, which
 * elements on screen actually move, and by how much?
 *
 * The release loop (`scheduleHandoffPadRetire`) writes `scrollTop` every frame
 * and compensates with a per-surface transform. Anything inside the scrollport
 * that is NOT in its surface set rides that `scrollTop` descent instead. This
 * script measures the screen travel of every candidate in the same run:
 *
 *   - the anchored rows (`assistant-1`, `user-1`)
 *   - the turn status row (`[data-chat-flow] > [role="status"]`) that carries
 *     the engine's runway margin and is excluded from `shiftSurfacesOf`
 *   - a tool-call row appended mid-release
 *
 * Usage: node scripts/probe-release-movers.mjs [--headed] [--mid-card]
 * Nothing under src/ is touched.
 */
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const HEADFUL = process.argv.includes('--headed')
const MID_CARD = process.argv.includes('--mid-card')
/** Insert the appended row BEFORE the status row, as the host does (rows then status). */
const BEFORE_STATUS = process.argv.includes('--before-status')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const file = join(root, 'repro', url.pathname === '/' ? 'stress-120fps.html' : decodeURIComponent(url.pathname))
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/stress-120fps.html`

const executablePath = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  process.env.CHROME_BIN,
].filter(Boolean).find(c => existsSync(c))

const browser = await chromium.launch({
  executablePath,
  headless: !HEADFUL,
  args: ['--use-gl=angle', '--use-angle=metal', '--force-device-scale-factor=1'],
})

const INSTRUMENT = (opts) => {
  const flow = document.querySelector('[data-conversation-scroll]').querySelector('[data-chat-flow]')
  const shiftOf = el => {
    const m = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec((el && el.style.transform) || '')
    return m === null ? 0 : Number.parseFloat(m[1])
  }
  window.__log = []
  window.__card = null
  window.__cardMountedAt = null
  if (opts.withCard) {
    setTimeout(() => {
      const row = document.createElement('div')
      row.setAttribute('data-chat-anchor-key', 'tool-call-1')
      row.setAttribute('data-chat-flow-key', 'tool-call-1')
      row.setAttribute('data-chat-flow-kind', 'tool-call')
      row.style.cssText = 'align-self:stretch;background:#1c2536;border:1px solid #2f3d55;border-radius:10px;padding:12px 14px;color:#cbd5e1;font-size:13px;line-height:20px;margin-top:12px'
      row.textContent = 'Bash · 定位最近会话数据文件'
      const status = flow.querySelector('[role="status"]')
      if (opts.beforeStatus && status !== null) flow.insertBefore(row, status)
      else flow.append(row)
      window.__card = row
      window.__cardMountedAt = performance.now()
    }, opts.mountDelayMs)
  }
  const sample = (label, el, port) => {
    if (el === null || !el.isConnected) return null
    const r = el.getBoundingClientRect()
    return {
      label,
      top: r.top,
      doc: r.top + port.scrollTop,
      shift: shiftOf(el),
      marginTop: el.style.marginTop || '',
      computedMarginTop: getComputedStyle(el).marginTop,
      offsetTop: el.offsetTop,
      h: r.height,
    }
  }
  const record = () => {
    const port = document.querySelector('[data-conversation-scroll]')
    const flowEl = port.querySelector('[data-chat-flow]')
    const status = port.querySelector('[data-chat-flow] > [role="status"]')
    const rows = [
      sample('user', port.querySelector('[data-chat-anchor-key="user-1"]'), port),
      sample('reply', port.querySelector('[data-chat-anchor-key="assistant-1"]'), port),
      sample('status', status, port),
      sample('card', window.__card, port),
    ]
    window.__log.push({
      t: performance.now(),
      scrollTop: port.scrollTop,
      scrollHeight: port.scrollHeight,
      clientH: port.clientHeight,
      pad: Number.parseFloat(getComputedStyle(flowEl).paddingBottom) || 0,
      rows,
    })
    requestAnimationFrame(record)
  }
  requestAnimationFrame(record)
}

const f = n => (n === null || n === undefined || !Number.isFinite(n) ? String(n) : n.toFixed(2))

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 300)))
await page.goto(url)
await page.waitForFunction(() => typeof window.__runStressTest === 'function')
await page.evaluate(INSTRUMENT, {
  mountDelayMs: Number(process.env.MOUNT_AT ?? 3400),
  withCard: MID_CARD,
  beforeStatus: BEFORE_STATUS,
})
await page.evaluate(() => window.__runStressTest({ cps: 600, domCostMs: 0, scenario: 'steady' }))
await page.waitForTimeout(7000)
const log = await page.evaluate(() => window.__log ?? [])
await browser.close()
server.close()

console.log(`frames=${log.length}${errors.length > 0 ? `  page errors: ${errors.slice(0, 2).join(' | ')}` : ''}`)

const padFrames = log.filter(x => x.pad > 0.5)
if (padFrames.length === 0) {
  console.log('no release window observed')
  process.exit(0)
}
const first = log.indexOf(padFrames[0])
const last = log.indexOf(padFrames[padFrames.length - 1])
const w0 = log[first]
const w1 = log[last]
console.log(`release window: frames ${first}..${last} (${padFrames.length}), pad ${f(w0.pad)}→${f(w1.pad)}, scrollTop ${f(w0.scrollTop)}→${f(w1.scrollTop)} (Δ ${f(w1.scrollTop - w0.scrollTop)})`)

const labels = [...new Set(log.flatMap(x => x.rows.filter(Boolean).map(r => r.label)))]
for (const label of labels) {
  const series = log.map((x, i) => ({ i, r: x.rows.find(r => r && r.label === label) })).filter(x => x.r)
  const inWin = series.filter(x => x.i >= first && x.i <= last)
  if (inWin.length === 0) { console.log(`  ${label}: not present in the release window`); continue }
  const a = inWin[0].r
  const b = inWin[inWin.length - 1].r
  let maxStep = 0
  let maxStepAt = first
  for (let idx = 1; idx < inWin.length; idx++) {
    const step = Math.abs(inWin[idx].r.top - inWin[idx - 1].r.top)
    if (step > maxStep) { maxStep = step; maxStepAt = inWin[idx].i }
  }
  const margins = [...new Set(inWin.map(x => x.r.marginTop))]
  console.log(
    `  ${label.padEnd(7)} n=${String(inWin.length).padStart(3)}`
    + `  screenTop ${f(a.top)}→${f(b.top)} (Δ ${f(b.top - a.top)})`
    + `  docTop ${f(a.doc)}→${f(b.doc)} (Δ ${f(b.doc - a.doc)})`
    + `  shift ${f(a.shift)}→${f(b.shift)}`
    + `  maxStep ${f(maxStep)}px @f${maxStepAt}`
    + `  marginTop ${margins.map(m => m === '' ? '(none)' : m).join('/')}`,
  )
}

console.log('\nper-frame screen top (release window + 6 frames before):')
const head = ['f', 'pad', 'scrollT', ...labels.map(l => l.slice(0, 7).padStart(8)), 'stMargin', 'stComputed', 'stOffTop', 'stShift']
console.log(head.map(h => String(h).padStart(8)).join(''))
for (let i = Math.max(0, first - 6); i <= last; i++) {
  const x = log[i]
  const cells = [String(i), f(x.pad), f(x.scrollTop)]
  for (const l of labels) {
    const r = x.rows.find(row => row && row.label === l)
    cells.push(r ? f(r.top) : '-')
  }
  const statusRow = x.rows.find(row => row && row.label === 'status')
  cells.push(statusRow ? (statusRow.marginTop === '' ? '-' : statusRow.marginTop) : '-')
  cells.push(statusRow ? statusRow.computedMarginTop : '-')
  cells.push(statusRow ? f(statusRow.offsetTop) : '-')
  cells.push(statusRow ? f(statusRow.shift) : '-')
  console.log(cells.map(c => String(c).padStart(8)).join(''))
}
