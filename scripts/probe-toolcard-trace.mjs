#!/usr/bin/env node
/**
 * READ-ONLY: frame-by-frame trace of what moves during the completion release
 * while a tool-call row mounts mid-release.
 *
 * Usage: node scripts/probe-toolcard-trace.mjs
 */
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const file = join(root, 'repro', url.pathname === '/' ? 'stress-120fps.html' : decodeURIComponent(url.pathname))
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch { res.writeHead(404).end('nf') }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/stress-120fps.html`
const executablePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--force-device-scale-factor=1'] })
const NEUTRALIZE = process.argv.includes('--neutralize')
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.addInitScript(v => { window.__neutralizeRelease = v }, NEUTRALIZE)
await page.goto(url)
await page.waitForFunction(() => typeof window.__runStressTest === 'function')

await page.evaluate(() => {
  const style = document.createElement('style')
  style.textContent = `
@keyframes dsh-toolbox-tool-rise { 0% { opacity:0; transform: translateY(12px) } 100% { opacity:1; transform: translateY(0) } }
[data-chat-flow-kind="tool-call"] [data-chat-call-id] { animation: dsh-toolbox-tool-rise 400ms cubic-bezier(0.2,0.9,0.3,1) backwards; }`
  document.head.append(style)
  const flow = document.querySelector('[data-conversation-scroll]').querySelector('[data-chat-flow]')
  window.__log = []
  window.__card = null
  setTimeout(() => {
    const row = document.createElement('div')
    row.setAttribute('data-chat-anchor-key', 'tool-call-1')
    row.setAttribute('data-chat-flow-kind', 'tool-call')
    row.style.cssText = 'align-self:stretch;background:#1c2536;border:1px solid #2f3d55;border-radius:10px;padding:12px 14px;color:#cbd5e1;font-size:13px;line-height:20px;margin-top:12px'
    const inner = document.createElement('div')
    inner.setAttribute('data-chat-call-id', 'call-1')
    inner.textContent = 'Bash · 定位最近会话数据文件'
    row.append(inner)
    flow.append(row)
    window.__card = row
  }, 3300)

  // A/B: when told to, neutralize the release the moment the pad appears, which
  // is exactly what the pre-ffdd5d0 code did (`setFlowPad(host, 0)` in the same
  // task). If the card's motion disappears, the per-frame release writes are the
  // cause; if it stays, the motion comes from somewhere else.
  if (window.__neutralizeRelease === true) {
    const flow = document.querySelector('[data-conversation-scroll]').querySelector('[data-chat-flow]')
    const tick = () => {
      const pad = Number.parseFloat(getComputedStyle(flow).paddingBottom) || 0
      if (pad > 0.5) {
        flow.style.paddingBottom = ''
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  const shiftOf = el => {
    const m = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform || '')
    return m === null ? 0 : Number.parseFloat(m[1])
  }
  const record = () => {
    const p = document.querySelector('[data-conversation-scroll]')
    const a = document.querySelector('[data-chat-anchor-key="assistant-1"]')
    const flowEl = p.querySelector('[data-chat-flow]')
    const card = window.__card
    const textWrap = a.querySelector('div') // the readable text arm
    const st = p.scrollTop
    window.__log.push({
      t: performance.now(),
      st,
      sh: p.scrollHeight,
      ch: p.clientHeight,
      pad: Number.parseFloat(getComputedStyle(flowEl).paddingBottom) || 0,
      aShift: shiftOf(a),
      aTop: a.getBoundingClientRect().top,
      textTop: textWrap === null ? null : textWrap.getBoundingClientRect().top,
      textBottom: textWrap === null ? null : textWrap.getBoundingClientRect().bottom,
      cardTop: card === null || !card.isConnected ? null : card.getBoundingClientRect().top,
      cardOffset: card === null || !card.isConnected ? null : card.offsetTop,
      cardShift: card === null || !card.isConnected ? 0 : shiftOf(card),
      flowTop: flowEl.getBoundingClientRect().top,
    })
    requestAnimationFrame(record)
  }
  requestAnimationFrame(record)
})

await page.evaluate(() => window.__runStressTest({ cps: 600, domCostMs: 0, scenario: 'steady' }))
await page.waitForTimeout(6500)
const log = await page.evaluate(() => window.__log ?? [])
await browser.close()
server.close()

const padIdx = log.findIndex(x => x.pad > 0.5)
const cardIdx = log.findIndex(x => x.cardTop !== null)
const from = Math.max(0, Math.min(padIdx, cardIdx) - 2)
const to = Math.min(log.length, Math.max(padIdx, cardIdx) + 26)
const f = v => (v === null || v === undefined || !Number.isFinite(v) ? '   -  ' : v.toFixed(1).padStart(6))
const ci = log.findIndex(x => x.cardTop !== null)
console.log(`\n### A/B SUMMARY (neutralize=${NEUTRALIZE})`)
console.log(`release window frames: ${log.filter(x => x.pad > 0.5).length}; card mounted at frame ${ci}, pad at mount = ${log[ci]?.pad}`)
const w = log.slice(ci, ci + 26)
console.log(`card  screen move over 400ms: ${f((w[w.length - 1].cardTop ?? 0) - w[0].cardTop)}px   (top ${f(w[0].cardTop)} -> ${f(w[w.length - 1].cardTop)})`)
console.log(`text  screen move over 400ms: ${f((w[w.length - 1].textTop ?? 0) - w[0].textTop)}px   (top ${f(w[0].textTop)} -> ${f(w[w.length - 1].textTop)})`)
console.log(`RELATIVE slide (card vs readable text) over 400ms: ${f(((w[w.length - 1].cardTop ?? 0) - w[0].cardTop) - ((w[w.length - 1].textTop ?? 0) - w[0].textTop))}px`)
console.log(`assistant wrapper aTop: ${f(w[0].aTop)} -> ${f(w[w.length - 1].aTop)} (shift ${f(w[0].aShift)} -> ${f(w[w.length - 1].aShift)})`)
console.log('')
console.log('frame    t(ms)   scrollT  scrollH  pad   aShift |  aTop  textTop textBot  cardTop  cardOff cardSh')
for (let i = from; i < to; i += 1) {
  const x = log[i]
  console.log(`${String(i).padStart(5)} ${f(x.t)} ${f(x.st)} ${f(x.sh)} ${f(x.pad)} ${f(x.aShift)} | ${f(x.aTop)} ${f(x.textTop)} ${f(x.textBottom)} ${f(x.cardTop)} ${f(x.cardOffset)} ${f(x.cardShift)}`)
}
