#!/usr/bin/env node
/** One-off: host E2E multi-turn — verify turn-2 streaming/adopt after turn-1 completion. */
import { chromium } from 'playwright-core'

const URL = process.argv[2]
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--force-device-scale-factor=1'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 200)))
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 })
await page.waitForTimeout(2500)
try { await page.locator('button:has-text("新会话")').first().click({ timeout: 3000 }) } catch {}
await page.waitForTimeout(800)

async function send(text) {
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.click()
  await page.keyboard.insertText(text)
  await page.waitForTimeout(400)
  try { await page.locator('button[aria-label*="发送"]').first().click({ timeout: 2500 }) } catch {
    await page.keyboard.press('Enter')
  }
}

// Turn 1
await send('请详细介绍量子计算，内容越长越好。')
await page.waitForTimeout(16000) // stream + cascade + settle + retire
const t1State = await page.evaluate(() => {
  const port = document.querySelector('[data-conversation-scroll]')
  const flow = port?.querySelector('[data-chat-flow]')
  return { pad: flow?.style.paddingBottom ?? '', sh: port?.scrollHeight, st: port?.scrollTop }
})
console.log('turn-1 end state:', JSON.stringify(t1State))

// Arm the sampler for turn 2
await page.evaluate(() => {
  window.__t2 = []
  let last = null
  const rec = () => {
    const port = document.querySelector('[data-conversation-scroll]')
    const row = [...(port?.querySelectorAll('[data-chat-anchor-key]') ?? [])].at(-1)
    if (port && row) {
      const m = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(row.style.transform || '')
      const user = port.querySelector('[data-chat-anchor-key]')?.getBoundingClientRect().top ?? null
      const s = { t: performance.now(), st: port.scrollTop, sh: port.scrollHeight, shift: m ? Number.parseFloat(m[1]) : 0, userTop: user, owned: port.hasAttribute('data-follow-owned') }
      if (last) s.d = (s.st - s.shift) - (last.st - last.shift)
      last = s
      window.__t2.push(s)
    }
    requestAnimationFrame(rec)
  }
  requestAnimationFrame(rec)
})

// Turn 2
await send('再讲讲它的主要挑战和产业化现状。')
await page.waitForTimeout(16000)
const t2log = await page.evaluate(() => window.__t2)
const t2State = await page.evaluate(() => {
  const port = document.querySelector('[data-conversation-scroll]')
  const flow = port?.querySelector('[data-chat-flow]')
  const kids = flow ? [...flow.children] : []
  const last = kids.filter(c => c.getBoundingClientRect().height > 0).at(-1)
  return { pad: flow?.style.paddingBottom ?? '', lastBottomVsPort: last && port ? Math.round(port.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom) : null }
})
await browser.close()

const active = t2log.filter(f => f.owned)
console.log(`turn-2: frames=${t2log.length} ownedFrames=${active.length}`)
// adopt-moment jumps (first 2s of turn 2)
const adopt = t2log.slice(0, 120)
let worstAdoptJump = 0
for (let i = 1; i < adopt.length; i++) {
  const d = (adopt[i].userTop ?? 0) - (adopt[i - 1].userTop ?? 0)
  if (Math.abs(d) > Math.abs(worstAdoptJump)) worstAdoptJump = d
}
console.log(`adopt-window worst userTop jump=${worstAdoptJump.toFixed(1)}px`)
// streaming advance profile of turn 2
const stream = active.filter((f, i) => i > 0 && f.d !== undefined)
const zeros = stream.filter(f => Math.abs(f.d) < 0.3).length
const mids = stream.filter(f => f.d >= 0.3 && f.d <= 6).length
const jumps = stream.filter(f => f.d > 6).length
console.log(`turn-2 streaming advance: zero=${zeros} mid=${mids} jump=${jumps} n=${stream.length}`)
console.log('END-STATE:', JSON.stringify(t2State))
console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none')
