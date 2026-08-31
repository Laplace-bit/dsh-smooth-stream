/**
 * Render-stability audit runner.
 *
 * Builds repro/audit.tsx with esbuild (real engine components + harness
 * scroll contract), serves the repro directory, drives N conversations
 * across the profile matrix in headless Chromium, and fails when any
 * conversation reports a stability violation (layout-shift entries,
 * single-frame visual jumps, pinned-content regressions, post-settle motion).
 *
 * Usage: node scripts/run-render-audit.mjs [--runs 10] [--profile id] [--keep]
 *
 * A clean pass is `runs` consecutive conversations with zero violations —
 * that is the "10 conversations without repaint/reflow incidents" bar.
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('..', import.meta.url))
const reproDir = join(root, 'repro')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const RUNS = Number(argOf('--runs', '10'))
const ONLY_PROFILE = argOf('--profile', null)
const HEADFUL = args.includes('--headed')

const PROFILE_ROTATION = ['slow-steady', 'fast-sustained', 'burst-gap', 'ramp', 'short-answer']

/* ------------------------------- build ----------------------------------- */

console.log('building audit bundle…')
await build({
  entryPoints: [join(reproDir, 'audit.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: join(reproDir, 'audit.bundle.js'),
  loader: { '.css': 'local-css' },
  alias: {
    '@deepseek-ai/dsh-client-ui-primitives': join(reproDir, 'shims/primitives.tsx'),
    '@deepseek-ai/dsh-client-runtime': join(reproDir, 'shims/client-runtime.ts'),
    '@deepseek-ai/dsh-client-runtime/client': join(reproDir, 'shims/client-runtime.ts'),
  },
  jsx: 'automatic',
  logLevel: 'silent',
})

/* ------------------------------- serve ----------------------------------- */

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
// esbuild extracts bundled CSS next to the JS outfile; the page links it.
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const path = url.pathname === '/' ? '/audit.html' : url.pathname
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
  args: ['--force-device-scale-factor=1', '--font-render-hinting=none'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.emulateMedia({ reducedMotion: 'no-preference' })
page.on('pageerror', error => console.error('[pageerror]', error.message))
page.on('console', message => {
  if (message.type() === 'error') console.error('[console]', message.text())
})

/* -------------------------------- drive ---------------------------------- */

/** @typedef {{kind: string, t: number, detail: string}} Violation */
/** @typedef {{samples: number, shifts: number, significantShiftCount: number, longFrames: number, worstDv: number, quietChecked: boolean, violations: Violation[], context: Record<string, string[]>, phases: Array<{name: string, t: number}>, events: Array<{t: number, e: string, info?: unknown}>, timeline: string[], designedCollapseShiftCount?: number, unpinnableFromT?: number | null}} Report */

/** @type {Array<{run: number, profile: string, ok: boolean, report: Report}>} */
const results = []
let failures = 0

for (let run = 1; run <= RUNS; run += 1) {
  const profileId = ONLY_PROFILE ?? PROFILE_ROTATION[(run - 1) % PROFILE_ROTATION.length]
  await page.goto(`http://127.0.0.1:${port}/audit.html?v=${run}`)
  await page.waitForSelector('[data-conversation-scroll]')
  // The page resolves once quiescence sampling has covered the settle tail.
  await page.evaluate(id => window.__start(id), profileId)
  await page.waitForFunction(
    () => window.__reportReady === true,
    null,
    { timeout: 120000, polling: 250 },
  ).catch(() => {})
  const report = /** @type {Report} */ (await page.evaluate(() => window.__report()))
  const blocking = report.violations.filter(v => v.kind !== 'velocity-step')
  const contexts = report.context ?? {}
  const ok = blocking.length === 0 && report.quietChecked
  if (!ok) failures += 1
  results.push({ run, profile: profileId, ok, report })
  const kinds = blocking.map(v => v.kind).join(',') || 'clean'
  console.log(
    `run ${String(run).padStart(2)} ${profileId.padEnd(14)} `
    + `${ok ? 'PASS' : 'FAIL'}  shifts=${report.significantShiftCount} `
    + `jumps=${blocking.filter(v => v.kind === 'jump').length} `
    + `regressions=${blocking.filter(v => v.kind === 'regression').length} `
    + `quietMoves=${blocking.filter(v => v.kind === 'quiescence-move').length} `
    + `longFrames=${report.longFrames} worstΔv=${report.worstDv}  ${kinds}`,
  )
  if (!ok) {
    for (const kind of ['jump', 'regression', 'quiescence-move', 'layout-shift']) {
      for (const violation of blocking.filter(v => v.kind === kind).slice(0, 6)) {
        console.log(`      · [${violation.kind}] t=${Math.round(violation.t)} ${violation.detail}`)
      }
    }
    const phases = report.phases ?? []
    console.log(`      phases: ${phases.map(p => `${p.name}@${Math.round(p.t)}`).join(' ')}`)
    const timeline = report.timeline ?? []
    if (process.env.AUDIT_TIMELINE) {
      console.log('      timeline:\n        ' + timeline.filter((_, i) => i % 3 === 0).join('\n        '))
    }
    const events = report.events ?? []
    const startedPhase = phases.find(p => p.name === 'started')
    const windowEvents = startedPhase
      ? events.filter(e => e.t >= startedPhase.t && e.t <= startedPhase.t + (process.env.AUDIT_EVENT_WINDOW ? Number(process.env.AUDIT_EVENT_WINDOW) : 1600))
      : events.slice(-24)
    if (windowEvents.length > 0) {
      const step = windowEvents.length > 60 ? Math.ceil(windowEvents.length / 60) : 1
      console.log('      events:', windowEvents.filter((_, i) => i % step === 0).map(e => `${e.e}@${Math.round(e.t)}${e.info !== undefined && e.info !== null ? `(${String(e.info)})` : ''}`).join(' '))
    }
    for (const [kind, windows] of Object.entries(contexts)) {
      for (const window of windows.slice(0, 2)) {
        console.log(`      context[${kind}]:\n${window.split('\n').map(line => `        ${line}`).join('\n')}`)
      }
    }
  }
}

await browser.close()
server.close()

const passed = results.filter(result => result.ok).length
console.log(`\n${passed}/${RUNS} conversations clean`)
process.exit(failures === 0 ? 0 : 1)
