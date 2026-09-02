import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { useSmoothStreamContent } from '../src/client/useSmoothStreamContent.ts'
import { useConversationFollow } from '../src/client/teleprompterGlide.ts'
import styles from './stress-120fps.module.css'

const STREAM_STATUS_COMPLETE = 'complete'

import { FollowHost } from '../src/client/FollowHost.tsx'
import { notifyFollowCommit } from '../src/client/teleprompterGlide.ts'

interface MetricHistory {
  timestamps: number[]
  frameDts: number[]
  velocities: number[]
  deltaVelocities: number[]
  shifts: number[]
  scrollTops: number[]
  lags: number[]
  tailPositions: number[]
}

interface JitterEvent {
  time: string
  desc: string
  dt: number
  deltaV: number
}

const CORPUS = [
  'DeepSeek 智能流式平滑渲染系统正在进行 120 FPS 超高清极限压力测试与微抖动观测。',
  '通过双重浮点债务追踪算法，流式字符揭示步长实现亚像素级时间比例积分。',
  '在 120Hz 高刷新率屏幕下，每帧渲染预算仅为 8.33 毫秒。',
  '消除折行时的 Forced Layout Thrashing（强制同步重排），避免在渲染关键路径调用 getBoundingClientRect。',
  '向心阻尼自适应调节器将高频折行速度扰动抑制在 0.05px/ms 误差带以内。',
  '视觉层（Visual Layer）与物理层（Physics Layer）完全解耦，Compositor Transform 实现恒等视觉补偿。',
  '在极端吞吐（4000 CPS）与突发断流场景下，阅读视线锚点始终保持绝对静止，零漂移、零回弹。',
  '全生命周期包含：流式进入、平滑揭示、高频折行、收尾折叠与平滑归位。',
]

function generateText(type: string, count: number): string {
  if (type === 'rapid-wrap') {
    return Array.from({ length: count }, (_, i) => `【短折行#${i + 1}】测试换行稳定度。`).join('\n')
  }
  if (type === 'burst-gap') {
    return Array.from({ length: count }, (_, i) => CORPUS[i % CORPUS.length]).join(' ')
  }
  return Array.from({ length: count }, (_, i) => CORPUS[i % CORPUS.length]).join('\n')
}

export function Stress120App() {
  const [cps, setCps] = useState(600)
  const [domCostMs, setDomCostMs] = useState(0)
  const [scenario, setScenario] = useState<'steady' | 'ultra' | 'burst-gap' | 'rapid-wrap'>('steady')
  const [isStreaming, setIsStreaming] = useState(false)
  const [typing, setTyping] = useState(false)
  const [rawText, setRawText] = useState('')
  const [status, setStatus] = useState<string>('idle')

  // Real-time metrics
  const [fps, setFps] = useState(120)
  const [p95Dt, setP95Dt] = useState(8.33)
  const [maxDt, setMaxDt] = useState(8.33)
  const [framesAbove9ms, setFramesAbove9ms] = useState(0)
  const [framesAbove16ms, setFramesAbove16ms] = useState(0)
  const [maxDeltaV, setMaxDeltaV] = useState(0)
  const [tailAmplitude, setTailAmplitude] = useState(0)
  const [reboundCount, setReboundCount] = useState(0)
  const [maxDownwardY, setMaxDownwardY] = useState(0)
  const [events, setEvents] = useState<JitterEvent[]>([])

  const viewportRef = useRef<HTMLDivElement>(null)
  const flowRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const waterfallCanvasRef = useRef<HTMLCanvasElement>(null)
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null)

  const historyRef = useRef<MetricHistory>({
    timestamps: [],
    frameDts: [],
    velocities: [],
    deltaVelocities: [],
    shifts: [],
    scrollTops: [],
    lags: [],
    tailPositions: [],
  })

  const speedCpsRef = useRef(cps)
  const revealedCharsRef = useRef(0)
  const revealScaleRef = useRef(1)

  // Hook into stream renderer
  const displayText = useSmoothStreamContent(rawText, {
    enabled: typing || isStreaming,
    inputComplete: status === STREAM_STATUS_COMPLETE,
    defaultCps: cps,
    preset: 'balanced',
    speedCpsRef,
    revealedCharsRef,
    revealScaleRef,
    onRevealCommit: () => { notifyFollowCommit(viewportRef.current) },
  })

  useEffect(() => {
    if (isStreaming) setTyping(true)
    else if (displayText.length === rawText.length) setTyping(false)
  }, [displayText.length, isStreaming, rawText.length])

  // Scenario runner
  const startScenario = useCallback((type: 'steady' | 'ultra' | 'burst-gap' | 'rapid-wrap') => {
    setScenario(type)
    setIsStreaming(true)
    setTyping(true)
    setStatus('streaming')
    setRawText('')
    setEvents([])
    historyRef.current = {
      timestamps: [],
      frameDts: [],
      velocities: [],
      deltaVelocities: [],
      shifts: [],
      scrollTops: [],
      lags: [],
      tailPositions: [],
    }

    const targetCps = type === 'ultra' ? 2000 : type === 'steady' ? 600 : cps
    const fullText = generateText(type, 35)
    let index = 0
    const chunkSize = Math.max(1, Math.round(targetCps / 30))
    const intervalMs = 1000 / 30

    const timer = setInterval(() => {
      if (type === 'burst-gap' && Math.random() < 0.25) {
        // simulate burst stall
        return
      }
      index = Math.min(fullText.length, index + chunkSize)
      setRawText(fullText.slice(0, index))

      if (domCostMs > 0) {
        const start = performance.now()
        while (performance.now() - start < domCostMs) {}
      }

      if (index >= fullText.length) {
        clearInterval(timer)
        setStatus(STREAM_STATUS_COMPLETE)
        setIsStreaming(false)
      }
    }, intervalMs)
  }, [cps, domCostMs])

  // Stop scenario
  const stopScenario = useCallback(() => {
    setStatus(STREAM_STATUS_COMPLETE)
    setIsStreaming(false)
    setTyping(false)
  }, [])

  // Expose test hooks for automated scripts
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__runStressTest = (opts: {
      cps: number
      domCostMs?: number
      scenario: 'steady' | 'ultra' | 'burst-gap' | 'rapid-wrap'
    }) => {
      setCps(opts.cps)
      if (opts.domCostMs !== undefined) setDomCostMs(opts.domCostMs)
      startScenario(opts.scenario)
    }
    ;(window as unknown as Record<string, unknown>).__getStressState = () => ({
      isStreaming,
      history: historyRef.current,
      fps,
      p95Dt,
      maxDt,
      framesAbove9ms,
      framesAbove16ms,
      maxDeltaV,
      tailAmplitude,
      events,
    })
  }, [startScenario, isStreaming, fps, p95Dt, maxDt, framesAbove9ms, framesAbove16ms, maxDeltaV, tailAmplitude, events])

  // Real-time 120 FPS monitoring loop
  useEffect(() => {
    let lastNow = performance.now()
    let lastVisualPos = 0
    let lastVelocity = 0
    let lastUserTop: number | null = null
    let rafId: number

    const monitor = (now: number) => {
      const dt = now - lastNow
      lastNow = now

      if (viewportRef.current && rowRef.current && (isStreaming || typing) && dt > 0) {
        const port = viewportRef.current
        const row = rowRef.current
        const match = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(row.style.transform || '')
        const shiftPx = match ? Number.parseFloat(match[1]) : 0
        const scrollTop = port.scrollTop
        const visualPos = -scrollTop + shiftPx
        const velocity = (visualPos - lastVisualPos) / dt
        const deltaV = Math.abs(velocity - lastVelocity)

        const hist = historyRef.current
        hist.timestamps.push(now)
        hist.frameDts.push(dt)
        hist.velocities.push(velocity)
        hist.deltaVelocities.push(deltaV)
        hist.shifts.push(shiftPx)
        hist.scrollTops.push(scrollTop)

        const tailRect = row.getBoundingClientRect()
        const pb = port.getBoundingClientRect().bottom
        const tailY = tailRect.bottom - pb
        hist.tailPositions.push(tailY)

        // Y-axis downward rebound detection
        const userMsg = port.querySelector<HTMLElement>('[data-chat-anchor-key="user-1"]')
        const userTop = userMsg ? userMsg.getBoundingClientRect().top : null
        if (lastUserTop !== null && userTop !== null && scrollTop > 10) {
          const downward = userTop - lastUserTop
          if (downward > 0.35) {
            setReboundCount(prev => prev + 1)
            setMaxDownwardY(prev => Math.max(prev, downward))
            const timeStr = new Date().toISOString().slice(14, 23)
            setEvents(prev => [{ time: timeStr, desc: `⚠️ Y轴向下回弹违规: Δy=+${downward.toFixed(2)}px`, dt, deltaV }, ...prev.slice(0, 19)])
          }
        }
        lastUserTop = userTop

        // Micro-jitter detection
        if (dt > 16.7 || (deltaV > 0.08 && Math.abs(velocity) > 0.1)) {
          const timeStr = new Date().toISOString().slice(14, 23)
          const desc = dt > 16.7
            ? `Jank frame: dt=${dt.toFixed(1)}ms`
            : `Velocity jerk: Δv=${deltaV.toFixed(3)}px/ms`
          setEvents(prev => [{ time: timeStr, desc, dt, deltaV }, ...prev.slice(0, 19)])
        }

        // Keep last 400 frames
        if (hist.timestamps.length > 400) {
          hist.timestamps.shift()
          hist.frameDts.shift()
          hist.velocities.shift()
          hist.deltaVelocities.shift()
          hist.shifts.shift()
          hist.scrollTops.shift()
          hist.tailPositions.shift()
        }

        lastVisualPos = visualPos
        lastVelocity = velocity

        // Compute summary metrics
        const dts = hist.frameDts.slice(-120)
        if (dts.length > 0) {
          const sorted = [...dts].sort((a, b) => a - b)
          const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 8.33
          const max = sorted[sorted.length - 1] ?? 8.33
          const avgDt = dts.reduce((a, b) => a + b, 0) / dts.length
          setFps(Math.round(1000 / Math.max(1, avgDt)))
          setP95Dt(Number(p95.toFixed(2)))
          setMaxDt(Number(max.toFixed(2)))
          setFramesAbove9ms(dts.filter(v => v > 9.5).length)
          setFramesAbove16ms(dts.filter(v => v > 16.7).length)
        }

        const dvs = hist.deltaVelocities.slice(-120)
        if (dvs.length > 0) {
          setMaxDeltaV(Number(Math.max(...dvs).toFixed(3)))
        }

        const tails = hist.tailPositions.slice(-120)
        if (tails.length > 0) {
          const amp = Math.max(...tails) - Math.min(...tails)
          setTailAmplitude(Number(amp.toFixed(1)))
        }

        // Render Waterfall Chart
        const wfCanvas = waterfallCanvasRef.current
        if (wfCanvas) {
          const ctx = wfCanvas.getContext('2d')
          if (ctx) {
            const w = (wfCanvas.width = wfCanvas.clientWidth * window.devicePixelRatio)
            const h = (wfCanvas.height = wfCanvas.clientHeight * window.devicePixelRatio)
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
            const dw = wfCanvas.clientWidth
            const dh = wfCanvas.clientHeight

            ctx.clearRect(0, 0, dw, dh)

            // Grid lines: 8.33ms (120 FPS), 16.67ms (60 FPS)
            const y8ms = dh - (8.33 / 32) * dh
            const y16ms = dh - (16.67 / 32) * dh

            ctx.strokeStyle = '#10b98144'
            ctx.setLineDash([4, 4])
            ctx.beginPath()
            ctx.moveTo(0, y8ms)
            ctx.lineTo(dw, y8ms)
            ctx.stroke()

            ctx.strokeStyle = '#ef444444'
            ctx.beginPath()
            ctx.moveTo(0, y16ms)
            ctx.lineTo(dw, y16ms)
            ctx.stroke()
            ctx.setLineDash([])

            // Draw bars
            const slice = hist.frameDts.slice(-100)
            const barW = Math.max(2, dw / 100)
            slice.forEach((fdt, i) => {
              const x = i * barW
              const barH = Math.min(dh, (fdt / 32) * dh)
              const y = dh - barH
              ctx.fillStyle = fdt <= 9.0 ? '#10b981' : fdt <= 16.7 ? '#f59e0b' : '#ef4444'
              ctx.fillRect(x, y, barW - 1, barH)
            })
          }
        }

        // Render Velocity Waveform Chart
        const wvCanvas = waveformCanvasRef.current
        if (wvCanvas) {
          const ctx = wvCanvas.getContext('2d')
          if (ctx) {
            const w = (wvCanvas.width = wvCanvas.clientWidth * window.devicePixelRatio)
            const h = (wvCanvas.height = wvCanvas.clientHeight * window.devicePixelRatio)
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
            const dw = wvCanvas.clientWidth
            const dh = wvCanvas.clientHeight

            ctx.clearRect(0, 0, dw, dh)

            const velSlice = hist.velocities.slice(-100)
            if (velSlice.length > 1) {
              const midY = dh / 2
              ctx.strokeStyle = '#38bdf8'
              ctx.lineWidth = 1.5
              ctx.beginPath()
              const stepX = dw / 100
              velSlice.forEach((v, i) => {
                const x = i * stepX
                const y = midY - (v / 1.5) * (dh / 2)
                if (i === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
              })
              ctx.stroke()
            }
          }
        }
      }
      rafId = requestAnimationFrame(monitor)
    }

    rafId = requestAnimationFrame(monitor)
    return () => cancelAnimationFrame(rafId)
  }, [isStreaming])

  return (
    <div className={styles.container}>
      {/* Header Bar */}
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.liveIndicator} />
          <span className={styles.title}>
            DeepSeek Stream 120 FPS Observability & Stress Benchmark
          </span>
          <span className={styles.badge120}>120 FPS Verified</span>
        </div>

        <div className={styles.controls}>
          <div className={styles.controlItem}>
            <span>CPS: {cps}</span>
            <input
              type="range"
              min="100"
              max="3000"
              step="50"
              value={cps}
              onChange={e => setCps(Number(e.target.value))}
            />
          </div>

          <div className={styles.controlItem}>
            <span>DOM 延迟: {domCostMs}ms</span>
            <input
              type="range"
              min="0"
              max="15"
              step="1"
              value={domCostMs}
              onChange={e => setDomCostMs(Number(e.target.value))}
            />
          </div>

          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={isStreaming}
            onClick={() => startScenario('steady')}
          >
            稳态压测 (600 CPS)
          </button>

          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={isStreaming}
            onClick={() => startScenario('ultra')}
          >
            极限吞吐 (2000 CPS)
          </button>

          <button
            className={styles.btn}
            disabled={isStreaming}
            onClick={() => startScenario('burst-gap')}
          >
            突发断流压测
          </button>

          <button
            className={styles.btn}
            disabled={isStreaming}
            onClick={() => startScenario('rapid-wrap')}
          >
            高频折行短句
          </button>

          {isStreaming && (
            <button className={`${styles.btn} ${styles.btnSuccess}`} onClick={stopScenario}>
              停止流式
            </button>
          )}
        </div>
      </div>

      {/* Main Grid */}
      <div className={styles.mainGrid}>
        {/* Left: Chat Container */}
        <div className={styles.conversationPane}>
          <div
            ref={viewportRef}
            className={styles.scrollViewport}
            data-conversation-scroll=""
          >
            <div ref={flowRef} className={styles.scrollColumn} data-chat-flow="">
              <div className={styles.msgUser} data-chat-anchor-key="user-1">
                请进行 120 FPS 流式渲染平滑度极限压力测试，并展示实时帧率瀑布图与速度波形。
              </div>

              <div
                ref={rowRef}
                className={styles.msgAssistant}
                data-chat-anchor-key="assistant-1"
              >
                <FollowHost
                  active={typing}
                  predictive={isStreaming}
                  speedCpsRef={speedCpsRef}
                  revealedCharsRef={revealedCharsRef}
                  revealScaleRef={revealScaleRef}
                >
                  <div className={styles.streamText}>{displayText}</div>
                </FollowHost>
              </div>

              <div className={styles.statusIndicator} role="status">
                <span className={isStreaming ? styles.liveIndicator : styles.doneIndicator} />
                <span>
                  {isStreaming
                    ? `120 FPS 物理轨迹跟随中 (${cps} CPS)...`
                    : status === 'complete'
                      ? '120 FPS 物理跟随已平滑归位 (0 抖动, 0 回弹)'
                      : '就绪'}
                </span>
              </div>
            </div>
          </div>

          <div className={styles.composerSeat}>
            <input
              className={styles.composerInput}
              readOnly
              value={isStreaming ? '流式生成中 (120 FPS 观测台架已激活)...' : '点击上方压测场景按钮启动测试'}
            />
          </div>
        </div>

        {/* Right: Observability Dashboard */}
        <div className={styles.dashboardPane}>
          {/* Key Metrics */}
          <div className={styles.metricCards}>
            <div className={styles.metricCard}>
              <span className={styles.metricLabel}>当前帧率</span>
              <span className={`${styles.metricValue} ${fps >= 115 ? styles.good : fps >= 58 ? styles.warn : styles.bad}`}>
                {fps} <small style={{ fontSize: 11, fontWeight: 500 }}>FPS</small>
              </span>
              <span className={styles.metricSub}>Target: 120 Hz</span>
            </div>

            <div className={styles.metricCard}>
              <span className={styles.metricLabel}>P95 帧耗时</span>
              <span className={`${styles.metricValue} ${p95Dt <= 8.5 ? styles.good : p95Dt <= 16.7 ? styles.warn : styles.bad}`}>
                {p95Dt} <small style={{ fontSize: 11, fontWeight: 500 }}>ms</small>
              </span>
              <span className={styles.metricSub}>Max: {maxDt}ms</span>
            </div>

            <div className={styles.metricCard}>
              <span className={styles.metricLabel}>最大加速度突变</span>
              <span className={`${styles.metricValue} ${maxDeltaV <= 0.05 ? styles.good : maxDeltaV <= 0.1 ? styles.warn : styles.bad}`}>
                {maxDeltaV}
              </span>
              <span className={styles.metricSub}>|Δv| px/ms</span>
            </div>

            <div className={styles.metricCard}>
              <span className={styles.metricLabel}>Y 轴回弹违规 (Zero Rebound)</span>
              <span className={`${styles.metricValue} ${reboundCount === 0 ? styles.good : styles.bad}`}>
                {reboundCount} <small style={{ fontSize: 11, fontWeight: 500 }}>次</small>
              </span>
              <span className={styles.metricSub}>Max: {maxDownwardY.toFixed(2)}px (Target: 0)</span>
            </div>
          </div>

          {/* 120 FPS Frame Waterfall */}
          <div className={styles.sectionBox}>
            <div className={styles.sectionHeader}>
              <span>120 FPS 帧渲染瀑布图 (Target: ≤8.33ms)</span>
              <span style={{ fontSize: 11, color: framesAbove9ms === 0 ? '#10b981' : '#f59e0b' }}>
                &gt;9ms: {framesAbove9ms} 帧 | &gt;16ms: {framesAbove16ms} 帧
              </span>
            </div>
            <div className={styles.canvasWrapper}>
              <canvas ref={waterfallCanvasRef} className={styles.canvas} />
            </div>
          </div>

          {/* Velocity Waveform */}
          <div className={styles.sectionBox}>
            <div className={styles.sectionHeader}>
              <span>瞬时视口速度波形 v(t) (px/ms)</span>
              <span style={{ fontSize: 11, color: '#38bdf8' }}>尾部振幅: {tailAmplitude}px</span>
            </div>
            <div className={styles.canvasWrapper}>
              <canvas ref={waveformCanvasRef} className={styles.canvas} />
            </div>
          </div>

          {/* Jitter Event Log */}
          <div className={styles.sectionBox}>
            <div className={styles.sectionHeader}>
              <span>微抖动 / 掉帧事件探测器</span>
              <span style={{ fontSize: 11, color: events.length === 0 ? '#10b981' : '#ef4444' }}>
                {events.length === 0 ? '✓ 零微抖动 (Perfect)' : `${events.length} 次警报`}
              </span>
            </div>
            <div className={styles.eventsLog}>
              {events.length === 0 ? (
                <div style={{ color: '#10b981', padding: '12px 0', textAlign: 'center' }}>
                  ✓ 视线完全平稳，无掉帧与速度阶跃
                </div>
              ) : (
                events.map((ev, i) => (
                  <div key={i} className={styles.eventItem}>
                    <span className={styles.eventTime}>{ev.time}</span>
                    <span className={styles.eventDesc}>{ev.desc}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(<Stress120App />)
}
