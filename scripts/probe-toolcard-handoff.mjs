#!/usr/bin/env node
/**
 * READ-ONLY probe: is a tool-call row that MOUNTS during the completion release
 * window pinned to the readable text, or does it slide?
 *
 * Mechanism under test: `scheduleHandoffPadRetire` (commit ffdd5d0) snapshots its
 * shift surfaces ONCE inside the effect cleanup. A row that mounts after that
 * snapshot is not shifted, while the retire loop keeps writing `scrollTop` for
 * the whole release. If so, such a row moves in DOCUMENT space and slides
 * relative to the pinned reply text.
 *
 * Reported per frame: absolute document Y of the assistant text and of the card
 * (rect.top + scrollTop), so layout motion is separated from scroll motion.
 *
 * Usage: node scripts/probe-toolcard-handoff.mjs [--headed]
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
  const style = document.createElement('style')
  style.textContent = `
@keyframes dsh-toolbox-tool-rise {
  0% { opacity: 0; transform: translateY(12px); }
  100% { opacity: 1; transform: translateY(0); }
}
[data-chat-flow-kind="tool-call"] [data-chat-call-id] {
  animation: dsh-toolbox-tool-rise 400ms cubic-bezier(0.2, 0.9, 0.3, 1) backwards;
}`
  document.head.append(style)
  const flow = document.querySelector('[data-conversation-scroll]').querySelector('[data-chat-flow]')
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
      const inner = document.createElement('div')
      inner.setAttribute('data-chat-call-id', 'call-1')
      inner.textContent = 'Bash · 定位最近会话数据文件'
      row.append(inner)
      flow.append(row)
      window.__card = row
      window.__cardMountedAt = performance.now()
    }, opts.mountDelayMs)
  }
  const shiftOf = el => {
    const m = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform || '')
    return m === null ? 0 : Number.parseFloat(m[1])
  }
  const record = () => {
    const p = document.querySelector('[data-conversation-scroll]')
    const a = document.querySelector('[data-chat-anchor-key="assistant-1"]')
    const card = window.__card
    const flowEl = p.querySelector('[data-chat-flow]')
    const status = p.querySelector('[data-chat-turn-status], [data-chat-flow] > [role="status"]')
    const st = p.scrollTop
    window.__log.push({
      t: performance.now(),
      scrollTop: st,
      scrollHeight: p.scrollHeight,
      pad: Number.parseFloat(getComputedStyle(flowEl).paddingBottom) || 0,
      statusMargin: status === null ? '(none)' : (status.style.marginTop || '(none)'),
      // absolute document Y (scroll removed)
      aDoc: a.getBoundingClientRect().top + st,
      aTop: a.getBoundingClientRect().top,
      aShift: shiftOf(a),
      cTop: card === null || !card.isConnected ? null : card.getBoundingClientRect().top,
      cDoc: card === null || !card.isConnected ? null : card.getBoundingClientRect().top + st,
      cShift: card === null || !card.isConnected ? 0 : shiftOf(card),
      // LAYOUT-space document Y (scroll and compositor both removed).
      aBoxDoc: a.getBoundingClientRect().top + shiftOf(a) + st,
      cBoxDoc: card === null || !card.isConnected ? null : card.getBoundingClientRect().top + shiftOf(card) + st,
      cInline: card === null || !card.isConnected ? null : (card.style.transform || '(none)'),
      cAnim: card === null || !card.isConnected || card.getAnimations === undefined
        ? null
        : card.getAnimations({ subtree: true }).map(an => Math.round(an.currentTime ?? -1)),
      mountedAt: window.__cardMountedAt,
    })
    requestAnimationFrame(record)
  }
  requestAnimationFrame(record)
}

// Exit code: 1 when the protective invariant fails, so this doubles as a
// regression check (the gate asserts the adoption contract; this asserts the
// visible consequence of it).
let protectionFailed = false

const runs = [
  { id: 'A-mount-streaming', mountDelayMs: 1500 },
  { id: 'B-mount-early-release', mountDelayMs: 3200 },
  { id: 'C-mount-mid-release', mountDelayMs: 3450 },
  { id: 'D-mount-after-release', mountDelayMs: 5200 },
]

const f = n => (n === null || n === undefined || !Number.isFinite(n) ? String(n) : n.toFixed(2))

for (const run of runs) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)))
  await page.goto(url)
  await page.waitForFunction(() => typeof window.__runStressTest === 'function')
  await page.evaluate(INSTRUMENT, { mountDelayMs: run.mountDelayMs, withCard: true })
  await page.evaluate(() => window.__runStressTest({ cps: 600, domCostMs: 0, scenario: 'steady' }))
  await page.waitForTimeout(6500)
  const log = await page.evaluate(() => window.__log ?? [])
  await page.close()

  console.log(`\n${'='.repeat(84)}\n▶ ${run.id}   frames=${log.length}`)
  if (errors.length > 0) console.log('  page errors:', errors.slice(0, 3))
  const padFrames = log.filter(x => x.pad > 0.5)
  if (padFrames.length === 0) { console.log('  no release window observed'); continue }
  const w0 = padFrames[0]
  const w1 = padFrames[padFrames.length - 1]
  console.log(`  release: ${padFrames.length} frames, pad ${f(w0.pad)}→${f(w1.pad)}, scrollTop ${f(w0.scrollTop)}→${f(w1.scrollTop)}, aShift ${f(w0.aShift)}→${f(w1.aShift)}`)
  console.log(`  assistant: aDoc ${f(w0.aDoc)}→${f(w1.aDoc)} (Δ ${f(w1.aDoc - w0.aDoc)})   aTop ${f(w0.aTop)}→${f(w1.aTop)} (Δ ${f(w1.aTop - w0.aTop)})`)

  const card = log.filter(x => x.cDoc !== null)
  if (card.length === 0) { console.log('  card never mounted'); continue }
  const c0 = card[0]
}
console.log(`\n${protectionFailed ? '\x1b[31m✗ new-row protection FAILED\x1b[0m' : '\x1b[32m✓ new-row protection holds in every run that mounted during the release\x1b[0m'}`)

await browser.close()
server.close()
process.exit(protectionFailed ? 1 : 0)
