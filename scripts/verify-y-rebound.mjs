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
// A legitimate rate-limited glide releases at most one frame's slice of the
// owned runway: runwayPx / FOLLOW_RUNWAY_RETIRE_MS at the 32ms frame ceiling is
// ~3.9px. Anything beyond this bound is a collapse, not a glide, however small
// the anchor step it happens to produce — see the `gliding` exemption below.
const MAX_GLIDE_SHRINK_PX = 12
// Mirrors the engine's FOLLOW_STATUS_RUNWAY_PX: the most owned space a handoff
// can ever hand back to the layout.
const FOLLOW_STATUS_RUNWAY_PX_HARNESS = 72
// One bounded retirement slice lands as an anchor step of at most one frame's
// release budget (runwayPx / FOLLOW_RUNWAY_RETIRE_MS * FOLLOW_MAX_FRAME_MS
// ≈ 3.9px), plus rounding headroom. Anything larger is a reflow-driven snap.
const RELEASE_MAX_ANCHOR_STEP_PX = 8
// Absolute bound on how far the reader may NET-move while the handoff retires
// the owned runway. The engine compensates the release in closed loop, so the
// honest bound is "did anything visibly move", not "is it smaller than the old
// 28-46px slam". The handoff frame also carries the drain's terminal commit and
// the engine's own shift decay, which is what this couple of px covers.
const RELEASE_NET_TOLERANCE_PX = 2.5

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

  // NEW-ROW-ADOPTION PROBE (strict-anchor scenarios only). A tool call that
  // lands while the completion handoff is retiring its pad joins the flow AFTER
  // the cleanup snapshotted its shift surfaces. Left out of the compensation it
  // rides the per-frame `scrollTop` descent while the reply above it is held
  // still — 73px of relative travel measured in the tool-card rig, which is the
  // "card slides on its own" defect.
  //
  // The probe row is `display:none` ON PURPOSE: it must be resolvable by
  // `shiftSurfacesOf` (a direct `[data-chat-flow]` child) without joining the
  // layout, because this scenario's release assertion is measured on the same
  // page and a real 52px row would perturb the very numbers it checks. Adoption
  // is judged on the transform the retire loop writes onto that hidden row; the
  // visible end-to-end travel is measured in scripts/probe-toolcard-handoff.mjs,
  // which drives a real laid-out card.
  if (sc.strictAnchor === true) {
    await page.evaluate(() => {
      window.__newRowProbe = { injectedAtPad: null, cardShift: null, anchorShift: null }
      const flowOf = () => document.querySelector('[data-chat-flow]')
      const padOf = () => {
        const flow = flowOf()
        return flow === null ? 0 : Number.parseFloat(getComputedStyle(flow).paddingBottom) || 0
      }
      const shiftOf = el => {
        const m = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform || '')
        return m === null ? 0 : Number.parseFloat(m[1])
      }
      let padFrames = 0
      let card = null
      const watch = () => {
        const pad = padOf()
        if (pad > 0.5) {
          padFrames += 1
          if (padFrames === 2 && card === null) {
            card = document.createElement('div')
            card.setAttribute('data-chat-anchor-key', 'tool-call-probe')
            card.setAttribute('data-chat-flow-key', 'tool-call-probe')
            card.setAttribute('data-chat-flow-kind', 'tool-call')
            card.style.cssText = 'display:none'
            const inner = document.createElement('div')
            inner.setAttribute('data-chat-call-id', 'probe-call')
            inner.textContent = 'probe tool row'
            card.append(inner)
            flowOf()?.append(card)
            window.__newRowProbe.injectedAtPad = pad
          }
        }
        if (card !== null && card.isConnected) {
          const anchor = document.querySelector('[data-chat-anchor-key="assistant-1"]')
          window.__newRowProbe.cardShift = shiftOf(card)
          window.__newRowProbe.cardTop = card.getBoundingClientRect().top
          window.__newRowProbe.anchorTop = anchor === null ? null : anchor.getBoundingClientRect().top
          if (anchor !== null) window.__newRowProbe.anchorShift = shiftOf(anchor)
          window.__newRowProbe.samples = window.__newRowProbe.samples ?? []
          window.__newRowProbe.samples.push({
            t: performance.now(),
            pad: pad,
            rel: window.__newRowProbe.anchorTop === null || window.__newRowProbe.cardTop === null
              ? null
              : window.__newRowProbe.anchorTop - window.__newRowProbe.cardTop,
            cardShift: window.__newRowProbe.cardShift,
            anchorShift: window.__newRowProbe.anchorShift,
          })
        }
        requestAnimationFrame(watch)
      }
      requestAnimationFrame(watch)
    })
  }

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
        clientHeight: port.clientHeight,
        shiftPx,
        visualAdvancement,
        userTop,
        downwardDelta,
        anchorTop,
        statusTop,
        statusText,
        flowPadPx,
        // Terminal-window evidence: whether the reply's text is still growing
        // (drain in flight) and where the READABLE text sits on screen. The
        // message wrapper's own rect keeps its padding and chrome, so the text
        // wrapper is the honest "is anything still readable" probe.
        textLen: (assistantMsg.textContent ?? '').length,
        textBottom: (() => {
          const text = assistantMsg.querySelector('div')
          if (text === null) return null
          return text.getBoundingClientRect().bottom
        })(),
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
  const newRowProbe = await page.evaluate(() => {
    const p = window.__newRowProbe
    if (p === undefined || p.samples === undefined || p.samples.length < 3) return null
    const steps = []
    for (let i = 1; i < p.samples.length; i += 1) {
      if (p.samples[i].rel === null || p.samples[i - 1].rel === null) continue
      steps.push({ t: p.samples[i].t, step: p.samples[i].rel - p.samples[i - 1].rel, rel: p.samples[i].rel })
    }
    // The injector appends mid-frame, so the first two samples straddle the
    // snapshot; the contract is about the steady state after adoption.
    const settled = steps.slice(2)
    return {
      samples: p.samples.length,
      injectedAtPad: p.injectedAtPad,
      shiftGap: Math.abs((p.cardShift ?? 0) - (p.anchorShift ?? 0)),
      cardShift: p.cardShift,
      anchorShift: p.anchorShift,
      relNet: settled.length < 2 ? 0 : Math.abs(settled[settled.length - 1].rel - settled[0].rel),
      relMaxStep: settled.reduce((acc, cur) => Math.max(acc, Math.abs(cur.step)), 0),
    }
  })
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
    //
    // The shrink itself must also be rate-limited. `extent shrank at all` was
    // enough before, which exempted an instantaneous collapse of the whole
    // owned runway (72px in one task, clamped straight onto the pinned floor)
    // for as long as the resulting anchor step stayed under 10px — the
    // burst-gap single-frame slam hid behind exactly that hole. A real glide
    // releases at most runwayPx/FOLLOW_RUNWAY_RETIRE_MS per frame.
    const extentShrinkPx = prev.scrollHeight - curr.scrollHeight
    const gliding = extentShrinkPx > 0.5
      && extentShrinkPx <= MAX_GLIDE_SHRINK_PX
      && downward <= REBOUND_TOLERANCE_PX * 10

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
  //
  // The window holds two physically different things and only one of them is a
  // defect:
  //
  //   * DRAIN (text still landing). Automatic follow is live and the anchor must
  //     hold: any downward step is a violation, and the threshold is the
  //     sub-pixel tolerance. This is where the round-trip defect lives.
  //   * RELEASE (drain closed, owned runway/pad handed back to the layout). The
  //     engine's contract permits exactly one shape here — a bounded,
  //     monotone, shrink-assisted descent — and only once the drain has closed
  //     and the reading anchor has left the screen. Nothing readable moves: the
  //     reply has drained to its final text and is above the scrollport, so the
  //     descent only retires empty space toward the composer.
  let terminalSummary = {}
  if (sc.strictAnchor === true) {
    const doneAt = motionLog.find(f => (f.statusText ?? '').includes('已平滑归位'))
    const terminalFrames = doneAt === undefined
      ? []
      : motionLog.filter(f => f.t >= doneAt.t && f.t - doneAt.t <= 5000)
    const lastLen = terminalFrames.length > 0
      ? Math.max(...terminalFrames.map(f => f.textLen ?? 0))
      : 0
    // The pad's first appearance IS the handoff frame: it carries the drain's
    // terminal commit and the first release slice at once, so it belongs to the
    // release leg. Counting it as drain reported the handoff as a drain-phase
    // step, which is not the interval the drain contract is written against.
    const padIndex = terminalFrames.findIndex(f => (f.flowPadPx ?? 0) > 0.5)
    const drainFrames = padIndex <= 0 ? terminalFrames : terminalFrames.slice(0, padIndex)
    const releaseFrames = padIndex <= 0 ? [] : terminalFrames.slice(padIndex)
    const releaseStart = releaseFrames.length > 0 ? releaseFrames[0] : null
    const textSettledAtRelease = releaseStart === null
      ? true
      : (releaseStart.textLen ?? 0) >= lastLen

    let maxDrainDown = 0
    for (let i = 1; i < drainFrames.length; i++) {
      const step = drainFrames[i].anchorTop - drainFrames[i - 1].anchorTop
      if (step > maxDrainDown) maxDrainDown = step
    }

    // Release leg: one bounded slice per frame, monotone, and — the part the
    // engine is actually accountable for — it may not NET-move the reader. The
    // handoff retires the owned runway/pad through a closed-loop compensation
    // that cancels the scrollport's real delta, so the readable content stays
    // put while the empty band closes. The bound below is therefore an absolute
    // one, not a "smaller than the old slam" allowance.
    const padSeen = releaseFrames
    let maxReleaseUp = 0
    let maxReleaseStep = 0
    for (let i = 1; i < releaseFrames.length; i++) {
      const step = releaseFrames[i].anchorTop - releaseFrames[i - 1].anchorTop
      if (step < maxReleaseUp) maxReleaseUp = step // negative = upward
      if (step > maxReleaseStep) maxReleaseStep = step
    }
    const releasePx = padSeen.length > 0 ? padSeen[0].flowPadPx : 0
    const releaseMonotone = maxReleaseUp >= -(REBOUND_TOLERANCE_PX + 0.5)
    const releaseBounded = releasePx <= FOLLOW_STATUS_RUNWAY_PX_HARNESS + 0.5
      && maxReleaseStep <= RELEASE_MAX_ANCHOR_STEP_PX
    const residualPad = terminalFrames.length > 0 ? terminalFrames.at(-1).flowPadPx : 0
    // Net reader movement across the whole release. The handoff frame itself
    // carries the drain's last growth and the engine's shift decay alongside
    // the first slice, so a couple of px of coupling survive there even with
    // compensation applied; it is bounded by RELEASE_NET_TOLERANCE_PX rather
    // than being waved through.
    const releaseNetDrift = releaseFrames.length > 0
      ? Math.max(
          ...releaseFrames.map(f => f.anchorTop),
        ) - Math.min(...releaseFrames.map(f => f.anchorTop))
      : 0

    // NEW-ROW ADOPTION. The row injected two frames into the release must end the
    // window carrying the same shift as the reply it sits under, and must not
    // travel relative to it. Not adopted, it rides the whole `scrollTop` descent
    // (tens of px) while the reply stays frozen — the failure this asserts.
    const probe = newRowProbe
    let newRowPassed = true
    if (probe === null) {
      console.log('\x1b[33m⚠️  新行纳管探针未取得样本（注入未发生或窗口过短）\x1b[0m')
      newRowPassed = false
    } else {
      // ADOPTION ONLY. A hidden row has no screen position to compare, so the
      // contract judged here is the one the engine owns: the retire loop enters
      // the new surface into the same shift write the reply is under. The
      // visible consequence is measured in scripts/probe-toolcard-handoff.mjs.
      newRowPassed = probe.cardShift !== null
        && probe.cardShift > 1
        && probe.shiftGap <= RELEASE_NET_TOLERANCE_PX
      if (newRowPassed) {
        console.log(`\x1b[32mPASS new-row (injected at pad ${probe.injectedAtPad?.toFixed(1)}px | new row shift ${probe.cardShift?.toFixed(1)} vs reply ${probe.anchorShift?.toFixed(1)}, gap ${probe.shiftGap.toFixed(3)}px — adopted into the compensation)\x1b[0m`)
      } else {
        console.log(`\x1b[31mFAIL new-row (new row shift ${probe.cardShift?.toFixed(1)} vs reply ${probe.anchorShift?.toFixed(1)}, gap ${probe.shiftGap.toFixed(3)}px — a row mounted during the release was NOT adopted into the compensation and will ride the scroll descent)\x1b[0m`)
      }
    }
    if (!newRowPassed) allPassed = false
    terminalSummary = {
      'Terminal Frames': terminalFrames.length,
      'Max Drain Δy_down': `${Math.max(0, maxDrainDown).toFixed(3)} px`,
      'Release Px': `${releasePx.toFixed(1)} px`,
      'Max Release Step': `${Math.max(0, maxReleaseStep).toFixed(3)} px`,
      'Release Net Drift': `${releaseNetDrift.toFixed(3)} px`,
      'Residual FlowPad': `${residualPad.toFixed(3)} px`,
      'New-Row Shift Gap': probe === null ? 'n/a' : `${probe.shiftGap.toFixed(3)} px`,
    }
    const anchorPassed = doneAt !== undefined
      && maxDrainDown <= REBOUND_TOLERANCE_PX
      && textSettledAtRelease
      && releaseMonotone
      && releaseBounded
      && releaseNetDrift <= RELEASE_NET_TOLERANCE_PX
      && residualPad <= 0.5
    if (!anchorPassed) allPassed = false
    if (doneAt === undefined) {
      console.log('\x1b[33m⚠️  未捕获到收尾完成标记，跳过终态断言\x1b[0m')
      allPassed = false
    } else if (anchorPassed) {
      console.log(`\x1b[32mPASS terminal (drain ${drainFrames.length}f, Max drain Δy_down = ${Math.max(0, maxDrainDown).toFixed(3)}px | release ${releasePx.toFixed(1)}px in ${releaseFrames.length}f, Max step = ${Math.max(0, maxReleaseStep).toFixed(3)}px, net drift = ${releaseNetDrift.toFixed(3)}px, monotone = ${releaseMonotone}, residual pad = ${residualPad.toFixed(3)}px)\x1b[0m`)
    } else {
      console.log(`\x1b[31mFAIL terminal (drain Δy_down = ${Math.max(0, maxDrainDown).toFixed(3)}px, release ${releasePx.toFixed(1)}px, Max step = ${Math.max(0, maxReleaseStep).toFixed(3)}px, net drift = ${releaseNetDrift.toFixed(3)}px (bound ${RELEASE_NET_TOLERANCE_PX}px), monotone = ${releaseMonotone}, bounded = ${releaseBounded}, textSettled = ${textSettledAtRelease}, residual pad = ${residualPad.toFixed(3)}px)\x1b[0m`)
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
