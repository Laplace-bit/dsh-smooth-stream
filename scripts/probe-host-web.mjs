#!/usr/bin/env node
/** One-off: end-to-end host verification — drive the real harness web UI and sample conversation Y-motion. */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'

const url = process.argv[2]
if (!url || !existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
  console.error('usage: node scripts/probe-host-web.mjs <url>'); process.exit(1)
}
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--force-device-scale-factor=1'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 200)) })
page.on('pageerror', err => errors.push(`PAGEERROR: ${String(err).slice(0, 300)}`))
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)

// Snapshot what the plugin exposed
const probe1 = await page.evaluate(() => {
  const port = document.querySelector('[data-conversation-scroll]')
  return {
    hasScrollPort: port !== null,
    dataAttrs: port ? [...port.attributes].map(a => a.name).filter(n => n.startsWith('data-')) : [],
    pluginGlobals: Object.keys(window).filter(k => /dsh|smooth|follow/i.test(k)).slice(0, 12),
    settingsUi: document.querySelectorAll('[class*="settings"], [class*="Settings"]').length,
    composerCount: document.querySelectorAll('textarea, [contenteditable="true"]').length,
  }
})
console.log('initial probe:', JSON.stringify(probe1, null, 1))

// Find composer and type a message
const typed = await page.evaluate(() => {
  const ta = document.querySelector('textarea') ?? document.querySelector('[contenteditable="true"]')
  if (!ta) return 'NO_COMPOSER'
  const set = Object.getOwnPropertyDescriptor(ta.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLElement.prototype, 'value')
  if (ta.tagName === 'TEXTAREA') {
    set.value.call(ta, '请用至少八百字详细介绍量子计算的基本原理、发展历史、当前挑战与未来展望，尽量分多段展开。')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    ta.textContent = '请用至少八百字详细介绍量子计算的基本原理、发展历史、当前挑战与未来展望，尽量分多段展开。'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return 'OK'
})
console.log('typed:', typed)

// Send: look for a send button or press Enter
const sent = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => /send|发送|提交/i.test(b.textContent || '') || /send/i.test(b.className))
  if (btn) { btn.click(); return 'CLICKED' }
  const ta = document.querySelector('textarea') ?? document.querySelector('[contenteditable="true"]')
  if (ta) {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    return 'ENTER'
  }
  return 'NO_TARGET'
})
console.log('send:', sent)

// Sample Y-motion for the reply
await page.waitForTimeout(1500)
await page.evaluate(() => {
  window.__ylog = []
  let lastUserTop = null
  const rec = () => {
    const port = document.querySelector('[data-conversation-scroll]')
    if (port) {
      const userTop = port.querySelector('[data-chat-anchor-key]')?.getBoundingClientRect().top ?? null
      const sft = [...port.querySelectorAll('[style*="translate3d"]')]
        .map(el => /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform)?.[1] ?? '0')
        .map(Number)
      const entry = {
        t: performance.now(), st: port.scrollTop, sh: port.scrollHeight,
        userTop, shift: sft.length ? sft[sft.length - 1] : 0,
        owned: port.hasAttribute('data-follow-owned'),
      }
      entry.userDown = lastUserTop !== null && userTop !== null ? userTop - lastUserTop : 0
      lastUserTop = userTop
      window.__ylog.push(entry)
    }
    requestAnimationFrame(rec)
  }
  requestAnimationFrame(rec)
})
await page.waitForTimeout(12000)
const log = await page.evaluate(() => window.__ylog)
const active = log.filter(f => f.st > 10)
const down = active.filter(f => f.userDown > 0.35)
const deltas = []
for (let i = 1; i < active.length; i++) {
  deltas.push((active[i].st - active[i].shift) - (active[i - 1].st - active[i - 1].shift))
}
const streaming = deltas.slice(0, Math.max(1, Math.floor(deltas.length * 0.7)))
console.log(`frames=${log.length} activeFrames=${active.length} ownedFrames=${log.filter(f => f.owned).length}`)
console.log(`downward violations(>0.35px)=${down.length}${down.length ? ' e.g. ' + down.slice(0, 3).map(f => f.userDown.toFixed(2)).join(',') : ''}`)
if (streaming.length > 4) {
  const zeros = streaming.filter(d => Math.abs(d) < 0.3).length
  console.log(`advance profile (painted px/frame, n=${streaming.length}): zero=${zeros} mid=${streaming.filter(d => d >= 0.3 && d <= 6).length} jump=${streaming.filter(d => d > 6).length}`)
  console.log(streaming.slice(0, 60).map(d => d.toFixed(1)).join(' '))
} else {
  console.log('insufficient scroll motion sampled — maybe no stream happened')
}
console.log('console errors:', errors.length ? errors.slice(0, 5) : 'none')
await browser.close()
