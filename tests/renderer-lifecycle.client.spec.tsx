import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { STREAM_SETTINGS_RPC } from '../src/settings-api.ts'
import { DEFAULT_STREAM_SETTINGS } from '../src/settings.ts'
import type { SmoothStreamCardFace } from '../src/client/smooth-stream-card-controller.ts'

const fibers: Array<ReturnType<Context['plugin']>> = []
afterEach(async () => {
  cleanup()
  for (const fiber of fibers.splice(0)) await fiber.dispose()
})

async function mount(builtin: boolean, settings = false) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.slots
  slots.register({ name: 'root', children: {
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    'settings.plugin.item': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  function OriginalAgent() { return null }
  function OriginalAssistant() { return null }
  slots.register({ name: 'conversation.chat.node', key: 'context' } as never, OriginalAgent as never)
  if (builtin) slots.register({ name: 'conversation.chat.node', key: 'assistant-step' } as never, OriginalAssistant as never)
  if (settings) {
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('connection', { rpc: { call: async (_channel: string, endpoint: string) => ({
      ok: true,
      value: endpoint === STREAM_SETTINGS_RPC.debugRead
        ? { debugEnabled: false, tuning: DEFAULT_STREAM_SETTINGS.debugTuning }
        : { ...DEFAULT_STREAM_SETTINGS, version: '0.6.1', installation: 'development', writable: true, canUpgrade: false },
    }) } } as never)
  }
  const fiber = ctx.plugin({ inject: [...inject], apply })
  fibers.push(fiber)
  await fiber.await()
  const agent = () => slots.entries('conversation.chat.node').find(e => e.options.key === 'context')?.component
  const assistant = () => slots.entries('conversation.chat.node').find(e => e.options.key === 'assistant-step')?.component
  return { ctx, slots, fiber, agent, assistant, OriginalAgent, OriginalAssistant }
}

for (const builtin of [false, true]) {
  it(`late Agent registration; built-in assistant present=${builtin}`, async () => {
    const m = await mount(builtin)
    let failure: unknown
    try { m.slots.register({ name: 'conversation.chat.node', key: 'custom-command' } as never, () => null) }
    catch (error) { failure = error }
    expect(failure).toBeUndefined()
  })
  it(`unload restores original component identity; built-in assistant present=${builtin}`, async () => {
    const m = await mount(builtin)
    expect(m.agent()).not.toBe(m.OriginalAgent)
    await m.fiber.dispose()
    expect(m.agent()).toBe(m.OriginalAgent)
    expect(m.assistant()).toBe(builtin ? m.OriginalAssistant : undefined)
  })
  it(`disable restores original component identity; built-in assistant present=${builtin}`, async () => {
    const m = await mount(builtin, true)
    const face = m.slots.entries('settings.plugin.item')[0]?.inject?.() as unknown as SmoothStreamCardFace
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot().status).toBe('ready'))
    expect(m.agent()).not.toBe(m.OriginalAgent)
    face.edit({ enabled: false })
    expect(m.agent()).toBe(m.OriginalAgent)
    expect(m.assistant()).toBe(builtin ? m.OriginalAssistant : undefined)
  })
}

/**
 * Compose the 0.2.x shape: the built-in assistant row declares the reasoning
 * Body child slot, and the kernel registers its own default Body there.
 * @param foreign - whether a feature replaces that default, the way the native
 * chain-of-thought translation plugin does.
 * @returns the mounted registry plus the original kernel renderer identity.
 */
async function mountWithReasoningBody(foreign: boolean) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.slots
  slots.register({ name: 'root', children: {
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
  } } as never, () => null)
  function KernelAssistant() { return null }
  slots.register({
    name: 'conversation.chat.node',
    key: 'assistant-step',
    children: { 'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' } },
  } as never, KernelAssistant as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  fibers.push(fiber)
  await fiber.await()
  slots.register({ name: 'conversation.chat.reasoning.body', priority: 100 } as never, (() => null) as never)
  if (foreign) slots.register({ name: 'conversation.chat.reasoning.body' } as never, (() => null) as never)
  return { slots, fiber, KernelAssistant }
}

it('dispatches the kernel reasoning Body only when a feature replaced it', async () => {
  for (const foreign of [false, true]) {
    const m = await mountWithReasoningBody(foreign)
    const swapped = m.slots.entries('conversation.chat.node')
      .find(entry => entry.options.key === 'assistant-step')?.component
    expect(swapped).not.toBe(m.KernelAssistant)

    const seats: string[] = []
    const view = render(createElement(swapped as never, {
      node: {
        kind: 'assistant-step',
        location: {
          kind: 'step',
          turn: { status: 'closed' },
          step: { status: 'closed' },
        },
        data: { status: 'settled', blocks: [{ kind: 'reasoning', text: 'thinking' }], turn: 1, step: 1, time: 0 },
      },
      useTurnData: () => undefined,
      openFile: () => {},
      loadImage: async () => new Blob(),
      fileMentions: () => undefined,
      t: (key: string) => key,
      renderSlot: (key: string) => {
        seats.push(key)
        return createElement('div', { 'data-seat': key })
      },
    }))

    fireEvent.click(view.container.querySelector('[data-disclosure-row]')!)
    await waitFor(() => {
      if (foreign) expect(view.container.querySelector('[data-seat]')).not.toBeNull()
      // Without a replacement the takeover keeps painting the reasoning text
      // itself, exactly as before this alignment.
      else expect(view.container.textContent).toContain('thinking')
    })

    // The seat is dispatched from render, so every re-render of the open body
    // calls it again; what matters is that it is reached exactly when a
    // feature replaced the kernel default.
    expect(seats.every(key => key === 'conversation.chat.reasoning.body')).toBe(true)
    expect(seats.length > 0).toBe(foreign)
    cleanup()
  }
})
