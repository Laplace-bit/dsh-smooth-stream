/**
 * Real-DOM repro: plugin's actual follow/reveal engine inside a verbatim
 * port of the host ChatView scroll contract (observed-top ledger, atBottom
 * state machine, ResizeObserver hard snap, back-to-bottom button).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { FollowHost } from '../src/client/FollowHost.tsx'
import { useSmoothStreamContent } from '../src/client/useSmoothStreamContent.ts'
import { useFpsGuard } from '../src/client/useFpsGuard.ts'

/* ---------------- host ChatView scroll contract (verbatim port) ---------- */

const FOLLOW_THRESHOLD = 24

function scrollerOf(from: HTMLElement): HTMLElement {
  return from.closest<HTMLElement>('[data-conversation-scroll]') ?? from
}

/* ---------------- assistant stream arm (plugin engine) ------------------- */

const SENTENCE = '深度探索这个问题需要从多个角度分析,首先我们要理解核心机制的运作原理,然后逐步推导出在高速输出场景下的边界条件与稳定性约束。'

function AssistantStream({ text, streaming, renderCostMs }: { text: string; streaming: boolean; renderCostMs: number }) {
  const { ref: guardRef, shouldHoldBack } = useFpsGuard(streaming)
  const [typing, setTyping] = useState(streaming)
  const speedCpsRef = useRef(35)
  const revealScaleRef = useRef(1)
  const displayed = useSmoothStreamContent(text, {
    enabled: typing,
    inputComplete: !streaming,
    preset: 'balanced',
    shouldHoldBack,
    speedCpsRef,
    revealScaleRef,
  })
  displayedLenRef.current = displayed.length
  useEffect(() => {
    if (streaming) setTyping(true)
    else if (displayed.length === text.length) setTyping(false)
  }, [displayed.length, streaming, text.length])
  // Simulate MarkdownText's incremental parse/layout cost: block the main
  // thread on every reveal commit so real frames stretch the way heavy
  // markdown does.
  useLayoutEffect(() => {
    if (!typing || renderCostMs <= 0) return
    const end = performance.now() + renderCostMs
    while (performance.now() < end) { /* busy wait */ }
  }, [displayed, typing, renderCostMs])
  return (
    <div ref={guardRef}>
      <FollowHost
        active={typing}
        predictive={streaming}
        speedCpsRef={speedCpsRef}
        revealScaleRef={revealScaleRef}
      >
        <div
          className="streamText"
          data-displayed-length={displayed.length}
          data-source-length={text.length}
          data-typing={typing || undefined}
        >
          {displayed}
        </div>
      </FollowHost>
    </div>
  )
}

const displayedLenRef = { current: 0 }

/* ---------------- host conversation shell -------------------------------- */

function HostConversation() {
  const [text, setText] = useState('')
  const [running, setRunning] = useState(false)
  const [cps, setCps] = useState(1000)
  const [renderCostMs, setRenderCostMs] = useState(0)
  const [atBottom, setAtBottom] = useState(true)

  // ChatView state
  const listRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const observedTopRef = useRef(0)

  const toBottom = useCallback((el: HTMLElement): void => {
    el.scrollTop = el.scrollHeight
    observedTopRef.current = el.scrollTop
    atBottomRef.current = true
    setAtBottom(true)
  }, [])

  const onScrollRef = useRef(() => {})
  onScrollRef.current = () => {
    const local = listRef.current
    if (local === null) return
    const el = scrollerOf(local)
    const floor = Math.max(0, el.scrollHeight - el.clientHeight)
    const movedByReader = Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > 0.5
    const isAtBottom = movedByReader
      ? floor - el.scrollTop <= FOLLOW_THRESHOLD + 1
      : atBottomRef.current
    if (!movedByReader && isAtBottom) {
      toBottom(el)
      return
    }
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    observedTopRef.current = el.scrollTop
  }

  useEffect(() => {
    const local = listRef.current
    if (local === null) return
    const el = scrollerOf(local)
    const onScroll = (): void => { onScrollRef.current() }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll) }
  }, [])

  // Host dynamic-height follow: ResizeObserver on the column hard-snaps to
  // the floor while the reader is pinned.
  const followRef = useRef<(() => void) | null>(null)
  followRef.current = () => {
    const local = listRef.current
    if (local !== null && atBottomRef.current) {
      const el = scrollerOf(local)
      el.scrollTop = el.scrollHeight
      observedTopRef.current = el.scrollTop
    }
  }
  useEffect(() => {
    const column = columnRef.current
    if (column === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { followRef.current?.() })
    observer.observe(column)
    return () => { observer.disconnect() }
  }, [])

  // Stream driver: append chars at the requested cps.
  useEffect(() => {
    if (!running) return
    const intervalMs = 40
    const perTick = Math.max(1, Math.round(cps * intervalMs / 1000))
    const id = setInterval(() => {
      setText(prev => prev + SENTENCE.repeat(2).slice(0, perTick))
    }, intervalMs)
    return () => { clearInterval(id) }
  }, [running, cps])

  const start = (): void => {
    displayedLenRef.current = 0
    setText('')
    atBottomRef.current = true
    setAtBottom(true)
    setRunning(true)
  }

  const portRef = (): HTMLElement | null =>
    listRef.current?.closest<HTMLElement>('[data-conversation-scroll]') ?? null

  return (
    <div className="root">
      <div className="toolbar">
        <button className="primary" onClick={start} disabled={running}>开始高速流</button>
        <button onClick={() => setRunning(false)} disabled={!running}>停止</button>
        <button onClick={() => { setRunning(false); setText('') }}>清空</button>
        <label>到达速度 {cps} cps</label>
        <input type="range" min={200} max={3000} step={100} value={cps}
          onChange={e => setCps(Number(e.target.value))} />
        <label>重渲染 {renderCostMs}ms/帧</label>
        <input type="range" min={0} max={40} step={2} value={renderCostMs}
          onChange={e => setRenderCostMs(Number(e.target.value))} />
      </div>
      <Stats listRef={listRef} />
      <div className="scrollBody" data-conversation-scroll="" tabIndex={0}>
        <div ref={listRef} className="scroll">
          <div ref={columnRef} className="column" data-chat-flow="">
            <div className="msg user" data-chat-anchor-key="u1">请深入分析这个机制的原理</div>
            <div className="msg assistant" data-chat-anchor-key="a1">
              <AssistantStream text={text} streaming={running} renderCostMs={renderCostMs} />
            </div>
            {running && (
              <div role="status" className="statusRow">
                <span className="dots">Deep diving</span>
              </div>
            )}
          </div>
        </div>
        <div className="composerSeat" data-composer-seat="">
          <input placeholder="输入消息…" />
          <button>发送</button>
        </div>
        {!atBottom && (
          <button className="toBottomBtn" onClick={() => { const el = portRef(); if (el !== null) toBottom(el) }}>
            ↓ 滚动到底部
          </button>
        )}
      </div>
    </div>
  )
}

/* ---------------- instrumentation ---------------------------------------- */

function Stats({ listRef }: { listRef: RefObject<HTMLDivElement | null> }): ReactNode {
  const [cells, setCells] = useState<Record<string, number>>({})
  const fpsRef = useRef(0)
  useEffect(() => {
    let frames = 0
    let last = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      frames += 1
      if (now - last >= 500) {
        fpsRef.current = Math.round(frames * 1000 / (now - last))
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf) }
  }, [])
  useEffect(() => {
    const id = setInterval(() => {
      const local = listRef.current
      const port = local?.closest<HTMLElement>('[data-conversation-scroll]')
      if (port === null || port === undefined) return
      const floor = Math.max(0, port.scrollHeight - port.clientHeight)
      const dist = floor - port.scrollTop
      const rows = port.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')
      const last = rows.item(rows.length - 1) as HTMLElement | null
      const portRect = port.getBoundingClientRect()
      const overflow = last === null ? 0 : last.getBoundingClientRect().bottom - portRect.bottom
      setCells({
        floor: Math.round(floor),
        dist: Math.round(dist),
        overflow: Math.round(overflow),
        fps: fpsRef.current,
        revealed: displayedLenRef.current,
      })
    }, 200)
    return () => { clearInterval(id) }
  }, [listRef])
  const cls = (v: number): string => (v > 60 ? 'cell bad' : v > 28 ? 'cell warn' : 'cell')
  return (
    <div className="stats">
      <div className={cls(cells.dist ?? 0)}><b>{cells.dist ?? 0}px</b>距底部</div>
      <div className={(cells.overflow ?? 0) > 4 ? 'cell bad' : 'cell'}><b>{cells.overflow ?? 0}px</b>文字超出视口底</div>
      <div className="cell"><b>{cells.floor ?? 0}px</b>floor</div>
      <div className="cell"><b>{cells.fps ?? 0}</b>FPS</div>
      <div className="cell"><b>{cells.revealed ?? 0}</b>已揭示字符</div>
    </div>
  )
}

/* ---------------- mount -------------------------------------------------- */

createRoot(document.getElementById('app')!).render(<HostConversation />)
