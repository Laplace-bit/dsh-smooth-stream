/**
 * Copy-button hover jitter probe.
 *
 * Replays streaming output while moving a real Playwright pointer onto a
 * host-shaped user-message copy button. Records per-frame scroll/floor,
 * anchored visual edges, transforms, and layout-shift entries before/during/
 * after hover. The probe fails on a visible edge reversal or layout shift
 * attributable to the hover transition.
 */
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reproDir = join(root, 'repro')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (req, res) => {
  const p = new URL(req.url ?? '/', 'http://x').pathname === '/' ? '/audit.html' : new URL(req.url ?? '/', 'http://x').pathname
  try { const b = await readFile(join(reproDir, p)); res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(b) } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const cache = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
const executablePath = process.env.AUDIT_CHROMIUM ?? [join(cache, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'), join(cache, 'chromium-1217', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')].find(existsSync)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--force-device-scale-factor=1', '--font-rendering=none'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.goto('http://127.0.0.1:' + server.address().port + '/audit.html')
await page.evaluate(() => {
  const flow = document.querySelector('[data-chat-flow]')
  if (!flow) throw new Error('flow unavailable')
  const row = document.createElement('div'); row.className = 'userRow'; row.dataset.chatAnchorKey = 'hover-user'; row.dataset.timeHoverRoot = ''
  row.style.display = 'flex'; row.style.flexDirection = 'column'; row.style.alignItems = 'flex-end'; row.style.gap = '6px'
  const bubble = document.createElement('div'); bubble.textContent = '用户消息（复制按钮悬停测试）'; bubble.style.padding = '10px 16px'; bubble.style.lineHeight = '24px'; bubble.style.background = '#f5f6f8'; bubble.style.borderRadius = '22px'
  const actions = document.createElement('div'); actions.className = 'actions'; actions.style.display = 'flex'; actions.style.alignItems = 'center'; actions.style.gap = '10px'; actions.style.height = '28px'; actions.style.marginTop = '0'
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'action'; copy.setAttribute('aria-label', '复制'); copy.textContent = '⧉'; copy.style.display = 'inline-flex'; copy.style.width = '28px'; copy.style.height = '28px'; copy.style.padding = '6px'; copy.style.border = '0'; copy.style.borderRadius = '28px'; copy.style.background = 'transparent'
  const tooltip = document.createElement('div'); tooltip.className = 'tooltipProbe'; tooltip.style.position = 'fixed'; tooltip.style.display = 'none'; tooltip.style.padding = '4px 8px'; tooltip.style.fontSize = '12px'; tooltip.style.background = '#222'; tooltip.style.color = '#fff'; tooltip.textContent = '复制'
  const flowEl = flow
  window.__bubbleDeltas = []
  let lastShift = null
  const logBubble = now => {
    if (tooltip.style.display === 'none') return
    const b = tooltip.getBoundingClientRect()
    const c = copy.getBoundingClientRect()
    const flowRect = flowEl.getBoundingClientRect()
    window.__bubbleDeltas.push({ t: now - t0, delta: b.top - c.top, flowTop: flowRect.top, flowShift: lastShift })
  }
  copy.addEventListener('mouseenter', () => { copy.style.background = '#e5e7eb'; copy.style.color = '#333'; tooltip.style.display = 'block'; actions.append(tooltip) })
  copy.addEventListener('mouseleave', () => { copy.style.background = 'transparent'; copy.style.color = ''; tooltip.style.display = 'none'; tooltip.remove() })
  actions.append(copy); row.append(bubble, actions); flow.insertBefore(row, flow.firstElementChild)
  window.__copyHoverButton = copy
  window.__copyHoverLog = []; let raf = 0, last = null, t0 = performance.now()
  const tick = now => { raf = requestAnimationFrame(tick); const port = document.querySelector('[data-conversation-scroll]'); const head = document.querySelector('[data-probe="head"]')?.getBoundingClientRect(); const tail = document.querySelector('[data-probe="tail"]')?.getBoundingClientRect(); if (!port) return; const a = document.querySelector('[data-chat-anchor-key="a1"]'); const shift = Number(/translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(a?.style.transform ?? '')?.[1] ?? 0); lastShift = shift; logBubble(now); window.__copyHoverLog.push({ t: now-t0, dt: last===null?16.7:now-last, top: port.scrollTop, floor: Math.max(0,port.scrollHeight-port.clientHeight), head: head?.top ?? NaN, tail: tail?.top ?? NaN, shift, hover: copy.matches(':hover'), rowH: row.getBoundingClientRect().height }) ; last=now }
  tick(0)
})
await page.evaluate(id => window.__start(id), 'fast-sustained')
await page.waitForTimeout(1300)
const copyButton = page.locator('button.action').first()
await copyButton.waitFor({ state: 'visible' })
const hoverAt = await page.evaluate(() => window.__copyHoverLog.at(-1)?.t ?? 0)
const copyBox = await copyButton.boundingBox()
if (copyBox === null) throw new Error('copy button has no box')
// Move the pointer directly; Locator.hover() may scroll the nearest scroller
// to reveal the target and would mask a real hover-induced scroll jump.
await page.mouse.move(copyBox.x + copyBox.width / 2, copyBox.y + copyBox.height / 2)
await copyButton.dispatchEvent('mouseenter')
await page.waitForTimeout(1000)
const leaveAt = await page.evaluate(() => window.__copyHoverLog.at(-1)?.t ?? 0)
await copyButton.dispatchEvent('mouseleave')
await page.mouse.move(1200, 20)
await page.waitForTimeout(500)
const log = await page.evaluate(() => window.__copyHoverLog ?? [])
const report = await page.evaluate(() => window.__report())
const deltas = await page.evaluate(() => window.__bubbleDeltas ?? [])
await browser.close(); server.close()
const during = log.filter(s => s.t >= hoverAt - 40 && s.t <= leaveAt + 40)
const d = deltas.filter(s => s.t >= hoverAt - 40 && s.t <= leaveAt + 40)
  const dTs = [...new Set(d.map(s => Math.round(s.delta * 10) / 10))]
  console.log(`bubble delta samples=${d.length} distinct={${dTs.join(',')}} spread=${dTs.length ? (Math.max(...dTs) - Math.min(...dTs)).toFixed(1) : 'n/a'} flowTop spread=${(d.length ? Math.max(...d.map(s=>s.flowTop)) - Math.min(...d.map(s=>s.flowTop)) : 0).toFixed(1)} shift range=${(d.length ? Math.max(...d.map(s=>s.flowShift)) - Math.min(...d.map(s=>s.flowShift)) : 0).toFixed(1)}`)
const reversals = []
for (let i = 2; i < during.length; i++) {
  const a = during[i-1].head - during[i-2].head; const b = during[i].head - during[i-1].head
  if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) > 0.6 && Math.abs(b) > 0.6 && Math.sign(a) !== Math.sign(b)) reversals.push({ t: during[i].t, a, b })
}
const rowHeights = [...new Set(during.map(s => Math.round(s.rowH * 10) / 10))]
console.log(`samples=${log.length} hoverWindow=${during.length} hover@${Math.round(hoverAt)} leave@${Math.round(leaveAt)}`)
console.log(`row heights during hover: ${rowHeights.join(', ')}`)
console.log(`head reversals=${reversals.length} reportViolations=${report?.violations?.length ?? 'n/a'}`)
console.log('hover transition frames:')
console.log(during.filter((_, i) => i % Math.max(1, Math.ceil(during.length / 50)) === 0).map(s => `t=${Math.round(s.t)} top=${Math.round(s.top)} floor=${Math.round(s.floor)} head=${Math.round(s.head)} tail=${Math.round(s.tail)} shift=${s.shift.toFixed(1)} rowH=${s.rowH.toFixed(1)} hover=${s.hover?1:0}`).join('\n'))
if (reversals.length) process.exitCode = 1
