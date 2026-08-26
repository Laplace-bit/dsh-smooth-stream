/**
 * End-to-end wiring for auto-collapse: composing the browser entry through a
 * real Cordis context must start the fold lifecycle (style injected, observer
 * armed) and fold a completed turn rendered in the document — the seam where
 * "the settings toggle exists but nothing folds" lives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { STREAM_SETTINGS_RPC } from '../src/settings-api.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'

const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] as const

/** Faithful frame queue: cancelAnimationFrame really removes the callback,
 * so a stop() between schedule() and the frame kills the pass like a browser. */
let frameQueue: Map<number, () => void>
let nextFrameId: number

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE] })
  frameQueue = new Map()
  nextFrameId = 0
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
    nextFrameId += 1
    frameQueue.set(nextFrameId, () => { callback(0) })
    return nextFrameId
  })
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(((handle: number) => {
    frameQueue.delete(handle)
    return undefined
  }) as typeof cancelAnimationFrame)
  document.documentElement.lang = 'zh-CN'
})

afterEach(() => {
  for (const child of [...document.body.children]) child.remove()
  document.getElementById('dshss-auto-collapse-style')?.remove()
  document.documentElement.lang = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function flushPasses(): void {
  const pending = [...frameQueue.values()]
  frameQueue.clear()
  for (const callback of pending) callback()
}

/** Minimal Harness-shaped conversation: one finished tool-using turn. */
function renderFinishedTurn(parent: HTMLElement = document.body): {
  flow: HTMLElement
  thinkingStep: HTMLElement
  finalStep: HTMLElement
} {
  const flow = document.createElement('div')
  flow.setAttribute('data-chat-flow', '')
  parent.appendChild(flow)
  const addItem = (kind: string, key?: string): HTMLElement => {
    const item = document.createElement('div')
    item.setAttribute('data-chat-flow-kind', kind)
    if (key !== undefined) item.setAttribute('data-chat-flow-key', key)
    flow.appendChild(item)
    return item
  }
  addUser(addItem)
  const thinkingStep = addItem('assistant-step', 's1')
  addThink(thinkingStep, 'reasoning')
  addParagraph(thinkingStep, 'intermediate note')
  addToolCall(addItem)
  const finalStep = addItem('assistant-step', 's2')
  addParagraph(finalStep, 'final answer')
  addTurnTail(addItem)
  return { flow, thinkingStep, finalStep }
}

function addUser(addItem: (kind: string, key?: string) => HTMLElement): void {
  const user = addItem('user', 'u1')
  addParagraph(user, 'question')
}

function addToolCall(addItem: (kind: string, key?: string) => HTMLElement): void {
  const seat = addItem('tool-call', 't1')
  const row = document.createElement('div')
  row.setAttribute('data-chat-call-id', 'call-t1')
  // Native bash card shape: variant + state (hand-rolled chrome family).
  const root = document.createElement('div')
  root.setAttribute('data-variant', 'bash')
  root.setAttribute('data-state', 'ok')
  root.textContent = 'git status'
  row.appendChild(root)
  seat.appendChild(row)
}

function addThink(item: HTMLElement, text: string): void {
  const row = document.createElement('div')
  row.setAttribute('data-variant', 'think')
  row.setAttribute('data-state', 'ok')
  row.textContent = text
  item.appendChild(row)
}

function addParagraph(item: HTMLElement, text: string): void {
  const paragraph = document.createElement('p')
  paragraph.textContent = text
  item.appendChild(paragraph)
}

function addTurnTail(addItem: (kind: string, key?: string) => HTMLElement): void {
  addItem('turn-tail').textContent = '用时 12秒'
}

async function bootClient(options: { readGate?: Promise<void> } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const call = vi.fn(async (_channel: string, endpoint: string) => {
    if (endpoint === STREAM_SETTINGS_RPC.read) {
      await options.readGate
      return {
        ok: true as const,
        value: {
          version: '0.0.0-test',
          installation: 'development' as const,
          writable: true,
          enabled: true,
          thinkAutoExpand: true,
          autoCollapse: true,
          canUpgrade: false,
        },
      }
    }
    if (endpoint === STREAM_SETTINGS_RPC.debugRead) {
      return { ok: true as const, value: { debugEnabled: false, tuning: DEFAULT_STREAM_DEBUG_TUNING } }
    }
    return { ok: false as const, error: { code: 'internal', message: 'unexpected endpoint' } }
  })
  ctx.provide('connection', {
    api: { settings: { describe: () => Promise.reject(new Error('third-party namespaces filtered')) } },
    rpc: { call },
  } as never)
  await ctx.plugin({ inject: [...inject], apply }).await()
  return ctx
}

describe('auto-collapse client wiring', () => {
  it('arms the fold lifecycle during composition (style injected)', async () => {
    await bootClient()
    expect(document.getElementById('dshss-auto-collapse-style')).not.toBeNull()
  })

  it('folds a finished turn that is already in the document', async () => {
    const { thinkingStep, finalStep } = renderFinishedTurn()
    await bootClient()
    flushPasses()

    expect(thinkingStep.style.display).toBe('none')
    expect(finalStep.style.display).toBe('')
    expect(document.querySelector('button.dshss-processed')).not.toBeNull()
  })

  it('folds a conversation that lands in the document after composition', async () => {
    await bootClient()
    // Session content mounts after the plugin composed; the first scheduled
    // pass must already classify and fold it.
    const { thinkingStep } = renderFinishedTurn()
    flushPasses()
    expect(thinkingStep.style.display).toBe('none')
  })

  it('restarts folding after the settings gate stops and resumes the lifecycle', async () => {
    // Production sequence: composition starts the coordinator while settings
    // are still loading, attach-time pending stops it (cancelling the queued
    // pass), then the finished RPC read restarts it — which must schedule a
    // fresh pass instead of hitting stale handles.
    let resolveRead: (() => void) | undefined
    const readGate = new Promise<void>((done) => { resolveRead = done })
    const { thinkingStep, finalStep } = renderFinishedTurn()

    await bootClient({ readGate })
    flushPasses()
    // Still loading: the gate stopped the coordinator, so nothing folded yet.
    expect(thinkingStep.style.display).toBe('')

    resolveRead?.()
    await vi.advanceTimersByTimeAsync(0)
    flushPasses()

    expect(thinkingStep.style.display).toBe('none')
    expect(finalStep.style.display).toBe('')
    expect(document.querySelector('button.dshss-processed')).not.toBeNull()
  })
})
