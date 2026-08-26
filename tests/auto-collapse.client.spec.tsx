/**
 * The auto-collapse coordinator folds finished turns behind one summary row,
 * keeps running and pure-reply turns untouched, honors manual toggling, and
 * restores every display value it touched on stop or session switch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AutoCollapseController,
  formatEnDuration,
  formatZhDuration,
} from '../src/client/auto-collapse-controller.ts'

const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] as const

let frameCallbacks: Array<() => void>
let controller: AutoCollapseController

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE] })
  frameCallbacks = []
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
    frameCallbacks.push(() => { callback(0) })
    return frameCallbacks.length
  })
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
  // The conversation UI is Chinese-first; individual tests may override.
  document.documentElement.lang = 'zh-CN'
})

afterEach(() => {
  controller?.stop()
  controller = undefined as unknown as AutoCollapseController
  for (const child of [...document.body.children]) child.remove()
  document.documentElement.lang = ''
  document.getElementById('dshss-auto-collapse-style')?.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Run one coordinated pass against the current DOM. */
function flush(): void {
  const pending = frameCallbacks
  frameCallbacks = []
  for (const callback of pending) callback()
}

function startController(): AutoCollapseController {
  controller = new AutoCollapseController()
  controller.start()
  return controller
}

function createFlow(): HTMLElement {
  const flow = document.createElement('div')
  flow.setAttribute('data-chat-flow', '')
  document.body.appendChild(flow)
  return flow
}

function addItem(flow: HTMLElement, kind: string, key?: string): HTMLElement {
  const item = document.createElement('div')
  item.setAttribute('data-chat-flow-kind', kind)
  if (key !== undefined) item.setAttribute('data-chat-flow-key', key)
  flow.appendChild(item)
  return item
}

function addParagraph(item: HTMLElement, text: string): HTMLElement {
  const paragraph = document.createElement('p')
  paragraph.textContent = text
  item.appendChild(paragraph)
  return paragraph
}

function addThink(item: HTMLElement, text: string, state = 'ok'): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('data-variant', 'think')
  row.setAttribute('data-state', state)
  row.textContent = text
  item.appendChild(row)
  return row
}

function addUser(flow: HTMLElement, key: string): HTMLElement {
  const item = addItem(flow, 'user', key)
  addParagraph(item, `question ${key}`)
  return item
}

function addToolCall(flow: HTMLElement, key: string, state = 'ok'): HTMLElement {
  const seat = addItem(flow, 'tool-call', key)
  const row = document.createElement('div')
  row.setAttribute('data-chat-call-id', `call-${key}`)
  // Native bash card shape (hand-rolled chrome family): variant + state,
  // no data-tool — matching the real BashRow DOM.
  const root = document.createElement('div')
  root.setAttribute('data-variant', 'bash')
  root.setAttribute('data-state', state)
  root.textContent = 'git status --porcelain'
  row.appendChild(root)
  seat.appendChild(row)
  return seat
}

function addTurnTail(flow: HTMLElement, text: string): HTMLElement {
  const item = addItem(flow, 'turn-tail')
  item.textContent = text
  return item
}

function summaryRow(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button.dshss-processed')
}

/** Controllable WAAPI stand-in: tests fire onfinish/oncancel by hand so the
 * animation ledger's arbitration can be exercised deterministically. */
interface FakeAnimation {
  host: HTMLElement | null
  onfinish: (() => void) | null
  oncancel: (() => void) | null
  canceled: boolean
  cancel(): void
  finishNow(): void
}

function makeFakeAnimation(host: HTMLElement | null): FakeAnimation {
  const anim: FakeAnimation = {
    host,
    onfinish: null,
    oncancel: null,
    canceled: false,
    cancel() {
      if (anim.canceled) return
      anim.canceled = true
      anim.oncancel?.()
    },
    finishNow() {
      if (anim.canceled) return
      anim.onfinish?.()
    },
  }
  return anim
}

describe('auto-collapse transitions', () => {
  let animations: FakeAnimation[]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE] })
    frameCallbacks = []
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      frameCallbacks.push(() => { callback(0) })
      return frameCallbacks.length
    })
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    document.documentElement.lang = 'zh-CN'
    animations = []
    // jsdom ships no Element.animate; install the controllable fake directly.
    ;(HTMLElement.prototype as { animate?: unknown }).animate = function fakeAnimate(this: HTMLElement): FakeAnimation {
      const anim = makeFakeAnimation(this)
      animations.push(anim)
      return anim
    }
  })

  afterEach(() => {
    controller?.stop()
    controller = undefined as unknown as AutoCollapseController
    for (const child of [...document.body.children]) child.remove()
    document.documentElement.lang = ''
    document.getElementById('dshss-auto-collapse-style')?.remove()
    delete (HTMLElement.prototype as { animate?: unknown }).animate
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function buildFinishedTurn(): { flow: HTMLElement; step: HTMLElement; think: HTMLElement } {
    const flow = createFlow()
    addUser(flow, 'u1')
    const step = addItem(flow, 'assistant-step', 's1')
    const think = addThink(step, 'reasoning')
    addParagraph(step, 'answer')
    addToolCall(flow, 't1')
    addTurnTail(flow, '用时 8秒')
    return { flow, step, think }
  }

  it('hides collapsed work synchronously — no deferred layout', () => {
    const { flow, think } = buildFinishedTurn()
    startController()
    flush()

    // The whole point of the motion model: even with WAAPI available, hidden
    // work lands on its final display value in the same pass that decides the
    // fold, so the squeeze always measures the true end geometry.
    expect(think.style.display).toBe('none')
    expect(flow.querySelector<HTMLElement>('[data-chat-flow-kind="tool-call"]')?.style.display).toBe('none')
    expect(summaryRow()).not.toBeNull()
    // The only element animation is the summary row's paint-only flourish;
    // geometry rides the column squeeze instead.
    expect(animations.every(anim => anim.host === flow || anim.host?.classList.contains('dshss-processed'))).toBe(true)
  })

  it('applies manual expansion synchronously', () => {
    const { flow, think, step } = buildFinishedTurn()
    startController()
    flush()
    expect(summaryRow()).not.toBeNull()

    summaryRow()?.click()
    flush()
    expect(summaryRow()?.getAttribute('aria-expanded')).toBe('true')
    expect(think.style.display).toBe('')
    expect(step.style.display).toBe('')
    expect(flow.querySelector<HTMLElement>('[data-chat-flow-kind="tool-call"]')?.style.display).toBe('')
  })

  it('restores true displays when stopped with transitions in flight', () => {
    const { think } = buildFinishedTurn()
    startController()
    flush()
    expect(animations.length).toBeGreaterThan(0)

    controller.stop()
    expect(think.style.display).toBe('')
    expect(document.getElementById('dshss-auto-collapse-style')).toBeNull()
  })

  it('keeps geometry untouched after the fold settles', () => {
    const { flow } = buildFinishedTurn()
    startController()
    flush()

    // No squeeze, no pins: the column carries zero inline geometry once the
    // synchronous pass is done, so nothing can drift afterwards.
    expect(flow.style.height).toBe('')
    expect(flow.style.overflow).toBe('')
    expect(flow.style.boxSizing).toBe('')

    // The only animation left is the summary row's paint-only fade.
    for (const anim of animations) {
      expect(anim.host?.classList.contains('dshss-processed')).toBe(true)
    }
  })

  it('folds context, command, and compaction seats like other work process', () => {
    const flow = createFlow()
    addUser(flow, 'u1')
    const context = addItem(flow, 'context', 'c1')
    context.textContent = '上下文注入'
    const command = addItem(flow, 'command', 'cmd1')
    const commandRow = document.createElement('div')
    commandRow.setAttribute('data-variant', 'others')
    commandRow.setAttribute('data-state', 'ok')
    commandRow.textContent = 'pnpm test'
    command.appendChild(commandRow)
    const compaction = addItem(flow, 'manual-compaction', 'mc1')
    compaction.textContent = '手动压缩'
    const step = addItem(flow, 'assistant-step', 's1')
    addParagraph(step, 'summary of the compacted history')
    addTurnTail(flow, '用时 15秒')

    startController()
    flush()

    expect(context.style.display).toBe('none')
    expect(command.style.display).toBe('none')
    expect(compaction.style.display).toBe('none')
    expect(step.style.display).toBe('')
    expect(summaryRow()?.nextElementSibling).toBe(context)
  })
})

describe('auto-collapse coordinator', () => {
  it('folds a finished turn behind one localized summary row', () => {
    const flow = createFlow()
    addUser(flow, 'u1')
    const thinkingStep = addItem(flow, 'assistant-step', 's1')
    addThink(thinkingStep, 'need status')
    addParagraph(thinkingStep, 'intermediate note')
    const toolSeat = addToolCall(flow, 't1')
    const finalStep = addItem(flow, 'assistant-step', 's2')
    const finalThink = addThink(finalStep, 'wrap up')
    addParagraph(finalStep, 'final answer')
    addTurnTail(flow, '用时 12秒')

    startController()
    flush()

    expect(thinkingStep.style.display).toBe('none')
    expect(toolSeat.style.display).toBe('none')
    expect(finalThink.style.display).toBe('none')
    expect(finalStep.style.display).toBe('')
    const row = summaryRow()
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain('已处理 12秒')
    expect(row?.getAttribute('aria-expanded')).toBe('false')
    expect(row?.nextElementSibling).toBe(thinkingStep)
  })

  it('falls back to English copy for other locales', () => {
    document.documentElement.lang = 'en-US'
    const flow = createFlow()
    addUser(flow, 'u1')
    addToolCall(flow, 't1')
    const step = addItem(flow, 'assistant-step', 's1')
    addParagraph(step, 'done')
    addTurnTail(flow, 'Ran for 2m 05s')

    startController()
    flush()

    expect(summaryRow()?.textContent).toContain('Processed 2m05s')
  })

  it('keeps a running turn fully expanded', () => {
    const flow = createFlow()
    addUser(flow, 'u1')
    const step = addItem(flow, 'assistant-step', 's1')
    addThink(step, 'working', 'running')
    addToolCall(flow, 't1', 'running')

    startController()
    flush()

    expect(step.style.display).toBe('')
    expect(flow.querySelector<HTMLElement>('[data-chat-flow-kind="tool-call"]')?.style.display).toBe('')
    expect(summaryRow()).toBeNull()
  })

  it('gives a pure reply turn no summary row', () => {
    const flow = createFlow()
    addUser(flow, 'u1')
    const step = addItem(flow, 'assistant-step', 's1')
    addParagraph(step, 'plain answer')
    addTurnTail(flow, '用时 4秒')

    startController()
    flush()

    expect(summaryRow()).toBeNull()
    expect(step.style.display).toBe('')
  })

  it('expands and re-collapses through manual clicks only', () => {
    const flow = createFlow()
    addUser(flow, 'u1')
    const step = addItem(flow, 'assistant-step', 's1')
    const think = addThink(step, 'reasoning')
    addParagraph(step, 'answer')
    const toolSeat = addToolCall(flow, 't1')
    addTurnTail(flow, '用时 8秒')

    startController()
    flush()
    const row = summaryRow()
    expect(row).not.toBeNull()
    // A lone reply-bearing message is the final answer: only its thinking
    // rows and the surrounding work seats fold away.
    expect(think.style.display).toBe('none')
    expect(toolSeat.style.display).toBe('none')

    row?.click()
    flush()
    expect(row?.getAttribute('aria-expanded')).toBe('true')
    expect(think.style.display).toBe('')
    expect(toolSeat.style.display).toBe('')

    row?.click()
    flush()
    expect(row?.getAttribute('aria-expanded')).toBe('false')
    expect(think.style.display).toBe('none')
    expect(toolSeat.style.display).toBe('none')
    expect(step.style.display).toBe('')
  })

  it('keeps the final answer of each steering-split segment visible', () => {
    const flow = createFlow()
    addUser(flow, 'u1')
    const middle = addItem(flow, 'assistant-step', 'm1')
    addThink(middle, 'first try')
    addParagraph(middle, 'draft answer')
    const finalA = addItem(flow, 'assistant-step', 'fa')
    addParagraph(finalA, 'refined answer')
    addItem(flow, 'steering', 'st1')
    const finalB = addItem(flow, 'assistant-step', 'fb')
    addParagraph(finalB, 'post-steering answer')
    addTurnTail(flow, '用时 20秒')

    startController()
    flush()

    expect(middle.style.display).toBe('none')
    expect(finalA.style.display).toBe('')
    expect(finalB.style.display).toBe('')
    // The second segment carries no work process, so only one row appears.
    expect(document.querySelectorAll('button.dshss-processed').length).toBe(1)
  })

  it('restores every display value on stop', () => {
    const flow = createFlow()
    addUser(flow, 'u1')
    const step = addItem(flow, 'assistant-step', 's1')
    const think = addThink(step, 'reasoning')
    addParagraph(step, 'answer')
    const toolSeat = addToolCall(flow, 't1')
    addTurnTail(flow, '用时 6秒')

    startController()
    flush()
    expect(think.style.display).toBe('none')
    expect(toolSeat.style.display).toBe('none')

    controller.stop()
    expect(think.style.display).toBe('')
    expect(toolSeat.style.display).toBe('')
    expect(summaryRow()).toBeNull()
    expect(document.getElementById('dshss-auto-collapse-style')).toBeNull()
  })

  it('rebuilds cleanly when the host swaps in another session flow', () => {
    const first = createFlow()
    addUser(first, 'u1')
    const firstStep = addItem(first, 'assistant-step', 's1')
    const firstThink = addThink(firstStep, 'old reasoning')
    addParagraph(firstStep, 'old answer')
    addTurnTail(first, '用时 5秒')

    startController()
    flush()
    expect(firstThink.style.display).toBe('none')

    first.remove()
    const second = createFlow()
    addUser(second, 'u2')
    const secondStep = addItem(second, 'assistant-step', 's2')
    const secondThink = addThink(secondStep, 'new reasoning')
    addParagraph(secondStep, 'new answer')
    addTurnTail(second, '用时 7秒')
    controller.refresh()
    flush()

    expect(firstThink.style.display).toBe('')
    expect(secondThink.style.display).toBe('none')
    expect(secondStep.style.display).toBe('')
    expect(summaryRow()?.parentElement).toBe(second)
  })

  it('restores a thinking-only message once a late reply arrives', () => {
    const flow = createFlow()
    addUser(flow, 'u1')
    const step = addItem(flow, 'assistant-step', 's1')
    addThink(step, 'only reasoning so far')
    addTurnTail(flow, '用时 9秒')

    startController()
    flush()
    expect(step.style.display).toBe('none')
    expect(summaryRow()).not.toBeNull()

    addParagraph(step, 'late final answer')
    controller.refresh()
    flush()

    expect(step.style.display).toBe('')
    expect(step.querySelector<HTMLElement>('[data-variant="think"]')?.style.display).toBe('none')
    expect(summaryRow()).not.toBeNull()
  })

  it('freezes the local duration of turns without an official elapsed time', () => {
    const now = vi.spyOn(Date, 'now')
    let clock = 1_000_000
    now.mockImplementation(() => clock)

    const flow = createFlow()
    addUser(flow, 'u1')
    const step = addItem(flow, 'assistant-step', 's1')
    addThink(step, 'reasoning')
    addParagraph(step, 'answer')
    addToolCall(flow, 't1', 'running')

    startController()
    flush()
    expect(summaryRow()).toBeNull()
    clock += 21_000

    // Turn ends without a 用时 tail (stopped turn): settle from local timing.
    flow.querySelector<HTMLElement>('[data-variant="bash"]')?.setAttribute('data-state', 'ok')
    addTurnTail(flow, '8月14日 22:11')
    controller.refresh()
    flush()
    expect(summaryRow()?.textContent).toContain('已处理 21秒')

    // The frozen label must not tick with further passes.
    clock += 60_000
    controller.refresh()
    flush()
    expect(summaryRow()?.textContent).toContain('已处理 21秒')
    now.mockRestore()
  })

  it('leaves other plugins\' flow seats untouched while folding core work', () => {
    const flow = createFlow()
    addUser(flow, 'u1')
    // A third-party plugin contributed this seat via its own chat-node slot;
    // neither its kind nor its contents are ours to fold.
    const foreignSeat = addItem(flow, 'acme-panel', 'p1')
    const foreignCall = document.createElement('div')
    foreignCall.setAttribute('data-chat-call-id', 'foreign-call')
    foreignCall.textContent = '看起来像工具卡的插件面板'
    foreignSeat.appendChild(foreignCall)
    const toolSeat = addToolCall(flow, 't1')
    const step = addItem(flow, 'assistant-step', 's1')
    addThink(step, 'reasoning')
    addParagraph(step, 'answer')
    addTurnTail(flow, '用时 8秒')

    startController()
    flush()

    expect(toolSeat.style.display).toBe('none')
    expect(step.querySelector<HTMLElement>('[data-variant="think"]')?.style.display).toBe('none')
    expect(foreignSeat.style.display).toBe('')
    expect(summaryRow()).not.toBeNull()
  })

  it('leaves custom tool views (no native card chrome) unfolded', () => {
    const flow = createFlow()
    addUser(flow, 'u1')
    // dsh-pianist-style tool: registered on tool.call.toolview, so the seat
    // kind is core `tool-call`, but its view replaces the native ToolRow
    // chrome entirely.
    const pianoSeat = addItem(flow, 'tool-call', 'piano1')
    const pianoRow = document.createElement('div')
    pianoRow.setAttribute('data-chat-call-id', 'call-piano1')
    pianoRow.setAttribute('data-chat-anchor-key', 'call:piano1')
    pianoRow.innerHTML = '<section data-pianist-performance="p1"><div class="piano-keys"></div></section>'
    pianoSeat.appendChild(pianoRow)
    const step = addItem(flow, 'assistant-step', 's1')
    addParagraph(step, '演奏完成了，请欣赏。')
    addTurnTail(flow, '用时 9秒')

    startController()
    flush()

    expect(pianoSeat.style.display).toBe('')
    expect(summaryRow()).toBeNull()
  })

  it('still folds a turn that mixes custom and native tool cards', () => {
    const flow = createFlow()
    addUser(flow, 'u1')
    const pianoSeat = addItem(flow, 'tool-call', 'piano2')
    const pianoRow = document.createElement('div')
    pianoRow.setAttribute('data-chat-call-id', 'call-piano2')
    pianoRow.innerHTML = '<section data-pianist-performance="p2"></section>'
    pianoSeat.appendChild(pianoRow)
    // A second seat in the same turn renders a native bash card.
    addToolCall(flow, 't2')

    const step = addItem(flow, 'assistant-step', 's1')
    addThink(step, 'reasoning')
    addParagraph(step, 'done')
    addTurnTail(flow, '用时 11秒')

    startController()
    flush()

    expect(flow.querySelector<HTMLElement>('[data-chat-flow-kind="tool-call"][data-chat-flow-key="t2"]')?.style.display).toBe('none')
    expect(step.querySelector<HTMLElement>('[data-variant="think"]')?.style.display).toBe('none')
    expect(pianoSeat.style.display).toBe('')
    expect(summaryRow()).not.toBeNull()
  })
})

describe('auto-collapse durations', () => {
  it('formats compact localized durations', () => {
    expect(formatZhDuration(14_000)).toBe('14秒')
    expect(formatZhDuration(125_000)).toBe('2分05秒')
    expect(formatZhDuration(900_000)).toBe('15分')
    expect(formatZhDuration(10_800_000)).toBe('3小时')
    expect(formatEnDuration(14_000)).toBe('14s')
    expect(formatEnDuration(125_000)).toBe('2m05s')
    expect(formatEnDuration(900_000)).toBe('15m')
    expect(formatEnDuration(10_920_000)).toBe('3h2m')
  })
})
