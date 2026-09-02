#!/usr/bin/env node
/** One-off: open the mock-stream session and dump the completed flow structure. */
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(process.argv[2], { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
// Open the most recent 量子计算 session
const item = page.locator('text=请详细介绍一下量子计算').first()
try { await item.click({ timeout: 4000 }); console.log('session opened') } catch { console.log('session not found') }
await page.waitForTimeout(2500)
const dump = await page.evaluate(() => {
  const flow = document.querySelector('[data-chat-flow]')
  if (!flow) return 'NO_FLOW'
  const kids = [...flow.children].map(c => {
    const cls = (c.className || '').toString().split(' ')[0]
    const role = c.getAttribute('role') ?? ''
    const anchor = c.getAttribute('data-chat-anchor-key') ?? ''
    const variant = c.querySelector('[data-variant="think"]') !== null ? 'HAS_THINK' : ''
    return `${c.tagName}.${cls} ${role} ${anchor} ${variant} h=${Math.round(c.getBoundingClientRect().height)} mt=${c.style.marginTop || '-'} mb=${c.style.marginBottom || '-'} transform=${c.style.transform || '-'}`
  })
  return kids.join('\n')
})
console.log(dump)
await page.screenshot({ path: '/tmp/host-session-flow.png' })
await browser.close()
