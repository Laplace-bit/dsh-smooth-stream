/** Local browser QA + recording. Start the repo's HTTP server and build:repro first. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const artifacts = resolve('repro/artifacts/logarithmic-fade')
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const context = await browser.newContext({
  viewport: { width: 1200, height: 900 },
  recordVideo: { dir: artifacts, size: { width: 1200, height: 900 } },
})
const page = await context.newPage()
const errors = []
page.on('pageerror', error => { errors.push(String(error)) })
const count = () => page.evaluate(() => [...CSS.highlights.values()].reduce((n, h) => n + h.size, 0))
const waitForInk = () => page.waitForFunction(() => [...CSS.highlights.values()].some(h => h.size > 0))
const waitForClear = () => page.waitForFunction(() => [...CSS.highlights.values()].every(h => h.size === 0)
  && [...document.querySelectorAll('[data-fade-fixture]')].every(el => el.dataset.shown === el.dataset.target))
const results = {}
try {
  await page.goto(process.env.FADE_DEMO_URL ?? 'http://127.0.0.1:8765/repro/index.html?demo=fade')
  const slider = page.getByRole('slider', { name: '输出速度' })
  await slider.fill('10')
  await page.getByRole('button', { name: '重新生成' }).click()
  await page.waitForTimeout(1000)
  const slowCount = Number(await page.locator('[data-fade-fixture="answer"]').getAttribute('data-target'))
  assert(slowCount >= 8 && slowCount <= 16, '10 chars/s must not be rounded up to one character every tick')
  await slider.fill('50')
  assert.equal(await page.locator('output').textContent(), '50 字/秒')
  results.speedSlider = { slowCount, liveChange: true }
  await page.getByRole('button', { name: '重新生成' }).click()
  await waitForInk()
  await page.waitForTimeout(1600)
  await page.waitForFunction(() => Number(document.querySelector('[data-fade-count="answer"]')?.textContent) > 0)
  results.liveGraphemeCount = true
  results.light = await page.evaluate(() => {
    const active = [...CSS.highlights.entries()].find(([, h]) => h.size)
    const range = [...active[1]][0]
    const element = range.startContainer.parentElement
    const color = getComputedStyle(element, `::highlight(${active[0]})`).color
    return { count: [...CSS.highlights.values()].reduce((n, h) => n + h.size, 0), color, original: getComputedStyle(element).color, alpha: Number(color.match(/\/\s*([\d.]+)/)?.[1] ?? 1) }
  })
  assert(results.light.count > 0 && results.light.count <= 320)
  // Actual paint style, not just the existence of ranges, must have alpha.
  assert.match(results.light.color, /(?:\/\s*[\d.]+\)|rgba\()/)
  assert(results.light.alpha >= 0 && results.light.alpha <= 1)
  await page.screenshot({ path: `${artifacts}/light-stream.png` })
  const pause = page.getByRole('button', { name: '暂停', exact: true })
  const play = page.getByRole('button', { name: '播放', exact: true })
  assert.equal(await pause.isEnabled(), true)
  assert.equal(await play.isDisabled(), true)
  await pause.click()
  assert.equal(await pause.isDisabled(), true)
  assert.equal(await play.isEnabled(), true)
  await page.waitForTimeout(300)
  const pausedCount = await count()
  const pausedBuckets = await page.evaluate(() => [...CSS.highlights.entries()].filter(([, h]) => h.size).map(([name, h]) => [name, h.size]))
  const pausedTargets = await page.locator('[data-fade-fixture]').evaluateAll(elements => elements.map(element => element.getAttribute('data-target')))
  assert(pausedCount > 0)
  await page.waitForTimeout(500)
  assert.equal(await count(), pausedCount)
  assert.deepEqual(await page.evaluate(() => [...CSS.highlights.entries()].filter(([, h]) => h.size).map(([name, h]) => [name, h.size])), pausedBuckets)
  assert.deepEqual(await page.locator('[data-fade-fixture]').evaluateAll(elements => elements.map(element => element.getAttribute('data-target'))), pausedTargets)
  results.pauseFreezes = { graphemes: pausedCount, opacityBuckets: pausedBuckets.length }
  await page.screenshot({ path: `${artifacts}/pause-settled.png` })
  await play.click()
  assert.equal(await pause.isEnabled(), true)
  assert.equal(await play.isDisabled(), true)
  results.pausePlay = true
  await page.getByRole('checkbox', { name: '深色', exact: true }).check()
  await waitForInk()
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${artifacts}/dark-stream.png` })
  await page.getByRole('checkbox', { name: '对数淡入', exact: true }).uncheck()
  assert.equal(await count(), 0)
  await page.getByRole('checkbox', { name: '对数淡入', exact: true }).check()
  await waitForInk()
  results.toggle = true
  await page.getByRole('checkbox', { name: '减少动画', exact: true }).check()
  assert.equal(await count(), 0)
  await page.getByRole('checkbox', { name: '减少动画', exact: true }).uncheck()
  await waitForInk()
  results.reduced = true
  for (const kind of ['code', 'formula']) {
    await page.getByRole('combobox', { name: '文本类型' }).selectOption(kind)
    await page.waitForTimeout(300)
    assert.equal(await count(), 0)
  }
  results.protected = true
  await page.getByRole('combobox', { name: '文本类型' }).selectOption('prose')
  await waitForInk()
  await page.getByRole('button', { name: '停止', exact: true }).click()
  assert.equal(await count(), 0)
  results.stop = true
  await page.getByRole('slider', { name: '输出速度' }).fill('1000')
  await page.getByRole('button', { name: '重新生成' }).click()
  await waitForInk()
  results.fastPeak = await page.evaluate(() => new Promise(resolve => {
    const start = performance.now()
    let peak = 0
    function sample(now) {
      peak = Math.max(peak, [...CSS.highlights.values()].reduce((n, h) => n + h.size, 0))
      if (now - start < 350) requestAnimationFrame(sample)
      else resolve(peak)
    }
    requestAnimationFrame(sample)
  }))
  assert(results.fastPeak > 48 && results.fastPeak <= 320, 'high-speed streams need a wider fade window')
  await page.screenshot({ path: `${artifacts}/fast-stream.png` })
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === '已完成')
  await waitForClear()
  results.completed = true
  results.copy = await page.locator('[data-fade-fixture="answer"]').evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const matches = selection.toString().replaceAll('\n', '') === element.textContent.replaceAll('\n', '')
    selection.removeAllRanges()
    return matches
  })
  assert(results.copy)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `${artifacts}/mobile-settled.png` })
  results.noHorizontalOverflow = await page.locator('main').evaluate(el => el.scrollWidth <= el.clientWidth)
  assert(results.noHorizontalOverflow)
  assert.deepEqual(errors, [])
  results.errors = errors
  console.log(JSON.stringify(results, null, 2))
  await writeFile(`${artifacts}/browser-report.json`, JSON.stringify(results, null, 2))
} finally {
  await context.close()
  await page.video().saveAs(`${artifacts}/logarithmic-fade.webm`)
  await browser.close()
}
