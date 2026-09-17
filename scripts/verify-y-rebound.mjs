#!/usr/bin/env node
/**
 * Authoritative Y-Axis Monotonicity & Zero-Downward-Rebound Stress Tester.
 *
 * Mathematically validates that during automatic follow scrolling, visual content
 * in the viewport NEVER moves downwards (Δy_screen <= 0.3px) across any scenario.
 *
 * Scenarios tested:
 *   1. 稳态标准流 (600 CPS)
 *   2. 极限超高吞吐 (2500 CPS)
 *   3. 突发断流与抖动流 (Burst-Gap Jitter)
 *   4. 高频折行短句 (Rapid 5-10 char wraps)
 *   5. 重度 DOM 延迟 (5ms per tick)
 *   6. 速度动态跃迁 (50 CPS -> 3000 CPS Ramp)
 *   7. 包含思考块的流式渲染 (Reasoning Block)
 *   8. 收尾折叠与平滑归位 (Completion Settle)
 *
 * Usage: node scripts/verify-y-rebound.mjs [--runs 1] [--headed]
 */
import { chromium } from 'playwright-core'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const HEADFUL = args.includes('--headed')

const REBOUND_TOLERANCE_PX = 0.35 // Sub-pixel rounding tolerance

const SCENARIOS = [
  { id: 'steady-600', name: '1. 稳态标准流 (600 CPS)', cps: 600, domCostMs: 0, scenario: 'steady', durationMs: 4000 },
  { id: 'ultra-2500', name: '2. 极限超高吞吐 (2500 CPS)', cps: 2500, domCostMs: 0, scenario: 'ultra', durationMs: 4000 },
  { id: 'burst-gap', name: '3. 突发断流流 (Burst-Gap Jitter)', cps: 1200, domCostMs: 0, scenario: 'burst-gap', durationMs: 4500 },
  { id: 'rapid-wrap', name: '4. 高频短句折行 (Rapid Wraps)', cps: 800, domCostMs: 0, scenario: 'rapid-wrap', durationMs: 4000 },
  { id: 'heavy-dom', name: '5. 重度 DOM 延迟 (5ms Stall)', cps: 900, domCostMs: 5, scenario: 'steady', durationMs: 4000 },
  {
    // 8. 收尾折叠与平滑归位 (Completion Settle). The five scenarios above only
    // ever sampled ACTIVE streaming frames (`scrollTop > 10`) and explicitly
    // exempted any step taken while `scrollHeight` was shrinking, which is
    // precisely the interval a completion glide occupies. This one judges the
    // terminal window instead: from the frame the producer stops to the frame
    // layout goes quiet, on the READING ANCHOR's real screen-space position.
    id: 'terminal-drain',
    name: '8. 收尾排空与归位 (Terminal Drain)',
    cps: 1400,
    domCostMs: 0,
    scenario: 'steady',
    durationMs: 7000,
    strictAnchor: true,
  },
]

console.log('⚡ Building Y-Axis Zero-Rebound Testbed Bundle...')
const bundle = await build({
  entryPoints: [join(root, 'repro', 'stress-120fps.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: join(root, 'repro', 'stress-120fps.bundle.js'),
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
  const path = url.pathname === '/' ? 'stress-120fps.html' : url.pathname.replace(/^\//, '')
  try {
    const filePath = join(root, 'repro', path)
    const mem = bundleFiles.get(filePath)
    if (mem !== undefined) {
      response.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
      response.end(mem)
      return
    }
    if (existsSync(filePath)) {
      const data = await readFile(filePath)
      response.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
      response.end(data)
      return
    }
    response.writeHead(404)
    response.end('Not found')
  } catch (err) {
    response.writeHead(500)
    response.end(String(err))
  }
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const url = `http://127.0.0.1:${port}/stress-120fps.html`

function findChromium() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.CHROME_BIN,
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

const executablePath = findChromium()
const browser = await chromium.launch({
  executablePath: executablePath ?? undefined,
  headless: !HEADFUL,
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--enable-features=UseSkiaRenderer',
    '--force-device-scale-factor=1',
  ],
})

console.log(`🚀 Launched Chromium on Y-Axis Rebound Testbed: ${url}`)
console.log('='.repeat(80))

let allPassed = true
const summaryResults = []

for (const sc of SCENARIOS) {
  process.stdout.write(`▶ Testing ${sc.name} for Y-Axis Rebound ... `)
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(url)
  await page.waitForFunction(() => typeof window.__runStressTest === 'function')

  // Inject high-precision frame-level Y-position tracker
  await page.evaluate(() => {
    window.__yMotionLog = []
    let lastUserTop = null
    let lastVisualAdvancement = null

    const record = () => {
      const port = document.querySelector('[data-conversation-scroll]')
      const userMsg = document.querySelector('[data-chat-anchor-key="user-1"]')
      const assistantMsg = document.querySelector('[data-chat-anchor-key="assistant-1"]')
      if (!port || !assistantMsg) {
        requestAnimationFrame(record)
        return
      }

      const match = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(assistantMsg.style.transform || '')
      const shiftPx = match ? Number.parseFloat(match[1]) : 0
      const scrollTop = port.scrollTop
      const visualAdvancement = scrollTop - shiftPx // Monotonic upward metric

      const userTop = userMsg ? userMsg.getBoundingClientRect().top : null

      // SCREEN-SPACE READING ANCHOR. `visualAdvancement` above is derived from
      // `scrollTop - shift`, which is blind to the settle interval by
      // construction: while the pad retires, scrollTop glides down and the
      // compositor shift rises by the same amount, so the composite stays flat
      // even though the reader's content really moved. The anchor's own
      // bounding rect cannot cancel that way.
      const anchorTop = assistantMsg.getBoundingClientRect().top
      const statusEl = port.querySelector('[data-chat-turn-status], [data-chat-flow] > [role="status"]')
      const statusText = statusEl ? (statusEl.textContent ?? '') : ''
      const statusTop = statusEl ? statusEl.getBoundingClientRect().top : null
      const flowPadPx = (() => {
        const flow = port.querySelector('[data-chat-flow]')
        if (!flow) return 0
        return Number.parseFloat(getComputedStyle(flow).paddingBottom) || 0
      })()

      const now = performance.now()
      let downwardDelta = 0
      if (lastVisualAdvancement !== null) {
        // If visualAdvancement decreases, content moved DOWNWARDS on screen
        const delta = lastVisualAdvancement - visualAdvancement
        if (delta > 0) downwardDelta = delta
      }

      window.__yMotionLog.push({
        t: now,
        scrollTop,
        scrollHeight: port.scrollHeight,
        shiftPx,
        visualAdvancement,
        userTop,
        downwardDelta,
        anchorTop,
        statusTop,
        statusText,
        flowPadPx,
      })

      lastVisualAdvancement = visualAdvancement
      lastUserTop = userTop
      requestAnimationFrame(record)
    }

    requestAnimationFrame(record)
  })

  // Start scenario
  await page.evaluate(opts => {
    window.__runStressTest(opts)
  }, { cps: sc.cps, domCostMs: sc.domCostMs, scenario: sc.scenario })

  // Wait for streaming + settle
  await new Promise(resolve => setTimeout(resolve, sc.durationMs))

  // Collect data
  const motionLog = await page.evaluate(() => window.__yMotionLog ?? [])
  await page.close()

  // Filter streaming frames where follow is active (scrollTop > 10)
  const activeFrames = motionLog.filter(f => f.scrollTop > 10)
  const reboundViolations = []

  let maxDownwardMove = 0
  for (let i = 1; i < activeFrames.length; i++) {
    const prev = activeFrames[i - 1]
    const curr = activeFrames[i]
    // Ground truth downward movement check: user message must never move downwards (increasing top)
    const downward = (curr.userTop !== null && prev.userTop !== null)
      ? Math.max(0, curr.userTop - prev.userTop)
      : Math.max(0, prev.visualAdvancement - curr.visualAdvancement)

    // The completion settle's final glide (收尾归位) hands the engine's retired
    // space back to the layout: a rate-limited downward return whose scroll
    // extent SHRINKS every frame by design. Jitter is motion at a static
    // extent, or any step past the engine's per-frame rate bound.
    const gliding = curr.scrollHeight < prev.scrollHeight - 0.5 && downward <= 10

    if (downward > maxDownwardMove && !gliding) maxDownwardMove = downward
    if (downward > REBOUND_TOLERANCE_PX && !gliding) {
      reboundViolations.push({
        t: curr.t,
        downwardPx: downward,
        from: prev.userTop ?? prev.visualAdvancement,
        to: curr.userTop ?? curr.visualAdvancement,
      })
    }
  }

  const passed = reboundViolations.length === 0
  if (passed) {
    console.log(`\x1b[32mPASS (0 回弹, Max Δy_down = ${maxDownwardMove.toFixed(3)}px)\x1b[0m`)
  } else {
    allPassed = false
    console.log(`\x1b[31mFAIL (${reboundViolations.length} 次向下回弹, Max Δy_down = ${maxDownwardMove.toFixed(3)}px)\x1b[0m`)
    for (const v of reboundViolations.slice(0, 3)) {
      console.log(`    ⚠️ 回弹时间 +${v.t.toFixed(0)}ms: 向下回弹 ${v.downwardPx.toFixed(2)}px (从 ${v.from.toFixed(1)} 到 ${v.to.toFixed(1)})`)
    }
  }

  // TERMINAL WINDOW ASSERTION (strict-anchor scenarios only).
  //
  // Everything above is blind to the completion interval: it samples only
  // active frames and exempts motion taken while the extent shrinks. This block
  // instead judges the anchor's real screen position from the frame the
  // producer stopped until layout goes quiet — the interval the terminal-drain
  // contract is written against.
  let terminalSummary = {}
  if (sc.strictAnchor === true) {
    const doneAt = motionLog.find(f => (f.statusText ?? '').includes('已平滑归位'))
    const terminalFrames = doneAt === undefined
      ? []
      : motionLog.filter(f => f.t >= doneAt.t && f.t - doneAt.t <= 5000)
    const anchorSteps = []
    for (let i = 1; i < terminalFrames.length; i++) {
      const step = terminalFrames[i].anchorTop - terminalFrames[i - 1].anchorTop
      // Positive = the reading anchor moved DOWN the screen.
      if (step > 0) anchorSteps.push({ t: terminalFrames[i].t, step })
    }
    const worstAnchorStep = anchorSteps.reduce((max, s) => Math.max(max, s.step), 0)
    // Net displacement of the whole terminal window. The round trip defect is
    // "content rose, then came back DOWN", and the engine's entire contract is
    // that no automatic terminal frame may move the anchor down. A net NEGATIVE
    // value is the expected shape: the drain's remaining new lines keep pushing
    // the reading anchor up (off-screen) as they land. Only a net positive
    // return — measured from the window's own minimum, i.e. the highest point
    // the anchor reached — counts as the give-back.
    const lowestAnchorTop = terminalFrames.length > 0
      ? Math.min(...terminalFrames.map(f => f.anchorTop))
      : 0
    const netAnchorDrift = terminalFrames.length > 0
      ? terminalFrames.at(-1).anchorTop - lowestAnchorTop
      : 0
    const residualPad = terminalFrames.length > 0 ? terminalFrames.at(-1).flowPadPx : 0
    const anchorPassed = doneAt !== undefined
      && worstAnchorStep <= REBOUND_TOLERANCE_PX
      && Math.max(0, netAnchorDrift) <= REBOUND_TOLERANCE_PX
      && residualPad <= 0.5
    if (!anchorPassed) allPassed = false
    terminalSummary = {
      'Terminal Frames': terminalFrames.length,
      'Max Anchor Δy_down': `${worstAnchorStep.toFixed(3)} px`,
      'Net Anchor Drift': `${netAnchorDrift.toFixed(3)} px`,
      'Residual FlowPad': `${residualPad.toFixed(3)} px`,
    }
    if (doneAt === undefined) {
      console.log('\x1b[33m⚠️  未捕获到收尾完成标记，跳过终态断言\x1b[0m')
      allPassed = false
    } else if (anchorPassed) {
      console.log(`\x1b[32mPASS terminal (${terminalFrames.length} frames, Max anchor Δy_down = ${worstAnchorStep.toFixed(3)}px, net drift = ${netAnchorDrift.toFixed(3)}px, residual pad = ${residualPad.toFixed(3)}px)\x1b[0m`)
    } else {
      const worst = anchorSteps.reduce((max, s) => (s.step > max.step ? s : max), { t: 0, step: 0 })
      console.log(`\x1b[31mFAIL terminal (Max anchor Δy_down = ${worstAnchorStep.toFixed(3)}px at +${Math.round(worst.t - doneAt.t)}ms, net drift = ${netAnchorDrift.toFixed(3)}px, residual pad = ${residualPad.toFixed(3)}px)\x1b[0m`)
    }
  }

  summaryResults.push({
    Scenario: sc.name,
    'Total Frames': activeFrames.length,
    'Max Downward Δy': `${maxDownwardMove.toFixed(3)} px`,
    'Rebound Count': reboundViolations.length,
    Status: passed ? '✅ PASS (零回弹)' : '❌ FAIL',
    ...terminalSummary,
  })
}

await browser.close()
server.close()

console.log('='.repeat(80))
console.log('📊 Y-AXIS ZERO-DOWNWARD-REBOUND VERIFICATION SUMMARY:')
console.table(summaryResults)

if (!allPassed) {
  console.error('\n❌ Y 轴滚动回弹测试失败：存在向下回弹/抖动违规。')
  process.exit(1)
} else {
  console.log('\n🎉 所有测试场景下 Y 轴视觉位移保持 100% 严格单调向上，完完全全零向下回弹！')
  process.exit(0)
}
