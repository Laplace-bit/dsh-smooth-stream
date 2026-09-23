#!/usr/bin/env node
/**
 * Measures the real streaming hot path in a browser.
 *
 * Two arms, identical pacing/follow/fade, differing only in the renderer:
 *   markdown : the SHIPPED MarkdownText (streaming mode)
 *   plain    : a plain text div
 *
 * Reported per arm: React commit durations from Profiler.actualDuration, frame
 * intervals from the shared clock, the clock's own per-frame work, and long
 * tasks. The markdown-minus-plain delta is what a per-frame React full-text
 * commit actually costs.
 *
 * Usage: node scripts/measure-stream-hotpath.mjs [--cps 600] [--duration 30000] [--json]
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const cps = Number(readArg('cps', 600))
const durationMs = Number(readArg('duration', 30000))
const asJson = args.includes('--json')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

console.log('· building rig bundle …')
const bundle = await build({
  entryPoints: [join(root, 'repro', 'PerfRig.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  write: false,
  outdir: join(root, 'repro'),
  loader: { '.css': 'local-css', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.eot': 'empty', '.svg': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'error',
})

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
// esbuild splits stylesheets out of the JS when bundling to an outdir, so the
// rig page must serve every emitted file, not just the entry chunk.
const files = new Map()
for (const file of bundle.outputFiles) {
  files.set(file.path, file.contents)
  files.set(file.path.replace(/\.css$/, '.css'), file.contents)
}
const entryName = bundle.outputFiles.find(file => file.path.endsWith('PerfRig.js'))?.path
console.log('· emitted', [...files.keys()].map(p => p.split('/').pop()).join(', '))
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname
  const asset = path.replace(/^\//, '')
  const target = path === '/' ? join(root, 'repro', 'perf.html') : join(root, 'repro', asset)
  const inMemory = files.get(target)
  if (inMemory !== undefined) {
    response.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' })
    response.end(inMemory)
    return
  }
  try {
    const data = await readFile(target)
    response.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' })
    response.end(data)
  } catch {
    response.writeHead(404)
    response.end('not found')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const executablePath = process.env.AUDIT_CHROMIUM ?? (existsSync(CHROME) ? CHROME : undefined)
const browser = await chromium.launch({
  executablePath,
  channel: executablePath === undefined ? 'chrome' : undefined,
  headless: true,
  args: ['--force-device-scale-factor=1', '--font-render-hinting=none'],
})

const percentile = (samples, p) => {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}
const round = value => Math.round(value * 1000) / 1000

async function runArm(arm, fade = true) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto(`${origin}/perf.html?arm=${arm}&cps=${cps}&duration=${durationMs}&fade=${fade ? '1' : '0'}`)
  await page.waitForFunction(() => window.__perfDone === true, null, { timeout: durationMs + 30000 })
  const raw = await page.evaluate(() => window.__perf)
  const last = raw.timeline.at(-1) ?? { chars: 0 }
  const result = {
    arm: fade ? arm : `${arm}+nofade`,
    chars: last.chars,
    frames: raw.frameIntervals.length,
    commits: raw.commits,
    avgFps: round(1000 / (raw.frameIntervals.reduce((a, b) => a + b, 0) / Math.max(1, raw.frameIntervals.length))),
    frameP50: round(percentile(raw.frameIntervals, 0.5)),
    frameP95: round(percentile(raw.frameIntervals, 0.95)),
    frameP99: round(percentile(raw.frameIntervals, 0.99)),
    frameMax: round(Math.max(0, ...raw.frameIntervals)),
    commitP50: round(percentile(raw.commitMs, 0.5)),
    commitP95: round(percentile(raw.commitMs, 0.95)),
    commitTotalMs: round(raw.commitMs.reduce((a, b) => a + b, 0)),
    coordinatorP95: round(percentile(raw.coordinatorMs, 0.95)),
    longTasks: raw.longTasks,
    timeline: raw.timeline,
  }
  await page.close()
  return result
}

const markdown = await runArm('markdown', true)
console.log(`· markdown+fade done (${markdown.chars} chars, ${markdown.commits} commits)`)
const noFade = await runArm('markdown', false)
console.log(`· markdown no-fade done (${noFade.chars} chars, ${noFade.commits} commits)`)
const plain = await runArm('plain', false)
console.log(`· plain arm done (${plain.chars} chars, ${plain.commits} commits)`)

await browser.close()
server.close()

const report = {
  cps,
  durationMs,
  markdown,
  noFade,
  plain,
  delta: {
    fadeCost: round(markdown.frameP95 - noFade.frameP95),
    markdownCost: round(noFade.frameP95 - plain.frameP95),
    commitFadeCost: round(markdown.commitP95 - noFade.commitP95),
  },
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const line = (label, a, b, c) => `${label.padEnd(20)} md+fade=${String(a).padStart(9)}  md=${String(b).padStart(9)}  plain=${String(c).padStart(9)}`
  console.log('\n=== 逐层剥离：md+fade / md 无淡入 / 纯文本（节奏与跟随完全相同）===')
  console.log(line('渲染字符数', markdown.chars, noFade.chars, plain.chars))
  console.log(line('帧数', markdown.frames, noFade.frames, plain.frames))
  console.log(line('React commits', markdown.commits, noFade.commits, plain.commits))
  console.log(line('平均 FPS', markdown.avgFps, noFade.avgFps, plain.avgFps))
  console.log(line('帧间隔 p50 ms', markdown.frameP50, noFade.frameP50, plain.frameP50))
  console.log(line('帧间隔 p95 ms', markdown.frameP95, noFade.frameP95, plain.frameP95))
  console.log(line('帧间隔 p99 ms', markdown.frameP99, noFade.frameP99, plain.frameP99))
  console.log(line('帧间隔 max ms', markdown.frameMax, noFade.frameMax, plain.frameMax))
  console.log(line('commit p95 ms', markdown.commitP95, noFade.commitP95, plain.commitP95))
  console.log(line('协调器 p95 ms', markdown.coordinatorP95, noFade.coordinatorP95, plain.coordinatorP95))
  console.log(line('长任务数', markdown.longTasks, noFade.longTasks, plain.longTasks))
  console.log(`\n淡入代价(帧p95): ${report.delta.fadeCost}ms   Markdown代价(帧p95): ${report.delta.markdownCost}ms`)
  console.log('\n时间线（markdown / plain）: t秒 → 字符数, commit p95, frame p95')
  const width = Math.max(markdown.timeline.length, plain.timeline.length)
  for (let index = 0; index < width; index += 1) {
    const m = markdown.timeline[index]
    const n = noFade.timeline[index]
    const p = plain.timeline[index]
    console.log(`  ${String(index + 1).padStart(2)}s  md+fade=${m ? `${m.chars}c f${m.frameP95}` : '-'}   md=${n ? `${n.chars}c f${n.frameP95}` : '-'}   plain=${p ? `${p.chars}c f${p.frameP95}` : '-'}`)
  }
}
