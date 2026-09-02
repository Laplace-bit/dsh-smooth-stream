#!/usr/bin/env node
/** One-off: diagnose composer insert + send in the host. */
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(process.argv[2], { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
try { await page.locator('button:has-text("新会话")').first().click({ timeout: 3000 }); console.log('new session') } catch {}
await page.waitForTimeout(600)
const composer = page.locator('[contenteditable="true"]').first()
await composer.click()
await page.keyboard.insertText('介绍一下量子计算，尽量长。')
await page.waitForTimeout(600)
const state1 = await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"]')
  const btns = [...document.querySelectorAll('button')].filter(b => b.closest('[class*="unmL2W"]') || b.closest('form'))
    .map(b => ({ cls: String(b.className).slice(0, 44), text: (b.textContent || '').trim().slice(0, 16), disabled: b.disabled, aria: b.getAttribute('aria-label') }))
  return { ceText: ce?.textContent, btns: btns.slice(0, 8) }
})
console.log('after insert:', JSON.stringify(state1, null, 1))
await browser.close()
