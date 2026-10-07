import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { STREAM_SETTINGS_RPC } from '../src/settings-api.ts'
import { DEFAULT_STREAM_SETTINGS } from '../src/settings.ts'
import type { SmoothStreamCardFace } from '../src/client/smooth-stream-card-controller.ts'

const fibers: Array<ReturnType<Context['plugin']>> = []
afterEach(async () => {
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
