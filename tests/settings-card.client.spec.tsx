/** The browser half uses the plugin-owned RPC instead of core settings.describe. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { SmoothStreamCard, type SmoothStreamCardProps } from '../src/client/SmoothStreamCard.tsx'
import type { SmoothStreamCardFace } from '../src/client/smooth-stream-card-controller.ts'
import { en } from '../src/client/locales.ts'
import { STREAM_SETTINGS_RPC, STREAM_SETTINGS_RPC_CHANNEL, type StreamSettingsView } from '../src/settings-api.ts'

afterEach(cleanup)

const developmentView: StreamSettingsView = {
  version: '0.1.0',
  installation: 'development',
  writable: true,
  enabled: true,
  thinkAutoExpand: true,
  canUpgrade: false,
}

interface BenchOptions {
  view?: StreamSettingsView
  failRead?: boolean
  readGate?: Promise<void>
  writeGate?: Promise<void>
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** Compose only the optional browser services used by the configuration card. */
async function bench(options: BenchOptions = {}): Promise<{
  ctx: Context
  slots: SlotRegistry
  coreDescribe: ReturnType<typeof vi.fn>
  call: ReturnType<typeof vi.fn>
  removeConnection: () => void
}> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)

  let view = options.view ?? developmentView
  const coreDescribe = vi.fn(() => Promise.resolve({
    rpcId: 'settings',
    result: { ok: false, error: { code: 'settings-not-exposed' } },
  }))
  const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
    if (channel !== STREAM_SETTINGS_RPC_CHANNEL) {
      return { ok: false as const, error: { code: 'internal', message: 'unexpected channel' } }
    }
    if (endpoint === STREAM_SETTINGS_RPC.read) {
      if (options.failRead === true) throw new Error('RPC unavailable')
      await options.readGate
      return { ok: true as const, value: view }
    }
    if (endpoint === STREAM_SETTINGS_RPC.write) {
      const settings = payload as { enabled?: unknown; thinkAutoExpand?: unknown }
      if (typeof settings.enabled !== 'boolean' || typeof settings.thinkAutoExpand !== 'boolean') {
        return { ok: false as const, error: { code: 'internal', message: 'bad payload' } }
      }
      await options.writeGate
      view = { ...view, enabled: settings.enabled, thinkAutoExpand: settings.thinkAutoExpand }
      return { ok: true as const, value: view }
    }
    if (endpoint === STREAM_SETTINGS_RPC.upgrade) return { ok: true as const, value: { restartRequired: true } }
    return { ok: false as const, error: { code: 'internal', message: 'unexpected endpoint' } }
  })
  const removeConnection = ctx.provide('connection', {
    api: { settings: { describe: coreDescribe } },
    rpc: { call },
  } as never)

  return { ctx, slots: ctx.get('slots') as SlotRegistry, coreDescribe, call, removeConnection }
}

function declareCardSlot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugin.item': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

function cardFace(slots: SlotRegistry): SmoothStreamCardFace {
  const entry = slots.entries('settings.plugin.item')[0]
  if (entry === undefined) throw new Error('smooth-stream card was not registered')
  return (entry.inject as unknown as () => SmoothStreamCardFace)()
}

function cardProps(face: SmoothStreamCardFace): SmoothStreamCardProps {
  return {
    ...face,
    t: (key: keyof typeof en) => en[key],
    useSmoothStreamCard: (selector: (state: ReturnType<typeof face.hooks.smoothStreamCard.getSnapshot>) => unknown) => (
      selector(face.hooks.smoothStreamCard.getSnapshot())
    ),
  } as unknown as SmoothStreamCardProps
}

describe('smooth-stream settings card', () => {
  it('uses the standard theme-aware card surface tokens', () => {
    const styles = readFileSync(join(process.cwd(), 'src/client/SmoothStreamCard.module.css'), 'utf8')

    expect(styles).toContain('border: 1px solid var(--dsw-alias-border-l2)')
    expect(styles).toContain('background: var(--dsw-alias-bg-layer-3)')
    expect(styles).toContain('background: var(--dsw-alias-bg-layer-2)')
    expect(styles).not.toMatch(/--dsw-alias-(?:border-base|bg-base|bg-hover|accent)\b/)
  })

  it('declares only the slots service (settings surface is optional)', () => {
    expect(inject).toEqual(['slots'])
  })

  it('registers the card once the plugin-item slot is declared', async () => {
    const { ctx, slots } = await bench()
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(slots.entries('settings.plugin.item').map(entry => entry.options.id))
      .toEqual(['smooth-stream'])
  })

  it('keeps the plugin entry visible when the core settings API filters third-party namespaces', async () => {
    const { ctx, slots, coreDescribe, call } = await bench({
      view: { ...developmentView, thinkAutoExpand: false },
    })
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const face = cardFace(slots)
    await vi.waitFor(() => {
      expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
        status: 'ready',
        thinkAutoExpand: false,
      })
    })
    render(<SmoothStreamCard {...cardProps(face)} />)

    expect(screen.getByText(en.title)).toBeTruthy()
    expect(call).toHaveBeenCalledWith(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.read, {})
    expect(coreDescribe).not.toHaveBeenCalled()
  })

  it('labels a link installation as a development version and disables its update action', async () => {
    const { ctx, slots } = await bench()
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot().status).toBe('ready'))
    render(<SmoothStreamCard {...cardProps(face)} />)

    fireEvent.click(screen.getByRole('button', { name: /smooth stream/i }))
    expect(screen.getByText('Development version 0.1.0')).toBeTruthy()
    expect(screen.getByRole('button', { name: en.update }).getAttribute('disabled')).not.toBeNull()
  })

  it('writes staged changes through the plugin-owned settings RPC', async () => {
    const { ctx, slots, call } = await bench()
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot().status).toBe('ready'))

    face.edit({ thinkAutoExpand: false })
    expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({ dirty: true, thinkAutoExpand: false })
    face.save()
    await vi.waitFor(() => {
      expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
        dirty: false,
        thinkAutoExpand: false,
      })
    })
    expect(call).toHaveBeenCalledWith(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.write, {
      enabled: true,
      thinkAutoExpand: false,
    })
  })

  it('shows a master toggle and disables its dependent preference when off', async () => {
    const { ctx, slots } = await bench({ view: { ...developmentView, enabled: false } })
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot().status).toBe('ready'))
    const card = render(<SmoothStreamCard {...cardProps(face)} />)

    fireEvent.click(screen.getByRole('button', { name: /smooth stream/i }))
    const enabled = screen.getByRole('checkbox', { name: new RegExp(`^${en.enabled}`) })
    const thinkAutoExpand = screen.getByRole('checkbox', { name: new RegExp(`^${en.thinkAutoExpand}`) })
    expect((enabled as HTMLInputElement).checked).toBe(false)
    expect(thinkAutoExpand.getAttribute('disabled')).not.toBeNull()

    fireEvent.click(enabled)
    card.rerender(<SmoothStreamCard {...cardProps(face)} />)
    expect((screen.getByRole('checkbox', { name: new RegExp(`^${en.enabled}`) }) as HTMLInputElement).checked)
      .toBe(true)
    expect(screen.getByRole('checkbox', { name: new RegExp(`^${en.thinkAutoExpand}`) }).getAttribute('disabled'))
      .toBeNull()
  })

  it('returns conversation rendering to Harness while the master toggle is off', async () => {
    function BuiltInAssistant() { return null }
    function BuiltInTool() { return null }
    const { ctx, slots } = await bench({ view: { ...developmentView, enabled: false } })
    slots.register({
      name: 'root',
      children: {
        'settings.plugin.item': { kind: 'list', scope: 'root' },
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      },
    } as never, () => null)
    slots.register({ name: 'conversation.chat.node', key: 'assistant-step' } as never, BuiltInAssistant as never)
    slots.register({ name: 'conversation.chat.node', key: 'tool-call' } as never, BuiltInTool as never)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      status: 'ready',
      enabled: false,
    }))

    expect(slots.entries('conversation.chat.node').filter(entry => entry.options.priority === -100))
      .toHaveLength(0)
    expect(slots.entries('conversation.chat.node').find(entry => entry.options.key === 'tool-call')?.component)
      .toBe(BuiltInTool)

    face.edit({ enabled: true })
    expect(slots.entries('conversation.chat.node').some(entry => entry.options.priority === -100))
      .toBe(true)
    expect(slots.entries('conversation.chat.node').find(entry => entry.options.key === 'tool-call')?.component)
      .not.toBe(BuiltInTool)

    face.discard()
    expect(slots.entries('conversation.chat.node').filter(entry => entry.options.priority === -100))
      .toHaveLength(0)
    expect(slots.entries('conversation.chat.node').find(entry => entry.options.key === 'tool-call')?.component)
      .toBe(BuiltInTool)
  })

  it('does not take over before a saved disabled setting resolves or after its service unloads', async () => {
    function BuiltInAssistant() { return null }
    function BuiltInTool() { return null }
    const read = deferred()
    const { ctx, slots, removeConnection } = await bench({
      view: { ...developmentView, enabled: false },
      readGate: read.promise,
    })
    slots.register({
      name: 'root',
      children: {
        'settings.plugin.item': { kind: 'list', scope: 'root' },
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      },
    } as never, () => null)
    slots.register({ name: 'conversation.chat.node', key: 'assistant-step' } as never, BuiltInAssistant as never)
    slots.register({ name: 'conversation.chat.node', key: 'tool-call' } as never, BuiltInTool as never)
    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(slots.entries('conversation.chat.node').filter(entry => entry.options.priority === -100))
      .toHaveLength(0)
    expect(slots.entries('conversation.chat.node').find(entry => entry.options.key === 'tool-call')?.component)
      .toBe(BuiltInTool)

    read.resolve()
    await vi.waitFor(() => expect(cardFace(slots).hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      status: 'ready',
      enabled: false,
    }))
    await removeConnection()

    expect(slots.entries('conversation.chat.node').filter(entry => entry.options.priority === -100))
      .toHaveLength(0)
    expect(slots.entries('conversation.chat.node').find(entry => entry.options.key === 'tool-call')?.component)
      .toBe(BuiltInTool)
  })

  it('blocks preference edits while a save is in flight', async () => {
    const write = deferred()
    const { ctx, slots } = await bench({ writeGate: write.promise })
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot().status).toBe('ready'))
    face.edit({ enabled: false })
    face.save()
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot().saving).toBe(true))
    face.edit({ enabled: true })
    expect(face.hooks.smoothStreamCard.getSnapshot().enabled).toBe(false)
    render(<SmoothStreamCard {...cardProps(face)} />)
    fireEvent.click(screen.getByRole('button', { name: /smooth stream/i }))

    expect(screen.getByRole('checkbox', { name: new RegExp(`^${en.enabled}`) }).getAttribute('disabled'))
      .not.toBeNull()
    expect(screen.getByRole('checkbox', { name: new RegExp(`^${en.thinkAutoExpand}`) }).getAttribute('disabled'))
      .not.toBeNull()

    write.resolve()
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({ saving: false }))
  })

  it('shows an unavailable card instead of removing it when its RPC cannot be reached', async () => {
    const { ctx, slots } = await bench({ failRead: true })
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot().status).toBe('unavailable'))
    render(<SmoothStreamCard {...cardProps(face)} />)

    expect(screen.getByText(en.title)).toBeTruthy()
  })

  it('streams without the settings surface (no card slot declared)', async () => {
    const { ctx, slots } = await bench()
    slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, () => null)
    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(slots.entries('conversation.chat.node').some(entry => entry.options.key === 'assistant-step'))
      .toBe(true)
  })

  it('registers the card when the optional settings services arrive after activation', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    await ctx.plugin({ inject: [...inject], apply }).await()

    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    ctx.provide('connection', {
      rpc: { call: vi.fn(() => Promise.resolve({ ok: true, value: developmentView })) },
    } as never)
    declareCardSlot(slots)

    await vi.waitFor(() => {
      expect(slots.entries('settings.plugin.item').map(entry => entry.options.id))
        .toEqual(['smooth-stream'])
    })
  })
})
