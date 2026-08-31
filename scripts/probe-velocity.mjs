/**
 * Deterministic rAF telemetry for the real browser repro.
 *
 * Usage: node scripts/probe-velocity.mjs [cps] [costMs] [durationMs]
 *   [--out result.json] [--compare baseline.json] [--frames]
 */
import { chromium } from 'playwright-core'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const values = []
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--out' || args[index] === '--compare') index += 1
  else if (!args[index].startsWith('--')) values.push(args[index])
}
const CPS = Number(values[0] ?? 1200)
const COST = Number(values[1] ?? 0)
const DURATION_MS = Number(values[2] ?? 5000)
const OUT = argOf('--out', null)
const COMPARE = argOf('--compare', null)
const INCLUDE_FRAMES = args.includes('--frames')
const SETTLE_MS = 700
const LINE_HEIGHT_PX = 28
const VELOCITY_STEP_P95_LIMIT = 0.025
const VELOCITY_STEP_MAX_LIMIT = 0.05

const bundle = await build({
  entryPoints: [join(root, 'repro', 'main.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: join(root, 'repro', 'bundle.js'),
  loader: { '.css': 'local-css' },
  alias: {
    '@deepseek-ai/dsh-client-ui-primitives': join(root, 'repro', 'shims', 'primitives.tsx'),
    '@deepseek-ai/dsh-client-runtime': join(root, 'repro', 'shims', 'client-runtime.ts'),
    '@deepseek-ai/dsh-client-runtime/client': join(root, 'repro', 'shims', 'client-runtime.ts'),
  },
  jsx: 'automatic',
  logLevel: 'silent',
  write: false,
})
const bundleFiles = new Map(bundle.outputFiles.map(file => [file.path, file.contents]))

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const path = url.pathname === '/' ? '/index.html' : url.pathname
  try {
    const filePath = join(root, 'repro', path)
    const body = bundleFiles.get(filePath) ?? await readFile(filePath)
    response.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end()
  }
})
await new Promise(resolveServer => server.listen(0, '127.0.0.1', resolveServer))

const cache = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
const executablePath = process.env.AUDIT_CHROMIUM ?? [
  join(cache, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
  join(cache, 'chromium-1217', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
].find(existsSync)
if (executablePath === undefined) throw new Error('no cached Chromium found; set AUDIT_CHROMIUM')

let browser
try {
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--force-device-scale-factor=1', '--font-render-hinting=none'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', error => console.error(`[pageerror] ${error.message}`))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`)
  await page.waitForSelector('[data-conversation-scroll]')

  // One sampler, no console, serialization, or forced rectangle read on the
  // hot path. The stable user row catches jumps hidden by a transcript shift.
  await page.evaluate(() => {
    const telemetry = { frames: [], startedAt: 0, stoppedAt: null }
    window.__scrollTelemetry = telemetry
    const sample = now => {
      requestAnimationFrame(sample)
      const port = document.querySelector('[data-conversation-scroll]')
      const anchor = document.querySelector('[data-chat-anchor-key="u1"]')
      if (port === null || anchor === null || telemetry.startedAt === 0) return
      const target = Math.max(0, port.scrollHeight - port.clientHeight)
      const actual = port.scrollTop
      const shift = Number(
        /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(anchor.style.transform)?.[1] ?? 0,
      )
      const status = document.querySelector('[role="status"]')
      const stream = document.querySelector('[data-displayed-length]')
      telemetry.frames.push({
        t: now - telemetry.startedAt,
        actual,
        target,
        lag: target - actual,
        visualPosition: -actual + shift,
        runway: Number.parseFloat(status?.style.marginTop ?? '') || 0,
        displayedChars: Number(stream?.getAttribute('data-displayed-length') ?? 0),
        hostPinned: document.querySelector('.toBottomBtn') === null,
      })
    }
    requestAnimationFrame(sample)
  })

  await page.evaluate(([cps, cost]) => {
    const ranges = [...document.querySelectorAll('input[type="range"]')]
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter === undefined || ranges.length < 2) throw new Error('replay controls unavailable')
    setter.call(ranges[0], String(cps))
    ranges[0].dispatchEvent(new Event('input', { bubbles: true }))
    ranges[0].dispatchEvent(new Event('change', { bubbles: true }))
    setter.call(ranges[1], String(cost))
    ranges[1].dispatchEvent(new Event('input', { bubbles: true }))
    ranges[1].dispatchEvent(new Event('change', { bubbles: true }))
    window.__scrollTelemetry.startedAt = performance.now()
    document.querySelector('button.primary')?.click()
  }, [CPS, COST])

  await page.waitForTimeout(DURATION_MS)
  await page.evaluate(() => {
    const telemetry = window.__scrollTelemetry
    telemetry.stoppedAt = performance.now() - telemetry.startedAt
    for (const button of document.querySelectorAll('button')) {
      if (button.textContent?.includes('停止')) button.click()
    }
  })
  await page.waitForTimeout(SETTLE_MS)

  const telemetry = await page.evaluate(() => window.__scrollTelemetry)
  const report = analyze(telemetry.frames, telemetry.stoppedAt, {
    cps: CPS,
    costMs: COST,
    durationMs: DURATION_MS,
  }, INCLUDE_FRAMES)
  printReport(report)
  if (COMPARE !== null) printComparison(JSON.parse(await readFile(COMPARE, 'utf8')), report)
  if (OUT !== null) {
    await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(`wrote ${OUT}`)
  }
  process.exitCode = report.acceptance.pass ? 0 : 1
} finally {
  await browser?.close()
  server.close()
}

function analyze(samples, stoppedAt, scenario, includeFrames) {
  const frames = []
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    const dt = current.t - previous.t
    if (!(dt > 0)) continue
    const displacement = current.actual - previous.actual
    const visualDisplacement = current.visualPosition - previous.visualPosition
    frames.push({
      ...current,
      dt,
      displacement,
      velocity: displacement / dt,
      velocityStep: null,
      acceleration: null,
      visualDisplacement,
      visualVelocity: visualDisplacement / dt,
      visualVelocityStep: null,
      visualAcceleration: null,
      dropped: dt > 32,
    })
  }
  for (let index = 1; index < frames.length; index += 1) {
    frames[index].velocityStep = frames[index].velocity - frames[index - 1].velocity
    frames[index].visualVelocityStep = frames[index].visualVelocity - frames[index - 1].visualVelocity
  }

  // Centered finite differences retain the real per-frame scrollTop samples
  // while rejecting one-sample rAF timestamp quantization (15.7/17.8ms pairs).
  for (let index = 1; index < frames.length - 1; index += 1) {
    const previous = frames[index - 1]
    const next = frames[index + 1]
    const centeredDt = next.t - previous.t
    if (centeredDt <= 0) continue
    frames[index].velocity = (next.actual - previous.actual) / centeredDt
    frames[index].visualVelocity = (next.visualPosition - previous.visualPosition) / centeredDt
  }
  for (let index = 1; index < frames.length; index += 1) {
    const dt = Math.max(0.001, frames[index].dt)
    frames[index].velocityStep = frames[index].velocity - frames[index - 1].velocity
    frames[index].acceleration = frames[index].velocityStep / dt
    frames[index].visualVelocityStep = frames[index].visualVelocity - frames[index - 1].visualVelocity
    frames[index].visualAcceleration = frames[index].visualVelocityStep / dt
  }

  const firstOverflow = frames.find(frame => frame.target > 0)?.t ?? 0
  const steady = frames.filter(frame => frame.t >= firstOverflow + 250 && frame.t <= stoppedAt - 250)
  const cadence = frames.filter(frame => frame.t <= stoppedAt + 500)
  const postStop = frames.filter(frame => frame.t >= stoppedAt && frame.t <= stoppedAt + 500)
  const velocitySteps = steady.map(frame => Math.abs(frame.velocityStep)).filter(Number.isFinite)
  const visualSteps = steady.map(frame => Math.abs(frame.visualVelocityStep)).filter(Number.isFinite)
  const intervals = cadence.map(frame => frame.dt)
  const typingLag = steady.map(frame => frame.lag)
  const convergenceFrame = postStop.find(frame => frame.lag <= 1)
  const result = {
    schemaVersion: 1,
    scenario,
    samples: samples.length,
    monitor: { perFrameRectReads: 0, consoleWritesDuringReplay: 0 },
    frameIntervalMs: summarize(intervals),
    framesOver32MsRatio: ratio(intervals.filter(value => value > 32).length, intervals.length),
    scrollVelocityPxPerMs: summarize(steady.map(frame => frame.velocity)),
    scrollVelocityStepPxPerMs: summarize(velocitySteps),
    paintedVelocityStepPxPerMs: summarize(visualSteps),
    visualVelocityStepPxPerMs: summarize(visualSteps),
    targetLagPx: summarize(typingLag),
    targetLagLines: summarize(typingLag.map(value => value / LINE_HEIGHT_PX)),
    runwayPx: summarize(steady.map(frame => frame.runway)),
    convergenceMs: convergenceFrame === undefined ? null : convergenceFrame.t - stoppedAt,
    lagAt500MsPx: postStop.at(-1)?.lag ?? null,
    hostPinnedRatio: ratio(steady.filter(frame => frame.hostPinned).length, steady.length),
  }
  result.acceptance = {
    velocity: result.visualVelocityStepPxPerMs.p95 <= VELOCITY_STEP_P95_LIMIT
      && result.visualVelocityStepPxPerMs.max <= VELOCITY_STEP_MAX_LIMIT,
    visual: result.visualVelocityStepPxPerMs.p95 <= VELOCITY_STEP_P95_LIMIT
      && result.visualVelocityStepPxPerMs.max <= VELOCITY_STEP_MAX_LIMIT,
    frames: result.frameIntervalMs.p95 <= 20 && result.framesOver32MsRatio <= 0.01,
    keepUp: result.targetLagLines.max <= 2,
    hostFollow: result.hostPinnedRatio === 1,
    position: result.runwayPx.max <= 72,
    convergence: result.convergenceMs !== null && result.convergenceMs <= 500,
  }
  result.acceptance.pass = Object.values(result.acceptance).every(Boolean)
  if (includeFrames) result.frames = frames
  return result
}

function summarize(values) {
  if (values.length === 0) return { count: 0, min: null, p50: null, p95: null, max: null, mean: null }
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = quantile => sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)]
  const round = value => Math.round(value * 10000) / 10000
  return {
    count: values.length,
    min: round(sorted[0]),
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    max: round(sorted.at(-1)),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
  }
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Math.round(numerator / denominator * 10000) / 10000
}

function printReport(report) {
  const flag = value => value ? 'PASS' : 'FAIL'
  console.log(`scenario cps=${report.scenario.cps} cost=${report.scenario.costMs}ms duration=${report.scenario.durationMs}ms samples=${report.samples}`)
  console.log(`frame dt: p95=${report.frameIntervalMs.p95}ms max=${report.frameIntervalMs.max}ms >32ms=${(report.framesOver32MsRatio * 100).toFixed(2)}%`)
  console.log(`|raw scroll Δv|: p95=${report.scrollVelocityStepPxPerMs.p95} max=${report.scrollVelocityStepPxPerMs.max} px/ms`)
  console.log(`|painted scroll Δv|: p95=${report.paintedVelocityStepPxPerMs.p95} max=${report.paintedVelocityStepPxPerMs.max} px/ms`)
  console.log(`target lag: p95=${report.targetLagPx.p95}px max=${report.targetLagPx.max}px (${report.targetLagLines.max} lines)`)
  console.log(`runway: max=${report.runwayPx.max}px`)
  console.log(`host pinned: ${(report.hostPinnedRatio * 100).toFixed(2)}%`)
  console.log(`post-stop convergence: ${report.convergenceMs ?? '>500'}ms lag@500=${report.lagAt500MsPx}px`)
  console.log(`ACCEPT ${flag(report.acceptance.velocity)} velocity ${flag(report.acceptance.visual)} visible ${flag(report.acceptance.frames)} frames ${flag(report.acceptance.keepUp)} keep-up ${flag(report.acceptance.position)} position ${flag(report.acceptance.hostFollow)} host-follow ${flag(report.acceptance.convergence)} convergence`)
}

function printComparison(before, after) {
  const delta = (left, right) => Math.round((right - left) * 10000) / 10000
  console.log('comparison (after - before)')
  const beforeVelocity = before.scrollVelocityStepPxPerMs
  const afterVelocity = after.scrollVelocityStepPxPerMs
  console.log(`  |raw Δv| p95 ${beforeVelocity.p95} -> ${afterVelocity.p95} (${delta(beforeVelocity.p95, afterVelocity.p95)})`)
  console.log(`  |raw Δv| max  ${beforeVelocity.max} -> ${afterVelocity.max} (${delta(beforeVelocity.max, afterVelocity.max)})`)
  console.log(`  frame dt p95    ${before.frameIntervalMs.p95} -> ${after.frameIntervalMs.p95} (${delta(before.frameIntervalMs.p95, after.frameIntervalMs.p95)})`)
  console.log(`  lag max          ${before.targetLagPx.max} -> ${after.targetLagPx.max} (${delta(before.targetLagPx.max, after.targetLagPx.max)})`)
  console.log(`  convergence      ${before.convergenceMs} -> ${after.convergenceMs}`)
}
