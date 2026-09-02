#!/usr/bin/env node
/** One-off: host E2E — select mock model, stream a long reply, frame-sample the completion window. */
import { chromium } from 'playwright-core'

const URL = process.argv[2]
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--force-device-scale-factor=1'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 200)))
const followLogs = []
page.on('console', m => { if (m.text().includes('[dsh-follow]')) followLogs.push(m.text().slice(0, 150)) })
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 })
await page.waitForTimeout(2000)

// Fresh session FIRST (stable home view), then pick the model with retries
try {
  await page.locator('button:has-text("新会话")').first().click({ timeout: 3000 })
  console.log('new session: clicked')
} catch { console.log('new session: not found') }
await page.waitForTimeout(800)
for (let attempt = 1; attempt <= 3; attempt++) {
  const currentModel = await page.evaluate(() => document.querySelector('.fh7cGa_triggerLabel')?.textContent ?? '')
  if (currentModel === 'mock-stream') { console.log('model already mock-stream'); break }
  try {
    await page.locator(`button:has(span:text("${currentModel}"))`).first().click({ timeout: 3000 })
    await page.waitForTimeout(900)
    await page.locator('text=模型').first().click({ timeout: 2500 })
    await page.waitForTimeout(1000)
    const opt = page.locator('text=mock-stream').first()
    await opt.waitFor({ state: 'visible', timeout: 4000 })
    await opt.click()
    console.log(`model pick: clicked (attempt ${attempt})`)
    await page.waitForTimeout(600)
    break
  } catch (e) {
    console.log(`model pick attempt ${attempt} failed: ${String(e).slice(0, 60)}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
  }
}
const label = await page.evaluate(() => [...document.querySelectorAll('span')].map(s => s.textContent).find(t => t === 'mock-stream' || t === 'glm-5-3-flash'))
console.log('active model label:', label ?? '(picker not found — profile default may persist)')

// Arm the frame sampler BEFORE sending
await page.evaluate(() => {
  window.__log = []
  window.__shifts = []
  if (typeof PerformanceObserver !== 'undefined') {
    const obs = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.value <= 0.01) continue
        window.__shifts.push({
          t: entry.startTime,
          value: entry.value,
          sources: (entry.sources ?? []).slice(0, 3).map(s => {
            const n = s.node
            if (n instanceof HTMLElement) return `${n.tagName.toLowerCase()}.${String(n.className).split(' ')[0].slice(0, 24)}`
            return n?.nodeName ?? '?'
          }),
        })
      }
    })
    obs.observe({ type: 'layout-shift', buffered: false })
  }
  // scrollTop setter spy: catch every big backward/forward write with its stack
  const port0 = document.querySelector('[data-conversation-scroll]')
  if (port0 && !window.__stSpy) {
    window.__stSpy = true
    window.__fights = []
    const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    Object.defineProperty(port0, 'scrollTop', {
      configurable: true,
      get() { return d.get.call(this) },
      set(v) {
        const prev = d.get.call(this)
        d.set.call(this, v)
        const now = d.get.call(this)
        if (Math.abs(now - prev) > 2 && Math.abs(now - (this.__lastSt ?? 0)) > 2) {
          window.__fights.push({ kind: 'set', from: Math.round(prev), to: Math.round(now), stack: new Error().stack.split('\n').slice(2, 6).map(l => l.trim().replace(/^at /, '').slice(0, 90)).join(' || ') })
        }
        this.__lastSt = now
      },
    })
    for (const method of ['scrollTo', 'scroll', 'scrollBy']) {
      const inst = port0
      const orig = inst[method].bind(inst)
      inst[method] = (...a) => {
        const prev = d.get.call(inst)
        orig.apply(inst, a)
        const now = d.get.call(inst)
        if (Math.abs(now - prev) > 2) {
          window.__fights.push({ kind: method, from: Math.round(prev), to: Math.round(now), stack: new Error().stack.split('\n').slice(2, 6).map(l => l.trim().replace(/^at /, '').slice(0, 90)).join(' || ') })
        }
        inst.__lastSt = now
      }
    }
  }
  const rec = () => {
    const port = document.querySelector('[data-conversation-scroll]')
    if (port) {
      const flow = port.querySelector('[data-chat-flow]')
      const kids = flow ? [...flow.children] : []
      const user = kids[0]?.getBoundingClientRect().top ?? null
      const assistant = kids.find(c => (c.getAttribute('class') || '').includes('13:assistant') || c.querySelector('[data-variant="think"]'))
      const assistantRect = assistant?.getBoundingClientRect() ?? null
      const think = assistant?.querySelector('[data-variant="think"]')
      const turnTail = kids.find(c => (c.className || '').toString().includes('turn-tail'))
      const turnProcess = kids.find(c => (c.className || '').toString().includes('turn-process'))
      const turnStatus = kids.find(c => (c.className || '').toString().includes('turnStatus') || c.getAttribute('role') === 'status')
      const emptyRows = kids.filter(c => (c.className || '').toString().includes('input-message') && Math.round(c.getBoundingClientRect().height) === 0).length
      const surface = assistant?.querySelector('[data-variant="think"]')?.parentElement ?? assistant
      window.__log.push({
        t: performance.now(),
        st: port.scrollTop,
        sh: port.scrollHeight,
        clientH: port.clientHeight,
        userTop: user,
        assistantTop: assistantRect?.top ?? null,
        assistantBottom: assistantRect?.bottom ?? null,
        assistantH: assistantRect ? Math.round(assistantRect.height) : null,
        thinkState: think?.getAttribute('data-state') ?? null,
        thinkH: think ? Math.round(think.getBoundingClientRect().height) : null,
        tailH: turnTail ? Math.round(turnTail.getBoundingClientRect().height) : 0,
        processH: turnProcess ? Math.round(turnProcess.getBoundingClientRect().height) : 0,
        statusPresent: turnStatus ? 1 : 0,
        statusH: turnStatus ? Math.round(turnStatus.getBoundingClientRect().height) : 0,
        statusMT: turnStatus ? turnStatus.style.marginTop : '',
        statusMB: turnStatus ? turnStatus.style.marginBottom : '',
        emptyRows,
        owned: port.hasAttribute('data-follow-owned'),
      })
    }
    requestAnimationFrame(rec)
  }
  requestAnimationFrame(rec)
})

// Type + send (composer is a contenteditable)
await page.waitForSelector('[contenteditable="true"], textarea', { timeout: 8000 })
const composer = page.locator('[contenteditable="true"], textarea').first()
await composer.click()
await page.keyboard.insertText('请详细介绍一下量子计算，内容越长越好。')
await page.waitForTimeout(500)
// Send via the exact send button
const sendBtn = page.locator('button[aria-label*="发送"]').first()
let sent = 'enter'
try {
  await sendBtn.click({ timeout: 2500 })
  sent = 'button'
} catch {
  await page.keyboard.press('Enter')
}
console.log('send path:', sent)

// Sample through the stream + completion + 8s
await page.waitForTimeout(24000)
const log = await page.evaluate(() => window.__log)
const fights = await page.evaluate(() => window.__fights ?? [])
console.log('ST-FIGHTS:', fights.length)
console.log('FIGHTS-JSON:')
for (const f of fights) console.log(JSON.stringify(f))
console.log('engine-log lines:', followLogs.length)
for (const l of followLogs.slice(0, 60)) console.log('  ' + l)
const shifts = await page.evaluate(() => window.__shifts ?? [])
const endState = await page.evaluate(() => {
  const port = document.querySelector('[data-conversation-scroll]')
  const flow = port?.querySelector('[data-chat-flow]')
  const kids = flow ? [...flow.children] : []
  const last = kids.filter(c => c.getBoundingClientRect().height > 0).at(-1)
  return {
    flowPad: flow?.style.paddingBottom ?? '',
    lastBottomVsPort: last && port ? Math.round(port.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom) : null,
  }
})
console.log('END-STATE:', JSON.stringify(endState))
const trace = await page.evaluate(() => (window.__ftrace ?? []).slice(-40))
await browser.close()
console.log('engine trace (last 40):')
for (const e of trace) {
  console.log(`  t=${Math.round(e.t)} ${e.event} ${JSON.stringify(e, (k, v) => k === 't' || k === 'event' ? undefined : v)}`)
}

console.log(`painted layout-shift entries (value>0.01): ${shifts.length}`)
for (const s of shifts.slice(0, 12)) {
  console.log(`  t=${Math.round(s.t)}ms value=${s.value.toFixed(4)} src=[${s.sources.join(', ')}]`)
}

const active = log.filter(f => f.st > 10)
if (active.length < 20) { console.log('no meaningful stream captured'); process.exit(0) }
const t0 = active[0].t
console.log(`total=${log.length} active=${active.length}`)
console.log('last-frames:', JSON.stringify(active.slice(-4).map(f => ({ t: Math.round((f.t - t0)), st: Math.round(f.st), sh: f.sh, owned: f.owned }))))

// Locate completion: first frame where turn-tail (metrics footer) is mounted
const tailAt = active.find(f => f.tailH > 0)?.t
const thinkCollapsedAt = active.find(f => f.thinkState === 'ok')?.t
console.log(`turn-tail mounted at t=+${tailAt ? Math.round(tailAt - t0) : 'never'}ms, think collapsed at t=+${thinkCollapsedAt ? Math.round(thinkCollapsedAt - t0) : 'never'}ms`)

// Stream vs completion window: completion = from 1s before tail mount to end
const compStart = tailAt !== undefined ? tailAt - 1200 : active.at(-1).t - 6000
const comp = active.filter(f => f.t >= compStart)
const stream = active.filter(f => f.t < compStart)

// Downward moves + jumps
let worstUserDown = 0
const events = []
const scan = (frames, label) => {
  for (let i = 1; i < frames.length; i++) {
    const p = frames[i - 1]
    const c = frames[i]
    const userDown = (c.userTop !== null && p.userTop !== null) ? c.userTop - p.userTop : 0
    const aTop = (c.assistantTop !== null && p.assistantTop !== null) ? c.assistantTop - p.assistantTop : 0
    if (userDown > worstUserDown) worstUserDown = userDown
    const flags = []
    if (userDown > 0.35) flags.push(`USER_DOWN=${userDown.toFixed(2)}`)
    if (Math.abs(aTop) > 4) flags.push(`aTopΔ=${aTop.toFixed(1)}`)
    if (c.sh - p.sh > 40) flags.push(`shΔ=${c.sh - p.sh}`)
    if (p.sh - c.sh > 40) flags.push(`shSHRINK=${p.sh - c.sh}`)
    if (c.tailH !== p.tailH) flags.push(`tailH=${p.tailH}→${c.tailH}`)
    if (c.thinkH !== p.thinkH && Math.abs((c.thinkH ?? 0) - (p.thinkH ?? 0)) > 8) flags.push(`thinkH=${p.thinkH}→${c.thinkH}`)
    if (c.emptyRows !== p.emptyRows) flags.push(`emptyRows=${p.emptyRows}→${c.emptyRows}`)
    if (c.owned !== p.owned) flags.push(`owned=${p.owned}→${c.owned}`)
    if (c.processH !== p.processH) flags.push(`processH=${p.processH}→${c.processH}`)
    if (flags.length > 0) events.push(`[${label}] t=+${Math.round(c.t - t0)}ms ${flags.join(' ')}`)
  }
}
scan(stream, 'stream')
scan(comp, 'COMPLETE')
console.log(`\ncompletion window frames=${comp.length}, stream frames=${stream.length}`)
console.log(`worst userDown=${worstUserDown.toFixed(2)}px`)
console.log(`events(${events.length}):`)
for (const e of events.slice(0, 40)) console.log('  ' + e)
// Detailed frame dump across the completion transition (search all active frames)
const bigIdx = active.findIndex((f, i) => i > 0 && f.userTop !== null && active[i - 1].userTop !== null && f.userTop - active[i - 1].userTop > 10)
if (bigIdx > 0) {
  console.log('\nframe dump around the big slam:')
  for (let i = Math.max(1, bigIdx - 16); i <= Math.min(active.length - 1, bigIdx + 10); i++) {
    const f = active[i]
    const p = active[i - 1]
    console.log(
      `t=+${Math.round(f.t - t0)} st=${f.st.toFixed(1)} sh=${f.sh} aTop=${f.assistantTop?.toFixed(1)} aH=${f.assistantH} think=${f.thinkState}/${f.thinkH}`
      + ` proc=${f.processH} status=${f.statusPresent}/${f.statusH} mt='${f.statusMT}' mb='${f.statusMB}' tail=${f.tailH} empty=${f.emptyRows} owned=${f.owned}`
      + ` dSt=${(f.st - p.st).toFixed(1)}`,
    )
  }
}
