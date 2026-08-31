/* TEMP probe: measure live paint-limit geometry mid-conversation. */
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript' }
const server = createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname === '/' ? '/audit.html' : new URL(req.url, 'http://x').pathname
  try {
    const b = await readFile(join(root, 'repro', p))
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
    res.end(b)
  } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const browser = await chromium.launch({
  executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.goto('http://127.0.0.1:' + server.address().port + '/audit.html')
await page.evaluate(() => window.__start('slow-steady'))
await page.waitForTimeout(3000)
console.log(JSON.stringify(await page.evaluate(() => {
  const port = document.querySelector('[data-conversation-scroll]')
  const status = document.querySelector('[role="status"]')
  const flow = document.querySelector('[data-chat-flow]')
  const rows = [...port.querySelectorAll('[data-chat-anchor-key]')].filter(r => r.parentElement?.closest('[data-chat-anchor-key]') === null)
  const last = rows.at(-1)
  const sr = status.getBoundingClientRect()
  const lr = last.getBoundingClientRect()
  const shiftOf = el => Number(/translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform ?? '')?.[1] ?? 0)
  const cr = document.querySelector('[data-composer-seat]').getBoundingClientRect()
  // Replicate safeShiftLimit exactly.
  const ceilings = [status, document.querySelector('[data-composer-seat]')]
    .map(el => ({ el, top: el.getBoundingClientRect().top - shiftOf(el) }))
    .sort((a, b) => a.top - b.top)
  const ceiling = ceilings[0]
  const naturalBottom = lr.bottom - shiftOf(last)
  return {
    flowChildren: [...flow.children].map(c => `${c.tagName}:${c.className.split(' ')[0]}${c.hasAttribute('data-chat-anchor-key') ? '#' + c.getAttribute('data-chat-anchor-key') : ''}`),
    surfacesTail: [...flow.children].filter(c => c !== status && (rows.includes(c) || c.querySelector('[data-chat-anchor-key]') === null)).map(c => c.className.split(' ')[0]),
    statusTop: Math.round(sr.top), statusH: Math.round(sr.height),
    composerTop: Math.round(cr.top), composerH: Math.round(cr.height),
    lastBottom: Math.round(lr.bottom), lastShift: shiftOf(last),
    chosenCeiling: ceiling.el.className.split(' ')[0] || ceiling.el.tagName,
    chosenCeilingTop: Math.round(ceiling.top),
    naturalBottom: Math.round(naturalBottom),
    computedLimit: Math.round((ceiling.top - naturalBottom - 1) * 10) / 10,
    portScrollTop: port.scrollTop,
    portScrollHeight: port.scrollHeight,
    composerPosition: getComputedStyle(document.querySelector('[data-composer-seat]')).position,
    composerBottom: getComputedStyle(document.querySelector('[data-composer-seat]')).bottom,
    composerOffsetParent: document.querySelector('[data-composer-seat]').offsetParent?.className ?? 'null',
    scrollBodyRectTop: Math.round(port.getBoundingClientRect().top),
    scrollBodyRectBottom: Math.round(port.getBoundingClientRect().bottom),
    disclosure: (() => {
      const el = document.querySelector('[data-disclosure-content]')
      if (el === null) return 'none found'
      const cs = getComputedStyle(el)
      return {
        display: cs.display,
        rows: cs.gridTemplateRows,
        transition: cs.transitionProperty + ' / ' + cs.transitionDuration,
        collapsedAttr: el.hasAttribute('data-collapsed'),
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        className: el.className,
        styleSheetsWithRule: [...document.styleSheets].filter(sheet => {
          try { return [...sheet.cssRules].some(rule => rule.cssText.includes('disclosure')) } catch { return false }
        }).length,
        totalSheets: document.styleSheets.length,
      }
    })(),
  }
}), null, 1))
await browser.close()
server.close()
