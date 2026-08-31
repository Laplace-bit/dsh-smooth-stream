/**
 * Inline-code wrap overlap probe driver (Issue #13).
 *
 * Builds repro/overlap.tsx with esbuild (REAL @deepseek-ai/dsh-client-ui-
 * primitives MarkdownText — no primitives shim, katex CSS stubbed), serves the
 * repro directory, drives headless Chromium across the three arms and fixture
 * variants at a width that forces the fixture's inline code to wrap, and
 * reports per-run geometry violations.
 *
 * Arms isolate the overlap source (see repro/overlap.tsx):
 *   static  - settled render, no plugin. MUST be clean: if this arm overlaps,
 *             the fault lives in the harness renderer / theme CSS (HOST).
 *   reveal  - real renderer + reveal smoother, no follow engine.
 *   engine  - reveal + FollowHost + transforms + real scroll contract.
 *             Any overlap / residual / transform violation here
 *             points at the plugin engine (OWN).
 *
 * Verdict per run:
 *   static arm   -> PASS = zero 'overlap'/'residual-overlap' violations.
 *   reveal/engine-> PASS = zero layout, visual, cross-surface, or transform
 *                          violations.
 * A code variant that fails to wrap at the measured width is reported as
 * INCONCLUSIVE (the fixture cannot exercise the reported scenario).
 *
 * Usage: node scripts/probe-overlap.mjs [--arm static|reveal|engine|all]
 *        [--variants issue,cjk,ascii,nocode] [--width 640] [--cps 600]
 *        [--fixed] [--slow] [--head] [--runs 1] [--pre-fix]
 *
 * CSS-state mirrors (data attributes toggled on <html> by the driver):
 *   default      - current shipped plugin CSS: inline code, no li text-box-trim.
 *                  This mirrors what actually ships, so a clean gate means the
 *                  shipped plugin cannot produce the reported overlap.
 *   --pre-fix    - the historical defective state: host inline-flex <code> +
 *                  the plugin's own `li { text-box-trim }`. Reproduces Issue #13
 *                  (painted -14px overlap under clean +6px li boxes); gate FAILS.
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('..', import.meta.url))
const reproDir = join(root, 'repro')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const ARMS_ARG = argOf('--arm', 'all')
const ARMS = ARMS_ARG === 'all' ? ['static', 'reveal', 'engine'] : ARMS_ARG.split(',')
const VARIANTS = argOf('--variants', 'issue,cjk,ascii,nocode').split(',')
const WIDTH = Number(argOf('--width', '640'))
const CPS = Number(argOf('--cps', '600'))
const SLOW = args.includes('--slow')
const HEADFUL = args.includes('--head')
const FIXED = args.includes('--fixed')
// Default: mirror the CURRENT shipped plugin CSS (inline code, no li trim).
// `--pre-fix` reproduces the historical defective state (li text-box-trim +
// host inline-flex code) that caused Issue #13, so it should FAIL.
const PRE_FIX = args.includes('--pre-fix')
const LI_TRIM = args.includes('--litrim') || PRE_FIX
const CODE_INLINE = args.includes('--code-inline') || !PRE_FIX
const RUNS = Number(argOf('--runs', '1'))

/* ------------------------------- build ----------------------------------- */

console.log('building overlap bundle (real harness MarkdownText)…')
const buildResult = await build({
  entryPoints: [join(reproDir, 'overlap.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: join(reproDir, 'overlap.bundle.js'),
  loader: { '.css': 'local-css' },
  alias: {
    'katex/dist/katex.min.css': join(reproDir, 'shims/katex-stub.css'),
    // debugRuntime imports the harness snapshot store; host loader globals do
    // not exist outside the host, so mirror that one symbol (same as audit).
    '@deepseek-ai/dsh-client-runtime': join(reproDir, 'shims/client-runtime.ts'),
    '@deepseek-ai/dsh-client-runtime/client': join(reproDir, 'shims/client-runtime.ts'),
  },
  jsx: 'automatic',
  logLevel: 'info',
}).catch(error => {
  console.error('build failed:', error.errors?.[0]?.text ?? error.message)
  process.exit(2)
})

/* ------------------------------- serve ----------------------------------- */

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const path = url.pathname === '/' ? '/overlap.html' : url.pathname
  try {
    const body = await readFile(join(reproDir, path))
    response.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end()
  }
})
await new Promise(resolveServer => server.listen(0, '127.0.0.1', resolveServer))
const port = server.address().port

/* ------------------------------ browser ---------------------------------- */

const CACHE = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
const candidates = [
  join(CACHE, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
  join(CACHE, 'chromium-1217', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
]
const executablePath = process.env.AUDIT_CHROMIUM ?? candidates.find(path => existsSync(path))
if (executablePath === undefined) {
  console.error('no cached chromium found; set AUDIT_CHROMIUM to a chrome binary')
  process.exit(2)
}

const browser = await chromium.launch({
  executablePath,
  headless: !HEADFUL,
  args: [
    '--force-device-scale-factor=1',
    '--font-render-hinting=none',
    // Keep the headless page out of the background-freeze path: a frozen page
    // stops rAF and timer delivery entirely (observed as a stalled probe run
    // with an idle main thread), which would kill the reveal driver.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.bringToFront().catch(() => {})
await page.emulateMedia({ reducedMotion: 'no-preference' })
page.on('pageerror', error => console.error('[pageerror]', error.message))
page.on('console', message => {
  const text = message.text()
  if (message.type() === 'error') console.error('[console]', text)
  else if (process.env.OVERLAP_DUMP && text.includes('[overlap]')) console.log('      ', text.slice(0, 160))
})

/* -------------------------------- drive ---------------------------------- */

const overlapKinds = [
  'overlap',
  'residual-overlap',
  'visual-overlap',
  'residual-visual-overlap',
  'cross-overlap',
  'residual-transform',
]

function summarize(report) {
  const byKind = {}
  for (const violation of report.violations ?? []) byKind[violation.kind] = (byKind[violation.kind] ?? 0) + 1
  return byKind
}

const runs = []
let failures = 0

/** Calibrate a width that wraps the code fixtures; fall back to requested. */
async function calibrateWidth() {
  let width = WIDTH
  await page.goto(`http://127.0.0.1:${port}/overlap.html?cal=1`)
  await page.waitForSelector('[data-conversation-scroll]')
  let report
  for (const candidate of [WIDTH, 600, 560, 500, 440]) {
    await page.evaluate(
      (args) => window.__overlapStart('static', 'issue', { cps: 600, width: args.width, liTrim: args.liTrim, codeInline: args.codeInline }),
      { width: candidate, liTrim: LI_TRIM, codeInline: CODE_INLINE },
    )
    await page.waitForFunction(() => window.__overlapReady === true, null, { timeout: 20000 }).catch(() => {})
    report = await page.evaluate(() => window.__overlapReport())
    if (report.wrapped === true) {
      width = candidate
      console.log(`  calibration: li wraps at width=${candidate}px`)
      break
    }
  }
  if (report?.wrapped !== true) console.warn(`  warning: 'issue' fixture never wrapped (tried ${[WIDTH, 600, 560, 500, 440].join(',')}px); results may be inconclusive`)
  return width
}

await page.goto(`http://127.0.0.1:${port}/overlap.html`)
await page.waitForSelector('[data-conversation-scroll]')
const width = FIXED ? WIDTH : await calibrateWidth()

for (let run = 1; run <= RUNS; run += 1) {
  for (const arm of ARMS) {
    for (const variant of VARIANTS) {
      for (const cps of SLOW && variant === 'issue' ? [CPS, 40] : [CPS]) {
        await page.evaluate(
          (args) => window.__overlapStart(args.arm, args.variant, {
            cps: args.cps,
            width: args.width,
            liTrim: args.liTrim,
            codeInline: args.codeInline,
          }),
          { arm, variant, cps, width, liTrim: LI_TRIM, codeInline: CODE_INLINE },
        )
        if (process.env.OVERLAP_DUMP) {
          const cssFlags = await page.evaluate(() => ({
            liTrim: document.documentElement.dataset.liTrim ?? null,
            codeInline: document.documentElement.dataset.codeInline ?? null,
          }))
          console.log(`      cssState: liTrim=${cssFlags.liTrim} codeInline=${cssFlags.codeInline}`)
        }
        const waitStart = Date.now()
        await page.waitForFunction(
          () => window.__overlapReady === true,
          null,
          { timeout: 40000, polling: 250 },
        ).catch(() => {})
        const report = await page.evaluate(() => window.__overlapReport())
        if (process.env.OVERLAP_DUMP) console.log(`      waited=${Date.now() - waitStart}ms phases=${JSON.stringify(report.phases)}`)
        if (process.env.OVERLAP_DUMP) {
          const dump = await page.evaluate(() => {
            const probe = document.querySelector('[data-probe-surface="a1"]')
            const lis = [...document.querySelectorAll('[data-probe-surface="a1"] li')]
            const rect = (el) => {
              const r = el.getBoundingClientRect()
              return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1) }
            }
            const lineBoxes = (li) => {
              const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT)
              const boxes = []
              let seen
              for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
                const t = n
                const len = t.textContent.length
                if (len === 0) continue
                seen = true
                const r = document.createRange()
                r.setStart(t, 0); r.setEnd(t, len)
                for (const b of r.getClientRects()) boxes.push({ top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), w: +b.width.toFixed(1) })
              }
              return seen ? boxes : null
            }
            const gap = (lis.length >= 2) ? +(lis[1].getBoundingClientRect().top - lis[0].getBoundingClientRect().bottom).toFixed(1) : null
            const code = probe?.querySelector('code')
            return {
              probeLen: probe?.textContent.length ?? -1,
              lis: lis.map(rect),
              liLines: lis.map(lineBoxes),
              gap,
              codeRect: code ? rect(code) : null,
              streaming: probe?.getAttribute('data-streaming'),
            }
          })
          console.log(`      geometry: probeLen=${dump.probeLen} gap=${dump.gap} streaming=${dump.streaming}`)
          console.log(`      lis=${JSON.stringify(dump.lis)}`)
          for (let li = 0; li < (dump.liLines ?? []).length; li += 1) {
            console.log(`      li${li} lineBoxes=${JSON.stringify(dump.liLines[li])}`)
          }
          console.log(`      codeRect=${JSON.stringify(dump.codeRect)}`)
        }
        const byKind = summarize(report)
        const isCodeVariant = variant !== 'nocode'
        let ok
        let reason = ''
        if (isCodeVariant && report.wrapped !== true) {
          ok = null
          reason = `INCONCLUSIVE (wrapped=${report.wrapped})`
        } else if (arm === 'engine' || arm === 'reveal') {
          const bad = (report.violations ?? []).some(v => overlapKinds.includes(v.kind))
          ok = !bad
          reason = ok ? 'PASS' : `FAIL ${JSON.stringify(byKind)}`
        } else {
          const bad = (report.violations ?? []).some(v => v.kind === 'overlap' || v.kind === 'residual-overlap' || v.kind === 'visual-overlap' || v.kind === 'residual-visual-overlap')
          ok = !bad
          reason = bad ? `FAIL ${JSON.stringify(byKind)}` : 'PASS'
        }
        if (ok === false) failures += 1
        runs.push({ arm, variant, cps, width, ok, wrapped: report.wrapped, byKind, report })
        const status = ok === true ? 'PASS' : ok === null ? 'INCONCLUSIVE' : 'FAIL'
        const detail = Object.keys(byKind).length > 0 ? ` ${JSON.stringify(byKind)}` : ''
        console.log(
          `run ${String(run).padStart(2)} ${arm.padEnd(7)} ${variant.padEnd(6)} cps=${String(cps).padStart(3)} w=${width}`
          + `${report.wrapped ? ' wrapped' : ' !wrapped'}  ${status}${detail}`,
        )
        if (ok === false) {
          for (const violation of (report.violations ?? []).slice(0, 6)) {
            console.log(`      · [${violation.kind}] t=${Math.round(violation.t)} ${violation.detail}`)
          }
          const context = report.context ?? {}
          for (const [kind, windows] of Object.entries(context)) {
            for (const window of windows.slice(0, 2)) {
              console.log(`      context[${kind}]:\n${window.split('\n').map(line => `        ${line}`).join('\n')}`)
            }
          }
        }
      }
    }
  }
}

await browser.close()
server.close()

const passed = runs.filter(run => run.ok === true).length
const inconclusive = runs.filter(run => run.ok === null).length
const failed = runs.filter(run => run.ok === false).length
console.log(`\n${passed} passed / ${failed} failed / ${inconclusive} inconclusive (of ${runs.length} runs)`)
console.log(`\nverdict: static arm clean = ${runs.filter(r => r.arm === 'static').every(r => r.ok === true)} | reveal/engine violations = ${failed}`)
process.exit(failures === 0 ? 0 : 1)
