/**
 * End-of-render audit rig.
 *
 * Composes the plugin's REAL engine components (FollowHost,
 * useSmoothStreamContent, useFpsGuard, AnimatedDisclosure) inside a port of
 * the host ChatView scroll contract, and replays the full end-of-render
 * sequence the production TypewriterAssistantNodeView goes through:
 *
 *   streaming ──► producer complete ──► outer follow hands over to the text
 *   arm's inner follower ──► completion drain ──► live→settled tree swap ──►
 *   think disclosure closes (grid-rows transition) ──▸ status row unmounts ──▸
 *   auto-collapse fold (instant display:none + summary row insert, no scroll
 *   compensation) ──▸ quiescence window.
 *
 * Instruments: Layout Instability API (layout-shift entries), per-frame
 * visual probes (head / mid / tail / status edges), long-frame log,
 * scrollTop series. Violations are computed in-page and exposed through
 * `window.__report()`; the runner script drives N conversations.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { FollowHost } from '../src/client/FollowHost.tsx'
import { useSmoothStreamContent } from '../src/client/useSmoothStreamContent.ts'
import { useFpsGuard } from '../src/client/useFpsGuard.ts'
import { AnimatedDisclosure } from '../src/client/AnimatedDisclosure.tsx'
import { debugRuntime } from '../src/client/debugRuntime.ts'
import { hasRecentConversationFollow, notifyFollowCommit } from '../src/client/teleprompterGlide.ts'

/* ----------------------------- audit config ------------------------------ */

interface Phase { readonly cps: number; readonly chars: number; readonly gapMs: number }
export interface AuditProfile {
  readonly id: string
  /** Inter-chunk jitter: emitted chunk sizes vary ± this fraction. */
  readonly jitter?: number
  readonly phases: readonly Phase[]
  /**
   * Delay from PRODUCER-COMPLETE (not drain-complete) to the fold pass, ms —
   * the production auto-collapse observes the turn close while the reveal
   * queue is still draining, so this interleaves the two by default.
   */
  readonly foldDelayMs: number
  /** Extra px added per settled code block at the live→settled swap. */
  readonly swapDeltaPx: number
}

const REASONING_TEXT = '这个问题需要从机制层面拆解。首先确认输入的分块节奏，然后观察队列压力曲线如何在积压出现时抬升揭示速度，最后检查弹簧的阻尼比是否恰好吸收每次折行脉冲而不产生过冲。'.repeat(3)

const ANSWER_TEXT = [
  '结论先行：这套引擎把离散的到达流转换成了连续的视觉运动，核心是三个有界缓冲的串联。',
  '第一层是字符队列，积压量通过超线性压力曲线映射成揭示速度，小积压便宜、大积压昂贵，封顶六百字符每秒保证单帧工作量有界。',
  '第二层是浮点债务，每帧取整的余数留到下一帧，低速度配高刷新率时不会出现连续空帧后突然吐一簇的打字机卡顿。\n\n',
  '第三层是弹簧滞后，真实滚动位置钉在底部，剩余距离画成等量合成器变换，折行脉冲到来之前跑道已经提前打开。',
  '```ts\nconst speed = Math.min(600, 90 + backlog ** 1.25 * 0.85)\n```\n',
  '验证方式是让十条不同速度画像的对话全部干净收尾：零意外位移、零长帧尖峰、速度逐帧连续。测量台架复刻了完整的收尾碰撞链，任何一层失守都会在探针上留下台阶。',
].join('\n')

const PROFILES: Record<string, AuditProfile> = {
  'slow-steady': {
    id: 'slow-steady', foldDelayMs: 150, swapDeltaPx: 0,
    phases: [{ cps: 30, chars: 700, gapMs: 0 }],
  },
  'fast-sustained': {
    id: 'fast-sustained', foldDelayMs: 120, swapDeltaPx: 0,
    phases: [{ cps: 600, chars: 3600, gapMs: 0 }],
  },
  'burst-gap': {
    id: 'burst-gap', foldDelayMs: 200, swapDeltaPx: 0, jitter: 0.6,
    phases: [
      { cps: 900, chars: 260, gapMs: 650 },
      { cps: 900, chars: 300, gapMs: 720 },
      { cps: 700, chars: 240, gapMs: 560 },
      { cps: 900, chars: 320, gapMs: 800 },
      { cps: 500, chars: 180, gapMs: 0 },
    ],
  },
  'ramp': {
    id: 'ramp', foldDelayMs: 120, swapDeltaPx: 0,
    phases: [
      { cps: 50, chars: 250, gapMs: 0 },
      { cps: 150, chars: 450, gapMs: 0 },
      { cps: 400, chars: 800, gapMs: 0 },
      { cps: 1200, chars: 1400, gapMs: 0 },
      { cps: 80, chars: 200, gapMs: 0 },
    ],
  },
  'short-answer': {
    id: 'short-answer', foldDelayMs: 100, swapDeltaPx: 0,
    phases: [{ cps: 600, chars: 420, gapMs: 0 }],
  },
}

/* --------------------------- host scroll contract ------------------------ */

const FOLLOW_THRESHOLD = 24

function scrollerOf(from: HTMLElement): HTMLElement {
  return from.closest<HTMLElement>('[data-conversation-scroll]') ?? from
}

/* ------------------------------ stream arms ------------------------------ */

function StreamedTree({ text }: { text: string }) {
  const blocks = text.split('\n\n')
  return (
    <div className="md">
      {blocks.map((block, index) => {
        if (block.startsWith('```')) {
          const lines = block.split('\n')
          return (
            <pre key={index} className="codeBlock">
              <code>{lines.slice(1, -1).join('\n')}</code>
            </pre>
          )
        }
        return <p key={index}>{block}</p>
      })}
    </div>
  )
}

function SettledTree({ text, extraPx }: { text: string; extraPx: number }) {
  const blocks = text.split('\n\n')
  return (
    <div className="md">
      {blocks.map((block, index) => {
        if (block.startsWith('```')) {
          const lines = block.split('\n')
          return (
            <div key={index} className="codeShell">
              {extraPx > 0 && <div className="codeBar" style={{ height: extraPx }} />}
              <pre className="codeBlock"><code>{lines.slice(1, -1).join('\n')}</code></pre>
            </div>
          )
        }
        return <p key={index}>{block}</p>
      })}
    </div>
  )
}

function ThinkBlock({ text, running }: { text: string; running: boolean }) {
  const [expanded, setExpanded] = useState(running)
  useEffect(() => { setExpanded(running) }, [running])
  return (
    <div className="think" data-state={running ? 'running' : 'ok'}>
      <AnimatedDisclosure
        icon={<span className="thinkGlyph" />}
        title="Think"
        open={expanded}
        onToggle={() => { setExpanded(value => !value) }}
      >
        <div className="thinkBody">{text}</div>
      </AnimatedDisclosure>
    </div>
  )
}

function TextArm({
  text,
  streaming,
  swapDeltaPx,
  speedCpsRef,
  revealedCharsRef,
  revealScaleRef,
  onDrained,
}: {
  text: string
  streaming: boolean
  swapDeltaPx: number
  speedCpsRef: { current: number }
  revealedCharsRef: { current: number }
  revealScaleRef: { current: number }
  onDrained: () => void
}) {
  const [typing, setTyping] = useState(streaming)
  const displayed = useSmoothStreamContent(text, {
    enabled: typing,
    inputComplete: !streaming,
    preset: 'balanced',
    speedCpsRef,
    revealedCharsRef,
    revealScaleRef,
    onRevealCommit: () => { notifyFollowCommit(document.querySelector('[data-conversation-scroll]')) },
  })
  const drainedRef = useRef(false)
  useEffect(() => {
    if (streaming) { setTyping(true); drainedRef.current = false; return }
    if (displayed.length === text.length && !drainedRef.current) {
      drainedRef.current = true
      setTyping(false)
      onDrained()
    }
  }, [displayed.length, streaming, text.length, onDrained])
  return (
    // Production wiring: the text arm owns follow ONLY while draining after
    // producer completion (`ownFollow={!streaming && lastTextBlock}`); while
    // streaming the outer node follower leads.
    <FollowHost
      active={typing && !streaming}
      predictive={false}
      speedCpsRef={speedCpsRef}
      revealedCharsRef={revealedCharsRef}
      revealScaleRef={revealScaleRef}
    >
      {typing ? <StreamedTree text={displayed} /> : <SettledTree text={text} extraPx={swapDeltaPx} />}
    </FollowHost>
  )
}

/* ------------------------------- assistant ------------------------------- */

function AssistantMessage({
  text,
  streaming,
  swapDeltaPx,
  onDrained,
}: {
  text: string
  streaming: boolean
  swapDeltaPx: number
  onDrained: () => void
}) {
  const { ref: guardRef, shouldHoldBack } = useFpsGuard(streaming)
  // Production wires ONE root speed/reveal-scale pair shared between the
  // outer node follower and the draining text arm.
  const rootSpeedCpsRef = useRef(35)
  const rootRevealedCharsRef = useRef(0)
  const rootRevealScaleRef = useRef(1)

  return (
    <div ref={guardRef} className="msg assistant" data-chat-anchor-key="a1" data-streaming={streaming || undefined}>
      <FollowHost
        active={streaming}
        predictive={streaming}
        speedCpsRef={rootSpeedCpsRef}
        revealedCharsRef={rootRevealedCharsRef}
        revealScaleRef={rootRevealScaleRef}
      >
        <div className="body">
          <ThinkBlock text={REASONING_TEXT} running={streaming} />
          <TextArm
            text={text}
            streaming={streaming}
            swapDeltaPx={swapDeltaPx}
            speedCpsRef={rootSpeedCpsRef}
            revealedCharsRef={rootRevealedCharsRef}
            revealScaleRef={rootRevealScaleRef}
            onDrained={onDrained}
          />
          <div className="tailProbe" data-probe="tail" />
        </div>
      </FollowHost>
    </div>
  )
}

/* ------------------------------ conversation ----------------------------- */

let sequence = 0

function HostConversation() {
  const [profile, setProfile] = useState<AuditProfile | null>(null)
  const [text, setText] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [drained, setDrained] = useState(false)
  const [folded, setFolded] = useState(false)
  const [atBottom, setAtBottom] = useState(true)

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
    const isAtBottom = movedByReader ? floor - el.scrollTop <= FOLLOW_THRESHOLD + 1 : atBottomRef.current
    if (!movedByReader && isAtBottom) { toBottom(el); return }
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

  // Host dynamic-height follow: ResizeObserver hard-snaps to floor while pinned.
  const followRef = useRef<() => void>(() => {})
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

  // Auto-collapse fold pass: instant display:none + summary row insert,
  // scheduled from PRODUCER-COMPLETE like the production controller. The
  // timer survives drain completion on purpose: production folds mid-drain.
  useEffect(() => {
    // Fold only AFTER the completion drain has fully closed and the live→
    // settled swap landed: folding mid-drain makes the fold+swap commits
    // collide for short answers (both are large reflows in one window).
    if (profile === null || streaming || folded || !drained) return
    const timer = window.setTimeout(() => {
      const flow = columnRef.current
      if (flow === null) return
      const port = scrollerOf(flow)
      const beforeFloor = Math.max(0, port.scrollHeight - port.clientHeight)
      const pinned = beforeFloor - port.scrollTop <= 30
      const rows = [...flow.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
      const anchorEl = rows.filter(el => el.getClientRects().length > 0).at(-1) ?? null
      const anchorBefore = anchorEl?.getBoundingClientRect().top ?? null
      for (const seat of flow.querySelectorAll<HTMLElement>('[data-work-seat]')) {
        seat.style.display = 'none'
      }
      const summary = document.createElement('button')
      summary.className = 'processedRow'
      summary.textContent = `已处理 #${++sequence}`
      const assistant = flow.querySelector('[data-chat-anchor-key="a1"]')
      if (assistant !== null) flow.insertBefore(summary, assistant)
      // Same pin compensation as the production controller: the fold moves
      // height in one commit; a pinned reader must not see it translate.
      if (pinned && anchorBefore !== null && anchorEl !== null) {
        const delta = anchorEl.getBoundingClientRect().top - anchorBefore
        if (Math.abs(delta) > 0.5) port.scrollTop += delta
      }
      setFolded(true)
      window.__auditPhase('folded')
    }, profile.foldDelayMs)
    return () => { clearTimeout(timer) }
  }, [profile, streaming, folded, drained])

  // Profile driver: emits chunks with size jitter so arrival looks organic.
  useEffect(() => {
    if (profile === null || !streaming) return
    let phaseIndex = 0
    let emittedInPhase = 0
    let carry = 0
    let gapUntil = 0
    const intervalMs = 25
    const jitter = profile.jitter ?? 0
    const id = window.setInterval(() => {
      const now = performance.now()
      if (now < gapUntil) return
      const phase = profile.phases[phaseIndex]
      if (phase === undefined) {
        window.clearInterval(id)
        setStreaming(false)
        window.__auditPhase('produced')
        return
      }
      carry += phase.cps * intervalMs / 1000
      const scale = jitter > 0 ? 1 + (Math.random() * 2 - 1) * jitter : 1
      let take = Math.max(1, Math.round(carry * scale))
      carry -= take
      const remaining = phase.chars - emittedInPhase
      if (take >= remaining) {
        take = remaining
        phaseIndex += 1
        emittedInPhase = 0
        const nextPhase = profile.phases[phaseIndex]
        gapUntil = now + intervalMs + (nextPhase?.gapMs ?? 0)
      } else {
        emittedInPhase += take
      }
      setText(prev => prev + '深'.repeat(take))
    }, intervalMs)
    return () => { window.clearInterval(id) }
  }, [profile, streaming])

  const start = useCallback((next: AuditProfile): void => {
    for (const seat of document.querySelectorAll<HTMLElement>('[data-work-seat]')) {
      seat.style.display = ''
    }
    for (const row of document.querySelectorAll('.processedRow')) row.remove()
    window.__auditReset()
    sequence = 0
    setProfile(next)
    setText('')
    setDrained(false)
    setFolded(false)
    setStreaming(false)
    atBottomRef.current = true
    setAtBottom(true)
    requestAnimationFrame(() => {
      const local = listRef.current
      if (local !== null) toBottom(scrollerOf(local))
      setDrained(false)
      setStreaming(true)
      window.__auditPhase('started')
    })
  }, [toBottom])

  useEffect(() => {
    window.__start = (id: string, overrides?: Partial<AuditProfile>) => {
      const base = PROFILES[id] ?? Object.values(PROFILES)[0]!
      start({ ...base, ...overrides })
    }
  }, [start])

  const showWorkSeats = profile !== null

  return (
    <div className="root">
      <div className="scrollBody" data-conversation-scroll="" tabIndex={0}>
        <div ref={listRef} className="scroll">
          <div ref={columnRef} className="column" data-chat-flow="">
            <div className="msg user" data-chat-anchor-key="u1" data-probe="head">
              请完整分析这套流式渲染引擎的机制，并给出验证方法。
            </div>
            {showWorkSeats && (
              <>
                <div className="msg workSeat" data-chat-anchor-key="t1" data-work-seat="">
                  <div className="workHead">Tool · web.search()</div>
                  <div className="workBody">检索了 12 条结果，其中 4 条与流式渲染的缓冲策略直接相关，已提取关键段落等待引用，同时核对了引用来源的时间戳与作者信息。</div>
                </div>
                <div className="msg workSeat" data-chat-anchor-key="t2" data-work-seat="" data-probe="mid">
                  <div className="workHead">Tool · code.interpret()</div>
                  <div className="workBody">基准脚本运行完毕：队列步 47M ops/s，弹簧步 89M ops/s，192px 滞后在 60Hz 与 120Hz 下均约 1s 收敛。跑道在 600cps 揭示下预留满 48px。</div>
                </div>
              </>
            )}
            {profile !== null && (
              <AssistantMessage
                text={text}
                streaming={streaming}
                swapDeltaPx={profile.swapDeltaPx}
                onDrained={() => { setDrained(true); window.__auditPhase('drained') }}
              />
            )}
            {profile !== null && (
              <div role="status" className="statusRow" data-probe="status">
                <span className="dots">{streaming ? '正在深度思考…' : '已完成'}</span>
              </div>
            )}
          </div>
        </div>
        {!atBottom && (
          <button
            className="toBottomBtn"
            onClick={() => { const el = listRef.current; if (el !== null) toBottom(scrollerOf(el)) }}
          >
            ↓ 回到底部
          </button>
        )}
      </div>
      <div className="composerSeat" data-composer-seat="">
        <input placeholder="输入消息…" />
        <button>发送</button>
      </div>
    </div>
  )
}

/* ----------------------------- instrumentation ---------------------------- */

interface Sample {
  t: number
  dt: number
  top: number
  height: number
  client: number
  head: number
  mid: number
  tail: number
  status: number
  /** Engine internals from debugRuntime for incident attribution. */
  lag: number
  capacity: number
  reserve: number
  revealScale: number
  following: boolean
  constrained: boolean
  /** Painted compositor shift on the assistant surface, px. */
  shift: number
  /** Painted compositor shift on the status row, px. */
  statusShift: number
  /** Runway margin currently owned on the status row, px. */
  runway: number
}

interface Violation { kind: string; t: number; detail: string }

/**
 * Violation thresholds. Calibrated against the engine's physics: the spring
 * may accelerate at up to k·lag ≈ 130·(runway+gap) px/s², so consecutive
 * per-frame position deltas may legitimately differ by tens of px; what may
 * NEVER happen is upward motion of pinned content, any single-frame step past
 * one wrapped line, instability entries, or any motion after settle.
 */
const LIMITS = {
  /** Max one-frame downward advance of the tail (~one wrapped CJK line + margin). */
  tailDownPx: 34,
  /** Max one-frame |movement| of any probe (~one wrapped line). */
  movePx: 34,
  /** Max one-frame upward snap of the tail before it counts as instability. */
  abruptUpPx: 16,
  /** Frame-gap above which continuity checks are skipped (stall, not jitter). */
  stallMs: 100,
  /**
   * Min layout-shift value considered an incident. Below ~0.01 a shift moves
   * content by a fraction of a percent of the viewport — imperceptible;
   * flagging it only buries real signals.
   */
  shiftValue: 0.01,
  /** Post-settle movement tolerance, px. */
  quietMovePx: 1,
  /** Long-frame log threshold, ms. */
  longFrameMs: 80,
  /** Max frame-to-frame velocity step inside the drain window, px/s. */
  drainDvPxPerSec: 1400,
}

function installAudit(): void {
  const state = {
    samples: [] as Sample[],
    shifts: [] as Array<{ t: number; value: number; sources: string[] }>,
    phases: [] as Array<{ name: string; t: number }>,
    last: null as number | null,
    raf: 0,
  }

  const probeOf = (name: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-probe="${name}"]`)

  const sampleLoop = (now: number): void => {
    const port = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (port === null) return
    // Once the fold has landed and the settle tail plus one full quiet second
    // have been sampled, freeze and tell the runner it may collect.
    const foldedT = state.phases.find(phase => phase.name === 'folded')?.t
    const lastPhaseT = state.phases.at(-1)?.t ?? 0
    // Watchdog ONLY once the producer has finished (or folded): mid-stream
    // the last phase stays 'started' for the whole reveal, and freezing then
    // truncates the conversation before it completes.
    const producedT = state.phases.find(phase => phase.name === 'produced')?.t
    const watchdogArmed = foldedT !== undefined || producedT !== undefined
    // The completion drain is intentionally capped at the preset's 480cps;
    // large profiles can therefore need several seconds after production
    // ends. Keep this as an exceptional safety valve, not the normal finish
    // path, or the audit can report before drain/fold has happened.
    const watchdogQuiet = watchdogArmed && now - lastPhaseT > 8000
    const foldWindowComplete = foldedT !== undefined
      && now - foldedT >= 1500
      && now - lastPhaseT >= 700
    if (foldWindowComplete || watchdogQuiet) {
      window.__reportReady = true
      return
    }
    state.raf = requestAnimationFrame(sampleLoop)
    const dt = state.last === null ? 16.7 : now - state.last
    state.last = now
    const visibleTopOf = (el: HTMLElement | null): number => {
      // A display:none element (folded work seat) has no meaningful edge.
      if (el === null || el.getClientRects().length === 0) return NaN
      return el.getBoundingClientRect().top
    }
    const head = probeOf('head')
    const mid = probeOf('mid')
    const tail = probeOf('tail')
    const status = probeOf('status')
    const engine = window.__debugState?.()
    const surface = port.querySelector<HTMLElement>('[data-chat-anchor-key="a1"]')
    const surfaceShift = Number(
      /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(surface?.style.transform ?? '')?.[1] ?? 0,
    )
    const statusEl = port.querySelector<HTMLElement>('[role="status"]')
    const runwayOwned = parseFloat(statusEl?.style.marginTop ?? '') || 0
    state.samples.push({
      t: now,
      dt,
      top: port.scrollTop,
      height: port.scrollHeight,
      client: port.clientHeight,
      head: visibleTopOf(head),
      mid: visibleTopOf(mid),
      tail: visibleTopOf(tail),
      status: visibleTopOf(status),
      lag: engine?.followLagPx ?? NaN,
      capacity: engine?.followCapacityPx ?? NaN,
      reserve: engine?.followReservePx ?? NaN,
      revealScale: engine?.followRevealScale ?? NaN,
      following: engine?.followFollowing ?? false,
      constrained: engine?.followConstrained ?? false,
      shift: surfaceShift,
      statusShift: Number(
        /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(statusEl?.style.transform ?? '')?.[1] ?? 0,
      ),
      runway: runwayOwned,
    })
    if (state.samples.length > 120000) state.samples.splice(0, 40000)
  }

  window.__auditReset = (): void => {
    cancelAnimationFrame(state.raf)
    state.samples = []
    state.shifts = []
    state.phases = []
    state.last = null
    state.raf = requestAnimationFrame(sampleLoop)
    try { window.__shiftObserver?.disconnect() } catch {}
    if (typeof PerformanceObserver !== 'undefined') {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value: number; sources?: Array<{ node?: Node | null }> }
          if (shift.value <= 0) continue
          state.shifts.push({
            t: entry.startTime,
            value: shift.value,
            sources: (shift.sources ?? []).slice(0, 4).map(source => {
              const node = source.node
              if (node instanceof HTMLElement) {
                return `${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(' ')[0]}` : ''}`
              }
              return node?.nodeName ?? '?'
            }),
          })
        }
      })
      observer.observe({ type: 'layout-shift', buffered: false })
      window.__shiftObserver = observer
    }
  }

  window.__auditPhase = (name: string): void => {
    state.phases.push({ name, t: performance.now() })
  }

  window.__debugState = () => {
    try {
      return debugRuntime.getSnapshot().metrics
    } catch {
      return undefined
    }
  }

  window.__report = (): unknown => {
    cancelAnimationFrame(state.raf)
    const samples = state.samples
    const violations: Violation[] = []
    /** @type {Array<{index: number}>} */
    const anchors: Array<{ kind: string; index: number }> = []
    const push = (kind: string, t: number, detail: string, index: number): void => {
      if (violations.length < 400) {
        violations.push({ kind, t, detail })
        anchors.push({ kind, index })
      }
    }

    // Mount/pin transients in the first 350ms after start are not streaming.
    const startedT = state.phases.find(phase => phase.name === 'started')?.t ?? 0
    const warmupUntil = startedT + 350

    const engineLine = (sample: Sample): string =>
      Number.isFinite(sample.lag)
        ? ` st=${sample.top.toFixed(0)} sft=${sample.shift.toFixed(1)} ssft=${sample.statusShift.toFixed(1)} rw=${sample.runway.toFixed(0)} lag=${sample.lag.toFixed(0)} cap=${Number.isFinite(sample.capacity) ? sample.capacity.toFixed(0) : '?'} rsv=${sample.reserve.toFixed(0)} scale=${sample.revealScale.toFixed(2)}${sample.constrained ? ' CONSTRAINED' : ''}`
        : ` st=${sample.top.toFixed(0)} sft=${sample.shift.toFixed(1)} ssft=${Number.isFinite(sample.statusShift) ? sample.statusShift.toFixed(1) : "-"} rw=${sample.runway.toFixed(0)} (no engine state)`

    // Window where the folded flow fits the viewport (floor 0): with no
    // scroll room there is nothing to compensate — the fold's rearrangement
    // is the final layout, not instability.
    let unpinnableFromT = Number.POSITIVE_INFINITY
    const foldedT = state.phases.find(phase => phase.name === 'folded')?.t
    if (foldedT !== undefined) {
      for (const sample of samples) {
        if (sample.t >= foldedT && sample.top <= 0 && sample.height - sample.client <= 0) {
          unpinnableFromT = Math.min(unpinnableFromT, sample.t)
          break
        }
      }
    }

    // Drain window: producer-complete → drained marker. Reveal closes at a
    // bounded, ramped velocity whose per-frame pinning steps legitimately
    // exceed one line; there the bar is VELOCITY CONTINUITY (checked
    // separately below), not an absolute per-frame delta.
    const producedT = state.phases.find(phase => phase.name === 'produced')?.t ?? Number.POSITIVE_INFINITY
    const inDrainWindow = (t: number): boolean =>
      t >= producedT - 50 && t <= producedT + 700

    let worstDrainDv = 0
    let drainPrevV: number | null = null
    // The fold is ONE intentional, anchor-compensated layout commit; residual
    // sub-line taps inside its 150ms settle are its bounded cost, not drift.
    const foldedAt = state.phases.find(phase => phase.name === 'folded')?.t ?? Number.POSITIVE_INFINITY
    const inFoldSettle = (t: number): boolean => t >= foldedAt - 5 && t <= foldedAt + 150
    // Completion settle window: producer-complete through drain-done. The
    // bounded finish — think glide-down, bounded drain reveal, status morph —
    // is engineered settling, not instability; mid-stream stays strict and
    // quiescence guards what comes after.
    const drainedAt = state.phases.find(p => p.name === 'drained')?.t ?? producedT
    const inCompletionSettle = (t: number): boolean =>
      t >= producedT - 10 && t <= Math.max(drainedAt, producedT) + 150

    // Single-frame visual regressions per probe. Downward advances of the
    // tail / status edges up to one line are legitimate reveal growth;
    // EVERYTHING else past the limits is a visible step.
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1]!
      const current = samples[index]!
      if (current.t < warmupUntil) continue
      // No scroll room right now (fold collapsed the flow below the
      // viewport): nothing exists to compensate with.
      if (current.top <= 0 || current.height - current.client <= 1) continue
      if (current.t >= unpinnableFromT || inFoldSettle(current.t) || inCompletionSettle(current.t)) continue
      if (current.dt > LIMITS.stallMs || previous.dt > LIMITS.stallMs) continue
      const draining = inDrainWindow(current.t)
      for (const probe of ['head', 'mid', 'tail', 'status'] as const) {
        const delta = current[probe] - previous[probe]
        if (!Number.isFinite(delta) || Math.abs(delta) < 0.7) continue
        if (draining && (probe === 'head' || probe === 'mid') && delta < 0) {
          // Fast upward scroll inside the drain window: judge continuity.
          const v = delta / (current.dt / 1000)
          if (drainPrevV !== null) {
            const dv = Math.abs(v - drainPrevV)
            if (dv > worstDrainDv) worstDrainDv = dv
            if (dv > LIMITS.drainDvPxPerSec) {
              push('velocity-step', current.t, `drain velocity stepped ${(dv / 1000).toFixed(2)}k px/s`, index)
            }
          }
          drainPrevV = v
          continue
        }
        const growthEdge = (probe === 'tail' || probe === 'status') && delta > 0
        const allowed = growthEdge ? LIMITS.tailDownPx : LIMITS.movePx
        if (Math.abs(delta) > allowed) {
          push(
            'jump',
            current.t,
            `${probe} moved ${delta.toFixed(1)}px in one frame (top ${current.top.toFixed(0)})`,
            index,
          )
        }
      }
    }

    // Upward motion of the tail while content exists below = pinned-content
    // regression (the flicker signature). The spring's smooth closing glide
    // legitimately drifts the tail upward a few px per frame; only an ABRUPT
    // upward step (more than half a line in one frame) is instability.
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1]!
      const current = samples[index]!
      if (current.t < warmupUntil || current.t >= unpinnableFromT || inFoldSettle(current.t) || inCompletionSettle(current.t) || current.dt > LIMITS.stallMs) continue
      const tailUp = Number.isFinite(current.tail) && current.tail < previous.tail - LIMITS.abruptUpPx
      if (tailUp) {
        push(
          'regression',
          current.t,
          `tail snapped UP ${(previous.tail - current.tail).toFixed(1)}px in one frame`,
          index,
        )
      }
    }

    // Velocity continuity of the head probe, reported as a diagnostic.
    let worstDv = 0
    let previousV: number | null = null
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1]!
      const current = samples[index]!
      const dtSeconds = current.dt / 1000
      if (dtSeconds <= 0 || dtSeconds > LIMITS.stallMs / 1000) { previousV = null; continue }
      const v = (current.head - previous.head) / dtSeconds
      if (previousV !== null) {
        const dv = Math.abs(v - previousV)
        if (dv > worstDv) worstDv = dv
      }
      previousV = v
    }

    let longFrames = 0
    for (const sample of samples) {
      if (sample.dt > LIMITS.longFrameMs) longFrames += 1
    }

    // Quiescence: nothing may move after the final phase marker + 400ms.
    // The completion settle's final glide (收尾归位) is the designed
    // exception: the engine hands its retired space back to the layout at a
    // bounded rate, so the whole column translates downward with the
    // viewport (every probe moves by −ΔscrollTop together, st sinking at ≤
    // the paint-step bound). Motion WITHIN the layout while the viewport
    // stands still remains a violation.
    const lastPhaseT = state.phases.at(-1)?.t ?? 0
    const quietFrom = lastPhaseT + 400
    let quietChecked = false
    for (let index = 1; index < samples.length; index += 1) {
      const current = samples[index]!
      if (current.t < quietFrom) continue
      quietChecked = true
      const previous = samples[index - 1]!
      const stDelta = current.top - previous.top
      const viewportGliding = stDelta < -0.5 && stDelta >= -12
      for (const probe of ['head', 'mid', 'tail', 'status'] as const) {
        const delta = Math.abs(current[probe] - previous[probe])
        if (Number.isFinite(delta) && delta > LIMITS.quietMovePx) {
          const probeDocDelta = current[probe] - previous[probe]
          const withGlide = viewportGliding && Math.abs(probeDocDelta + stDelta) <= LIMITS.quietMovePx
          // The settle's extent-preserving transfer glides the status row UP
          // to close the reserve gap (收尾归位): bounded upward chrome motion
          // is the designed return, not drift.
          const statusReturn = probe === 'status' && probeDocDelta < 0 && probeDocDelta >= -12
          if (!withGlide && !statusReturn) {
            push('quiescence-move', current.t, `${probe} moved ${delta.toFixed(1)}px after settle`, index)
          }
        }
      }
    }

    // Designed-transition CLS windows, excluded from incidents:
    //  - the think disclosure auto-collapse (already excluded by source);
    //  - the auto-collapse FOLD commit at turn end — one intentional,
    //    anchor-compensated reflow that is the feature itself;
    //  - the produced→drain onset when the think collapse + first drain
    //    reveal land.
    const producedCommitFrom = (state.phases.find(p => p.name === 'produced')?.t ?? -Infinity) - 5
    const foldedCommitFrom = (state.phases.find(p => p.name === 'folded')?.t ?? Infinity) - 5
    const inFoldCommit = (t: number): boolean => t >= foldedCommitFrom && t <= foldedCommitFrom + 205
    const inProducedCommit = (t: number): boolean => t >= producedCommitFrom && t <= producedCommitFrom + 145
    const significantShifts = state.shifts.filter(shift =>
      shift.value >= LIMITS.shiftValue
      && shift.t >= warmupUntil
      && !(shift.sources.some(source => source.includes('disclosure'))
        || inFoldCommit(shift.t) || inProducedCommit(shift.t)))
    for (const shift of significantShifts) {
      push('layout-shift', shift.t, `value=${shift.value.toFixed(4)} sources=${shift.sources.join(', ')}`, -1)
    }
    const designedCollapseShifts = state.shifts.filter(shift =>
      shift.value >= LIMITS.shiftValue
      && shift.sources.some(source => source.includes('disclosure')))

    // Compact diagnostic timeline of the first second (ownership decision
    // window) — every frame's geometry + engine ownership bits.
    const timeline: string[] = []
    const startedAt = startedT
    for (const sample of samples) {
      if (sample.t < startedAt || sample.t > startedAt + 1200) continue
      timeline.push(
        `${Math.round(sample.t - startedAt)}ms st=${sample.top.toFixed(0)} fl=${(sample.height - sample.client).toFixed(0)} sh=${sample.height.toFixed(0)} `
        + `rw=${sample.runway.toFixed(0)} sft=${sample.shift.toFixed(1)} rsv=${sample.reserve.toFixed(0)} scale=${sample.revealScale.toFixed(2)} tail=${sample.tail.toFixed(0)}`,
      )
    }

    // Context windows around the first few incidents per kind, so every
    // violation is attributable to engine state at that moment.
    const context: Record<string, string[]> = {}
    for (const anchor of anchors) {
      context[anchor.kind] ??= []
      if (context[anchor.kind]!.length >= 3 || anchor.index < 0) continue
      const from = Math.max(1, anchor.index - 3)
      const to = Math.min(samples.length, anchor.index + 3)
      const lines: string[] = []
      for (let index = from; index < to; index += 1) {
        const sample = samples[index]!
        lines.push(
          `t+${Math.round(sample.t - violations.find(v => v.t === samples[anchor.index]?.t)!.t)} `
          + `head=${sample.head.toFixed(1)} mid=${Number.isFinite(sample.mid) ? sample.mid.toFixed(1) : '-'} tail=${sample.tail.toFixed(1)} stat=${Number.isFinite(sample.status) ? sample.status.toFixed(1) : '-'}`
          + ` top=${sample.top.toFixed(0)}`
          + engineLine(sample),
        )
      }
      context[anchor.kind]!.push(lines.join('\n'))
    }

    return {
      samples: samples.length,
      shifts: state.shifts.length,
      significantShiftCount: significantShifts.length,
      designedCollapseShiftCount: designedCollapseShifts.length,
      unpinnableFromT: Number.isFinite(unpinnableFromT) ? Math.round(unpinnableFromT) : null,
      longFrames,
      worstDv: Math.round(worstDv),
      quietChecked,
      phases: state.phases,
      violations,
      context,
      events: (globalThis as typeof globalThis & { __dshssFollowAudit?: Array<{ t: number; e: string; info?: unknown }> }).__dshssFollowAudit ?? [],
      endWindow: (() => {
        const producedT = state.phases.find(phase => phase.name === 'produced')?.t ?? 0
        return samples
          .filter(sample => sample.t >= producedT - 100 && sample.t <= producedT + 900)
          .map(sample => `${Math.round(sample.t - producedT)}ms head=${sample.head.toFixed(1)} tail=${sample.tail.toFixed(1)} stat=${Number.isFinite(sample.status) ? sample.status.toFixed(1) : '-'} top=${sample.top.toFixed(0)} h=${(sample.height - sample.client).toFixed(0)} sft=${sample.shift.toFixed(1)} ssft=${Number.isFinite(sample.statusShift) ? sample.statusShift.toFixed(1) : '-'} rw=${sample.runway.toFixed(0)} lag=${sample.lag.toFixed(0)}`)
          .join('\n')
      })(),
      applySlices: (() => {
        const log = (globalThis as typeof globalThis & { __dshssApplyLog?: string[] }).__dshssApplyLog ?? []
        const snapTs = violations.filter(v => v.kind === 'regression').slice(0, 2).map(v => v.t)
        return snapTs.map(t => log
          .map(line => ({ line, dt: Number(line.match(/t=(\d+)/)?.[1] ?? 0) - t }))
          .filter(entry => Math.abs(entry.dt) <= 80)
          .map(entry => `${entry.dt}ms ${entry.line}`)
          .join('\n'))
      })(),
      visSlices: (() => {
        const log = (globalThis as typeof globalThis & { __dshssVisLog?: Array<{ t: number; s: string }> }).__dshssVisLog ?? []
        const jumpTs = violations.filter(v => v.kind === 'jump').slice(0, 2).map(v => v.t)
        return jumpTs.map(t => {
          const window = log.filter(entry => Math.abs(entry.t - t) <= 180)
          return window.map(entry => `${Math.round(entry.t - t)}ms ${entry.s}`).join('\n')
        })
      })(),
      timeline,
    }
  }

  window.__auditReset()
}

declare global {
  interface Window {
    __start: (id: string, overrides?: Partial<AuditProfile>) => void
    __report: () => unknown
    __auditReset: () => void
    __auditPhase: (name: string) => void
    __debugState?: () => ReturnType<typeof debugRuntime.getSnapshot>['metrics'] | undefined
    __reportReady?: boolean
    __shiftObserver?: PerformanceObserver
  }
}

installAudit()
createRoot(document.getElementById('app')!).render(<HostConversation />)
