#!/usr/bin/env node
/**
 * Measure the visible completion rebound in the real follower audit rig.
 * Unlike verify-overflow, this checks every frame from producer completion
 * through the final settled paint. A temporary scroll floor is diagnostic;
 * the pass/fail signal is the screen position of stable message anchors.
 *
 * Usage: node scripts/verify-terminal-rebound.mjs
 *   [--profiles short-answer,burst-gap,fast-sustained] [--trace /tmp/trace.json]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reproDir = join(root, 'repro')
const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1] ?? fallback
}
const profiles = option('--profiles', 'short-answer,burst-gap,fast-sustained').split(',')
const tracePath = option('--trace', '')
const statusMode = option('--status', 'none')
const swapDeltaPx = Number(option('--swap-delta', '0')) || 0
const swapMode = option('--swap', 'default')
const hostFollowMode = option('--host-follow', 'default')
const foldMode = option('--fold', 'default')
const footerMode = option('--footer', 'default')
const downwardTolerancePx = 2

const bundle = await build({
  entryPoints: [join(reproDir, 'audit.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: join(reproDir, 'audit.bundle.js'),
  write: false,
  loader: { '.css': 'local-css' },
  alias: {
    '@deepseek-ai/dsh-client-ui-primitives': join(reproDir, 'shims/primitives.tsx'),
    '@deepseek-ai/dsh-client-runtime': join(reproDir, 'shims/client-runtime.ts'),
    '@deepseek-ai/dsh-client-runtime/client': join(reproDir, 'shims/client-runtime.ts'),
  },
  jsx: 'automatic',
  logLevel: 'silent',
})
const generated = new Map(bundle.outputFiles.map(file => [file.path, file.contents]))
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (request, response) => {
  const name = new URL(request.url ?? '/', 'http://localhost').pathname.replace(/^\//, '') || 'audit.html'
  const path = join(reproDir, name)
  try {
    const data = generated.get(path) ?? await readFile(path)
    response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' })
    response.end(data)
  } catch {
    response.writeHead(404)
    response.end()
  }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))

const cache = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
const executablePath = process.env.AUDIT_CHROMIUM ?? [
  join(cache, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
  join(cache, 'chromium-1217', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync)

let browser
let failed = false
const traces = []
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--force-device-scale-factor=1'] })
  for (const profile of profiles) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    try {
      const query = new URLSearchParams({ status: statusMode, swap: swapMode, hostfollow: hostFollowMode, fold: foldMode, footer: footerMode })
      await page.goto(`http://127.0.0.1:${server.address().port}/audit.html?${query}`)
      await page.waitForSelector('[data-conversation-scroll]')
      await page.evaluate(() => {
        const samples = []
        window.__terminalMotionSamples = samples
        const top = selector => {
          const element = document.querySelector(selector)
          return element?.getClientRects().length ? element.getBoundingClientRect().top : null
        }
        const tick = now => {
          requestAnimationFrame(tick)
          const port = document.querySelector('[data-conversation-scroll]')
          if (!port) return
          const flow = port.querySelector('[data-chat-flow]')
          const status = flow?.querySelector(':scope > [role="status"]')
          const assistant = port.querySelector('[data-chat-anchor-key="a1"]')
          const textBlock = port.querySelector('[data-probe="text-block"]')
          const composer = port.querySelector('[data-composer-seat]')
          const state = window.__debugState?.()
          samples.push({
            t: now,
            userY: top('[data-probe="head"]'),
            assistantY: top('[data-chat-anchor-key="a1"]'),
            assistantBottom: assistant?.getClientRects().length ? assistant.getBoundingClientRect().bottom : null,
            textTop: top('[data-probe="text-block"]'),
            textBottom: textBlock?.getClientRects().length ? textBlock.getBoundingClientRect().bottom : null,
            textHeight: textBlock?.getClientRects().length ? textBlock.getBoundingClientRect().height : null,
            composerY: composer?.getClientRects().length ? composer.getBoundingClientRect().top : null,
            portBottom: port.getBoundingClientRect().bottom,
            tailY: top('[data-probe="tail"]'),
            statusY: top('[data-probe="status"]'),
            scrollTop: port.scrollTop,
            floor: Math.max(0, port.scrollHeight - port.clientHeight),
            scrollHeight: port.scrollHeight,
            flowPad: Number.parseFloat(flow?.style.paddingBottom ?? '') || 0,
            statusRunway: Number.parseFloat(status?.style.marginTop ?? '') || 0,
            assistantRunway: Number.parseFloat(assistant?.style.marginBottom ?? '') || 0,
            assistantShift: Number(/translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(assistant?.style.transform ?? '')?.[1] ?? 0),
            lag: state?.followLagPx ?? null,
            reserve: state?.followReservePx ?? null,
            terminalPhase: state?.followTerminalPhase ?? null,
            statusPresent: status !== null,
          })
        }
        requestAnimationFrame(tick)
      })
      await page.evaluate(({ id, swapDeltaPx }) => window.__start(id, { swapDeltaPx }), { id: profile, swapDeltaPx })
      await page.waitForFunction(() => window.__reportReady === true, null, { timeout: 45000 })
      await page.waitForTimeout(1200)
      const { samples, report } = await page.evaluate(() => ({
        samples: window.__terminalMotionSamples,
        report: window.__report(),
      }))
      const phases = report.phases
      const producedAt = phases.find(phase => phase.name === 'produced')?.t
      const drainedAt = phases.find(phase => phase.name === 'drained' && phase.t >= producedAt)?.t
      if (producedAt === undefined || drainedAt === undefined) throw new Error(`Missing completion phases: ${JSON.stringify(phases)}`)
      const terminal = samples.filter(sample => sample.t >= producedAt && sample.textTop !== null)
      const afterDrain = terminal.filter(sample => sample.t >= drainedAt && sample.textBottom !== null)
      if (terminal.length < 5 || afterDrain.length < 5) throw new Error('Too few terminal frames')

      let minUserY = Number.POSITIVE_INFINITY
      let maxReturnPx = 0
      let maxDownStepPx = 0
      let worstAt = producedAt
      for (let i = 0; i < terminal.length; i++) {
        const current = terminal[i]
        minUserY = Math.min(minUserY, current.userY)
        const returned = current.userY - minUserY
        if (returned > maxReturnPx) { maxReturnPx = returned; worstAt = current.t }
        if (i > 0 && current.t - terminal[i - 1].t <= 100) {
          maxDownStepPx = Math.max(maxDownStepPx, current.userY - terminal[i - 1].userY)
        }
      }
      let maxTextReturnPx = 0
      let minTextTop = Number.POSITIVE_INFINITY
      let textWorstAt = producedAt
      for (const sample of terminal) {
        minTextTop = Math.min(minTextTop, sample.textTop)
        const returned = sample.textTop - minTextTop
        if (returned > maxTextReturnPx) { maxTextReturnPx = returned; textWorstAt = sample.t }
      }
      const final = terminal.at(-1)
      const finalTextBottom = afterDrain.at(-1)?.textBottom ?? null
      const textBottomOvershootPx = finalTextBottom === null
        ? 0
        : Math.max(0, ...afterDrain.map(sample => (sample.textBottom ?? finalTextBottom) - finalTextBottom))
      const maxTerminalShiftPx = Math.max(...afterDrain.map(sample => Math.abs(sample.assistantShift)))
      const maxTerminalPadPx = Math.max(...afterDrain.map(sample => sample.flowPad))
      const tailSamples = afterDrain.filter(sample => sample.tailY !== null)
      const finalTailY = tailSamples.at(-1)?.tailY ?? null
      const tailReturnPx = finalTailY === null ? 0 : finalTailY - Math.min(...tailSamples.map(sample => sample.tailY))
      const maxTailSample = terminal.reduce((best, sample) =>
        sample.scrollTop > 1 && sample.tailY !== null && (best === null || sample.tailY > best.tailY) ? sample : best,
        null)
      const tailOvershootPx = finalTailY === null ? 0 : Math.max(0, (maxTailSample?.tailY ?? finalTailY) - finalTailY)
      const scrollOvershootPx = Math.max(...terminal.map(sample => sample.scrollTop)) - final.scrollTop
      const maxPadPx = Math.max(...terminal.map(sample => sample.flowPad))
      // The head deliberately changes position when the earlier Think seats
      // fold. The assistant's last text edge is stable after its reveal, so a
      // peak followed by a return is the reported terminal bounce.
      const terminalGeometryOk = statusMode !== 'none'
        || (maxTerminalShiftPx <= downwardTolerancePx && maxTerminalPadPx <= downwardTolerancePx)
      const ok = maxTextReturnPx <= downwardTolerancePx
        && textBottomOvershootPx <= downwardTolerancePx
        && terminalGeometryOk
      failed ||= !ok
      const summary = { profile, ok, maxTextReturnPx, textBottomOvershootPx, maxTerminalShiftPx, maxTerminalPadPx, maxReturnPx, maxDownStepPx, tailReturnPx, tailOvershootPx, scrollOvershootPx, maxPadPx, worstAtMs: textWorstAt - producedAt }
      const aroundWorst = terminal.filter(sample => Math.abs(sample.t - textWorstAt) <= 100)
      traces.push({ summary, phases, samples, aroundWorst, auditViolations: report.violations })
      console.log(`${profile}: ${ok ? 'PASS' : 'FAIL'}  textTopReturn=${maxTextReturnPx.toFixed(2)}px  textBottomOvershoot=${textBottomOvershootPx.toFixed(2)}px  terminalShift=${maxTerminalShiftPx.toFixed(2)}px  terminalPad=${maxTerminalPadPx.toFixed(2)}px  tailOvershoot=${tailOvershootPx.toFixed(2)}px  anchorReturn=${maxReturnPx.toFixed(2)}px  scrollBeyondFinal=${scrollOvershootPx.toFixed(2)}px`)
      if (!ok) {
        for (const sample of aroundWorst.slice(0, 12)) {
          console.log(`  +${(sample.t - producedAt).toFixed(0)}ms text=${sample.textTop.toFixed(1)}..${sample.textBottom?.toFixed(1) ?? '-'} h=${sample.textHeight?.toFixed(1) ?? '-'} tail=${sample.tailY?.toFixed(1) ?? '-'} top=${sample.scrollTop.toFixed(1)} floor=${sample.floor.toFixed(1)} runway=${sample.assistantRunway.toFixed(1)} shift=${sample.assistantShift.toFixed(1)} reserve=${sample.reserve?.toFixed(1) ?? '-'} lag=${sample.lag?.toFixed(1) ?? '-'}`)
        }
      }
    } finally {
      await page.close()
    }
  }
} finally {
  await browser?.close()
  await new Promise(done => server.close(done))
  if (tracePath !== '') await writeFile(tracePath, JSON.stringify({ traces }, null, 2))
}
process.exitCode = failed ? 1 : 0
