#!/usr/bin/env node
/**
 * Follow-stability black-box detector.
 *
 * The bar this script enforces (user contract, 2026-09-03):
 *   1. Once the follow engine scrolls the reader up, raw scrollTop must NEVER
 *      move back down (outside the designed, rate-limited settle glides).
 *   2. Pinned content must never visibly rebound downward (user-message top
 *      is the ground-truth probe) and the paint-shift must never manufacture
 *      a downward step the raw trajectory hides.
 *   3. The engine must not overshoot the bottom: the pinned bottom edge must
 *      not swing up and then return (over-scroll-then-bounce), and the end
 *      state must rest within FLOOR_EPS of the true floor (贴底, no offset).
 *
 * Instrumentation, all injected at document-start so nothing escapes:
 *   - scrollTop/scrollTo/scrollBy setter spy on the conversation port with a
 *     compacted call stack per write → every downward move is attributable to
 *     engine write / host snap / unknown.
 *   - per-rAF sampler: scrollTop, extents, user/head/tail/status rects,
 *     paint shifts, runway, data-follow-owned, engine debug state.
 *
 * Analysis runs in Node over the collected trajectories; violations print
 * with ±5-frame context and the full run is dumped as JSON for diffing.
 *
 * Usage: node scripts/verify-follow-stability.mjs [--runs 5] [--seed N]
 *               [--profile id] [--headed] [--out dir]
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reproDir = join(root, 'repro')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const RUNS = Number(argOf('--runs', '5'))
const ONLY_PROFILE = argOf('--profile', null)
const SEED = Number(argOf('--seed', String(Date.now() % 1e9)))
const HEADFUL = args.includes('--headed')
// Negative control: inject hostile external down-writes mid-stream — the
// detector MUST flag them (validates the harness actually sees the defect).
const INJECT_DROP = args.includes('--inject-drop')
const OUT_DIR = resolve(argOf('--out', join(reproDir, 'artifacts', 'follow-stability')))

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
const httpPort = server.address().port

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
  const text = message.text()
  if (message.type() === 'error') console.error('[console]', text.slice(0, 300))
  if (text.includes('[dshss-av]') || text.includes('[dsh-follow]')) console.log(text.slice(0, 240))
})

/* --------------------------- in-page instrument --------------------------- */

await page.addInitScript(() => {
  const state = { samples: [], writes: [] }

  const compactStack = () => {
    return String(new Error().stack ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('at '))
      .map(line => line
        .replace(/^at\s+/, '')
        .replace(/\s+\(.*$/, '')
        .replace(/^Object\./, '')
        .replace(/:\d+:\d+$/, ''))
      .filter(name => name !== 'set scrollTop' && name !== 'Array.forEach'
        && name !== 'compactStack' && name !== 'record' && name !== 'HTMLDivElement.set')
      .slice(0, 6)
      .join(' < ')
  }

  const install = (el) => {
    if (el.__fsSpy === true) return
    el.__fsSpy = true
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    const nativeGet = desc.get
    const nativeSet = desc.set
    const record = (via, before, requested, after) => {
      state.writes.push({
        t: performance.now(),
        before,
        requested,
        after,
        overshoot: requested - (el.scrollHeight - el.clientHeight),
        sh: el.scrollHeight,
        cl: el.clientHeight,
        owned: el.getAttribute('data-follow-owned'),
        via,
        stack: compactStack(),
      })
    }
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get() { return nativeGet.call(this) },
      set(value) {
        const before = nativeGet.call(this)
        nativeSet.call(this, value)
        record('scrollTop', before, value, nativeGet.call(this))
      },
    })
    for (const method of ['scrollTo', 'scrollBy', 'scroll']) {
      const original = el[method]
      if (typeof original !== 'function') continue
      el[method] = (...fnArgs) => {
        const before = el.scrollTop
        original.apply(el, fnArgs)
        record(method, before, el.scrollTop, el.scrollTop)
      }
    }
  }

  const tryInstall = () => {
    const port = document.querySelector('[data-conversation-scroll]')
    if (port !== null) { install(port); return true }
    return false
  }
  if (!tryInstall()) {
    const observer = new MutationObserver(() => {
      if (tryInstall()) observer.disconnect()
    })
    observer.observe(document, { childList: true, subtree: true })
  }

  const transformShiftOf = (el) =>
    Number(/translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el?.style.transform ?? '')?.[1] ?? 0)

  // Per-write shift ledger: every compositor transform DOM write in the flow,
  // timestamped — this sees INTRA-frame engine calls (handoff cleanups,
  // pre-paint corrections) that the rAF sampler coalesces.
  const shiftWrites = []
  const styleObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const el = mutation.target
      if (!(el instanceof HTMLElement)) continue
      shiftWrites.push({
        t: performance.now(),
        tag: `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`,
        shift: transformShiftOf(el),
        margin: Number.parseFloat(el.style.marginTop ?? '') || 0,
      })
    }
  })
  const armStyleObserver = () => {
    const flow = document.querySelector('[data-chat-flow]')
    if (flow !== null && !styleObserver.__armed) {
      styleObserver.observe(flow, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] })
      styleObserver.__armed = true
    } else if (flow === null) {
      requestAnimationFrame(armStyleObserver)
    }
  }
  requestAnimationFrame(armStyleObserver)
  const edgeOf = (el, edge) => {
    if (el === null || el.getClientRects().length === 0) return NaN
    const rect = el.getBoundingClientRect()
    return edge === 'bottom' ? rect.bottom : rect.top
  }

  let last = null
  const sample = (now) => {
    requestAnimationFrame(sample)
    const port = document.querySelector('[data-conversation-scroll]')
    if (port === null) return
    const dt = last === null ? 16.7 : now - last
    last = now
    const engine = typeof window.__debugState === 'function' ? window.__debugState() : undefined
    const surface = port.querySelector('[data-chat-anchor-key="a1"]')
    const statusEl = port.querySelector('[role="status"]')
    const flow = port.querySelector('[data-chat-flow]')
    const painted = [...(flow?.children ?? [])]
      .filter(child => child instanceof HTMLElement
        && !child.matches('[role="status"]')
        && child.getClientRects().length > 0)
    const lastPainted = painted.at(-1) ?? null
    const lastBottom = edgeOf(lastPainted, 'bottom')
    const portBottom = port.getBoundingClientRect().bottom
    state.samples.push({
      t: now,
      dt,
      top: port.scrollTop,
      sh: port.scrollHeight,
      cl: port.clientHeight,
      owned: port.getAttribute('data-follow-owned'),
      userTop: edgeOf(port.querySelector('[data-chat-anchor-key="u1"]'), 'top'),
      headBottom: edgeOf(port.querySelector('[data-probe="head"]'), 'bottom'),
      tailTop: edgeOf(port.querySelector('[data-probe="tail"]'), 'top'),
      statusTop: edgeOf(statusEl, 'top'),
      statusH: statusEl !== null && statusEl.getClientRects().length > 0 ? statusEl.getBoundingClientRect().height : NaN,
      shift: transformShiftOf(surface),
      statusShift: transformShiftOf(statusEl),
      runway: Number.parseFloat(statusEl?.style.marginTop ?? '') || 0,
      // Painted bottom edge of the last flow surface vs the port bottom:
      // over-scroll swings this, then a return closes it (the bounce).
      bottomGap: Number.isFinite(lastBottom) && Number.isFinite(portBottom) ? lastBottom - portBottom : NaN,
      lag: engine?.followLagPx ?? NaN,
      following: engine?.followFollowing ?? false,
      constrained: engine?.followConstrained ?? false,
      scale: engine?.followRevealScale ?? NaN,
    })
    if (state.samples.length > 200000) state.samples.splice(0, 50000)
  }
  requestAnimationFrame(sample)

  window.__fsCollect = () => ({ samples: state.samples, writes: state.writes, shiftWrites })
})

/* ------------------------------ analysis ---------------------------------- */

const RAW_DOWN_PX = 1.0        // raw scrollTop downward step treated as real (browser quantizes to 1px)
const VISUAL_REBOUND_PX = 0.5  // visible pinned-zone probes must never sink past this per frame
const RETIRE_GLIDE_PX = 1.2    // designed settle retire glides the bottom ≤ this per frame
const FLOOR_EPS = 1.5          // end-state |scrollTop - floor| tolerance
const OVERSCROLL_PX = 2        // painted content below the port bottom = over-scroll
const STALL_MS = 100           // frames wider than this are stalls, not motion
const WARMUP_MS = 350

const ENGINE_STACK = /setFollowScrollTop|applyVisual|pullReadingAnchor|settleAtFloor|finishAtNaturalFloor|teleprompterGlide/
const HOST_STACK = /toBottom|followRef|HostConversation|onScrollRef/

const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Analyze one run's trajectory. Returns { violations, stats }. */
function analyze({ samples, writes, shiftWrites }, phases) {
  const phaseT = (name) => phases.find(phase => phase.name === name)?.t ?? null
  const startedT = phaseT('started') ?? 0
  const foldedT = phaseT('folded')
  const warmupUntil = startedT + WARMUP_MS
  // The auto-collapse FOLD is one intentional, host-owned layout commit
  // (work seats display:none + summary insert + anchor compensation): the
  // column above the anchor visibly compresses by design. Carve only that
  // commit window — the completion tug-of-war BEFORE the fold stays policed.
  const inFoldCommit = (t) => foldedT !== null && t >= foldedT - 5 && t <= foldedT + 120

  const violations = []
  const push = (kind, t, detail, index) => {
    if (violations.length < 200) violations.push({ kind, t, detail, index })
  }

  const writesBetween = (fromT, toT) =>
    writes.filter(write => write.t > fromT && write.t <= toT + 4)

  // --- 1. raw scrollTop must never move down while pinned ------------------
  // NO blanket completion-window carve: the user-reported rebound lives
  // there. The only legal downward motion is a rate-limited glide whose
  // extent shrinks in lockstep (settle retire, fold compensation, disclosure
  // collapse) — checked by the dSh rule below, not by time windows.
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    if (current.t < warmupUntil) continue
    if (current.dt > STALL_MS || previous.dt > STALL_MS) continue
    const floor = current.sh - current.cl
    if (floor <= 1 || current.top <= 0) continue
    const dTop = current.top - previous.top
    if (dTop >= -RAW_DOWN_PX) continue
    const dSh = current.sh - previous.sh
    // Extent-shrinking lockstep (settle retire, fold compensation, disclosure
    // collapse): raw scrollTop follows the shrink 1:1, so the reader sees
    // nothing — visibility is policed by checks 2/3, not here. No rate bound:
    // the retire can legitimately step tens of px/frame.
    if (dSh < -0.5 && dTop >= dSh - 1) continue
    if (inFoldCommit(current.t)) continue
    const frameWrites = writesBetween(previous.t, current.t)
    const engineWrites = frameWrites.filter(write => ENGINE_STACK.test(write.stack))
    const hostWrites = frameWrites.filter(write => HOST_STACK.test(write.stack))
    let kind = 'raw-drop-unknown'
    if (hostWrites.length > 0 && engineWrites.length === 0) kind = 'host-snap-down'
    else if (engineWrites.some(write => write.requested > write.floor + 1)) kind = 'engine-overshoot-write'
    else if (engineWrites.length > 0) kind = 'engine-down-write'
    else if (frameWrites.length > 0) kind = 'external-down-write'
    push(kind, current.t,
      `scrollTop ${previous.top.toFixed(1)}→${current.top.toFixed(1)} (${dTop.toFixed(1)}px, sh ${previous.sh.toFixed(0)}→${current.sh.toFixed(0)})`
      + ` writes=[${frameWrites.slice(0, 3).map(write => `${write.via}:${write.before.toFixed(0)}→${write.after.toFixed(0)} ov=${write.overshoot.toFixed(0)} ${write.stack.split(' < ')[0]}`).join(' | ')}]`,
      index)
  }

  // --- 2. the bottom chrome must never sink (贴底 anchor) -------------------
  // The status row is the bottom-most element: its doc Y only changes when
  // content above it grows, and a pinned wrap commit locks scrollTop to that
  // same step, so while pinned its viewport Y is constant. A rise = the
  // whole bottom anchor sank = the visible rebound. Carve-outs: the designed
  // settle retire glides the bottom down ≤ ~1px/frame while the extent
  // shrinks; a status height morph moves its own top; the fold commit is
  // host-owned; the entrance frame that first leaves scrollTop 0.
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    if (current.t < warmupUntil || current.top <= 10 || previous.top <= 10) continue
    if (current.dt > STALL_MS || previous.dt > STALL_MS) continue
    const floor = current.sh - current.cl
    if (floor <= 1 || current.owned === null) continue
    if (inFoldCommit(current.t)) continue
    if (!Number.isFinite(current.statusTop) || !Number.isFinite(previous.statusTop)) continue
    const rise = current.statusTop - previous.statusTop
    // 1.0px threshold sits above browser scrollTop quantization wobble
    // (integer scrollTop vs fractional layout heights) but well under any
    // real lockstep error (observed defect forms are 3-26px).
    if (rise <= 1.0) continue
    const dSh = current.sh - previous.sh
    if (dSh <= -0.5 && rise <= RETIRE_GLIDE_PX) continue // designed retire glide
    if (Number.isFinite(current.statusH) && Number.isFinite(previous.statusH)
      && Math.abs(current.statusH - previous.statusH) > 0.5) continue // status morph
    push('bottom-zone-sink', current.t,
      `statusTop +${rise.toFixed(2)}px (top ${previous.top.toFixed(0)}→${current.top.toFixed(0)}, shift ${previous.shift.toFixed(1)}→${current.shift.toFixed(1)}, dSh=${dSh.toFixed(1)}, dTop=${(current.top - previous.top).toFixed(1)})`,
      index)
  }

  // --- 3. the reading zone must never sink (fixed-content probe) ------------
  // V = scrollTop − shift is the painted position of the assistant surface's
  // TOP — fixed content during streaming (wraps grow inside it; the lockstep
  // commit cancels the steps). A drop = the text the reader is watching moved
  // DOWN = the rebound. Frames where the extent is collapsing (think
  // disclosure, fold) are excluded: content above the collapse point sinks
  // as part of the collapse animation itself, not from scroll motion.
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    if (current.t < warmupUntil || current.top <= 10 || previous.top <= 10) continue
    if (current.dt > STALL_MS || previous.dt > STALL_MS) continue
    const floor = current.sh - current.cl
    if (floor <= 1) continue
    if (inFoldCommit(current.t)) continue
    const dSh = current.sh - previous.sh
    if (dSh <= -0.5) continue // extent collapsing: top-zone sink is the animation
    const dV = (current.top - current.shift) - (previous.top - previous.shift)
    if (dV >= -VISUAL_REBOUND_PX) continue
    push('visual-down-step', current.t,
      `reading zone ${((previous.top - previous.shift)).toFixed(1)}→${((current.top - current.shift)).toFixed(1)} (${dV.toFixed(2)}px, top ${previous.top.toFixed(0)}→${current.top.toFixed(0)}, shift ${previous.shift.toFixed(1)}→${current.shift.toFixed(1)}, dSh=${dSh.toFixed(1)})`,
      index)
  }

  // --- 3b. user-message top, only while it is actually on screen ------------
  // Above the fold it is invisible and legitimately sinks with any extent
  // collapse; near the viewport it is a stable early-stream anchor.
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    if (current.t < warmupUntil || current.top <= 10 || previous.top <= 10) continue
    if (current.dt > STALL_MS || previous.dt > STALL_MS) continue
    const floor = current.sh - current.cl
    if (floor <= 1) continue
    if (inFoldCommit(current.t)) continue
    if (!Number.isFinite(current.userTop) || !Number.isFinite(previous.userTop)) continue
    if (previous.userTop < -previous.cl * 0.5) continue // off-screen: not a visual probe
    const dUser = current.userTop - previous.userTop
    if (dUser <= VISUAL_REBOUND_PX) continue
    const dSh = current.sh - previous.sh
    if (dSh <= -0.5) continue // extent collapsing: above-collapse content sinks by design
    push('visual-rebound', current.t,
      `userTop +${dUser.toFixed(2)}px on-screen (top ${previous.top.toFixed(0)}→${current.top.toFixed(0)}, shift ${previous.shift.toFixed(1)}→${current.shift.toFixed(1)}, dSh=${dSh.toFixed(1)})`,
      index)
  }

  // --- 3b. over-scroll: painted content must not cross the port bottom -----
  // scrollTop pins to the floor, so painted content below the port bottom
  // means the engine shifted/rolled past the true bottom ("滚得太高" — the
  // over-scroll half of the bounce). The return leg is upward motion, which
  // is always allowed; catching the crossing leg is enough.
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index]
    if (current.t < warmupUntil || current.dt > STALL_MS) continue
    const floor = current.sh - current.cl
    // owned === null → the engine yielded (reader reading above the bottom);
    // content extending below the viewport is then the normal reading state.
    if (floor <= 1 || current.top <= 10 || current.owned === null) continue
    if (!Number.isFinite(current.bottomGap) || current.bottomGap <= 2) continue
    push('bottom-overscroll', current.t,
      `painted bottom edge ${current.bottomGap.toFixed(1)}px below port bottom (top ${current.top.toFixed(0)}, floor ${floor.toFixed(0)}, shift ${current.shift.toFixed(1)}, runway ${current.runway.toFixed(0)})`,
      index)
  }

  // --- 4. end state must rest exactly on the floor (贴底, no offset) --------
  const tail = samples.slice(-6).filter(sample => sample.t >= warmupUntil)
  if (tail.length > 0) {
    const rest = tail.at(-1)
    const floor = rest.sh - rest.cl
    if (floor > 1 && Math.abs(rest.top - floor) > FLOOR_EPS) {
      push('end-not-pinned', rest.t, `scrollTop ${rest.top.toFixed(1)} vs floor ${floor.toFixed(1)} (off by ${(rest.top - floor).toFixed(1)}px)`, samples.length - 1)
    }
    if (floor <= 1 && rest.top > FLOOR_EPS) {
      push('end-not-pinned', rest.t, `flow collapsed (floor ${floor.toFixed(1)}) but scrollTop rests at ${rest.top.toFixed(1)}`, samples.length - 1)
    }
  }

  // --- engine overshoot requests (diagnostic, feeds check 1 attribution) ----
  const overshootWrites = writes.filter(write => write.overshoot > 1 && ENGINE_STACK.test(write.stack))
  const hostSnaps = writes.filter(write => HOST_STACK.test(write.stack) && Math.abs(write.after - write.before) > 1)

  const stats = {
    samples: samples.length,
    writes: writes.length,
    engineOvershootWrites: overshootWrites.length,
    hostSnaps: hostSnaps.length,
    maxScrollTop: Math.max(...samples.map(sample => sample.top)),
  }
  return { violations, stats }
}

const contextOf = (samples, violations, writes, shiftWrites) => violations.slice(0, 6).map((violation) => {
  const index = violation.index
  if (index === undefined || index < 0 || index >= samples.length) return violation.detail
  const from = Math.max(0, index - 5)
  const to = Math.min(samples.length, index + 6)
  const lines = []
  for (let i = from; i < to; i += 1) {
    const sample = samples[i]
    const marker = i === index ? '▶' : ' '
    lines.push(`${marker} t+${Math.round(sample.t)} st=${sample.top.toFixed(1)} fl=${(sample.sh - sample.cl).toFixed(0)} sh=${sample.sh.toFixed(0)}`
      + ` sft=${sample.shift.toFixed(1)} user=${Number.isFinite(sample.userTop) ? sample.userTop.toFixed(1) : '-'}`
      + ` gap=${Number.isFinite(sample.bottomGap) ? sample.bottomGap.toFixed(1) : '-'} rw=${sample.runway.toFixed(0)} own=${sample.owned ?? '-'}`)
  }
  const nearWrites = writes
    .filter(write => Math.abs(write.t - violation.t) <= 60)
    .slice(0, 5)
    .map(write => `    w@+${Math.round(write.t - violation.t)}ms ${write.via} ${write.before.toFixed(1)}→${write.after.toFixed(1)} req=${write.requested.toFixed(1)} ov=${write.overshoot.toFixed(0)} :: ${write.stack.split(' < ').slice(0, 3).join(' < ')}`)
  const nearShifts = (shiftWrites ?? [])
    .filter(write => Math.abs(write.t - violation.t) <= 60)
    .slice(0, 14)
    .map(write => `    s@+${Math.round(write.t - violation.t)}ms ${write.tag} shift=${write.shift.toFixed(1)} mt=${write.margin.toFixed(0)}`)
  return [violation.detail, ...lines, ...nearWrites, ...nearShifts].join('\n')
})

/* -------------------------------- drive ----------------------------------- */

const PROFILES = ['slow-steady', 'fast-sustained', 'burst-gap', 'ramp', 'short-answer']
const random = mulberry32(SEED)
await mkdir(OUT_DIR, { recursive: true })

console.log(`follow-stability detector: runs=${RUNS} seed=${SEED} out=${OUT_DIR}`)
console.log('='.repeat(88))

/** @type {Array<{run: number, profile: string, ok: boolean, violations: Array, stats: object, file: string}>} */
const results = []
let failedRuns = 0

for (let run = 1; run <= RUNS; run += 1) {
  const profileId = ONLY_PROFILE ?? PROFILES[(run - 1) % PROFILES.length]
  // Soak randomization: jitter the profile so timing races move around.
  const overrides = {
    jitter: Math.round(random() * 80) / 100,
    foldDelayMs: Math.round(60 + random() * 340),
    swapDeltaPx: [0, 0, 0, 6, 12, 24][Math.floor(random() * 6)],
  }
  await page.goto(`http://127.0.0.1:${httpPort}/audit.html?v=${Date.now()}-${run}`)
  if (args.includes('--trace-av')) {
    await page.evaluate(() => { globalThis.__dshssTrace = true })
  }
  await page.waitForSelector('[data-conversation-scroll]')
  await page.evaluate(({ id, overrides: overridesLocal }) => window.__start(id, overridesLocal), { id: profileId, overrides })
  if (INJECT_DROP) {
    // Mid-stream hostile writes: an external controller yanking scrollTop
    // down 4px at random moments while the engine is following.
    await page.evaluate(() => {
      const timer = setInterval(() => {
        const port = document.querySelector('[data-conversation-scroll]')
        if (port === null) return
        if (port.scrollTop > 60 && Math.random() < 0.35) port.scrollTop -= 4
      }, 120)
      window.__auditPhase && window.__auditPhase('inject-drop-armed')
      setTimeout(() => clearInterval(timer), 8000)
    })
  }
  await page.waitForFunction(() => window.__reportReady === true, null, { timeout: 120000, polling: 250 }).catch(() => {})
  await page.waitForTimeout(250)

  const trajectory = await page.evaluate(() => window.__fsCollect())
  const report = await page.evaluate(() => window.__report())
  const phases = report.phases ?? []

  const { violations, stats } = analyze(trajectory, phases)
  const auditBlocking = (report.violations ?? []).filter(v => v.kind !== 'velocity-step')
  const ok = violations.length === 0
  if (!ok) failedRuns += 1

  const file = join(OUT_DIR, `run-${String(run).padStart(2, '0')}-${profileId}.json`)
  await writeFile(file, JSON.stringify({
    run, profile: profileId, overrides, seed: SEED,
    ok, violations, stats,
    auditViolations: auditBlocking,
    phases,
    samples: trajectory.samples,
    writes: trajectory.writes,
    shiftWrites: trajectory.shiftWrites,
  }))

  const kinds = violations.map(v => v.kind).join(',') || 'clean'
  console.log(`run ${String(run).padStart(2)} ${profileId.padEnd(14)} jitter=${overrides.jitter.toFixed(2)} fold=${overrides.foldDelayMs} swap=${overrides.swapDeltaPx}  ${ok ? 'PASS' : 'FAIL'}  frames=${stats.samples} writes=${stats.writes} ovw=${stats.engineOvershootWrites} hostSnaps=${stats.hostSnaps}`)
  console.log(`         kinds: ${kinds}`)
  if (auditBlocking.length > 0) console.log(`         audit(secondary): ${auditBlocking.map(v => `${v.kind}@${Math.round(v.t)}`).slice(0, 8).join(', ')}`)
  if (!ok) {
    for (const line of contextOf(trajectory.samples, violations, trajectory.writes, trajectory.shiftWrites)) {
      console.log(`  ⚠️  ${line}`)
    }
    console.log(`         trajectory → ${file}`)
  }
  results.push({ run, profile: profileId, ok, violations, stats, file })
}

await browser.close()
server.close()

console.log('='.repeat(88))
const byKind = {}
for (const result of results) {
  for (const violation of result.violations) byKind[violation.kind] = (byKind[violation.kind] ?? 0) + 1
}
console.log(`summary: ${results.length - failedRuns}/${results.length} runs clean; violations by kind:`, JSON.stringify(byKind))
if (failedRuns > 0) {
  console.error(`\n❌ follow-stability FAILED on ${failedRuns}/${results.length} runs (seed=${SEED}; reproduce with --seed ${SEED})`)
  process.exit(1)
}
console.log(`\n🎉 follow-stability: all ${results.length} runs clean (seed=${SEED})`)
