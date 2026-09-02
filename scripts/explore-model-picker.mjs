#!/usr/bin/env node
/** One-off: inspect and open the host model picker. */
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(process.argv[2], { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)

const dom = await page.evaluate(() => {
  const span = [...document.querySelectorAll('span')].find(s => s.textContent === 'glm-5-3-flash')
  let el = span
  const chain = []
  for (let i = 0; i < 6 && el; i++) {
    chain.push(`${el.tagName}.${String(el.className).slice(0, 44)} aria-exp=${el.getAttribute ? el.getAttribute('aria-expanded') : '?'}`)
    el = el.parentElement
  }
  return chain
})
console.log(dom.join('\n'))

const triggerBtn = page.locator('button:has(span:text("glm-5-3-flash"))').first()
try {
  await triggerBtn.click({ timeout: 3000 })
  console.log('clicked button')
} catch (e) {
  console.log('button click failed:', String(e).slice(0, 100))
}
await page.waitForTimeout(900)
const opts = await page.evaluate(() => {
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length === 0) {
      const t = (el.textContent || '').trim()
      if (t.length > 0 && t.length < 30 && /mock|火山|deepseek|glm/i.test(t)) out.push(`${el.tagName}.${String(el.className).slice(0, 36)}: ${t}`)
    }
  }
  return out.slice(0, 14)
})
console.log('visible options:', JSON.stringify(opts, null, 1))
await browser.close()
