import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useRef, type FunctionComponent } from 'react'
import { TypewriterAssistantNodeView } from '../src/client/TypewriterAssistantNodeView.tsx'
import {
  computeFollowStep,
  FOLLOW_SPEED_REF_CPS,
  FOLLOW_STATUS_RUNWAY_PX,
  useConversationFollow,
} from '../src/client/teleprompterGlide.ts'
import {
  BACKLOG_CHAR_CEILING,
  BACKLOG_SECOND_CEILING,
  PRESET_CONFIG,
  computeAdaptiveQueueStep,
  computeQueueReveal,
  computeSettleDrain,
  useSmoothStreamContent,
} from '../src/client/useSmoothStreamContent.ts'
import { apply, inject } from '../src/client/index.ts'
import { isGrowingChatNode, wrapFollowNodeView } from '../src/client/TypewriterToolNodeView.tsx'
import { DEFAULT_STREAM_CONFIG, STREAM_BOOT_GLOBAL } from '../src/config.ts'
import { Config } from '../src/plugin.ts'
import css from '../src/client/TypewriterAssistantNodeView.module.css'

const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] as const

afterEach(() => {
  cleanup()
  vi.useRealTimers()
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

function SmoothProbe({ text, shouldHoldBack, steadyCps }: { text: string; shouldHoldBack?: () => boolean; steadyCps?: number }) {
  const displayed = useSmoothStreamContent(text, { shouldHoldBack, steadyCps })
  return <span>{displayed}</span>
}

function FollowProbe() {
  const rootRef = useRef<HTMLDivElement>(null)
  const speedCpsRef = useRef(FOLLOW_SPEED_REF_CPS)
  useConversationFollow(rootRef, true, speedCpsRef)
  return <div ref={rootRef} data-chat-transcript>Streaming response</div>
}

describe('useSmoothStreamContent', () => {
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
})

describe('assistant renderer', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: [...FAKE] }))

  it('does not jump the visible transcript when one new line lands', async () => {
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
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 176 } as DOMRect)

    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(80))
    const before = -port.scrollTop + currentTranslate(transcript)

    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    const after = -port.scrollTop + currentTranslate(transcript)

    expect(Math.abs(after - before)).toBeLessThanOrEqual(4)
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
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 400, bottom: 480 } as DOMRect)

    try {
      port.scrollTop = 390
      act(() => frames.shift()?.(0))
      const before = -port.scrollTop + currentTranslate(transcript)
      baseHeight = 700
      act(() => frames.shift()?.(100))

      const after = -port.scrollTop + currentTranslate(transcript)
      const expectedAdvance = computeFollowStep(32, {
        lag: 200,
        speedEma: FOLLOW_SPEED_REF_CPS,
      }).advancePx
      expect(before - after).toBeCloseTo(expectedAdvance, 5)
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

  it('gives only the active final text block an announcement', () => {
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'second' },
    ])} />)
    expect(view.container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)
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
    expect(port.scrollTop).toBeLessThan(550)

    height = 800
    const beforeGrowth = port.scrollTop
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    expect(port.scrollTop).toBeGreaterThan(beforeGrowth)
  })

  it('unpins on a light upward wheel instead of requiring a 25px engine lag', async () => {
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
    port.scrollTop = 385
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(port.scrollTop).toBe(385)
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
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(transcript.style.marginBottom) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockReturnValue({ top: 128, bottom: 154 } as DOMRect)
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

    for (let elapsed = 0; elapsed < 1200; elapsed += 16) {
      await act(() => vi.advanceTimersByTimeAsync(16))
      const shift = currentTranslate(transcript)
      const runway = Number.parseFloat(transcript.style.marginBottom) || 0
      // While the temporary runway contributes to the scroll floor, an equal
      // transform is the natural final position. Going below it scrolls past
      // the final resting point and produces a rebound when runway is removed.
      expect(shift === 0 ? runway : shift - runway).toBeGreaterThanOrEqual(-0.1)
    }
    expect(transcript.style.transform).toBe('')
    expect(transcript.style.marginBottom).toBe('')
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

    fireEvent.wheel(port, { deltaY: -60 })
    port.scrollTop = 500
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
    expect(port.scrollTop).toBeGreaterThan(400)
    expect(port.scrollTop).toBeLessThanOrEqual(428)
    expect(currentTranslate(surface)).toBeGreaterThan(0)
    expect(surface.getBoundingClientRect().bottom).toBeLessThan(88)
    expect(Math.abs((-port.scrollTop + currentTranslate(surface)) - before)).toBeLessThanOrEqual(4)

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
    expect(port.scrollTop).toBeLessThan(1100)
    expect(flow.style.transform).toBe('')
    const burstShift = currentTranslate(rows[0] as HTMLElement)
    expect(burstShift).toBeGreaterThanOrEqual(initialShift)
    expect(80 + burstShift).toBeLessThan(96)
    for (const row of rows) {
      expect(currentTranslate(row)).toBeCloseTo(burstShift, 5)
    }
    expect(flow.style.clipPath).toBe('')
    expect(label.style.clipPath).toBe('')

    // The paint ceiling caps the visible transform, but must not erase the
    // much larger logical lag. It therefore stays capped for several frames
    // instead of collapsing immediately from a synthetic bounded extent.
    await act(() => vi.advanceTimersByTimeAsync(64))
    expect(currentTranslate(rows[0] as HTMLElement)).toBeCloseTo(burstShift, 1)
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

  it('carries lag in scrollTop when layout exposes no safe paint clearance', async () => {
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
    expect(port.scrollTop).toBeLessThan(1100)
    expect(flow.style.transform).toBe('')
    expect(transcript.style.transform).toBe('')
    expect(transcript.style.clipPath).toBe('')
    expect(currentTranslate(chrome)).toBeLessThan(0)
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
    expect(port.scrollTop).toBeGreaterThan(beforeStatusLeaves)
    expect(port.scrollTop).toBeLessThan(1100)
    expect(transcript.style.transform).toBe('')
    expect(transcript.style.clipPath).toBe('')

    view.unmount()
    expect(flow.style.transform).toBe('')
    expect(flow.style.willChange).toBe('')
  })

  it('splits burst lag while status, jump control, and composer stay fixed', async () => {
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
      return { top: 96 + runway, bottom: 122 + runway } as DOMRect
    })
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 240 } as DOMRect)
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    const beforeBurst = port.scrollTop

    height = 1200
    await act(() => vi.advanceTimersByTimeAsync(16))

    expect(port.scrollTop).toBeGreaterThan(beforeBurst)
    expect(port.scrollTop).toBeLessThan(1100)
    const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(surface.style.transform)?.[1] ?? 0)
    expect(shift).toBeGreaterThanOrEqual(28)
    expect(80 + shift).toBeLessThan(96 + (Number.parseFloat(status.style.marginTop) || 0))
    expect(surface.style.clipPath).toBe('')
    expect(currentTranslate(status)).toBeLessThan(0)
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
    expect(port.scrollTop).toBeLessThan(1100)
    expect(80 + shift).toBeLessThan(140)
    expect(surface.style.clipPath).toBe('')
  })

  it('hands the transformed visual position back on an upward reader gesture', async () => {
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
    vi.spyOn(surface, 'getBoundingClientRect').mockImplementation(() => {
      const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(surface.style.transform)?.[1] ?? 0)
      return { top: 0, bottom: 80 + shift } as DOMRect
    })
    vi.spyOn(status, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 122 } as DOMRect)
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(32))
    height += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(surface.style.transform)?.[1] ?? 0)
    expect(shift).toBeGreaterThan(0)

    fireEvent.wheel(port, { deltaY: -60 })
    port.scrollTop = 340
    await act(() => vi.advanceTimersByTimeAsync(16))

    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(port.scrollTop).toBeCloseTo(340 - shift, 5)
    expect(surface.style.transform).toBe('')
    expect(status.style.marginTop).toBe('16px')

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
    expect(port.scrollTop).toBeLessThan(620)
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
    expect(view.container.textContent).toContain('tool:running')

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.chat.node').find(item => item.options.key === 'tool-call')?.component).toBe(DummyTool)
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
    expect(view.container.textContent).toContain('late')
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
  ])('glides the final $label height instead of dropping it in one frame', async ({ running, settled }) => {
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
    expect(view.container.textContent).toContain('final output')
    expect(port.scrollTop).toBeGreaterThan(400)
    expect(port.scrollTop).toBeLessThan(600)
    expect(landed).toBeGreaterThan(0)
    const landedVisual = -port.scrollTop + landed
    expect(landedVisual).toBeCloseTo(before, 5)
    await act(() => vi.advanceTimersByTimeAsync(32))
    const nextVisual = -port.scrollTop + currentTranslate(transcript)
    expect(nextVisual).toBeLessThan(landedVisual)
    expect(landedVisual - nextVisual).toBeLessThan(40)
    await act(() => vi.advanceTimersByTimeAsync(320))
    expect(port.scrollTop).toBeGreaterThan(500)
  })

  it('hosts follow only while the wrapped node is growing', () => {
    function Inner({ node }: { node: { data: { root: object } } }) {
      return <span>{'kind' in node.data.root ? 'done' : 'live'}</span>
    }
    const Wrapped = wrapFollowNodeView(Inner as never)
    const live = render(<Wrapped node={{ data: { root: { callId: '1' } } }} />)
    expect(live.container.querySelector(`.${css.follow}`)).not.toBeNull()
    expect(live.container.textContent).toBe('live')
    const done = render(<Wrapped node={{ data: { root: { kind: 'tool-result', callId: '1' } } }} />)
    expect(done.container.textContent).toBe('done')
  })
})

describe('computeFollowStep', () => {
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
