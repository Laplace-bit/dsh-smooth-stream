import { chromium } from 'playwright-core'
const url = process.argv[2]
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('console', m => { if (/error/i.test(m.type()) && !/gl_context/.test(m.text())) console.log(`[console.${m.type()}]`, m.text().slice(0, 300)) })
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)))
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(3500)
try {
  await page.locator('button[aria-label="新建会话"]').last().click({ timeout: 3000 })
  console.log('new session: clicked')
} catch { console.log('new session: kept current') }
await page.waitForTimeout(1200)
const editor = page.locator('[contenteditable="true"]').first()
await editor.click()
await editor.type('请用至少五百字介绍量子纠缠，分多段。', { delay: 5 })
await page.waitForTimeout(400)
const state = await page.evaluate(() => {
  const send = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? '').includes('发送'))
  return { sendDisabled: send?.disabled, editText: (document.querySelector('[contenteditable="true"]')?.textContent ?? '').slice(0, 60) }
})
console.log('state before send:', JSON.stringify(state))
if (state.sendDisabled) { await page.keyboard.press('Enter'); console.log('pressed Enter') } else {
  await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? '').includes('发送'))?.click() })
  console.log('clicked send')
}
await page.waitForTimeout(3000)
console.log('after 3s:', JSON.stringify(await page.evaluate(() => ({
  flowItems: document.querySelectorAll('[data-chat-flow-key]').length,
  streaming: !!document.querySelector('[data-streaming]'),
  len: (document.querySelector('[data-conversation-scroll]')?.textContent ?? '').length,
}))))
await page.waitForTimeout(9000)
console.log('after 12s:', JSON.stringify(await page.evaluate(() => ({
  flowItems: document.querySelectorAll('[data-chat-flow-key]').length,
  streaming: !!document.querySelector('[data-streaming]'),
  think: !!document.querySelector('[data-variant="think"]'),
  owned: document.querySelector('[data-conversation-scroll]')?.hasAttribute('data-follow-owned'),
  len: (document.querySelector('[data-conversation-scroll]')?.textContent ?? '').length,
}))))
await browser.close()
