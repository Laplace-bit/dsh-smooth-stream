import { chromium } from 'playwright-core'
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--force-device-scale-factor=1'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
const response = await page.goto('http://127.0.0.1:43120/', { waitUntil: 'domcontentloaded', timeout: 20000 })
console.log('status:', response?.status())
await page.waitForTimeout(3500)
console.log('title:', await page.title())
console.log('url:', page.url())
const probe = await page.evaluate(() => ({
  hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
  roots: document.querySelectorAll('#root, #app').length,
  bodyLen: document.body.innerHTML.length,
  text: document.body.innerText.slice(0, 200),
  scripts: [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')).slice(0, 8),
}))
console.log(JSON.stringify(probe, null, 2))
if (errors.length > 0) console.log('console errors:', errors.slice(0, 5))
await browser.close()
