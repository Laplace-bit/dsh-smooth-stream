#!/usr/bin/env node
/** [DEBUG-a4f2] Activation probe — is the smooth-stream client takeover alive on every page load?
 *
 * Boots an ISOLATED harness host (DSH_HOME temp copy of the web profile, mock LLM),
 * then drives N independent page loads: each sends one mock-stream reply and samples
 * plugin DOM markers (`[data-streaming]`, `[data-variant="think"]`, `data-follow-owned`)
 * plus every console error / page error. A page load is RED when the plugin's renderer
 * is absent while the stream runs, when text dumps in huge single-frame jumps, or when
 * the console shows slot entry / crash reports.
 *
 * usage: node scripts/probe-activation.mjs [iterations=5] [--keep]
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ITERATIONS = Number(process.argv[2] ?? 5)
const KEEP = process.argv.includes('--keep')
const HARNESS = '/Users/dzlin/work/project/deepseek-harness'
const REAL_PROFILE = '/Users/dzlin/.dsh/profiles/web'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MOCK_URL = 'http://127.0.0.1:49731'
const MOCK_KEY = 'mock'

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function ensureMockServer() {
  try {
    const res = await fetch(`${MOCK_URL}/v1/models`)
    if (res.ok) return { started: false }
  } catch {}
  const child = spawn(process.execPath, [new URL('./mock-llm-server.mjs', import.meta.url).pathname], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try {
      const res = await fetch(`${MOCK_URL}/v1/models`)
      if (res.ok) return { started: true, child }
    } catch {}
  }
  throw new Error('mock LLM did not come up')
}

async function bootHost() {
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-activation-'))
  const home = join(tmp, 'home')
  // Clone the user's real home so workspaces/sessions/history behave exactly
  // like production UI (fresh homes stop at the workspace picker). The clone
  // is private to the probe and deleted afterwards — the real home is never
  // touched.
  await cp('/Users/dzlin/.dsh', home, { recursive: true, verbatimSymlinks: true })
  // Relative plugin links break at the new depth — re-point them absolutely.
  const nm = join(home, 'profiles', 'web', 'node_modules')
  for (const name of ['dsh-airbind', 'dsh-bell-notify', 'dsh-pianist', 'dsh-smooth-stream']) {
    await rm(join(nm, name), { force: true, recursive: true })
    await cp(`/Users/dzlin/work/project/${name}`, join(nm, name), { recursive: true, verbatimSymlinks: true })
  }
  await writeFile(join(home, 'settings.yaml'), `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
ui-theme:
  preference: dark
agent-default-model:
  model: mock-stream
  provider: dsh-mock
llm-pi-ai:
  providers:
    dsh-mock:
      apiKeyEnv: DSH_MOCK_KEY
      api: openai-completions
      baseURL: ${MOCK_URL}/v1
      models:
        - id: mock-stream
          name: mock-stream
`)
  // The user's live host owns 127.0.0.1:3080 — pin this probe host to an
  // OS-assigned port through the launcher's patch overlay. PROBE_DISABLE_PLUGIN=1
  // additionally disables the smooth-stream plugin row (differential calibration:
  // the detector must report RED when the plugin is off).
  const disablePlugin = process.env.PROBE_DISABLE_PLUGIN === '1'
    ? '\n- id: dsh-smooth-stream\n  disabled: true\n'
    : ''
  await writeFile(join(home, 'port-zero.yml'), `- id: webserver
  config:
    host: 127.0.0.1
    port: 0
${disablePlugin}`)

  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    '--profile', 'web', '--patch', join(home, 'port-zero.yml'), '--no-open',
  ], {
    cwd: HARNESS,
    env: { ...process.env, DSH_HOME: home, DSH_MOCK_KEY: MOCK_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let bootLog = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`host boot timeout. log:\n${bootLog.slice(-3000)}`)), 120_000)
    const onChunk = buf => {
      bootLog += buf.toString()
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(bootLog)
      if (m) {
        clearTimeout(timer)
        resolve(`http://127.0.0.1:${m[1]}/?token=${m[2]}`)
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('exit', code => reject(new Error(`host exited early (${code}). log:\n${bootLog.slice(-3000)}`)))
  })
  return { tmp, home, child, url, bootLog }
}

async function driveOnce(browser, url, index) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const consoleHits = []
  const pageErrors = []
  page.on('console', msg => {
    const text = msg.text()
    if (msg.type() === 'error' || msg.type() === 'warning'
      || /dsh-smooth-stream|slot|entry|abdicate|crash/i.test(text)) {
      consoleHits.push(`[${msg.type()}] ${text.slice(0, 400)}`)
    }
  })
  page.on('pageerror', err => pageErrors.push(String(err).slice(0, 500)))

  const result = { index, pluginFrames: 0, frames: 0, dumps: 0, reveal: 'unknown', consoleHits, pageErrors }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForSelector('[data-conversation-scroll]', { timeout: 30_000 })
    await sleep(1200)
    try {
      await page.locator('button[aria-label="新建会话"]').last().click({ timeout: 3000 })
      await sleep(700)
    } catch {}
    const model = await page.evaluate(() =>
      document.querySelector('button[aria-label^="选择模型"]')?.getAttribute('aria-label') ?? '')
    result.model = model
    if (!model.includes('mock-stream')) {
      result.modelWarning = `model picker shows "${model}" — expected mock-stream`
    }
    const typed = await page.evaluate(text => {
      const ta = document.querySelector('textarea') ?? document.querySelector('[contenteditable="true"]')
      if (!ta) return 'NO_COMPOSER'
      return `composer:${ta.tagName}`
    }, '')
    if (typed === 'NO_COMPOSER') throw new Error(typed)
    // The composer is a Lexical contenteditable — native value injection does
    // not register; real keyboard input does.
    const editor = page.locator('[contenteditable="true"]').first()
    await editor.click()
    await editor.type('请用至少八百字详细介绍量子计算的基本原理、发展历史、当前挑战与未来展望，尽量分多段展开。', { delay: 4 })
    await page.waitForTimeout(400)
    const sent = await page.evaluate(() => {
      const send = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? '').includes('发送'))
      if (send && !send.disabled) { send.click(); return 'clicked-send' }
      return 'send-disabled'
    })
    if (sent !== 'clicked-send') {
      await page.keyboard.press('Enter')
    }
    result.sent = sent
    const beforeLen = await page.evaluate(() => (document.querySelector('[data-conversation-scroll]')?.textContent ?? '').length)
    result.beforeLen = beforeLen
    await page.evaluate(() => {
      window.__probe = { frames: [], lastLen: 0 }
      const rec = () => {
        const p = document.querySelector('[data-conversation-scroll]')
        if (p) {
          const len = (p.textContent ?? '').length
          window.__probe.frames.push({
            t: performance.now(),
            streaming: !!p.querySelector('[data-streaming]'),
            think: !!p.querySelector('[data-variant="think"]'),
            owned: p.hasAttribute('data-follow-owned'),
            len,
          })
        }
        requestAnimationFrame(rec)
      }
      requestAnimationFrame(rec)
    })
    await sleep(16_000)
    const probe = await page.evaluate(() => window.__probe)
    const frames = probe.frames
    result.frames = frames.length
    result.pluginFrames = frames.filter(f => f.streaming || f.think || f.owned).length
    result.streamingFrames = frames.filter(f => f.streaming).length
    result.ownedFrames = frames.filter(f => f.owned).length
    result.textGrew = frames.at(-1)?.len - beforeLen
    // Text growth profile while the stream ran: many small steps = reveal pacing; huge jumps = dump.
    let last = beforeLen
    const jumps = []
    for (const f of frames) {
      const d = f.len - last
      last = f.len
      if (d > 300) jumps.push(d)
    }
    result.dumps = jumps.length
    if (!result.textGrew || result.textGrew < 400) {
      result.reveal = `NO-STREAM (grew ${result.textGrew ?? 0} chars, sent=${result.sent})`
    } else if (result.pluginFrames > 60) {
      result.reveal = jumps.length === 0 ? 'smooth' : `jumpy(${jumps.length} big jumps)`
    } else {
      result.reveal = 'DUMPED(built-in renderer?)'
    }
  } catch (err) {
    result.reveal = `ERROR ${String(err).slice(0, 200)}`
  } finally {
    await page.close().catch(() => {})
  }
  return result
}

const mock = await ensureMockServer()
const host = await bootHost()
console.log(`[DEBUG-a4f2] host up: ${host.url}`)
console.log(`[DEBUG-a4f2] plugin host-half loaded: ${/dsh-smooth-stream\] plugin loaded/.test(host.bootLog)} (disable requested: ${process.env.PROBE_DISABLE_PLUGIN === '1'})`)
console.log(`[DEBUG-a4f2] home: ${host.home}${KEEP ? ' (kept)' : ''}`)
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--force-device-scale-factor=1'] })
const results = []
try {
  for (let i = 1; i <= ITERATIONS; i++) {
    const r = await driveOnce(browser, host.url, i)
    results.push(r)
    const red = r.reveal.includes('DUMPED') || r.reveal.startsWith('ERROR') || r.pageErrors.length > 0
    console.log(`\n=== page load ${i}: ${red ? 'RED' : 'green'} — reveal=${r.reveal} pluginFrames=${r.pluginFrames}/${r.frames} streamingFrames=${r.streamingFrames} ownedFrames=${r.ownedFrames} dumps=${r.dumps}`)
    if (r.modelWarning) console.log(`  model: ${r.modelWarning}`)
    for (const e of r.pageErrors) console.log(`  PAGEERROR: ${e}`)
    const interesting = r.consoleHits.filter(h => /error|abdicate|crash|slot|entry|smooth/i.test(h))
    for (const h of interesting.slice(0, 12)) console.log(`  ${h}`)
    if (interesting.length > 12) console.log(`  ... +${interesting.length - 12} more console hits`)
  }
} finally {
  await browser.close().catch(() => {})
  host.child.kill('SIGKILL')
  if (mock.started) mock.child.kill('SIGKILL')
}
const reds = results.filter(r => r.reveal.includes('DUMPED') || r.reveal.startsWith('ERROR') || r.pageErrors.length > 0)
console.log(`\n[DEBUG-a4f2] SUMMARY: ${results.length - reds.length}/${results.length} page loads green, ${reds.length} RED`)
if (!KEEP) await rm(host.tmp, { recursive: true, force: true }).catch(() => {})
process.exit(reds.length > 0 ? 1 : 0)
