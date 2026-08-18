import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type FunctionComponent } from 'react'
import { TypewriterAssistantNodeView } from '../src/client/TypewriterAssistantNodeView.tsx'
import {
  computeFollowStep,
  FOLLOW_LERP_DT_MS,
  FOLLOW_LERP_MAX,
  FOLLOW_SPEED_REF_CPS,
} from '../src/client/teleprompterGlide.ts'
import {
  BACKLOG_CHAR_CEILING,
  BACKLOG_SECOND_CEILING,
  PRESET_CONFIG,
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

function SmoothProbe({ text, shouldHoldBack, steadyCps }: { text: string; shouldHoldBack?: () => boolean; steadyCps?: number }) {
  const displayed = useSmoothStreamContent(text, { shouldHoldBack, steadyCps })
  return <span>{displayed}</span>
}

describe('useSmoothStreamContent', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: [...FAKE] }))

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

  it('reveals at the steady rate while input streams and drains at 1.8x after', async () => {
    const view = render(<SmoothProbe text="" steadyCps={25} />)
    view.rerender(<SmoothProbe text={'x'.repeat(100)} steadyCps={25} />)
    // ~48ms minimum commit interval: a few commits land, far below the input.
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
    expect(partial).toBeGreaterThan(40)
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

  it('does not render a caret while streaming', () => {
    const block = { kind: 'text', text: 'hello' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
    expect(view.container.textContent).not.toContain('▍')
  })

  it('renders streaming text through Markdown without a raw-text tail', () => {
    const block = { kind: 'text', text: '**finished**' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
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

    // The owner must survive the content-type handoff without an intermediate
    // cleanup write. The next frames express growth as transcript lag, so the
    // effective visual top may advance but must never move upward.
    expect(port.scrollTop).toBe(400)
    const visualTop = () => {
      const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(
        (view.container.querySelector('[data-chat-transcript]') as HTMLElement).style.transform,
      )?.[1] ?? 0)
      return port.scrollTop - shift
    }
    for (const collapsingHeight of [1200, 1100, 1000, 900]) {
      height = collapsingHeight
      await act(() => vi.advanceTimersByTimeAsync(16))
      expect(port.scrollTop).toBeGreaterThan(0)
      expect(visualTop()).toBeGreaterThanOrEqual(399)
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

  it('glides the growing conversation port toward the floor while streaming', async () => {
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
    expect(port.scrollTop).toBeGreaterThan(390)
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
    expect(port.scrollTop).toBe(550)

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

  it('hands the reader the lag-compensated position on unpin, not the engine floor', async () => {
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
    // Engine pinned at the floor; the glide lag rides on the transcript.
    expect(port.scrollTop).toBe(400)
    const lagBefore = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(transcript.style.transform)?.[1] ?? -1)
    expect(lagBefore).toBeGreaterThan(0)
    expect(transcript.style.clipPath).toBe('')

    // Reader pulls the engine up beyond the slack band; the effective visual
    // top is engine - lag.
    fireEvent.wheel(port, { deltaY: -60 })
    port.scrollTop = 340
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(transcript.style.transform).toBe('')
    expect(transcript.style.clipPath).toBe('')
    // Continuity: after the transform clears, scrollTop IS the visual top the
    // reader was seeing (engine - lag), not the pre-unpin engine position.
    expect(port.scrollTop).toBeCloseTo(340 - lagBefore, 1)
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
    expect(port.scrollTop).toBeLessThan(340)
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

  it('shifts message rows, not the turn-status sibling, when the host has no transcript box', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    let height = 500
    const statusGap = 16
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="a">
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
          <div data-chat-anchor-key="b"><span>older</span></div>
          <div role="status">Deep diving...</div>
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const flow = view.container.querySelector('[data-chat-flow]') as HTMLElement
    const label = view.container.querySelector('[role="status"]') as HTMLElement
    const rows = flow.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    vi.spyOn(rows[1] as HTMLElement, 'getBoundingClientRect').mockImplementation(() => {
      const row = rows[1] as HTMLElement
      const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(row.style.transform)?.[1] ?? 0)
      return { top: 100 + shift, bottom: 200 + shift } as DOMRect
    })
    vi.spyOn(label, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 200 + statusGap, bottom: 200 + statusGap + 26 }) as DOMRect,
    )
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    // Engine pinned at the floor; the lag rides the message rows only.
    expect(port.scrollTop).toBe(400)
    expect(flow.style.transform).toBe('')
    expect(label.style.transform).toBe('')
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(row.style.transform).toMatch(/^translate3d\(0(px)?, \d/)
    }
    expect(rows[0]?.style.clipPath).toBe('')
    expect(rows[1]?.style.clipPath).toBe('')

    height = 1200
    await act(() => vi.advanceTimersByTimeAsync(16))
    const last = rows[1] as HTMLElement
    const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(last.style.transform)?.[1] ?? -1)
    const bottomClip = Number(/inset\(0(?:px)? 0(?:px)? ([\d.]+)px 0(?:px)?\)/.exec(last.style.clipPath)?.[1] ?? -1)
    expect(shift).toBeGreaterThan(25)
    expect(bottomClip).toBeCloseTo(shift - statusGap, 5)
  })

  it('shifts only the outermost rows so nested tool subcalls do not double-shift', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
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
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const flow = view.container.querySelector('[data-chat-flow]') as HTMLElement
    const outer = flow.querySelector('[data-chat-anchor-key="a"]') as HTMLElement
    const sub = flow.querySelector('[data-chat-anchor-key="a:sub"]') as HTMLElement
    const sibling = flow.querySelector('[data-chat-anchor-key="b"]') as HTMLElement
    const label = view.container.querySelector('[role="status"]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    // The lag rides the outermost rows only; a nested subcall row is not
    // shifted on its own (it would tear away from its parent by the lag).
    expect(outer.style.transform).toMatch(/^translate3d\(0(px)?, \d/)
    expect(sibling.style.transform).toMatch(/^translate3d\(0(px)?, \d/)
    expect(sub.style.transform).toBe('')
    expect(outer.style.clipPath).toBe('')
    expect(sibling.style.clipPath).toMatch(/^inset\(0(px)? 0(px)? [\d.]+px 0(px)?\)$/)
    expect(sub.style.clipPath).toBe('')
    expect(flow.style.transform).toBe('')
    expect(label.style.transform).toBe('')
  })

  it('clips transcript paint at the status line, preserving the natural gap', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    let height = 500
    const statusGap = 16
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
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => {
      const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(transcript.style.transform)?.[1] ?? 0)
      return { top: 0, bottom: height + shift } as DOMRect
    })
    vi.spyOn(chrome, 'getBoundingClientRect').mockImplementation(
      () => ({ top: height + statusGap, bottom: height + statusGap + 24 }) as DOMRect,
    )
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))

    const initialShift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(transcript.style.transform)?.[1] ?? -1)
    expect(initialShift).toBeGreaterThan(0)
    expect(initialShift).toBeLessThan(statusGap)
    expect(transcript.style.clipPath).toBe('')

    // Simulate a fast chunk or an FPS-guard flush landing in one layout pass.
    height = 1200
    await act(() => vi.advanceTimersByTimeAsync(16))
    const shift = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(transcript.style.transform)?.[1] ?? -1)
    const bottomClip = Number(/inset\(0(?:px)? 0(?:px)? ([\d.]+)px 0(?:px)?\)/.exec(transcript.style.clipPath)?.[1] ?? -1)
    expect(shift).toBeGreaterThan(25)
    expect(bottomClip).toBeCloseTo(shift - statusGap, 5)
    // Preserve the layout gap as usable reveal space; only paint that would
    // enter the status line itself is clipped.
    const naturalBottom = height
    expect(naturalBottom + shift - bottomClip).toBeCloseTo(naturalBottom + statusGap, 5)
    expect(chrome.style.transform).toBe('')

    view.unmount()
    expect(transcript.style.transform).toBe('')
    expect(transcript.style.clipPath).toBe('')
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
    expect(port.scrollTop).toBeGreaterThan(390)
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
    expect(container.querySelector('strong')?.textContent).toBe('hello')
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
  it('types one glyph per frame when the queue is small', () => {
    expect(computeQueueReveal(3, 16.67)).toBe(1)
  })

  it('raises the step when the queue is backlogged', () => {
    expect(computeQueueReveal(40, 16.67)).toBe(5)
    expect(computeQueueReveal(80, 16.67)).toBe(10)
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
  it('eases a wrap-sized lag instead of snapping it', () => {
    const step = computeFollowStep(16, { lag: 28, speedEma: FOLLOW_SPEED_REF_CPS })
    expect(step.advancePx).toBeGreaterThan(0.5)
    expect(step.advancePx).toBeLessThan(28)
    expect(step.lerpStep).toBeLessThan(FOLLOW_LERP_MAX)
  })

  it('accelerates when reveal speed or lag is high', () => {
    const slow = computeFollowStep(16, { lag: 28, speedEma: 20 })
    const fast = computeFollowStep(16, { lag: 200, speedEma: 120 })
    expect(fast.advancePx).toBeGreaterThan(slow.advancePx)
    expect(fast.lerpStep).toBeGreaterThan(slow.lerpStep)
  })

  it('settles when lag is already closed', () => {
    const step = computeFollowStep(16, { lag: 0, speedEma: 80 })
    expect(step.advancePx).toBe(0)
    expect(step.lerpStep).toBe(0)
  })

  it('uses the demo dt term', () => {
    const step = computeFollowStep(FOLLOW_LERP_DT_MS, { lag: 160, speedEma: FOLLOW_SPEED_REF_CPS })
    // lag == LAG_REF and speedFactor == 1 → baseLerp saturates at MAX; dt term is 1 - 1/e.
    expect(step.lerpStep).toBeCloseTo(FOLLOW_LERP_MAX * (1 - Math.exp(-1)), 5)
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
})
