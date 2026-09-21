/**
 * Streaming hot-path measurement rig.
 *
 * Replicates the assistant reply's live path with the SHIPPED renderer:
 * `useSmoothStreamContent` reveal -> React state -> real `MarkdownText`
 * (streaming) -> `notifyFollowCommit` -> shared frame clock.
 *
 * `?arm=plain` swaps MarkdownText for a plain text div, which isolates how
 * much of a frame the real Markdown parse + commit actually costs. Every other
 * knob (reveal pacing, follow, fade, probes) stays identical between arms, so
 * the delta is attributable to the renderer.
 */
import { Profiler, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { FrameCoordinator } from '../src/client/FrameCoordinator.ts'
import { useFpsGuard } from '../src/client/useFpsGuard.ts'
import { useSmoothStreamContent } from '../src/client/useSmoothStreamContent.ts'
import { useLogarithmicFade } from '../src/client/useLogarithmicFade.ts'

const SENTENCE = '深度探索这个问题需要从多个角度分析,首先我们要理解核心机制的运作原理,然后逐步推导出在高速输出场景下的边界条件与稳定性约束。'
const MARKDOWN_BLOCK = [
  '## 分块渲染与增量解析',
  '',
  '活动尾部由稳定的 DOM Island 承载,已封口块不再重新解析:',
  '',
  '- `StreamBuffer` 用 UTF-16 安全的分块 Rope 保存源文本',
  '- `RevealClock` 同时记录 requested / effective / commit 三种速度',
  '- `FadeBands` 把逐字素 Range 换成连续年龄带',
  '',
  '| 指标 | 60Hz 目标 |',
  '| --- | ---: |',
  '| rAF 帧时长 p95 | <= 16.67 ms |',
  '| 插件自身 p95 | <= 8 ms |',
  '',
  '```ts',
  'const step = computeRevealStep(config, input, dtSeconds)',
  'revealChars = Math.min(Math.round(step.revealChars * scale), backlog)',
  '```',
  '',
].join('\n')

interface Metrics {
  arm: string
  cps: number
  frameIntervals: number[]
  coordinatorMs: number[]
  commits: number
  commitMs: number[]
  longTasks: number
  timeline: Array<{ t: number; chars: number; commitP95: number; frameP95: number }>
}

const metrics: Metrics = {
  arm: 'markdown',
  cps: 600,
  frameIntervals: [],
  coordinatorMs: [],
  commits: 0,
  commitMs: [],
  longTasks: 0,
  timeline: [],
}
;(window as unknown as { __perf: Metrics }).__perf = metrics

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
 return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
}

function MarkdownArm({ text, streaming, onCommit }: { text: string; streaming: boolean; onCommit: () => void }): ReactNode {
  return <MarkdownText text={text} streaming={streaming} labels={undefined} fileMentions={undefined} />
}

function PlainArm({ text }: { text: string }): ReactNode {
  return <div data-plain="1" style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
}

function Reply({ arm, cps, fade }: { arm: string; cps: number; fade: boolean }): ReactNode {
  const [streaming, setStreaming] = useState(true)
  const [source, setSource] = useState('')
  const speedCpsRef = useRef(35)
  const revealedCharsRef = useRef(0)
  const revealScaleRef = useRef(1)
  const fadeRootRef = useRef<HTMLDivElement>(null)
  const { ref: guardRef, shouldHoldBack } = useFpsGuard(streaming)
  const targetRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    let produced = 0
    const tickMs = 50
    const perTick = (cps * tickMs) / 1000
    void (async () => {
      while (!cancelled && produced < 12000) {
        produced += perTick
        setSource(SENTENCE.repeat(Math.ceil((produced + 200) / SENTENCE.length)).slice(0, Math.floor(produced)))
        await sleep(tickMs)
      }
      if (!cancelled) setStreaming(false)
    })()
    return () => { cancelled = true }
  }, [cps])

  const displayed = useSmoothStreamContent(source, {
    enabled: streaming,
    inputComplete: !streaming,
    preset: 'silky',
    shouldHoldBack,
    speedCpsRef,
    revealedCharsRef,
    revealScaleRef,
  })
  const shown = displayed
  targetRef.current = shown.length

  if (fade) useLogarithmicFade(fadeRootRef, true, streaming, speedCpsRef)

  return (
    <div ref={guardRef} data-conversation-scroll style={{ height: '100vh', overflowY: 'auto' }}>
      <div data-chat-flow>
        <div ref={fadeRootRef} data-reply-root>
          {arm === 'markdown'
            ? <MarkdownArm text={shown} streaming={streaming} onCommit={() => {}} />
            : <PlainArm text={shown} />}
        </div>
      </div>
    </div>
  )
}

function Rig(): ReactNode {
  const params = new URLSearchParams(window.location.search)
  const arm = params.get('arm') ?? 'markdown'
  const cps = Number(params.get('cps') ?? '600')
  const fade = (params.get('fade') ?? '1') !== '0'
  const durationMs = Number(params.get('duration') ?? '30000')
  metrics.arm = arm
  metrics.cps = cps

  // Frame instrumentation rides the same single clock the app now uses.
  useEffect(() => {
    const coordinator = FrameCoordinator.forDocument()
    let frameStart = 0
    let lastFrameAt: number | null = null
    coordinator.registerTask({
      onRead: () => { frameStart = performance.now() },
      onSimulate: () => {
        const now = performance.now()
        if (lastFrameAt !== null) metrics.frameIntervals.push(now - lastFrameAt)
        lastFrameAt = now
        return true
      },
      onWrite: () => { metrics.coordinatorMs.push(performance.now() - frameStart) },
    })
    return () => { coordinator.shutdown() }
  }, [])

  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return
    const observer = new PerformanceObserver(list => { metrics.longTasks += list.getEntries().length })
    try {
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      observer.disconnect()
    }
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    const started = performance.now()
    const timer = window.setInterval(() => {
      const chars = document.querySelector('[data-reply-root]')?.textContent?.length ?? 0
      metrics.timeline.push({
        t: Math.round(performance.now() - started),
        chars,
        commitP95: Math.round(percentile(metrics.commitMs, 0.95) * 100) / 100,
        frameP95: Math.round(percentile(metrics.frameIntervals, 0.95) * 100) / 100,
      })
    }, 1000)
    const stopTimer = window.setTimeout(() => {
      window.clearInterval(timer)
      ;(window as unknown as { __perfDone: boolean }).__perfDone = true
    }, durationMs)
    return () => { window.clearInterval(timer); window.clearTimeout(stopTimer) }
  }, [durationMs])

  const onRender = useCallback((_id: string, _phase: string, actualDuration: number) => {
    metrics.commits += 1
    metrics.commitMs.push(actualDuration)
  }, [])

  return (
    <Profiler id="reply" onRender={onRender}>
      <Reply arm={arm} cps={cps} fade={fade} />
    </Profiler>
  )
}

const container = document.getElementById('root')
if (container !== null) createRoot(container).render(<Rig />)
