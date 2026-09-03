import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Suspense,
  StrictMode,
  createElement,
  memo,
  startTransition,
  useLayoutEffect,
  useRef,
  useState,
  type FunctionComponent,
} from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { TypewriterAssistantNodeView } from '../src/client/TypewriterAssistantNodeView.tsx'
import {
  computeFollowRevealScale,
  computeFollowReserve,
  computeFollowStep,
  computeFollowTrajectoryStep,
  FOLLOW_PAINT_GUARD_PX,
  FOLLOW_SETTLE_EPSILON_PX,
  FOLLOW_SPEED_REF_CPS,
  FOLLOW_STATUS_RUNWAY_PX,
  FOLLOW_RESERVE_MIN_PX,
  FollowRevealPhaseTracker,
  useConversationFollow,
} from '../src/client/teleprompterGlide.ts'
import {
  BACKLOG_CHAR_CEILING,
  BACKLOG_SECOND_CEILING,
  PRESET_CONFIG,
  computeAdaptiveQueueStep,
  computeCompletionDrain,
  computeQueueReveal,
  computeSettleDrain,
  useSmoothStreamContent,
} from '../src/client/useSmoothStreamContent.ts'
import { apply, inject } from '../src/client/index.ts'
import { isFollowableChatNode, isGrowingChatNode, wrapFollowNodeView } from '../src/client/TypewriterToolNodeView.tsx'
import { DEFAULT_STREAM_CONFIG, STREAM_BOOT_GLOBAL } from '../src/config.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'
import { debugRuntime } from '../src/client/debugRuntime.ts'
import { Config } from '../src/plugin.ts'
import { useProgressiveDomText } from '../src/client/useProgressiveDomText.ts'
import css from '../src/client/TypewriterAssistantNodeView.module.css'
import entranceCss from '../src/client/AgentRowEntrance.module.css'

const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] as const

afterEach(() => {
  cleanup()
  debugRuntime.resetRuntime()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function assistantProps(
  status: 'running' | 'settled',
  blocks: unknown[],
): Parameters<typeof TypewriterAssistantNodeView>[0] {
  return {
    node: {
      kind: 'assistant-step',
      location: { kind: 'unresolved' },
      data: { status, blocks, turn: 1, step: 1, time: 0 },
    },
    useTurnData: () => undefined,
    openFile: () => {},
    fileMentions: () => undefined,
    t: (key: string) => key,
  } as unknown as Parameters<typeof TypewriterAssistantNodeView>[0]
}

function currentTranslate(element: HTMLElement): number {
  return Number(
    /translate3d\(0(?:px)?,\s*(-?[\d.]+)px,\s*0(?:px)?\)/.exec(element.style.transform)?.[1] ?? 0,
  )
}

function SmoothProbe({
  text,
  inputComplete,
  shouldHoldBack,
  steadyCps,
  revealScaleRef,
  speedCpsRef,
  revealedCharsRef,
  onRevealCommit,
}: {
  text: string
  inputComplete?: boolean
  shouldHoldBack?: () => boolean
  steadyCps?: number
  revealScaleRef?: { current: number }
  speedCpsRef?: { current: number }
  revealedCharsRef?: { current: number }
  onRevealCommit?: () => void
}) {
  const displayed = useSmoothStreamContent(text, {
    inputComplete: inputComplete ?? false,
    shouldHoldBack,
    steadyCps,
    revealScaleRef,
    speedCpsRef,
    revealedCharsRef,
    onRevealCommit,
  })
  return <span>{displayed}</span>
}

function FollowProbe({
  active = true,
  controlScroll = true,
  speedCps = FOLLOW_SPEED_REF_CPS,
  revealScaleRef,
}: {
  active?: boolean
  controlScroll?: boolean
  speedCps?: number
  revealScaleRef?: { current: number }
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const speedCpsRef = useRef(speedCps)
  speedCpsRef.current = speedCps
  useConversationFollow(rootRef, active, speedCpsRef, revealScaleRef, true, false, undefined, undefined, undefined, undefined, controlScroll)
  return <div ref={rootRef} data-chat-transcript>Streaming response</div>
}

function FollowTooltipProbe() {
  const rootRef = useRef<HTMLDivElement>(null)
  const speedCpsRef = useRef(600)
  useConversationFollow(rootRef, true, speedCpsRef)
  return (
    <div ref={rootRef} data-tooltip-probe>
      <span>user message</span>
      <span>
        <Tooltip label="Copy" side="bottom">
          <button type="button">copy</button>
        </Tooltip>
      </span>
    </div>
  )
}

function ProgressiveDomProbe({ text }: { text: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const speedCpsRef = useRef(35)
  useProgressiveDomText(rootRef, true, true, speedCpsRef)
  return <div ref={rootRef}>{text}</div>
}

function FollowToggleProgressiveDomProbe({ enabled, text }: { enabled: boolean; text: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const speedCpsRef = useRef(35)
  useProgressiveDomText(rootRef, enabled, true, speedCpsRef)
  return <div ref={rootRef}>{text}</div>
}

function CompetingFollowProbe({ secondary }: { secondary: boolean }) {
  const primaryRef = useRef<HTMLDivElement>(null)
  const secondaryRef = useRef<HTMLDivElement>(null)
  const primarySpeedRef = useRef(FOLLOW_SPEED_REF_CPS)
  const secondarySpeedRef = useRef(FOLLOW_SPEED_REF_CPS)
  useConversationFollow(primaryRef, true, primarySpeedRef)
  useConversationFollow(secondaryRef, secondary, secondarySpeedRef, undefined, false, secondary)
  return (
    <div data-chat-transcript>
      <div ref={primaryRef}>assistant</div>
      <div ref={secondaryRef}>agent row</div>
    </div>
  )
}

function ShortLivedFollowProbe() {
  const rootRef = useRef<HTMLDivElement>(null)
  const speedCpsRef = useRef(FOLLOW_SPEED_REF_CPS)
  const [active, setActive] = useState(true)
  useLayoutEffect(() => {
    const port = rootRef.current?.closest<HTMLElement>('[data-conversation-scroll]')
    if (port === null || port === undefined) return
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
  }, [])
  useConversationFollow(rootRef, active, speedCpsRef)
  useLayoutEffect(() => { setActive(false) }, [])
  return <div ref={rootRef} data-chat-transcript>final committed height</div>
}

describe('useSmoothStreamContent', () => {
  it('publishes only the character count that has committed to the display', async () => {
    const revealedCharsRef = { current: -1 }
    const commitCounts: number[] = []
    const content = 'x'.repeat(100)
    const view = render(
      <SmoothProbe
        text={content}
        steadyCps={25}
        revealedCharsRef={revealedCharsRef}
        onRevealCommit={() => { commitCounts.push(revealedCharsRef.current) }}
      />,
    )
    expect(revealedCharsRef.current).toBe(0)

    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(revealedCharsRef.current).toBe(view.container.textContent?.length)
    expect(revealedCharsRef.current).toBeGreaterThan(0)
    expect(revealedCharsRef.current).toBeLessThan(content.length)
    expect(commitCounts.every(count => count === view.container.textContent?.length)).toBe(true)
  })

  beforeEach(() => vi.useFakeTimers({ toFake: [...FAKE] }))

  it('queues content already present on the first streaming render', async () => {
    const content = 'fast provider batch '.repeat(20)
    const view = render(<SmoothProbe text={content} />)

    expect(view.container.textContent).toBe('')
    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(view.container.textContent?.length).toBeGreaterThan(0)
    expect(view.container.textContent?.length).toBeLessThan(content.length)
    await act(() => vi.advanceTimersByTimeAsync(8000))
    expect(view.container.textContent).toBe(content)
  })

  it('reveals an appended stream progressively instead of dumping it', async () => {
    const view = render(<SmoothProbe text="" />)
    view.rerender(<SmoothProbe text={'x'.repeat(40)} />)

    expect(view.container.textContent).toBe('')
    await act(() => vi.advanceTimersByTimeAsync(120))
    const partial = view.container.textContent?.length ?? 0
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(40)

    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(view.container.textContent).toBe('x'.repeat(40))
  })

  it('integrates the pressure queue on each 120Hz frame', () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const view = render(<SmoothProbe text="" />)

    try {
      view.rerender(<SmoothProbe text="xxx" />)
      act(() => frames.shift()?.(0))
      act(() => frames.shift()?.(1000 / 120))
      expect(view.container.textContent).toBe('')
      act(() => frames.shift()?.(2000 / 120))
      expect(view.container.textContent).toHaveLength(1)
      act(() => frames.shift()?.(3000 / 120))
      expect(view.container.textContent).toHaveLength(2)
    } finally {
      view.unmount()
      requestFrame.mockRestore()
    }
  })

  it('slows the pressure queue while the follow spring needs paint headroom', async () => {
    const revealScaleRef = { current: 0.55 }
    const throttled = render(<SmoothProbe text={'x'.repeat(600)} revealScaleRef={revealScaleRef} />)
    await act(() => vi.advanceTimersByTimeAsync(1000))
    const throttledCount = throttled.container.textContent?.length ?? 0
    throttled.unmount()

    const unrestricted = render(<SmoothProbe text={'x'.repeat(600)} />)
    await act(() => vi.advanceTimersByTimeAsync(1000))
    const unrestrictedCount = unrestricted.container.textContent?.length ?? 0

    expect(throttledCount).toBeGreaterThan(100)
    expect(throttledCount).toBeLessThan(unrestrictedCount * 0.7)
  })

  it('drains a producer-complete tail at bounded speed without live backpressure', async () => {
    // The old contract published the whole accumulated source in one commit:
    // a fast stream ending with standing backlog teleported hundreds of px
    // in a single frame. The tail now closes at a bounded, ramped constant
    // velocity — never teleporting, never dragging an exponential tail.
    const revealScaleRef = { current: 0.55 }
    const content = 'x'.repeat(300)
    const view = render(
      <SmoothProbe text={content} revealScaleRef={revealScaleRef} />,
    )
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(view.container.textContent?.length).toBeLessThan(content.length)

    view.rerender(
      <SmoothProbe text={content} inputComplete revealScaleRef={revealScaleRef} />,
    )
    // No single-commit teleport: the drain needs at least one frame.
    expect(view.container.textContent?.length).toBeLessThan(content.length)
    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(view.container.textContent).toBe(content)
  })

  it('drains a large producer-complete tail near its configured deadline', async () => {
    const content = 'x'.repeat(2000)
    const view = render(<SmoothProbe text={content} />)
    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(view.container.textContent?.length).toBeLessThan(content.length / 4)

    view.rerender(<SmoothProbe text={content} inputComplete />)
    expect(view.container.textContent?.length).toBeLessThan(content.length)
    // Completion has its own deadline budget and may exceed the live-stream
    // speed ceiling, while the ramp still prevents a single-commit teleport.
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(view.container.textContent).toBe(content)
  })

  it('reveals at the steady rate while input streams and drains at 1.8x after', async () => {
    const view = render(<SmoothProbe text="" steadyCps={25} />)
    view.rerender(<SmoothProbe text={'x'.repeat(100)} steadyCps={25} />)
    // One commit per available frame: several glyphs land, far below the input.
    await act(() => vi.advanceTimersByTimeAsync(200))
    const partial = view.container.textContent?.length ?? 0
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(40)
    // After the (fake) stream goes idle and settling kicks in, the 1.8x
    // drain clears the remaining backlog quickly but not instantly.
    await act(() => vi.advanceTimersByTimeAsync(2500))
    expect(view.container.textContent).toBe('x'.repeat(100))
  })

  it('keeps up with a fast chunked arrival instead of trailing at the old 72cps cap', async () => {
    const view = render(<SmoothProbe text="" />)
    view.rerender(<SmoothProbe text={'x'.repeat(20)} />)
    await act(() => vi.advanceTimersByTimeAsync(40))
    view.rerender(<SmoothProbe text={'x'.repeat(40)} />)
    await act(() => vi.advanceTimersByTimeAsync(40))
    view.rerender(<SmoothProbe text={'x'.repeat(60)} />)
    await act(() => vi.advanceTimersByTimeAsync(40))
    view.rerender(<SmoothProbe text={'x'.repeat(80)} />)
    await act(() => vi.advanceTimersByTimeAsync(80))
    const partial = view.container.textContent?.length ?? 0
    // 80 chars over ~200ms is 400 cps arrival. The old maxCps=72 cap would
    // have revealed ~15 chars; keep-up must be well past that.
    expect(partial).toBeGreaterThan(25)
    expect(partial).toBeLessThanOrEqual(80)
  })

  it('queues a large append instead of dumping it', async () => {
    const view = render(<SmoothProbe text="" />)
    view.rerender(<SmoothProbe text={'x'.repeat(240)} />)
    await act(() => vi.advanceTimersByTimeAsync(120))
    const partial = view.container.textContent?.length ?? 0
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(240)
    await act(() => vi.advanceTimersByTimeAsync(8000))
    expect(view.container.textContent).toBe('x'.repeat(240))
  })

  it('holds back the DOM commit while the guard vetoes and flushes after', async () => {
    let hold = true
    const view = render(<SmoothProbe text="" shouldHoldBack={() => hold} />)
    view.rerender(<SmoothProbe text="hello world" shouldHoldBack={() => hold} />)

    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(view.container.textContent).toBe('')

    hold = false
    view.rerender(<SmoothProbe text="hello world" shouldHoldBack={() => hold} />)
    await act(() => vi.advanceTimersByTimeAsync(1200))
    expect(view.container.textContent).toBe('hello world')
  })

  it('returns the shared reveal speed to idle when its queue drains', async () => {
    const speedCpsRef = { current: 35 }
    const view = render(<SmoothProbe text={'x'.repeat(300)} speedCpsRef={speedCpsRef} />)
    await act(() => vi.advanceTimersByTimeAsync(160))
    expect(speedCpsRef.current).toBeGreaterThan(PRESET_CONFIG.balanced.defaultCps)

    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(view.container.textContent).toBe('x'.repeat(300))
    expect(speedCpsRef.current).toBe(PRESET_CONFIG.balanced.defaultCps)
  })
})

describe('assistant renderer', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: [...FAKE] }))

  it('does not jump the visible transcript when one new line lands', async () => {
    let baseHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe speedCps={100} />
        <div data-chat-turn-status role="status">Deep diving...</div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 - (Number.parseFloat(status.style.marginTop) || 0) + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 122 } as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 176 } as DOMRect)

    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(600))
    const before = -port.scrollTop + currentTranslate(transcript)

    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    const after = -port.scrollTop + currentTranslate(transcript)

    expect(Math.abs(after - before)).toBeLessThanOrEqual(4)
  })

  it('holds a surface untransformed while a fixed tooltip is open, then resumes shifting', async () => {
    let baseHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe speedCps={600} />
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight,
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 176 } as DOMRect)

    // Without a tooltip the follow shift applies to the surface directly.
    const bubble = document.createElement('span')
    bubble.textContent = 'user message'
    transcript.replaceChildren(bubble)
    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(240))
    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    const shiftedWithoutTooltip = currentTranslate(transcript)
    expect(shiftedWithoutTooltip).toBeGreaterThan(0)

    // While an open fixed tooltip lives on the surface the guard holds it
    // untransformed: no transform becomes the tooltip's fixed containing
    // block, so the bubble keeps viewport coordinates and the tooltip stays
    // glued to its anchor.
    const actions = document.createElement('span')
    const copy = document.createElement('button')
    copy.textContent = 'copy'
    const tooltip = document.createElement('span')
    tooltip.setAttribute('role', 'tooltip')
    tooltip.textContent = 'Copy'
    actions.append(copy, tooltip)
    transcript.append(actions)
    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(transcript.style.transform).toBe('')
    expect(currentTranslate(transcript)).toBe(0)
    expect(currentTranslate(bubble)).toBe(0)
    expect(tooltip.style.transform).toBe('')

    // Once the tooltip closes, the next follow frame resumes the shift.
    tooltip.remove()
    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(currentTranslate(transcript)).toBeGreaterThan(0)
  })

  it('does not reset the conversation when the real Tooltip mounts on hover', async () => {
    let baseHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="user">
            <FollowTooltipProbe />
          </div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const surface = view.container.querySelector('[data-chat-anchor-key="user"]') as HTMLElement
    const transcript = view.container.querySelector('[data-tooltip-probe]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight,
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 176 } as DOMRect)

    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(240))
    const beforeTop = port.scrollTop
    const message = view.getByText('user message')
    const visualPosition = (): number => (
      -port.scrollTop
        + currentTranslate(surface)
        + currentTranslate(transcript)
        + currentTranslate(message)
    )
    const beforeHover = visualPosition()
    const button = view.getByRole('button', { name: 'copy' })
    fireEvent.mouseEnter(button)
    expect(view.container.querySelector('[role="tooltip"]')).not.toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(visualPosition()).toBeCloseTo(beforeHover, 5)
    expect(surface.style.transform).toBe('')
    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))

    expect(port.scrollTop).toBeGreaterThanOrEqual(beforeTop)
    expect(port.scrollTop).toBeLessThanOrEqual(baseHeight - port.clientHeight)
    expect(transcript.style.transform).toBe('')
    expect(view.container.querySelector('[role="tooltip"]')?.getAttribute('role')).toBe('tooltip')
    expect((view.container.querySelector('[role="tooltip"]') as HTMLElement).style.transform).toBe('')
  })

  for (const scenario of [
    { speedCps: 300, wrapIntervalMs: 192, maxDisplacementPx: 4 },
    { speedCps: 600, wrapIntervalMs: 96, maxDisplacementPx: 8 },
  ]) {
    it(`keeps ${scenario.speedCps}cps wrap frames within the continuous-motion limit`, async () => {
      let baseHeight = 500
      const view = render(
        <div data-conversation-scroll>
          <FollowProbe speedCps={scenario.speedCps} />
          <div data-composer-seat>Composer</div>
        </div>,
      )
      const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
      const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
      const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
      Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
      Object.defineProperty(port, 'scrollHeight', {
        configurable: true,
        get: () => baseHeight + (Number.parseFloat(transcript.style.marginBottom) || 0),
      })
      vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
        top: 0,
        bottom: 80 - (Number.parseFloat(transcript.style.marginBottom) || 0) + currentTranslate(transcript),
      }) as DOMRect)
      vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 176 } as DOMRect)

      port.scrollTop = 400
      await act(() => vi.advanceTimersByTimeAsync(240))

      for (let index = 0; index < 20; index += 1) {
        const before = -port.scrollTop + currentTranslate(transcript)
        baseHeight += 28
        await act(() => vi.advanceTimersByTimeAsync(16))
        const floor = port.scrollHeight - port.clientHeight
        const after = -port.scrollTop + currentTranslate(transcript)
        expect(port.scrollTop).toBeCloseTo(floor, 5)
        expect(Math.abs(after - before)).toBeLessThanOrEqual(scenario.maxDisplacementPx)
        expect(transcript.getBoundingClientRect().bottom).toBeLessThan(96)
        await act(() => vi.advanceTimersByTimeAsync(scenario.wrapIntervalMs - 16))
      }

      view.unmount()
    })
  }

  it('applies live predictive-runway tuning while a reply is streaming', async () => {
    const baseHeight = 500
    debugRuntime.syncSettings({
      enabled: true,
      writable: true,
      dirty: false,
      status: 'ready',
      tuning: DEFAULT_STREAM_DEBUG_TUNING,
    })
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe speedCps={600} />
        <div data-chat-turn-status role="status">Deep diving...</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 - (Number.parseFloat(status.style.marginTop) || 0) + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 96 + runway, bottom: 122 + runway } as DOMRect
    })

    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(240))
    expect(Number.parseFloat(status.style.marginTop)).toBeCloseTo(72, 0)

    debugRuntime.syncSettings({
      enabled: true,
      writable: true,
      dirty: true,
      status: 'ready',
      tuning: { ...DEFAULT_STREAM_DEBUG_TUNING, runwayPx: 40 },
    })
    await act(() => vi.advanceTimersByTimeAsync(900))
    // Zero-downward-rebound contract: the follower pins scrollTop to the
    // floor and the floor rides the owned margin 1:1, so an owned margin is
    // never shrunk mid-ownership — a lower tuning cap only bounds future
    // growth. Retiring it here would clamp scrollTop downward and slide the
    // whole transcript down.
    expect(Number.parseFloat(status.style.marginTop)).toBeCloseTo(72, 0)
  })

  it('restores the transcript min-height when the follow host unmounts', async () => {
    const renderFollow = (active: boolean) => (
      <div data-conversation-scroll>
        <FollowProbe active={active} />
      </div>
    )
    const view = render(renderFollow(true))
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => Math.max(40, Number.parseFloat(transcript.style.minHeight) || 0),
    })

    await act(() => vi.advanceTimersByTimeAsync(32))
    expect(transcript.style.minHeight).toBe('100px')

    view.unmount()
    await act(() => vi.advanceTimersByTimeAsync(32))
    expect(transcript.style.minHeight).toBe('')
  })

  it('adds reveal backpressure before a narrow safe gap forces a hard catch-up', async () => {
    let baseHeight = 500
    const revealScaleRef = { current: 1 }
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe speedCps={600} revealScaleRef={revealScaleRef} />
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(transcript.style.marginBottom) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 - (Number.parseFloat(transcript.style.marginBottom) || 0) + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 82, bottom: 162 } as DOMRect)

    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(240))
    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))

    expect(revealScaleRef.current).toBeLessThan(0.75)
    expect(revealScaleRef.current).toBeGreaterThanOrEqual(0.55)
    expect(port.scrollTop).toBeCloseTo(port.scrollHeight - port.clientHeight, 5)
    expect(transcript.getBoundingClientRect().bottom).toBeLessThan(82)
  })

  it('keeps chrome clearance and bottom follow after a long main-thread stall', () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const cancelFrame = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined)
    let clockNow = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => clockNow)
    let baseHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe />
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(transcript.style.marginBottom) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 - (Number.parseFloat(transcript.style.marginBottom) || 0) + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 400, bottom: 480 } as DOMRect)

    const step = (advanceMs: number): void => {
      clockNow += advanceMs
      act(() => frames.shift()?.(clockNow))
    }

    try {
      port.scrollTop = 390
      step(0)
      for (let index = 0; index < 4; index += 1) {
        baseHeight += 28
        step(16)
      }
      // A 250ms stall while the stream kept growing: heavy markdown frames
      // stretch far past the 32ms spring clamp, and the follower must still
      // track growth measured in real time.
      baseHeight += 300
      step(250)
      for (let index = 0; index < 5; index += 1) {
        baseHeight += 5
        step(16)
        const floor = port.scrollHeight - port.clientHeight
        expect(port.scrollTop).toBeCloseTo(floor, 5)
        expect(transcript.getBoundingClientRect().bottom).toBeLessThan(400)
      }
    } finally {
      view.unmount()
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      clock.mockRestore()
    }
  })

  it('caps a dropped RAF interval so the first recovery paint does not teleport', () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const cancelFrame = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    let baseHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe />
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(transcript.style.marginBottom) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 - (Number.parseFloat(transcript.style.marginBottom) || 0) + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 400, bottom: 480 } as DOMRect)

    try {
      port.scrollTop = 390
      act(() => frames.shift()?.(0))
      const before = -port.scrollTop + currentTranslate(transcript)
      baseHeight = 700
      act(() => frames.shift()?.(100))

      const after = -port.scrollTop + currentTranslate(transcript)
      const springAdvance = computeFollowStep(32, {
        lag: 200,
        speedEma: FOLLOW_SPEED_REF_CPS,
      }).advancePx
      // Composer-only follow does not pre-open a runway at the 35cps neutral
      // seed; the clamped 32ms spring step is therefore the whole movement.
      expect(before - after).toBeCloseTo(springAdvance, 5)
    } finally {
      view.unmount()
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      clock.mockRestore()
    }
  })

  it('does not render a caret while streaming', () => {
    const block = { kind: 'text', text: 'hello' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
    expect(view.container.textContent).not.toContain('▍')
  })

  it('renders streaming text through Markdown without a raw-text tail', async () => {
    const block = { kind: 'text', text: '**finished**' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
    await act(() => vi.advanceTimersByTimeAsync(400))
    // The emphasis renders during streaming: no plain `**finished**` fallback.
    expect(view.getByText('finished').tagName).toBe('STRONG')
  })

  it('swaps to the settled full parse exactly once after the queue drains', async () => {
    const block = { kind: 'text', text: '**finished**' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
    view.rerender(<TypewriterAssistantNodeView {...assistantProps('settled', [block])} />)
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(view.getByText('finished').tagName).toBe('STRONG')
  })

  it('keeps the rendered Markdown DOM mounted when a drained stream settles', async () => {
    const block = { kind: 'text', text: '**finished**' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
    await act(() => vi.advanceTimersByTimeAsync(2000))
    const streamingNode = view.getByText('finished')

    view.rerender(<TypewriterAssistantNodeView {...assistantProps('settled', [block])} />)

    expect(view.getByText('finished')).toBe(streamingNode)
  })

  it('opens the built-in Think disclosure while reasoning streams', () => {
    const block = { kind: 'reasoning', text: 'first line\nlatest tokens' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
    const row = view.container.querySelector('[data-disclosure-row]')
    expect(row).not.toBeNull()
    expect(row?.getAttribute('aria-expanded')).toBe('true')
    expect(view.container.querySelector('[data-variant="think"]')).not.toBeNull()
    expect(view.getByText('Think')).toBeTruthy()
    expect(view.container.querySelector('details')).toBeNull()
  })

  it('collapses the Think disclosure when the assistant node settles', () => {
    const block = { kind: 'reasoning', text: 'first line\n\nsecond' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
    expect(view.container.querySelector('[data-disclosure-row]')?.getAttribute('aria-expanded')).toBe('true')
    view.rerender(<TypewriterAssistantNodeView {...assistantProps('settled', [block])} />)
    expect(view.getByText('first line')).toBeTruthy()
    expect(view.container.querySelector('[data-disclosure-row]')?.getAttribute('aria-expanded')).toBe('false')
    // The animated body stays mounted while collapsed (hidden by the 0fr
    // track), so collapse is an assertion on the wrapper state, not absence.
    expect(view.container.querySelector('[data-disclosure-content]')?.hasAttribute('data-collapsed')).toBe(true)
  })

  it('snaps only the auto-close body, gliding manual toggles while streaming', () => {
    const block = { kind: 'reasoning', text: 'first line\n\nsecond' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
    // While the stream owns the disclosure, the body keeps its grid-track
    // transition (manual toggle glides).
    expect(view.container.querySelector('[data-disclosure-content]')?.hasAttribute('data-no-transition')).toBe(false)
    // The settle auto-close snaps: the follower's spring absorbs the height
    // step, and a grid animation on top would double-animate it.
    view.rerender(<TypewriterAssistantNodeView {...assistantProps('settled', [block])} />)
    expect(view.container.querySelector('[data-disclosure-content]')?.hasAttribute('data-no-transition')).toBe(true)
    fireEvent.click(view.container.querySelector('[data-disclosure-row]') as HTMLElement)
    expect(view.container.querySelector('[data-disclosure-content]')?.hasAttribute('data-no-transition')).toBe(false)
  })

  it('collapses the Think disclosure when a later block becomes the tail', () => {
    const think = { kind: 'reasoning', text: 'first line\n\nsecond' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [think])} />)
    expect(view.container.querySelector('[data-disclosure-row]')?.getAttribute('aria-expanded')).toBe('true')
    view.rerender(<TypewriterAssistantNodeView {...assistantProps('running', [
      think,
      { kind: 'text', text: 'the answer' },
    ])} />)
    expect(view.container.querySelector('[data-disclosure-row]')?.getAttribute('aria-expanded')).toBe('false')
    expect(view.getByText('first line')).toBeTruthy()
    expect(view.container.querySelector('[data-disclosure-content]')?.hasAttribute('data-collapsed')).toBe(true)
  })

  it('keeps a streaming Think visually still when its visible height does not grow', async () => {
    let text = 'examining'
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView
              {...assistantProps('running', [{ kind: 'reasoning', text }])}
              thinkAutoExpand={false}
            />
          </div>
          <div role="status">Deep diving...</div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[role="status"]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => 500 + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 128 + runway, bottom: 154 + runway } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)
    port.scrollTop = 390

    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(view.container.querySelector('[data-disclosure-row]')?.getAttribute('aria-expanded')).toBe('false')
    const visualPositions = [-port.scrollTop + currentTranslate(transcript)]
    for (let chunk = 0; chunk < 6; chunk += 1) {
      text += ` more reasoning ${String(chunk)}`
      view.rerender(
        <div data-conversation-scroll>
          <div data-chat-flow>
            <div data-chat-transcript>
              <TypewriterAssistantNodeView
                {...assistantProps('running', [{ kind: 'reasoning', text }])}
                thinkAutoExpand={false}
              />
            </div>
            <div role="status">Deep diving...</div>
          </div>
          <div data-composer-seat>Composer</div>
        </div>,
      )
      await act(() => vi.advanceTimersByTimeAsync(64))
      visualPositions.push(-port.scrollTop + currentTranslate(transcript))
    }

    expect(Math.max(...visualPositions) - Math.min(...visualPositions)).toBeLessThan(0.5)

    fireEvent.click(view.container.querySelector('[data-disclosure-row]') as HTMLElement)
    expect(view.container.querySelector('[data-disclosure-row]')?.getAttribute('aria-expanded')).toBe('true')
    const beforeExpandedIdle = -port.scrollTop + currentTranslate(transcript)
    await act(() => vi.advanceTimersByTimeAsync(192))
    expect(-port.scrollTop + currentTranslate(transcript)).toBeCloseTo(beforeExpandedIdle, 5)
  })

  it('keeps the streaming Think to Deep diving gap at the natural spacing', async () => {
    let text = 'examining'
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView
              {...assistantProps('running', [{ kind: 'reasoning', text }])}
              thinkAutoExpand
            />
          </div>
          <div role="status">Deep diving...</div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[role="status"]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => 500 + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 96 + runway, bottom: 122 + runway } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)
    port.scrollTop = 390

    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(view.container.querySelector('[data-disclosure-row]')?.getAttribute('aria-expanded')).toBe('true')
    const naturalGap = 16
    const gaps: number[] = []
    for (let chunk = 0; chunk < 8; chunk += 1) {
      text += ` more reasoning ${String(chunk)} ${'x'.repeat(80)}`
      view.rerender(
        <div data-conversation-scroll>
          <div data-chat-flow>
            <div data-chat-transcript>
              <TypewriterAssistantNodeView
                {...assistantProps('running', [{ kind: 'reasoning', text }])}
                thinkAutoExpand
              />
            </div>
            <div role="status">Deep diving...</div>
          </div>
          <div data-composer-seat>Composer</div>
        </div>,
      )
      await act(() => vi.advanceTimersByTimeAsync(64))
      gaps.push(status.getBoundingClientRect().top - transcript.getBoundingClientRect().bottom)
    }

    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(naturalGap - 1)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(naturalGap + 1)
  })

  it('limits an expanded Think wrap to the unavoidable safe catch-up', async () => {
    const lineHeight = 24
    const naturalGap = 16
    let naturalHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView
              {...assistantProps('running', [{ kind: 'reasoning', text: 'examining' }])}
              thinkAutoExpand
            />
          </div>
          <div role="status">Deep diving...</div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[role="status"]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => naturalHeight + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 96 + runway, bottom: 122 + runway } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 180, bottom: 260 } as DOMRect)
    port.scrollTop = 390

    await act(() => vi.advanceTimersByTimeAsync(480))
    const beforeWrap = -port.scrollTop + currentTranslate(transcript)
    naturalHeight += lineHeight
    await act(() => vi.advanceTimersByTimeAsync(16))
    const afterWrap = -port.scrollTop + currentTranslate(transcript)
    const catchUp = beforeWrap - afterWrap
    const unavoidableCatchUp = lineHeight - naturalGap + FOLLOW_PAINT_GUARD_PX

    expect(catchUp).toBeGreaterThanOrEqual(unavoidableCatchUp - 0.5)
    expect(catchUp).toBeLessThanOrEqual(unavoidableCatchUp + 0.5)
    expect(status.getBoundingClientRect().top - transcript.getBoundingClientRect().bottom)
      .toBeGreaterThanOrEqual(FOLLOW_PAINT_GUARD_PX - 0.1)
  })

  it('does not expose follow runway below Think before the port can scroll', async () => {
    const think = { kind: 'reasoning', text: 'exploring the current project' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="context"><span>Context injection</span></div>
          <div data-chat-anchor-key="tool"><span>Read README.md</span></div>
          <div data-chat-anchor-key="assistant">
            <TypewriterAssistantNodeView
              {...assistantProps('running', [think])}
              thinkAutoExpand={false}
            />
          </div>
          <div role="status">Deep diving...</div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const rows = view.container.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')
    const thinkRow = rows.item(rows.length - 1)
    const status = view.container.querySelector('[role="status"]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 800 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => 500 + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(thinkRow, 'getBoundingClientRect').mockImplementation(() => ({
      top: 76 + currentTranslate(thinkRow),
      bottom: 100 + currentTranslate(thinkRow),
      height: 24,
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 116 + runway, bottom: 142 + runway, height: 26 } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({
      top: 640,
      bottom: 800,
      height: 160,
    } as DOMRect)

    await act(() => vi.advanceTimersByTimeAsync(80))

    expect(port.scrollHeight).toBeLessThan(port.clientHeight)
    expect(status.getBoundingClientRect().top - thinkRow.getBoundingClientRect().bottom).toBeCloseTo(16, 1)
  })

  it('removes accumulated status runway left by an earlier plugin bundle', async () => {
    const think = { kind: 'reasoning', text: 'exploring the current project' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="context"><span>Context injection</span></div>
          <div data-chat-anchor-key="tool"><span>Read README.md</span></div>
          <div data-chat-anchor-key="assistant">
            <TypewriterAssistantNodeView
              {...assistantProps('running', [think])}
              thinkAutoExpand={false}
            />
          </div>
          <div role="status" style={{ marginTop: 'calc(calc(48px + 48px) + 48px)' }}>
            Deep diving...
          </div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const rows = view.container.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')
    const thinkRow = rows.item(rows.length - 1)
    const status = view.container.querySelector('[role="status"]') as HTMLElement
    const staleRunway = (): number => status.style.marginTop === ''
      ? 0
      : 3 * FOLLOW_STATUS_RUNWAY_PX
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 800 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => 500 + staleRunway(),
    })
    vi.spyOn(thinkRow, 'getBoundingClientRect').mockImplementation(() => ({
      top: 76 + currentTranslate(thinkRow),
      bottom: 100 + currentTranslate(thinkRow),
      height: 24,
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = staleRunway()
      return { top: 116 + runway, bottom: 142 + runway, height: 26 } as DOMRect
    })

    await act(() => vi.advanceTimersByTimeAsync(80))

    expect(status.style.marginTop).toBe('')
    expect(status.getBoundingClientRect().top - thinkRow.getBoundingClientRect().bottom).toBeCloseTo(16, 1)
  })

  it('normalizes accumulated status runway to one owned runway when scrollable', async () => {
    const think = { kind: 'reasoning', text: 'exploring the current project' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="assistant">
            <TypewriterAssistantNodeView
              {...assistantProps('running', [think])}
              thinkAutoExpand={false}
            />
          </div>
          <div role="status" style={{ marginTop: 3 * FOLLOW_STATUS_RUNWAY_PX }}>
            Deep diving...
          </div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const thinkRow = view.container.querySelector('[data-chat-anchor-key]') as HTMLElement
    const status = view.container.querySelector('[role="status"]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => 500 + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(thinkRow, 'getBoundingClientRect').mockImplementation(() => ({
      top: 56 + currentTranslate(thinkRow),
      bottom: 80 + currentTranslate(thinkRow),
      height: 24,
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 96 + runway, bottom: 122 + runway, height: 26 } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({
      top: 180,
      bottom: 260,
      height: 80,
    } as DOMRect)
    port.scrollTop = 534

    await act(() => vi.advanceTimersByTimeAsync(80))

    expect(status.style.marginTop).toBe(`${String(FOLLOW_STATUS_RUNWAY_PX)}px`)
    expect(status.getBoundingClientRect().top - thinkRow.getBoundingClientRect().bottom).toBeCloseTo(16, 1)
  })

  it('removes accumulated message runway left after turn status unmounts', async () => {
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div
            data-chat-anchor-key="assistant"
            style={{ marginBottom: 'calc(calc(48px + 48px) + 48px)' }}
          >
            <TypewriterAssistantNodeView
              {...assistantProps('running', [{ kind: 'text', text: 'final answer' }])}
            />
          </div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const assistantRow = view.container.querySelector('[data-chat-anchor-key]') as HTMLElement
    const staleRunway = (): number => assistantRow.style.marginBottom === ''
      ? 0
      : 3 * FOLLOW_STATUS_RUNWAY_PX
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 800 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => 500 + staleRunway(),
    })

    await act(() => vi.advanceTimersByTimeAsync(80))

    expect(port.scrollHeight).toBe(500)
    expect(assistantRow.style.marginBottom).toBe('')
  })

  it('does not flash the conversation port to the top when Think yields to new text', async () => {
    const think = { kind: 'reasoning', text: 'working through the details' }
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('running', [think])} />
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.scrollTop).toBe(400)

    // Reasoning ends as a large text block arrives. Before the fix, the
    // outgoing Think owner handed its stale lag to the still-running root
    // owner: 400 - (1200 - 500) clamps to 0 for one rendered frame.
    height = 1200
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('running', [
            think,
            { kind: 'text', text: 'the answer '.repeat(100) },
          ])} />
        </div>
      </div>,
    )

    // The owner survives the content-type handoff and approaches each new
    // floor without an intermediate write toward zero.
    for (const collapsingHeight of [1200, 1100, 1000, 900]) {
      height = collapsingHeight
      await act(() => vi.advanceTimersByTimeAsync(16))
      expect(port.scrollTop).toBeGreaterThan(0)
      expect(port.scrollTop).toBeLessThanOrEqual(collapsingHeight - 100)
    }
  })

  it('does not pre-scroll and rebound when Think yields to a short same-line answer', async () => {
    const think = { kind: 'reasoning', text: 'done thinking' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView
              {...assistantProps('running', [think])}
              thinkAutoExpand={false}
            />
          </div>
          <div role="status">Deep diving...</div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[role="status"]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => 500 + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 0, bottom: 80 - runway + currentTranslate(transcript) } as DOMRect
    })
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 128 + runway, bottom: 154 + runway } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(600))

    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView
              {...assistantProps('running', [think, { kind: 'text', text: 'Short answer.' }])}
              thinkAutoExpand={false}
            />
          </div>
          <div role="status">Deep diving...</div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )

    const visualPositions: number[] = []
    for (let frame = 0; frame < 40; frame += 1) {
      await act(() => vi.advanceTimersByTimeAsync(16))
      visualPositions.push(-port.scrollTop + currentTranslate(transcript))
    }

    // The answer fits the existing line, so there is no height impulse to
    // smooth. Any movement here is speculative scroll that must later return.
    expect(Math.max(...visualPositions) - Math.min(...visualPositions)).toBeLessThan(0.5)
  })

  it('still prepares runway when Think yields to text that will wrap', async () => {
    const think = { kind: 'reasoning', text: 'done thinking' }
    let baseHeight = 500
    const renderTurn = (blocks: unknown[]) => (
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView
              {...assistantProps('running', blocks)}
              thinkAutoExpand={false}
            />
          </div>
          <div role="status">Deep diving...</div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>
    )
    const view = render(renderTurn([think]))
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[role="status"]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 0, bottom: 80 - runway + currentTranslate(transcript) } as DOMRect
    })
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 128 + runway, bottom: 154 + runway } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(600))

    view.rerender(renderTurn([think, { kind: 'text', text: 'long answer '.repeat(80) }]))
    await act(() => vi.advanceTimersByTimeAsync(160))
    const beforeWrap = -port.scrollTop + currentTranslate(transcript)
    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    const afterWrap = -port.scrollTop + currentTranslate(transcript)

    expect(Math.abs(afterWrap - beforeWrap)).toBeLessThanOrEqual(8)
  })

  it('keeps the Think body mounted behind the animated 0fr track while collapsed', () => {
    const block = { kind: 'reasoning', text: 'first line\n\nsecond' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('settled', [block])} />)
    const content = view.container.querySelector('[data-disclosure-content]')
    // The height-animates substrate: the body is in the DOM (measurable for
    // the grid track) while the collapsed wrapper carries data-collapsed.
    expect(content).not.toBeNull()
    expect(content?.hasAttribute('data-collapsed')).toBe(true)
    expect(content?.querySelector(`.${css.thinkBody}`)?.textContent).toContain('second')
    fireEvent.click(view.container.querySelector('[data-disclosure-row]') as HTMLElement)
    expect(content?.hasAttribute('data-collapsed')).toBe(false)
  })

  it('expands the built-in Think row on click', async () => {
    const block = { kind: 'reasoning', text: 'first line\n\nsecond' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('settled', [block])} />)
    const row = view.container.querySelector('[data-disclosure-row]')
    expect(row).not.toBeNull()
    fireEvent.click(row as HTMLElement)
    expect(row?.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/second/)).toBeTruthy()
  })

  it('exposes one node-level announcement for multiple text blocks', async () => {
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'second' },
    ])} />)
    expect(view.container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)
    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe('first\nsecond')
  })

  it('announces streaming text in paced increments instead of rewriting the full response', async () => {
    const renderText = (text: string) => (
      <TypewriterAssistantNodeView {...assistantProps('running', [{ kind: 'text', text }])} />
    )
    const view = render(renderText(''))
    const liveRegion = view.container.querySelector('[aria-live="polite"]') as HTMLElement

    view.rerender(renderText('The first phrase'))
    view.rerender(renderText('The first phrase and the second phrase'))
    expect(liveRegion.textContent).toBe('')

    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(liveRegion.textContent).toBe('The first phrase and the second phrase')

    view.rerender(renderText('The first phrase and the second phrase, followed by a third.'))
    expect(liveRegion.textContent).toBe('The first phrase and the second phrase')
    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(liveRegion.textContent).toBe(', followed by a third.')
  })

  it('keeps announcement pacing alive through Strict Mode effect replay', async () => {
    const text = 'Strict Mode must not retire the scheduled announcement.'
    const view = render(
      <StrictMode>
        <TypewriterAssistantNodeView {...assistantProps('running', [{ kind: 'text', text }])} />
      </StrictMode>,
    )

    await act(() => vi.advanceTimersByTimeAsync(800))

    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe(text)
  })

  it('announces the unspoken tail when a reply finishes before the next interval', async () => {
    const text = 'A short reply that finishes before the first announcement interval.'
    const view = render(
      <TypewriterAssistantNodeView {...assistantProps('running', [{ kind: 'text', text }])} />,
    )
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe('')

    view.rerender(
      <TypewriterAssistantNodeView {...assistantProps('settled', [{ kind: 'text', text }])} />,
    )

    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe(text)
    await act(() => vi.advanceTimersByTimeAsync(799))
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe(text)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(view.container.querySelector('[aria-live="polite"]')).toBeNull()
  })

  it('flushes only the unspoken announcement tail when a longer reply finishes', async () => {
    const first = 'The already announced first phrase.'
    const tail = ' The final unspoken phrase.'
    const renderText = (status: 'running' | 'settled', text: string) => (
      <TypewriterAssistantNodeView {...assistantProps(status, [{ kind: 'text', text }])} />
    )
    const view = render(renderText('running', first))
    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe(first)

    view.rerender(renderText('running', first + tail))
    view.rerender(renderText('settled', first + tail))

    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe(tail)
  })

  it('keeps the previous text announcement alive when ownership moves to Think', async () => {
    const text = 'Answer text that arrived immediately before the reasoning block.'
    const view = render(
      <TypewriterAssistantNodeView {...assistantProps('running', [{ kind: 'text', text }])} />,
    )

    view.rerender(
      <TypewriterAssistantNodeView {...assistantProps('running', [
        { kind: 'text', text },
        { kind: 'reasoning', text: 'checking' },
      ])} />,
    )

    expect(view.container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)
    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe(text)
  })

  it('paces a long completion tail before retiring its live region', async () => {
    const text = 'x'.repeat(800)
    const renderText = (status: 'running' | 'settled') => (
      <TypewriterAssistantNodeView {...assistantProps(status, [{ kind: 'text', text }])} />
    )
    const view = render(renderText('running'))

    view.rerender(renderText('settled'))
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe('x'.repeat(320))

    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe('x'.repeat(320))
    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe('x'.repeat(160))
    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(view.container.querySelector('[aria-live="polite"]')).toBeNull()
  })

  it('does not mutate visible Markdown while completion announcements drain', async () => {
    const text = 'visible settled text '.repeat(40)
    const renderText = (status: 'running' | 'settled') => (
      <TypewriterAssistantNodeView {...assistantProps(status, [{ kind: 'text', text }])} />
    )
    const view = render(renderText('running'))
    view.rerender(renderText('settled'))
    // The completion tail drains at a bounded velocity instead of teleporting
    // the whole backlog into one paint, so let it finish before the static
    // window the announcer paces across.
    await act(() => vi.advanceTimersByTimeAsync(2500))
    const followHosts = view.container.querySelectorAll<HTMLElement>(`.${css.follow}`)
    const visibleMarkdown = followHosts.item(followHosts.length - 1)
    const visibleHtml = visibleMarkdown.innerHTML
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver(records => { mutations.push(...records) })
    observer.observe(visibleMarkdown, { characterData: true, childList: true, subtree: true })

    await act(() => vi.advanceTimersByTimeAsync(2000))
    await Promise.resolve()
    observer.disconnect()

    expect(followHosts.item(followHosts.length - 1)).toBe(visibleMarkdown)
    expect(visibleMarkdown.innerHTML).toBe(visibleHtml)
    expect(mutations).toHaveLength(0)
  })

  it('keeps draining the committed completion snapshot after inactive text changes', async () => {
    const completed = 'x'.repeat(800)
    const renderText = (text: string, status: 'running' | 'settled') => (
      <TypewriterAssistantNodeView {...assistantProps(status, [{ kind: 'text', text }])} />
    )
    const view = render(renderText(completed, 'running'))
    view.rerender(renderText(completed, 'settled'))
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe('x'.repeat(320))

    view.rerender(renderText('edited history', 'settled'))
    await act(() => vi.advanceTimersByTimeAsync(800))

    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe('x'.repeat(320))
  })

  it('does not let an abandoned concurrent render stop the committed announcement', async () => {
    const text = 'The committed stream remains active while a transition suspends.'
    const uncommitted = 'This text belongs only to the abandoned render.'
    let update: ((nextText: string, suspend: boolean) => void) | undefined
    const pending = new Promise<never>(() => {})
    function SuspendAfterAssistant({ suspend }: { suspend: boolean }) {
      if (suspend) throw pending
      return null
    }
    function ConcurrentProbe() {
      const [state, setState] = useState({ text, suspend: false })
      update = (nextText, suspend) => { setState({ text: nextText, suspend }) }
      return (
        <Suspense fallback={<span>pending</span>}>
          <TypewriterAssistantNodeView
            {...assistantProps('running', [{ kind: 'text', text: state.text }])}
          />
          <SuspendAfterAssistant suspend={state.suspend} />
        </Suspense>
      )
    }
    const view = render(<ConcurrentProbe />)

    await act(async () => {
      startTransition(() => { update?.(uncommitted, true) })
    })
    expect(view.container.textContent).not.toContain('pending')

    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe(text)
  })

  it('mutates the live region for consecutive announcement chunks with identical text', async () => {
    const chunk = 'x'.repeat(320)
    const renderText = (text: string) => (
      <TypewriterAssistantNodeView {...assistantProps('running', [{ kind: 'text', text }])} />
    )
    const view = render(renderText(chunk))
    await act(() => vi.advanceTimersByTimeAsync(800))
    const liveRegion = view.container.querySelector('[aria-live="polite"]') as HTMLElement
    expect(liveRegion.textContent).toBe(chunk)

    const mutations: MutationRecord[] = []
    const observer = new MutationObserver(records => { mutations.push(...records) })
    observer.observe(liveRegion, { characterData: true, childList: true, subtree: true })
    view.rerender(renderText(chunk + chunk))
    await act(() => vi.advanceTimersByTimeAsync(800))
    await Promise.resolve()
    observer.disconnect()

    expect(liveRegion.textContent).toBe(chunk)
    expect(mutations.length).toBeGreaterThan(0)
  })

  it('reuses visible-tail geometry across source chunks before the next reveal', () => {
    const renderText = (text: string) => (
      <TypewriterAssistantNodeView {...assistantProps('running', [{ kind: 'text', text }])} />
    )
    const view = render(renderText(''))
    const followHosts = view.container.querySelectorAll<HTMLElement>(`.${css.follow}`)
    const textFollowHost = followHosts.item(followHosts.length - 1)
    Object.defineProperty(textFollowHost, 'clientWidth', { configurable: true, value: 320 })
    vi.spyOn(textFollowHost, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 320,
      width: 320,
    } as DOMRect)
    const treeWalker = vi.spyOn(document, 'createTreeWalker')

    view.rerender(renderText('one'))
    view.rerender(renderText('one two'))
    view.rerender(renderText('one two three'))

    expect(treeWalker).toHaveBeenCalledTimes(1)
  })

  it('pins the growing conversation port at the floor while streaming', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    // Start pinned near the floor so the first frame claims follow.
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(port.scrollTop).toBe(400)
  })

  it('leaves scroll ownership to the host when control is disabled', async () => {
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe active controlScroll={false} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(160))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(port.scrollTop).toBe(390)
  })

  it('does not emit follow console traces unless diagnostics are enabled', async () => {
    const logSpy = vi.spyOn(console, 'log')
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe active />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    view.rerender(
      <div data-conversation-scroll>
        <FollowProbe active={false} />
      </div>,
    )
    await act(() => vi.advanceTimersByTimeAsync(2400))

    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[dsh-follow]'),
      expect.any(String),
    )
  })

  it('hands the scrollport to the host after repeated external writes', async () => {
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe active />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    // One disagreement can be a browser clamp. Two prove that another
    // bottom-follow writer is active; the engine must not keep overwriting it.
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(16))
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(port.scrollTop).toBe(400)

    port.scrollTop = 380
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.scrollTop).toBe(380)
  })

  it('keeps smoothing when an external writer agrees on the scroll floor', async () => {
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe active />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    // A manual jump-to-bottom (or shrink clamp) lands on the same floor the
    // engine uses. It is a compatible handoff point, not a competing target.
    height = 520
    port.scrollTop = 420
    await act(() => vi.advanceTimersByTimeAsync(16))
    port.scrollTop = 420
    await act(() => vi.advanceTimersByTimeAsync(16))

    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    expect(port.scrollTop).toBe(420)
  })

  it('returns leadership to a still-running assistant after a one-shot Agent row settles', async () => {
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <CompetingFollowProbe secondary />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    view.rerender(
      <div data-conversation-scroll>
        <CompetingFollowProbe secondary={false} />
      </div>,
    )
    await act(() => vi.advanceTimersByTimeAsync(80))

    height = 620
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    expect(port.scrollTop).toBe(520)
  })

  it('releases follow on a reader pull-up and resumes only after a return to the floor', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    fireEvent.wheel(port, { deltaY: -80 })
    port.scrollTop = 40
    fireEvent.scroll(port)
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    const held = port.scrollTop
    await act(() => vi.advanceTimersByTimeAsync(2400))
    expect(port.scrollTop).toBe(held)

    port.scrollTop = 400
    fireEvent.scroll(port)
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 650 })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(port.scrollTop).toBeGreaterThan(400)
  })

  it('keeps the text-to-status gap natural after the reader returns to the floor', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    let naturalHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
          <div data-chat-turn-status="" role="status">Deep diving...</div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => naturalHeight + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 96 + runway, bottom: 122 + runway } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))

    const untouchedGaps: number[] = []
    for (let frame = 0; frame < 8; frame += 1) {
      naturalHeight += 8
      await act(() => vi.advanceTimersByTimeAsync(16))
      untouchedGaps.push(status.getBoundingClientRect().top - transcript.getBoundingClientRect().bottom)
    }

    fireEvent.wheel(port, { deltaY: -80 })
    port.scrollTop = 320
    fireEvent.scroll(port)
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(status.style.marginTop).toBe('')
    expect(status.getBoundingClientRect().top - transcript.getBoundingClientRect().bottom).toBeCloseTo(16, 1)

    fireEvent.wheel(port, { deltaY: 80 })
    port.scrollTop = port.scrollHeight - port.clientHeight
    fireEvent.scroll(port)
    await act(() => vi.advanceTimersByTimeAsync(16))
    const returnGap = status.getBoundingClientRect().top - transcript.getBoundingClientRect().bottom

    const gaps: number[] = []
    await act(() => vi.advanceTimersByTimeAsync(800))
    for (let frame = 0; frame < 12; frame += 1) {
      naturalHeight += 8
      await act(() => vi.advanceTimersByTimeAsync(16))
      gaps.push(status.getBoundingClientRect().top - transcript.getBoundingClientRect().bottom)
    }

    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    // Normal line-wrap buffering can briefly add less than one rendered line;
    // a leaked 48px runway instead opens the screenshot's full blank block.
    const maximumBufferedGap = 40 + FOLLOW_SETTLE_EPSILON_PX
    expect(Math.max(...untouchedGaps)).toBeLessThanOrEqual(maximumBufferedGap)
    expect(returnGap).toBeLessThanOrEqual(maximumBufferedGap)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(maximumBufferedGap)
  })

  it('drops follow after the node settles so a light wheel is not pulled back', async () => {
    const block = { kind: 'reasoning', text: 'first line\n\nsecond' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    view.rerender(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('settled', [block])} />
      </div>,
    )
    const settled = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(settled, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(settled, 'scrollHeight', { configurable: true, value: 500 })
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(settled.getAttribute('data-follow-owned')).toBeNull()

    fireEvent.wheel(settled, { deltaY: -12 })
    settled.scrollTop = 370
    fireEvent.scroll(settled)
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(settled.getAttribute('data-follow-owned')).toBeNull()
    expect(settled.scrollTop).toBe(370)
  })

  it('keeps a released reader position while the final reveal queue drains after stream close', async () => {
    const initial = { kind: 'text', text: '' }
    const text = 'queued ending '.repeat(80)
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('running', [initial])} />
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))

    const queued = { kind: 'text', text }
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('running', [queued])} />
        </div>
      </div>,
    )
    await act(() => vi.advanceTimersByTimeAsync(120))

    // The reader unpins mid-drain and holds a fixed position. Lifecycle
    // completion must not hand the still-revealing queue a follow owner that
    // would hard-snap the viewport to the floor.
    fireEvent.wheel(port, { deltaY: -80 })
    port.scrollTop = 300
    fireEvent.scroll(port)
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()

    height = 800
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('settled', [queued])} />
        </div>
      </div>,
    )
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(port.scrollTop).toBe(300)

    await act(() => vi.advanceTimersByTimeAsync(2400))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(port.scrollTop).toBe(300)
  })

  it('keeps follow while the final text reveal queue drains after stream close', async () => {
    const initial = { kind: 'text', text: '' }
    const text = 'queued ending '.repeat(80)
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('running', [initial])} />
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))

    const queued = { kind: 'text', text }
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('running', [queued])} />
        </div>
      </div>,
    )
    await act(() => vi.advanceTimersByTimeAsync(120))
    // A final layout flush lands before the stream-close effects. The old
    // cleanup handed this >25px lag to the next owner, which then refused to
    // follow because it looked like reader input.
    height = 650
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('settled', [queued])} />
        </div>
      </div>,
    )
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    expect(port.scrollTop).toBeGreaterThan(400)
    expect(port.scrollTop).toBeLessThanOrEqual(550)

    height = 800
    const beforeGrowth = port.scrollTop
    await act(() => vi.advanceTimersByTimeAsync(400))
    // The deadline-aware drain may already have completed by this point; in
    // that case ownership is intentionally released at the natural floor.
    if (port.getAttribute('data-follow-owned') !== null) {
      expect(port.scrollTop).toBeGreaterThan(beforeGrowth)
    } else {
      expect(port.scrollTop).toBeLessThanOrEqual(height - port.clientHeight)
    }
  })

  it('unpins on a real upward scroll instead of a sub-threshold bounce', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    fireEvent.wheel(port, { deltaY: -60 })
    port.scrollTop = 340
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(port.scrollTop).toBe(340)
  })

  it('releases follow on a light upward wheel even if follow erases its small scroll delta', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    fireEvent.wheel(port, { deltaY: -12 })
    port.scrollTop = 398
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    // ChatView treats <=24px as still pinned. A plugin release must land just
    // outside that band or the host's next ResizeObserver callback re-pins it.
    expect(port.scrollTop).toBeLessThanOrEqual(374)
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(port.scrollTop).toBeLessThanOrEqual(374)
  })

  it('releases follow on a light downward finger drag', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    fireEvent.touchStart(port, { touches: [{ clientY: 100 }] })
    fireEvent.touchMove(port, { touches: [{ clientY: 104 }] })
    port.scrollTop = 396
    await act(() => vi.advanceTimersByTimeAsync(32))

    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(port.scrollTop).toBeLessThanOrEqual(374)
  })

  it('releases real-scroll follow at the exact reader position', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    expect(port.scrollTop).toBe(400)
    expect(transcript.style.transform).toBe('')
    expect(transcript.style.clipPath).toBe('')

    // There is no visual transform to compensate: release exactly where the
    // browser reports the reader's upward gesture.
    fireEvent.wheel(port, { deltaY: -60 })
    port.scrollTop = 340
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(transcript.style.transform).toBe('')
    expect(transcript.style.clipPath).toBe('')
    expect(port.scrollTop).toBe(340)
    const held = port.scrollTop
    await act(() => vi.advanceTimersByTimeAsync(2400))
    expect(port.scrollTop).toBe(held)
  })

  it('preserves an upward gesture when the stream closes before the unpin frame', async () => {
    const block = { kind: 'reasoning', text: 'first line\n\nsecond' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))

    fireEvent.wheel(port, { deltaY: -60 })
    port.scrollTop = 340
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('settled', [block])} />
        </div>
      </div>,
    )

    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(port.scrollTop).toBe(340)
  })

  it('settles at the floor when the stream closes without a reader gesture', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.scrollTop).toBe(400)

    // Lifecycle completion is not a reader unpin. Even with residual visual
    // lag, the final position must remain pinned at the floor.
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('settled', [block])} />
        </div>
      </div>,
    )
    await act(() => vi.advanceTimersByTimeAsync(48))
    expect(port.scrollTop).toBe(400)
  })

  it('yields completion scrollTop to the host for an extent-neutral scroll', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe active />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const anchor = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => ({
      top: 100 - port.scrollTop,
      bottom: 110 - port.scrollTop,
      width: 320,
      height: 10,
    }) as DOMRect)
    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    // The settled-side arm hands off to the detached settle loop. The host's
    // ResizeObserver can then overwrite scrollTop without changing extent:
    // that is a pure scroll, not a layout push, so the guard must rebase and
    // the settle must not manufacture pad or fight the host's floor writer.
    view.rerender(
      <div data-conversation-scroll>
        <FollowProbe active={false} />
      </div>,
    )
    await act(() => vi.advanceTimersByTimeAsync(16))
    port.scrollTop = 380
    await act(() => vi.advanceTimersByTimeAsync(16))
    await act(() => vi.advanceTimersByTimeAsync(16))

    expect(anchor.style.paddingBottom).toBe('')
    expect(port.scrollTop).toBe(380)
    await act(() => vi.advanceTimersByTimeAsync(1200))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(port.scrollTop).toBe(380)
  })

  it('keeps the residual glide continuous across the response-finished commit', async () => {
    const block = { kind: 'text', text: 'finished response' }
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
          <div data-chat-turn-status="" role="status">Deep diving...</div>
        </div>
        <div data-composer-seat="">Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockReturnValue({ top: 128, bottom: 154 } as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)

    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    height = 700
    await act(() => vi.advanceTimersByTimeAsync(16))
    const beforeFinish = currentTranslate(transcript)
    expect(beforeFinish).toBeGreaterThan(20)

    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('settled', [block])} />
          </div>
        </div>
        <div data-composer-seat="">Composer</div>
      </div>,
    )

    // Finishing is a lifecycle transition, not permission to drop the
    // compositor lag. The first settled paint must continue from the same
    // visual position and subsequent frames may only ease toward zero.
    const finishCommit = currentTranslate(transcript)
    expect(finishCommit).toBeGreaterThan(0)
    expect(finishCommit).toBeLessThanOrEqual(beforeFinish)
    await act(() => vi.advanceTimersByTimeAsync(16))
    const nextFrame = currentTranslate(transcript)
    expect(nextFrame).toBeGreaterThan(0)
    expect(nextFrame).toBeLessThanOrEqual(finishCommit)
  })

  it('retires the compositor layer only after a stable final paint', async () => {
    const block = { kind: 'reasoning', text: 'quietly finishing the analysis' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView
              {...assistantProps('running', [block])}
              thinkAutoExpand={false}
            />
          </div>
          <div role="status">Deep diving...</div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const flow = view.container.querySelector('[data-chat-flow]') as HTMLElement
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[role="status"]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => 500
        + (status.isConnected ? Number.parseFloat(status.style.marginTop) || 0 : 0)
        + (Number.parseFloat(transcript.style.marginBottom) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 128 + runway, bottom: 154 + runway } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(currentTranslate(transcript)).toBeGreaterThan(0)

    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView
              {...assistantProps('settled', [block])}
              thinkAutoExpand={false}
            />
          </div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )

    expect(currentTranslate(transcript)).toBe(0)
    expect(flow.style.paddingBottom).toBe('')
    expect(transcript.style.transform).not.toBe('')
    expect(transcript.style.willChange).toBe('transform')
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(transcript.style.transform).not.toBe('')
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(transcript.style.transform).toBe('')
    expect(transcript.style.willChange).toBe('')
  })

  it('never drains past the natural final position before removing its runway', async () => {
    const block = { kind: 'text', text: 'finished response' }
    let baseHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
          <div data-chat-turn-status="" role="status">Deep diving...</div>
        </div>
        <div data-composer-seat="">Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const flow = view.container.querySelector('[data-chat-flow]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight
        + (Number.parseFloat(status.style.marginTop) || 0)
        + (Number.parseFloat(transcript.style.marginBottom) || 0)
        + (Number.parseFloat(flow.style.paddingBottom) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 128 + runway, bottom: 154 + runway } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)

    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    baseHeight = 700
    await act(() => vi.advanceTimersByTimeAsync(16))
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('settled', [block])} />
          </div>
        </div>
        <div data-composer-seat="">Composer</div>
      </div>,
    )

    let previousTop = port.scrollTop
    let worstDownwardFrame = 0
    for (let elapsed = 0; elapsed < 2400; elapsed += 16) {
      await act(() => vi.advanceTimersByTimeAsync(16))
      worstDownwardFrame = Math.max(worstDownwardFrame, previousTop - port.scrollTop)
      previousTop = port.scrollTop
      const shift = currentTranslate(transcript)
      const runway = Number.parseFloat(transcript.style.marginBottom) || 0
      // While the temporary runway contributes to the scroll floor, an equal
      // transform is the natural final position. Going below it scrolls past
      // the final resting point and produces a rebound when runway is removed.
      expect(shift === 0 ? runway : shift - runway).toBeGreaterThanOrEqual(-FOLLOW_SETTLE_EPSILON_PX)
    }
    expect(transcript.style.transform).toBe('')
    expect(transcript.style.marginBottom).toBe('')
    expect(flow.style.paddingBottom).toBe('')
    expect(worstDownwardFrame).toBeLessThanOrEqual(1)
    expect(port.scrollTop).toBe(600)
  })

  it('releases a response-finish drain when the reader pulls upward', async () => {
    const block = { kind: 'text', text: 'finished response' }
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
        </div>
        <div data-composer-seat="">Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)

    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    height = 700
    await act(() => vi.advanceTimersByTimeAsync(16))
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('settled', [block])} />
        </div>
        <div data-composer-seat="">Composer</div>
      </div>,
    )
    expect(currentTranslate(transcript)).toBeGreaterThan(0)

    // The drain still carries ~70px of the glide in scroll, so a real pull
    // must exceed the unpin threshold from that position, not the floor.
    fireEvent.wheel(port, { deltaY: -60 })
    port.scrollTop = 460
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(transcript.style.transform).toBe('')
    const readerTop = port.scrollTop
    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(port.scrollTop).toBe(readerTop)
  })

  it('measures transform clearance from the real floor before splitting lag', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
          <div data-chat-turn-status="" role="status">Deep diving...</div>
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const surface = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    vi.spyOn(surface, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      // At scrollTop 390 this appears to cross the status; at the real floor
      // it has 8px of layout clearance for the glide.
      bottom: 80 + (400 - port.scrollTop) + currentTranslate(surface),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockReturnValue({ top: 88, bottom: 114 } as DOMRect)

    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(32))

    expect(port.scrollTop).toBe(400)
    expect(currentTranslate(surface)).toBe(0)

    const before = -port.scrollTop + currentTranslate(surface)
    height += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(port.scrollTop).toBe(428)
    expect(currentTranslate(surface)).toBeGreaterThan(0)
    expect(surface.getBoundingClientRect().bottom).toBeLessThan(88)
    expect(Math.abs((-port.scrollTop + currentTranslate(surface)) - before)).toBeLessThan(28)

    // Chromium serializes the zeros with px units. The next frame must still
    // recover the existing shift when measuring natural layout clearance.
    surface.style.transform = `translate3d(0px, ${String(currentTranslate(surface))}px, 0px)`
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(currentTranslate(surface)).toBeGreaterThan(0)
  })

  it('keeps fallback rows and status in one normal-flow scroll', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="a">
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
          <div data-chat-anchor-key="b"><span>older</span></div>
          <div role="status">Deep diving...</div>
        </div>
        <div data-composer-seat="">Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const flow = view.container.querySelector('[data-chat-flow]') as HTMLElement
    const label = view.container.querySelector('[role="status"]') as HTMLElement
    const rows = flow.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    vi.spyOn(rows[1] as HTMLElement, 'getBoundingClientRect').mockImplementation(() => {
      const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(rows[1]?.style.transform ?? '')?.[1] ?? 0)
      return { top: 40, bottom: 80 + shift } as DOMRect
    })
    vi.spyOn(label, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 122 } as DOMRect)
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    expect(port.scrollTop).toBe(400)
    expect(flow.style.transform).toBe('')
    expect(label.style.transform).toBe('')
    expect(rows.length).toBe(2)
    const initialShift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(rows[0]?.style.transform ?? '')?.[1] ?? 0)
    expect(initialShift).toBeGreaterThanOrEqual(0)
    for (const row of rows) {
      expect(currentTranslate(row)).toBeCloseTo(initialShift, 5)
    }
    expect(rows[0]?.style.clipPath).toBe('')
    expect(rows[1]?.style.clipPath).toBe('')
    expect(label.getAttribute('data-dsh-follow-status')).toBeNull()

    const beforeBurst = port.scrollTop
    height = 1200
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(port.scrollTop).toBeGreaterThan(beforeBurst)
    expect(port.scrollTop).toBe(1100)
    expect(flow.style.transform).toBe('')
    const burstShift = currentTranslate(rows[0] as HTMLElement)
    expect(burstShift).toBeGreaterThanOrEqual(initialShift)
    expect(80 + burstShift).toBeLessThan(96)
    for (const row of rows) {
      expect(currentTranslate(row)).toBeCloseTo(burstShift, 5)
    }
    expect(flow.style.clipPath).toBe('')
    expect(label.style.clipPath).toBe('')

    // Unsafe backlog is caught up immediately instead of being hidden in the
    // physical scroll position; the remaining safe transform drains normally.
    await act(() => vi.advanceTimersByTimeAsync(64))
    expect(currentTranslate(rows[0] as HTMLElement)).toBeLessThanOrEqual(burstShift)
    expect(currentTranslate(label)).toBe(0)
  })

  it('never shifts nested tool rows when status enters or leaves', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="a">
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
            <div data-chat-anchor-key="a:sub">
              <span>subcall</span>
            </div>
          </div>
          <div data-chat-anchor-key="b"><span>older</span></div>
          <div role="status">Deep diving...</div>
        </div>
        <div data-composer-seat="">Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const flow = view.container.querySelector('[data-chat-flow]') as HTMLElement
    const outer = flow.querySelector('[data-chat-anchor-key="a"]') as HTMLElement
    const sub = flow.querySelector('[data-chat-anchor-key="a:sub"]') as HTMLElement
    const sibling = flow.querySelector('[data-chat-anchor-key="b"]') as HTMLElement
    const label = view.container.querySelector('[role="status"]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    vi.spyOn(sibling, 'getBoundingClientRect').mockImplementation(() => ({
      top: 40,
      bottom: 80 + currentTranslate(sibling),
    }) as DOMRect)
    vi.spyOn(label, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 122 } as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    expect(flow.style.transform).toBe('')
    expect(currentTranslate(outer)).toBeGreaterThanOrEqual(0)
    expect(currentTranslate(sibling)).toBeCloseTo(currentTranslate(outer), 5)
    expect(sub.style.transform).toBe('')

    // Harness removes turn status before a queued final reveal finishes. The
    // composer becomes the paint ceiling without shifting nested tool rows.
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="a">
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
            <div data-chat-anchor-key="a:sub"><span>subcall</span></div>
          </div>
          <div data-chat-anchor-key="b"><span>older</span></div>
        </div>
        <div data-composer-seat="">Composer</div>
      </div>,
    )
    height = 700
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(flow.style.transform).toBe('')
    expect(currentTranslate(outer)).toBeGreaterThan(0)
    expect(currentTranslate(sibling)).toBeCloseTo(currentTranslate(outer), 5)
    expect(sub.style.transform).toBe('')
    expect(sibling.style.marginBottom).toBe(`${String(FOLLOW_STATUS_RUNWAY_PX)}px`)
    expect(outer.style.clipPath).toBe('')
    expect(sibling.style.clipPath).toBe('')
    expect(sub.style.clipPath).toBe('')
    expect(flow.style.clipPath).toBe('')
    expect(label.style.transform).toBe('')
  })

  it('catches up unsafe lag while fixed chrome exposes no paint clearance', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    let height = 500
    const statusGap = 12
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow style={{ gap: statusGap }}>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
          <div data-chat-turn-status="" role="status">Deep diving...</div>
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const flow = view.container.querySelector('[data-chat-flow]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const chrome = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))

    expect(port.scrollTop).toBe(400)
    expect(flow.style.transform).toBe('')
    expect(transcript.style.transform).toBe('')
    expect(transcript.style.clipPath).toBe('')
    expect(chrome.style.transform).toBe('')
    expect(chrome.style.clipPath).toBe('')
    expect(chrome.getAttribute('data-dsh-follow-status')).toBeNull()

    // Simulate a fast chunk or an FPS-guard flush landing in one layout pass.
    const beforeBurst = port.scrollTop
    height = 1200
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(port.scrollTop).toBeGreaterThan(beforeBurst)
    expect(port.scrollTop).toBe(1100)
    expect(flow.style.transform).toBe('')
    expect(transcript.style.transform).toBe('')
    expect(transcript.style.clipPath).toBe('')
    expect(currentTranslate(chrome)).toBe(0)
    expect(chrome.style.clipPath).toBe('')
    expect(chrome.getAttribute('data-dsh-follow-status')).toBeNull()

    // Removing status does not expose a hidden transform backlog; without a
    // measurable composer ceiling the message remains in normal paint flow.
    const beforeStatusLeaves = port.scrollTop
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-flow style={{ gap: statusGap }}>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
        </div>
      </div>,
    )
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(port.scrollTop).toBe(beforeStatusLeaves)
    expect(transcript.style.transform).toBe('')
    expect(transcript.style.clipPath).toBe('')

    view.unmount()
    expect(flow.style.transform).toBe('')
    expect(flow.style.willChange).toBe('')
  })

  it('bounds burst lag while status, jump control, and composer stay fixed', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
          <div data-chat-turn-status="" role="status">Deep diving...</div>
        </div>
        <button data-scroll-to-bottom="" style={{ position: 'sticky' }}>Scroll to bottom</button>
        <div data-composer-seat="" style={{ position: 'sticky' }}>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const surface = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    const jump = view.container.querySelector('[data-scroll-to-bottom]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    vi.spyOn(surface, 'getBoundingClientRect').mockImplementation(() => {
      const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(surface.style.transform)?.[1] ?? 0)
      return { top: 0, bottom: 80 + shift } as DOMRect
    })
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      const shift = currentTranslate(status)
      return { top: 96 + runway + shift, bottom: 122 + runway + shift } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    const beforeBurst = port.scrollTop

    height = 1200
    await act(() => vi.advanceTimersByTimeAsync(16))

    expect(port.scrollTop).toBeGreaterThan(beforeBurst)
    expect(port.scrollTop).toBe(1100)
    const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(surface.style.transform)?.[1] ?? 0)
    expect(shift).toBeGreaterThanOrEqual(28)
    expect(80 + shift).toBeLessThan(
      96 + (Number.parseFloat(status.style.marginTop) || 0) + currentTranslate(status),
    )
    expect(surface.style.clipPath).toBe('')
    expect(currentTranslate(status)).toBe(0)
    for (const chrome of [jump, composer]) expect(chrome.style.transform).toBe('')
    for (const chrome of [status, jump, composer]) expect(chrome.style.clipPath).toBe('')
  })

  it('uses the composer as the paint ceiling after turn status leaves', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
        </div>
        <div data-composer-seat="" style={{ position: 'sticky' }}>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const surface = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    vi.spyOn(surface, 'getBoundingClientRect').mockImplementation(() => {
      const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(surface.style.transform)?.[1] ?? 0)
      return { top: 0, bottom: 80 + shift } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 140, bottom: 240 } as DOMRect)
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    const beforeBurst = port.scrollTop

    height = 1200
    await act(() => vi.advanceTimersByTimeAsync(16))

    const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(surface.style.transform)?.[1] ?? 0)
    expect(port.scrollTop).toBeGreaterThan(beforeBurst)
    expect(port.scrollTop).toBe(1100)
    expect(80 + shift).toBeLessThan(140)
    expect(surface.style.clipPath).toBe('')
  })

  it('hands the exact visual position back on an upward reader gesture', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    let height = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
          <div data-chat-turn-status="" role="status">Deep diving...</div>
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const surface = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => height + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(surface, 'getBoundingClientRect').mockImplementation(() => {
      const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(surface.style.transform)?.[1] ?? 0)
      return { top: 0, bottom: 80 + shift } as DOMRect
    })
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 96 + runway, bottom: 122 + runway } as DOMRect
    })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(32))
    height += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(surface.style.transform)?.[1] ?? 0)
    expect(shift).toBeGreaterThanOrEqual(0)

    fireEvent.wheel(port, { deltaY: -60 })
    port.scrollTop = 340
    await act(() => vi.advanceTimersByTimeAsync(16))

    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(port.scrollTop).toBeCloseTo(340 - shift, 5)
    expect(surface.style.transform).toBe('')
    expect(status.style.marginTop).toBe('')
    expect(status.getBoundingClientRect().top - surface.getBoundingClientRect().bottom).toBeCloseTo(16, 1)

    view.unmount()
    expect(status.style.marginTop).toBe('')
  })

  it('keeps following when the column grows without a reader gesture', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 720 })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    expect(port.scrollTop).toBeGreaterThan(600)
    // The visible glide rides the transcript transform; the real port stays
    // at the floor so host bottom-follow and jump chrome remain stable.
    expect(port.scrollTop).toBeCloseTo(620, 5)
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(port.scrollTop).toBeGreaterThan(618)
  })

  it('keeps the turn-status chrome in natural flow before the port has scroll room', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
          <div data-chat-turn-status="" role="status">Deep diving...</div>
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const chrome = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    // Content shorter than the viewport: the port cannot scroll, so the
    // content-height lag has no scrollTop room to ride.
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 20 })
    port.scrollTop = 0
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    // A wrap grows the content while it is still short of the viewport. A
    // negative status transform would consume the column's 16px gap and
    // overlap the newly revealed transcript, so chrome stays in normal flow.
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 60 })
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(port.scrollTop).toBe(0)
    expect(transcript.style.transform).toBe('')
    expect(chrome.style.transform).toBe('')

    // It remains unshifted throughout the old glide window.
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(chrome.style.transform).toBe('')
  })

  it('returns settled text to the Harness Markdown renderer', () => {
    const view = render(<TypewriterAssistantNodeView {...assistantProps('settled', [
      { kind: 'text', text: '**finished**' },
    ])} />)
    expect(view.getByText('finished').tagName).toBe('STRONG')
  })

  it('renders unknown blocks through JsonBlock', () => {
    const view = render(<TypewriterAssistantNodeView {...assistantProps('settled', [
      { kind: 'other', block: { type: 'mystery', value: 1 } },
    ])} />)
    expect(view.container.textContent).toContain('message.unknownBlock')
  })
})

describe('client plugin lifecycle', () => {
  it('shadows the built-in assistant cell and removes its entry on disposal', async () => {
    expect(inject).toEqual(['slots'])
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'tool-call',
    } as never, (() => null) as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const keys = ctx.slots.entries('conversation.chat.node').map(entry => entry.options.key)
    expect(keys).toEqual(expect.arrayContaining(['assistant-step', 'tool-call']))

    await fiber.dispose()
    const leftover = ctx.slots.entries('conversation.chat.node')
    expect(leftover).toHaveLength(1)
    expect(leftover[0]?.options.key).toBe('tool-call')
  })

  it('wraps a prior tool-call that already declared children without re-registering', async () => {
    function DummyTool({ node }: { node: { data: { root: object } } }) {
      return <div>tool:{'kind' in node.data.root ? 'settled' : 'running'}</div>
    }
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'tool-call',
      children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
    } as never, DummyTool as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = ctx.slots.entries('conversation.chat.node').find(item => item.options.key === 'tool-call')
    expect(entry?.component).not.toBe(DummyTool)
    const view = render(createElement(entry?.component as FunctionComponent<{ node: { data: { root: object } } }>, {
      node: { data: { root: { callId: '1', name: 'bash' } } },
    }))
    expect(view.container.querySelector(`.${css.follow}`)).not.toBeNull()
    expect(view.container.querySelector(`.${css.follow} > div`)).not.toBeNull()

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.chat.node').find(item => item.options.key === 'tool-call')?.component).toBe(DummyTool)
  })

  it('wraps memoized Agent rows while preserving memoized human rows', async () => {
    const ContextRow = memo(function ContextRow() {
      return <div>context</div>
    })
    const UserRow = memo(function UserRow() {
      return <div>user</div>
    })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'context',
    } as never, ContextRow as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'user',
    } as never, UserRow as never)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const contextEntry = ctx.slots.entries('conversation.chat.node')
      .find(item => item.options.key === 'context')
    const userEntry = ctx.slots.entries('conversation.chat.node')
      .find(item => item.options.key === 'user')
    expect(contextEntry?.component).not.toBe(ContextRow)
    expect(userEntry?.component).toBe(UserRow)

    await fiber.dispose()
    expect(contextEntry?.component).toBe(ContextRow)
  })

  it('wraps a tool-call registered after the overlay mounts', async () => {
    function LateTool() {
      return <div>late</div>
    }
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'tool-call',
    } as never, LateTool as never)
    const entry = ctx.slots.entries('conversation.chat.node').find(item => item.options.key === 'tool-call')
    expect(entry?.component).not.toBe(LateTool)
    const view = render(createElement(entry?.component as FunctionComponent<{ node: { data: { root: object } } }>, {
      node: { data: { root: { callId: '2', name: 'read' } } },
    }))
    expect(view.container.querySelector(`.${css.follow}`)).not.toBeNull()
    expect(view.container.querySelector(`.${css.follow} > div`)).not.toBeNull()
    await fiber.dispose()
  })

  async function renderRegisteredView(props: Parameters<typeof TypewriterAssistantNodeView>[0]): Promise<HTMLElement> {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const component = ctx.slots.entries('conversation.chat.node')[0]?.component
    expect(component).toBeTypeOf('function')
    const view = render(createElement(component as FunctionComponent<Parameters<typeof TypewriterAssistantNodeView>[0]>, props))
    await fiber.dispose()
    return view.container
  }

  it('applies the Host-bridged config to the registered view', async () => {
    ;(globalThis as Record<string, unknown>)[STREAM_BOOT_GLOBAL] = {
      ...DEFAULT_STREAM_CONFIG,
      mode: 'teleprompter',
      preset: 'silky',
      scrollSpeedPxPerSec: 60,
      maxScrollSpeedPxPerSec: 200,
    }
    const container = await renderRegisteredView(assistantProps('running', [
      { kind: 'text', text: 'hello' },
    ]))
    expect(container.querySelector(`.${css.follow}`)).not.toBeNull()
    delete (globalThis as Record<string, unknown>)[STREAM_BOOT_GLOBAL]
  })

  it('falls back to defaults without the Host config bridge', async () => {
    delete (globalThis as Record<string, unknown>)[STREAM_BOOT_GLOBAL]
    const container = await renderRegisteredView(assistantProps('running', [
      { kind: 'text', text: '**hello**' },
    ]))
    // Default mode is typewriter: follow host + markdown parsed.
    expect(container.querySelector(`.${css.follow}`)).not.toBeNull()
    await vi.waitFor(() => expect(container.querySelector('strong')?.textContent).toBe('hello'))
  })

  it('fails loudly on a malformed boot global', async () => {
    ;(globalThis as Record<string, unknown>)[STREAM_BOOT_GLOBAL] = { mode: 'diagonal' }
    await expect(renderRegisteredView(assistantProps('running', [
      { kind: 'text', text: 'hello' },
    ]))).rejects.toThrow(/malformed/)
    delete (globalThis as Record<string, unknown>)[STREAM_BOOT_GLOBAL]
  })
})

describe('plugin Config schema', () => {
  it('fills defaults when the overlay config is omitted', () => {
    const resolved = Config({} as never)
    expect(resolved).toEqual(DEFAULT_STREAM_CONFIG)
  })

  it('accepts a full override and rejects invalid values', () => {
    const resolved = Config({
      mode: 'teleprompter',
      preset: 'realtime',
      revealCharsPerSec: 60,
      scrollSpeedPxPerSec: 100,
      maxScrollSpeedPxPerSec: 400,
    })
    expect(resolved).toEqual({
      mode: 'teleprompter',
      preset: 'realtime',
      revealCharsPerSec: 60,
      scrollSpeedPxPerSec: 100,
      maxScrollSpeedPxPerSec: 400,
    })
    expect(() => Config({ mode: 'diagonal' } as never)).toThrow()
    expect(() => Config({ scrollSpeedPxPerSec: 0 } as never)).toThrow()
    expect(() => Config({ maxScrollSpeedPxPerSec: 9000 } as never)).toThrow()
    expect(() => Config({ revealCharsPerSec: 0 } as never)).toThrow()
  })
})

describe('computeQueueReveal', () => {
  it('matches the reference pressure curve for an 80-character backlog', () => {
    const backlog = 80
    const speed = Math.min(600, 90 + Math.pow(backlog, 1.25) * 0.85)
    expect(computeQueueReveal(backlog, 1000 / 60)).toBe(Math.floor(speed / 60))
  })

  it('types one glyph per frame when the queue is small', () => {
    expect(computeQueueReveal(3, 16.67)).toBe(1)
  })

  it('raises the step when the queue is backlogged', () => {
    expect(computeQueueReveal(40, 16.67)).toBe(2)
    expect(computeQueueReveal(80, 16.67)).toBe(4)
  })

  it('carries fractional character debt across short frames', () => {
    const first = computeAdaptiveQueueStep(3, 5, 0)
    expect(first.revealChars).toBe(0)
    const second = computeAdaptiveQueueStep(3, 6, first.debt)
    expect(second.revealChars).toBe(1)
    expect(second.debt).toBeGreaterThanOrEqual(0)
    expect(second.debt).toBeLessThan(1)
  })

  it('never exceeds the backlog', () => {
    expect(computeQueueReveal(2, 1000)).toBe(2)
    expect(computeQueueReveal(0, 16)).toBe(0)
  })

  it('applies live diagnostics tuning without changing the production default', () => {
    const baseline = computeAdaptiveQueueStep(80, 1000 / 60, 0)
    const explicitDefault = computeAdaptiveQueueStep(
      80,
      1000 / 60,
      0,
      1,
      DEFAULT_STREAM_DEBUG_TUNING,
    )
    const tuned = computeAdaptiveQueueStep(80, 1000 / 60, 0, 1, {
      ...DEFAULT_STREAM_DEBUG_TUNING,
      queuePressure: 1.6,
      revealScale: 1.4,
      maxRevealCps: 900,
    })

    expect(explicitDefault).toEqual(baseline)
    expect(tuned.speedCps).toBeGreaterThan(baseline.speedCps)
    expect(tuned.revealChars).toBeGreaterThan(baseline.revealChars)
  })
})

describe('computeSettleDrain', () => {
  it('drains ordinary backlog within the settle window', () => {
    const config = PRESET_CONFIG.balanced
    const ordinary = computeSettleDrain(config, { backlog: 200, inputActive: false, settling: true })
    expect(ordinary).toBeGreaterThanOrEqual(config.flushCps)
    expect(ordinary).toBeLessThanOrEqual(config.maxFlushCps)
  })

  it('climbs past the settle window to close a backlog beyond the lag ceiling', () => {
    const config = PRESET_CONFIG.balanced
    const lagged = computeSettleDrain(config, { backlog: 2000, inputActive: false, settling: true })
    const ordinary = computeSettleDrain(config, { backlog: 50, inputActive: false, settling: true })
    expect(lagged).toBeGreaterThan(ordinary)
    expect(lagged).toBe(config.maxFlushCps)
    // Ceiling drain alone closes a 2000-char backlog within two seconds:
    // the whole reply drains at maxFlushCps while the overflow pays for itself.
    expect((2000 - BACKLOG_CHAR_CEILING) * 1000 / BACKLOG_SECOND_CEILING).toBeGreaterThan(config.maxFlushCps)
  })

  it('stays in the settle band while input is still active or not yet settling', () => {
    const config = PRESET_CONFIG.balanced
    expect(computeSettleDrain(config, { backlog: 5000, inputActive: true, settling: false })).toBe(0)
    expect(computeSettleDrain(config, { backlog: 5000, inputActive: false, settling: false })).toBe(0)
  })
})

describe('computeCompletionDrain', () => {
  it('closes every producer-complete backlog within its configured deadline', () => {
    const config = PRESET_CONFIG.balanced
    expect(computeCompletionDrain(config, 32)).toBeGreaterThanOrEqual(config.flushCps)
    for (const backlog of [32, 128, 512, 2048]) {
      const deadlineMs = Math.min(
        config.settleDrainMaxMs,
        Math.max(config.settleDrainMinMs, backlog * 8),
      )
      const drainMs = backlog * 1000 / computeCompletionDrain(config, backlog)
      expect(drainMs).toBeLessThanOrEqual(deadlineMs)
    }
  })
})

describe('isGrowingChatNode', () => {
  it('treats running assistant, unsettled tools, and scheduled retries as growing', () => {
    expect(isGrowingChatNode({ data: { status: 'running', blocks: [] } })).toBe(true)
    expect(isGrowingChatNode({ data: { status: 'settled', blocks: [] } })).toBe(false)
    expect(isGrowingChatNode({ data: { root: { callId: '1', name: 'bash' } } })).toBe(true)
    expect(isGrowingChatNode({ data: { root: { kind: 'tool-result', callId: '1' } } })).toBe(false)
    expect(isGrowingChatNode({ data: { current: { retryState: 'scheduled' } } })).toBe(true)
    expect(isGrowingChatNode({ data: { current: { retryState: 'done' } } })).toBe(false)
    expect(isGrowingChatNode({ data: { kind: 'command', outcome: null } })).toBe(true)
    expect(isGrowingChatNode({ data: { kind: 'command', outcome: { kind: 'success' } } })).toBe(false)
  })

  it('treats an otherwise unknown renderer in an open Agent step as followable', () => {
    expect(isFollowableChatNode({
      location: {
        kind: 'step',
        turn: { status: 'open' },
        step: { status: 'open' },
      },
      data: { pluginSurface: 'future-tool' },
    })).toBe(true)
    expect(isFollowableChatNode({
      location: {
        kind: 'step',
        turn: { status: 'closed' },
        step: { status: 'closed' },
      },
      data: { pluginSurface: 'history' },
    })).toBe(false)
  })

  it.each([
    {
      label: 'context row in an open step',
      oneShot: true,
      node: {
        location: {
          kind: 'step',
          turn: { status: 'open' },
          step: { status: 'open' },
        },
        data: { content: [], source: {}, provenance: {}, form: null },
      },
    },
    {
      label: 'first running Tool row',
      oneShot: false,
      node: {
        location: { kind: 'unresolved' },
        data: { root: { callId: '1', name: 'bash' } },
      },
    },
  ])('eases the newly inserted $label from the pre-insert extent', async ({ node, oneShot }) => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    function Inner() {
      return <div>new agent row</div>
    }
    const Wrapped = wrapFollowNodeView(Inner as never)
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript data-chat-anchor-key="row">
            <Wrapped node={node} />
          </div>
          <div role="status">Deep diving...</div>
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[role="status"]') as HTMLElement
    const root = view.container.querySelector(`.${css.follow}`) as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      top: 48,
      bottom: 80,
      height: 32,
    } as DOMRect)
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 186 } as DOMRect)
    port.scrollTop = 400

    await act(() => vi.advanceTimersByTimeAsync(16))
    const entered = currentTranslate(transcript)
    expect(entered).toBeGreaterThan(8)

    await act(() => vi.advanceTimersByTimeAsync(48))
    const advanced = currentTranslate(transcript)
    expect(advanced).toBeGreaterThan(0)
    expect(advanced).toBeLessThan(entered)

    if (oneShot) {
      await act(() => vi.advanceTimersByTimeAsync(1600))
      expect(transcript.style.transform).toBe('')
      expect(port.getAttribute('data-follow-owned')).toBeNull()
    }
  })

  it('reveals text inside a newly inserted generic Agent renderer progressively', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    function Inner() {
      return <div>Context injection is ready</div>
    }
    const Wrapped = wrapFollowNodeView(Inner as never)
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <Wrapped node={{
              location: {
                kind: 'step',
                turn: { status: 'open' },
                step: { status: 'open' },
              },
              data: { pluginSurface: 'context' },
            }} />
          </div>
          <div role="status">Deep diving...</div>
        </div>
      </div>,
    )

    expect(view.container.textContent).not.toContain('Context injection is ready')
    await act(() => vi.advanceTimersByTimeAsync(48))
    const partial = view.container.querySelector(`.${css.follow}`)?.textContent ?? ''
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan('Context injection is ready'.length)
    await act(() => vi.advanceTimersByTimeAsync(1200))
    expect(view.container.textContent).toContain('Context injection is ready')
  })

  it('plays a short streaming-style entrance for opaque Agent rows', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    function Inner() {
      return <div>Tool result is ready</div>
    }
    const Wrapped = wrapFollowNodeView(Inner as never)
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <Wrapped node={{
              location: {
                kind: 'step',
                turn: { status: 'open' },
                step: { status: 'open' },
              },
              data: { pluginSurface: 'tool' },
            }} />
          </div>
          <div role="status">Deep diving...</div>
        </div>
      </div>,
    )
    const surface = view.container.querySelector(`.${entranceCss.surface}`) as HTMLElement
    expect(surface).not.toBeNull()
    expect(surface.getAttribute('data-entrance')).toBe('active')
  })

  it('reveals an unknown unresolved renderer when it mounts at the active Agent tail', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    function Inner() {
      return <div>Future renderer</div>
    }
    const Wrapped = wrapFollowNodeView(Inner as never)
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-flow-key="future"><Wrapped node={{
            location: { kind: 'unresolved' },
            data: { pluginSurface: 'future' },
          }} /></div>
          <div role="status">Deep diving...</div>
        </div>
      </div>,
    )

    expect(view.container.textContent).not.toContain('Future renderer')
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(view.container.textContent).toContain('Future renderer')
  })

  it('paces same-height text mutations from an opaque Agent renderer', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    const location = {
      kind: 'step',
      turn: { status: 'open' },
      step: { status: 'open' },
    }
    function Inner({ node }: { node: { data: { label: string } } }) {
      return <span>{node.data.label}</span>
    }
    const Wrapped = wrapFollowNodeView(Inner as never)
    const view = render(<Wrapped node={{ location, data: { label: 'Bash command' } }} />)
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(view.container.textContent).toBe('Bash command')

    view.rerender(<Wrapped node={{ location, data: { label: 'Read command' } }} />)
    await act(async () => {})
    expect(view.container.textContent).not.toBe('Read command')
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(view.container.textContent).toBe('Read command')
  })

  it('sleeps after a generic text queue drains and wakes for later mutations', async () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const cancelFrame = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined)
    let now = 0
    const drainFrames = async (): Promise<void> => {
      for (let count = 0; count < 100 && frames.length > 0; count += 1) {
        const callback = frames.shift()
        now += 16
        await act(async () => { callback?.(now) })
      }
    }
    try {
      const view = render(<ProgressiveDomProbe text="Context ready" />)
      await drainFrames()
      expect(view.container.textContent).toBe('Context ready')
      expect(frames).toHaveLength(0)

      view.rerender(<ProgressiveDomProbe text="Context updated" />)
      await act(async () => {})
      expect(frames).toHaveLength(1)
      expect(view.container.textContent).not.toBe('Context updated')
      await drainFrames()
      expect(view.container.textContent).toBe('Context updated')
      expect(frames).toHaveLength(0)
    } finally {
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
    }
  })

  it('reports real total and displayed characters for opaque DOM text', async () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const cancelFrame = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined)
    debugRuntime.syncSettings({
      enabled: true,
      writable: true,
      dirty: false,
      status: 'ready',
      tuning: DEFAULT_STREAM_DEBUG_TUNING,
    })

    try {
      render(<ProgressiveDomProbe text={'x'.repeat(400)} />)
      await act(async () => { frames.shift()?.(0) })
      await act(async () => { frames.shift()?.(100) })

      expect(debugRuntime.getSnapshot().metrics).toMatchObject({
        streamTargetChars: 400,
        streamDisplayedChars: expect.any(Number),
      })
      expect(debugRuntime.getSnapshot().metrics.streamDisplayedChars).toBeGreaterThan(0)
      expect(debugRuntime.getSnapshot().metrics.streamDisplayedChars).toBeLessThan(400)
    } finally {
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
    }
  })

  it('keeps already-revealed text when the follow flip restores and re-enables', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    const view = render(<FollowToggleProgressiveDomProbe enabled text="Tool invoked" />)
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(view.container.textContent).toBe('Tool invoked')

    // Tool row settles: structural follow drops, the hook restores full text.
    view.rerender(<FollowToggleProgressiveDomProbe enabled={false} text="Tool invoked" />)
    await act(async () => {})
    expect(view.container.textContent).toBe('Tool invoked')

    // The live turn tail re-arms follow in the next layout pass. Without
    // retaining the root's activation state, a fresh ledger would blank and
    // replay the already-visible text.
    view.rerender(<FollowToggleProgressiveDomProbe enabled text="Tool invoked" />)
    await act(async () => {})
    expect(view.container.textContent).toBe('Tool invoked')
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(view.container.textContent).toBe('Tool invoked')
  })

  it('keeps text that became visible while follow was disabled', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    const view = render(<FollowToggleProgressiveDomProbe enabled text="Tool" />)
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(view.container.textContent).toBe('Tool')

    view.rerender(<FollowToggleProgressiveDomProbe enabled={false} text="Tool" />)
    await act(async () => {})
    view.rerender(<FollowToggleProgressiveDomProbe enabled={false} text="Tool result" />)
    await act(async () => {})
    expect(view.container.textContent).toBe('Tool result')

    view.rerender(<FollowToggleProgressiveDomProbe enabled text="Tool result" />)
    await act(async () => {})
    expect(view.container.textContent).toBe('Tool result')
  })

  it('paces only new text committed when follow re-enables', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    const view = render(<FollowToggleProgressiveDomProbe enabled text="Tool" />)
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(view.container.textContent).toBe('Tool')

    view.rerender(<FollowToggleProgressiveDomProbe enabled={false} text="Tool" />)
    await act(async () => {})
    view.rerender(<FollowToggleProgressiveDomProbe enabled text="Tool result" />)
    await act(async () => {})
    expect(view.container.textContent).toBe('Tool')

    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(view.container.textContent).toBe('Tool result')
  })

  it('keeps initial reveal pacing through StrictMode effect replay', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    const text = 'StrictMode should not mark a fresh renderer as already revealed.'
    const view = render(
      <StrictMode>
        <FollowToggleProgressiveDomProbe enabled text={text} />
      </StrictMode>,
    )

    expect(view.container.textContent).not.toBe(text)
    await act(() => vi.advanceTimersByTimeAsync(1600))
    expect(view.container.textContent).toBe(text)
  })

  it('does not animate a completed historical context row', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    let resizeObserverCount = 0
    let mutationObserverCount = 0
    class ResizeObserverStub {
      constructor(_callback: ResizeObserverCallback) {
        resizeObserverCount += 1
      }

      observe(): void {}
      disconnect(): void {}
    }
    class MutationObserverStub {
      constructor(_callback: MutationCallback) {
        mutationObserverCount += 1
      }

      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('MutationObserver', MutationObserverStub)
    function Inner() {
      return <div>historical context</div>
    }
    const Wrapped = wrapFollowNodeView(Inner as never)
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <Wrapped node={{
            location: {
              kind: 'step',
              turn: { status: 'closed' },
              step: { status: 'closed' },
            },
            data: { content: [] },
          }} />
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 400

    await act(() => vi.advanceTimersByTimeAsync(32))

    expect(transcript.style.transform).toBe('')
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(resizeObserverCount).toBe(0)
    expect(mutationObserverCount).toBe(0)
  })

  it('re-arms follow for a future Agent renderer when its DOM grows', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    let height = 32
    const observers: ResizeObserverCallback[] = []
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback)
      }

      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    function FutureAgentRow() {
      return <div style={{ height }}>{'future tool output'}</div>
    }
    const Wrapped = wrapFollowNodeView(FutureAgentRow as never)
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <Wrapped node={{
            location: {
              kind: 'step',
              turn: { status: 'open' },
              step: { status: 'open' },
            },
            data: { pluginSurface: 'future-tool' },
          }} />
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => 400 + height,
    })
    port.scrollTop = 380

    const notify = (): void => {
      for (const callback of observers) callback([
        { contentRect: { height } } as ResizeObserverEntry,
      ], {} as ResizeObserver)
    }
    act(() => { notify() })
    await act(() => vi.advanceTimersByTimeAsync(32))
    const initialText = view.container.querySelector(`.${css.follow}`)?.textContent ?? ''
    expect(initialText.length).toBeGreaterThan(0)
    expect(initialText.length).toBeLessThan('future tool output'.length)

    height = 80
    act(() => { notify() })
    await act(() => vi.advanceTimersByTimeAsync(32))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    await act(() => vi.advanceTimersByTimeAsync(1600))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    port.scrollTop = 320
    height = 120
    act(() => { notify() })
    await act(() => vi.advanceTimersByTimeAsync(32))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
  })

  it('re-arms a settled open Tool row for delayed asynchronous height growth', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    let height = 32
    const observers: ResizeObserverCallback[] = []
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback)
      }

      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const location = {
      kind: 'step',
      turn: { status: 'open' },
      step: { status: 'open' },
    }
    function Inner() {
      return <div style={{ height }}>Tool output</div>
    }
    const Wrapped = wrapFollowNodeView(Inner as never)
    const running = { location, data: { root: { callId: '1', name: 'bash' } } }
    const settled = {
      location,
      data: { root: { kind: 'tool-result', callId: '1', content: ['done'] } },
    }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript><Wrapped node={running} /></div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => 400 + height,
    })
    port.scrollTop = 332
    const notify = (): void => {
      for (const callback of observers) callback([
        { contentRect: { height } } as ResizeObserverEntry,
      ], {} as ResizeObserver)
    }
    act(() => { notify() })
    await act(() => vi.advanceTimersByTimeAsync(80))

    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-transcript><Wrapped node={settled} /></div>
      </div>,
    )
    await act(() => vi.advanceTimersByTimeAsync(1600))
    expect(port.getAttribute('data-follow-owned')).toBeNull()

    height = 96
    act(() => { notify() })
    await act(() => vi.advanceTimersByTimeAsync(32))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
  })

  it('primes a short-lived completion owner before its first paint', () => {
    const view = render(
      <div data-conversation-scroll>
        <ShortLivedFollowProbe />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement

    expect(port.scrollTop).toBe(400)
    expect(port.getAttribute('data-follow-owned')).toBeNull()
  })

  it('keeps short Tool rows at their natural status gap without an idle rebound', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    const running = {
      location: { kind: 'unresolved' },
      data: { root: { callId: '1', name: 'read' } },
    }
    const settled = {
      location: { kind: 'unresolved' },
      data: { root: { kind: 'tool-result', callId: '1', content: ['done'] } },
    }
    function Inner() {
      return <div>Read · packages/client/ui-slots/src/index.ts</div>
    }
    const Wrapped = wrapFollowNodeView(Inner as never)
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript><Wrapped node={running} /></div>
          <div role="status">Deep diving...</div>
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[role="status"]') as HTMLElement
    const baseHeight = 500
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return {
        top: 0,
        bottom: 80 - runway + currentTranslate(transcript),
      } as DOMRect
    })
    vi.spyOn(status, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 122 } as DOMRect)
    port.scrollTop = 400

    const gaps: number[] = []
    for (let frame = 0; frame < 40; frame += 1) {
      await act(() => vi.advanceTimersByTimeAsync(16))
      gaps.push(96 - transcript.getBoundingClientRect().bottom)
    }
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript><Wrapped node={settled} /></div>
          <div role="status">Deep diving...</div>
        </div>
      </div>,
    )
    for (let frame = 0; frame < 40; frame += 1) {
      await act(() => vi.advanceTimersByTimeAsync(16))
      gaps.push(96 - transcript.getBoundingClientRect().bottom)
    }

    // Entrance motion may temporarily consume the natural 16px gap, but an
    // idle short row must never open extra speculative space and close it later.
    expect(Math.max(...gaps)).toBeLessThanOrEqual(16.5)
    expect(gaps.at(-1)).toBeCloseTo(16, 1)
  })

  it.each([
    {
      label: 'tool result',
      running: { data: { root: { callId: '1', name: 'bash' } } },
      settled: { data: { root: { kind: 'tool-result', callId: '1', content: ['done'] } } },
    },
    {
      label: 'command result',
      running: { data: { kind: 'command', commandId: '1', outcome: null } },
      settled: { data: { kind: 'command', commandId: '1', outcome: { kind: 'success', text: 'done' } } },
    },
  ])('uses all safe paint room to soften the final $label height', async ({ running, settled }) => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    let height = 500
    function Inner({ node }: { node: typeof running }) {
      const done = 'root' in node.data
        ? 'kind' in node.data.root
        : node.data.outcome !== null
      return <div>{done ? 'final output' : 'running'}</div>
    }
    const Wrapped = wrapFollowNodeView(Inner as never)
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript data-chat-anchor-key="row">
          <Wrapped node={running} />
        </div>
        <div data-composer-seat="">Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)

    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    const before = -port.scrollTop + currentTranslate(transcript)
    height = 700
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-transcript data-chat-anchor-key="row">
          <Wrapped node={settled as unknown as typeof running} />
        </div>
        <div data-composer-seat="">Composer</div>
      </div>,
    )

    const landed = currentTranslate(transcript)
    expect(view.container.querySelector(`.${css.follow}`)).not.toBeNull()
    expect(port.scrollTop).toBeGreaterThan(400)
    expect(port.scrollTop).toBe(600)
    expect(landed).toBeGreaterThan(0)
    const landedVisual = -port.scrollTop + landed
    expect(landedVisual).toBeGreaterThan(-port.scrollTop)
    expect(landedVisual).toBeLessThan(before)
    await act(() => vi.advanceTimersByTimeAsync(32))
    const nextVisual = -port.scrollTop + currentTranslate(transcript)
    expect(nextVisual).toBeLessThan(landedVisual)
    expect(landedVisual - nextVisual).toBeLessThan(40)
    await act(() => vi.advanceTimersByTimeAsync(320))
    expect(view.container.textContent).toContain('final output')
    expect(port.scrollTop).toBeGreaterThan(500)
  })

  it('hosts follow only while the wrapped node is growing', () => {
    function Inner({ node }: { node: { data: { root: object } } }) {
      return <span>{'kind' in node.data.root ? 'done' : 'live'}</span>
    }
    const Wrapped = wrapFollowNodeView(Inner as never)
    const live = render(<Wrapped node={{ data: { root: { callId: '1' } } }} />)
    expect(live.container.querySelector(`.${css.follow}`)).not.toBeNull()
    expect(live.container.querySelector('span')).not.toBeNull()
    const done = render(<Wrapped node={{ data: { root: { kind: 'tool-result', callId: '1' } } }} />)
    expect(done.container.textContent).toBe('done')
  })
})

describe('computeFollowStep', () => {
  it('bridges revealed characters into a continuous predictive wrap target', () => {
    const phase = new FollowRevealPhaseTracker({
      seedCharsPerLine: 50,
      seedLineHeightPx: 28,
    })

    expect(phase.advance(400, 0).targetPx).toBe(400)
    expect(phase.advance(400, 25).targetPx).toBeCloseTo(414, 5)
    const beforeWrap = phase.advance(400, 49).targetPx
    const afterWrap = phase.advance(428, 50).targetPx
    expect(afterWrap - beforeWrap).toBeLessThan(1)

    // An early paragraph/layout wrap updates the estimate instead of locking
    // the tracker to the original 50-character seed.
    phase.advance(428, 89)
    const earlyWrap = phase.advance(456, 90)
    expect(earlyWrap.charsPerLine).toBeLessThan(50)
    expect(earlyWrap.phase).toBe(0)
  })

  it('does not treat sub-line floor rounding as a new wrap', () => {
    const phase = new FollowRevealPhaseTracker({
      seedCharsPerLine: 50,
      seedLineHeightPx: 28,
    })
    phase.advance(400, 0)
    const before = phase.advance(400, 25)
    const after = phase.advance(401, 26)

    expect(after.phase).toBeGreaterThan(before.phase)
    expect(after.lineHeightPx).toBe(28)
  })

  it('resets phase sampling across non-text flow growth', () => {
    const phase = new FollowRevealPhaseTracker({
      seedCharsPerLine: 50,
      seedLineHeightPx: 28,
    })
    phase.advance(400, 0)
    phase.advance(428, 50)
    phase.advance(456, 50)
    const afterTextWrap = phase.advance(484, 90)

    expect(afterTextWrap.charsPerLine).toBeLessThan(50)
  })

  it('keeps trajectory position continuous across early and late wraps', () => {
    const phase = new FollowRevealPhaseTracker({
      seedCharsPerLine: 50,
      seedLineHeightPx: 28,
    })
    const wrapAt = [50, 90, 150]
    let floorPx = 400
    let positionPx = 352
    let velocityPxPerMs = 0.34
    let previousPositionPx = positionPx
    let maxAdvancePx = 0

    for (let revealedChars = 0; revealedChars <= 170; revealedChars += 5) {
      if (wrapAt.includes(revealedChars)) floorPx += 28
      const target = phase.advance(floorPx, revealedChars)
      const step = computeFollowTrajectoryStep(16, {
        positionPx,
        velocityPxPerMs,
        targetPx: target.targetPx,
        targetVelocityPxPerMs: 0.34,
        minLagPx: 40,
        maxLagPx: 71,
        paintFloorPx: floorPx,
      })
      positionPx = step.positionPx
      velocityPxPerMs = step.velocityPxPerMs
      maxAdvancePx = Math.max(maxAdvancePx, positionPx - previousPositionPx)
      previousPositionPx = positionPx
      expect(step.shiftPx).toBeGreaterThanOrEqual(0)
      expect(step.shiftPx).toBeLessThanOrEqual(71)
    }

    expect(maxAdvancePx).toBeLessThan(8)
  })

  it('keeps effective scroll velocity continuous across repeated line wraps', () => {
    let targetPx = 100
    let positionPx = targetPx - 7
    let velocityPxPerMs = 28 / (7 * 16)
    let targetVelocityPxPerMs = velocityPxPerMs
    const positions: number[] = []

    for (let frame = 0; frame < 80; frame += 1) {
      if (frame > 0 && frame % 7 === 0) {
        targetPx += 28
        targetVelocityPxPerMs = 28 / (7 * 16)
      }
      const step = computeFollowTrajectoryStep(16, {
        positionPx,
        velocityPxPerMs,
        targetPx,
        targetVelocityPxPerMs,
        minLagPx: 7,
        maxLagPx: 47,
      })
      positionPx = step.positionPx
      velocityPxPerMs = step.velocityPxPerMs
      positions.push(positionPx)
      expect(step.shiftPx).toBeGreaterThanOrEqual(7)
      expect(step.shiftPx).toBeLessThanOrEqual(47)
    }

    const velocities = positions.slice(1).map((position, index) => (position - positions[index]!) / 16)
    const changes = velocities.slice(16).map((velocity, index) => Math.abs(velocity - velocities[index + 15]!))
    const sortedChanges = [...changes].sort((left, right) => left - right)
    expect(sortedChanges[Math.ceil(sortedChanges.length * 0.95) - 1]).toBeLessThanOrEqual(0.025)
    expect(Math.max(...changes)).toBeLessThanOrEqual(0.075)
  })

  it('uses the velocity budget when a narrow fast stream needs more than 8px per frame', () => {
    const velocityPxPerMs = 26 / 50
    const step = computeFollowTrajectoryStep(16, {
      positionPx: 100,
      velocityPxPerMs,
      targetPx: 150,
      targetVelocityPxPerMs: velocityPxPerMs,
      minLagPx: 31,
      maxLagPx: 71,
    })

    expect(step.positionPx - 100).toBeGreaterThan(8)
    expect(step.positionPx - 100).toBeCloseTo(step.velocityPxPerMs * 16, 5)
  })

  it('does not reverse position when an estimated phase target is corrected downward', () => {
    const step = computeFollowTrajectoryStep(16, {
      positionPx: 120,
      velocityPxPerMs: 0.2,
      targetPx: 145,
      targetVelocityPxPerMs: 0.2,
      minLagPx: 30,
      maxLagPx: 60,
      paintFloorPx: 140,
    })

    expect(step.positionPx).toBeGreaterThanOrEqual(120)
  })

  it('never allows a lag band to exceed its paint-space ceiling', () => {
    const step = computeFollowTrajectoryStep(16, {
      positionPx: 60,
      velocityPxPerMs: 0,
      targetPx: 100,
      targetVelocityPxPerMs: 0,
      minLagPx: 40,
      maxLagPx: 10,
      paintFloorPx: 100,
    })

    expect(step.shiftPx).toBeLessThanOrEqual(10)
  })

  it('reserves reveal headroom without changing the spring constants', () => {
    expect(computeFollowRevealScale(0, 48)).toBe(1)
    expect(computeFollowRevealScale(28, 48)).toBeLessThan(0.75)
    expect(computeFollowRevealScale(48, 48)).toBe(0.55)
    expect(computeFollowRevealScale(20, 48, true)).toBe(0.55)
    expect(computeFollowRevealScale(200, Number.POSITIVE_INFINITY)).toBe(1)
  })

  it('holds one wrap impulse of runway at every active speed, none while idle', () => {
    // Idle (no reveal) holds nothing; any active cadence gets at least one
    // full wrapped line of absorption room — a narrower natural gap would
    // otherwise turn every slow-cadence wrap into an instant catch-up step.
    expect(computeFollowReserve(10)).toBe(0)
    expect(computeFollowReserve(35)).toBeGreaterThanOrEqual(FOLLOW_RESERVE_MIN_PX)
    expect(computeFollowReserve(91)).toBeGreaterThanOrEqual(FOLLOW_RESERVE_MIN_PX)
    expect(computeFollowReserve(600)).toBe(FOLLOW_STATUS_RUNWAY_PX)
    expect(computeFollowReserve(300)).toBeGreaterThanOrEqual(FOLLOW_RESERVE_MIN_PX)
    expect(computeFollowReserve(300)).toBeLessThan(FOLLOW_STATUS_RUNWAY_PX)
  })

  it('matches the reference K=130 C=24 four-substep spring', () => {
    const frameMs = 1000 / 60
    const lag = 28
    const subDt = frameMs / 1000 / 4
    let expectedLag = lag
    let expectedVelocity = 0
    for (let substep = 0; substep < 4; substep += 1) {
      const acceleration = 130 * expectedLag - 24 * expectedVelocity
      expectedVelocity += acceleration * subDt
      expectedLag -= expectedVelocity * subDt
    }
    const step = computeFollowStep(frameMs, { lag, speedEma: FOLLOW_SPEED_REF_CPS })

    expect(step.advancePx).toBeCloseTo(lag - expectedLag, 5)
  })

  it('uses live diagnostics spring and backpressure tuning', () => {
    const baseline = computeFollowStep(16, { lag: 28, speedEma: FOLLOW_SPEED_REF_CPS })
    const stiffer = computeFollowStep(16, { lag: 28, speedEma: FOLLOW_SPEED_REF_CPS }, {
      ...DEFAULT_STREAM_DEBUG_TUNING,
      springStiffness: 260,
    })
    const lowerBackpressure = computeFollowRevealScale(48, 48, false, {
      ...DEFAULT_STREAM_DEBUG_TUNING,
      backpressureMinScale: 0.35,
    })

    expect(stiffer.advancePx).toBeGreaterThan(baseline.advancePx)
    expect(lowerBackpressure).toBe(0.35)
  })

  it('eases a wrap-sized lag instead of snapping it', () => {
    const step = computeFollowStep(16, { lag: 28, speedEma: FOLLOW_SPEED_REF_CPS })
    expect(step.advancePx).toBeGreaterThan(0.5)
    expect(step.advancePx).toBeLessThan(28)
    expect(step.lerpStep).toBeLessThan(0.25)
  })

  it('accelerates proportionally when the physical lag is high', () => {
    const slow = computeFollowStep(16, { lag: 28, speedEma: 20 })
    const fast = computeFollowStep(16, { lag: 200, speedEma: 120 })
    expect(fast.advancePx).toBeGreaterThan(slow.advancePx)
    expect(fast.lerpStep).toBeCloseTo(slow.lerpStep, 10)
  })

  it('settles when lag is already closed', () => {
    const step = computeFollowStep(16, { lag: 0, speedEma: 80 })
    expect(step.advancePx).toBe(0)
    expect(step.lerpStep).toBe(0)
  })

  it('closes a line-sized lag over many frames instead of one hop', () => {
    let lag = 28
    for (let frame = 0; frame < 10; frame += 1) {
      const step = computeFollowStep(16, { lag, speedEma: FOLLOW_SPEED_REF_CPS })
      expect(step.advancePx).toBeLessThan(8)
      lag -= step.advancePx
    }
    expect(lag).toBeGreaterThan(8)
    expect(lag).toBeLessThan(24)
  })

  it('tracks the reference response consistently across high-refresh frame rates', () => {
    const simulate = (frameMs: number): number => {
      let lag = 28
      let velocityPxPerSec = 0
      for (let elapsed = 0; elapsed < 500; elapsed += frameMs) {
        const dt = Math.min(frameMs, 500 - elapsed)
        const step = computeFollowStep(dt, {
          lag,
          speedEma: FOLLOW_SPEED_REF_CPS,
          velocityPxPerSec,
        })
        lag -= step.advancePx
        velocityPxPerSec = step.velocityPxPerSec
      }
      return lag
    }
    const at60Fps = simulate(1000 / 60)
    expect(simulate(1000 / 120)).toBeCloseTo(at60Fps, 0)
  })

  it('limits a stalled frame to the reference 32ms physics interval', () => {
    const lag = 200
    const stalled = computeFollowStep(250, { lag, speedEma: FOLLOW_SPEED_REF_CPS })
    const reference = computeFollowStep(32, { lag, speedEma: FOLLOW_SPEED_REF_CPS })
    expect(stalled.advancePx).toBeCloseTo(reference.advancePx, 8)
  })
})
