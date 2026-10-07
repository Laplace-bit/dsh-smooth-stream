import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { transform } from 'lightningcss'

const output = process.argv[2] ?? '/tmp/smooth-stream-inline-code'
await mkdir(output, { recursive: true })
const source = await readFile(new URL('../src/client/TypewriterAssistantNodeView.module.css', import.meta.url))
const sheet = transform({ filename: 'assistant.module.css', code: source, cssModules: { pattern: '[local]' } }).code.toString()
const browser = await chromium.launch({ executablePath: process.env.AUDIT_CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 850, height: 800 }, deviceScaleFactor: 1.25 })
  await page.setContent(`<html><head><style>
    body { background: #181818; color: white; font-family: sans-serif; }
    p { margin: 16px 0; } code { padding: 4px; background: #555; border: 1px solid #888; }
    .root { width: 320px; --dsw-alias-label-primary: white; }
    ${sheet}
  </style></head><body><div class="root"><div class="body">
    <p id="sample"><span>中文正文前缀</span> <code>very_long_inline_code_${'reference_path_component_'.repeat(7)}</code> <span>中文正文后缀</span></p>
    <p id="next">下一行中文正文必须保持完整可见</p>
    <p id="plain">普通中文段落的排版对照</p>
  </div></div></body></html>`)
  const result = await page.evaluate(() => {
    const sample = document.querySelector('#sample')
    const code = sample.querySelector('code')
    const range = document.createRange()
    range.selectNodeContents(code)
    return {
      browser: navigator.userAgent,
      supportsTrim: CSS.supports('text-box-trim', 'trim-both'),
      fragments: code.getClientRects().length,
      trim: getComputedStyle(sample).getPropertyValue('text-box-trim'),
      codeDisplay: getComputedStyle(code).display,
      paragraph: sample.getBoundingClientRect().toJSON(),
      code: range.getBoundingClientRect().toJSON(),
      next: document.querySelector('#next').getBoundingClientRect().toJSON(),
      chinese: [...sample.querySelectorAll('span')].map(element => ({ text: element.textContent, rect: element.getBoundingClientRect().toJSON() })),
    }
  })
  await page.screenshot({ path: `${output}/inline-code.png`, fullPage: true })
  await writeFile(`${output}/inline-code.json`, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  assert(result.fragments > 1, 'fixture must wrap inline code')
  assert.equal(result.trim, 'none', 'paragraphs containing wrapped inline code must retain full line boxes')
  assert(result.next.top >= result.code.bottom, 'the following paragraph must not overlap wrapped code')
} finally {
  await browser.close()
}
