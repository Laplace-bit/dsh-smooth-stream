/** The browser half uses the plugin-owned RPC instead of core settings.describe. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { SmoothStreamCard, type SmoothStreamCardProps } from '../src/client/SmoothStreamCard.tsx'
import type { SmoothStreamCardFace } from '../src/client/smooth-stream-card-controller.ts'
import { en } from '../src/client/locales.ts'
import { debugRuntime } from '../src/client/debugRuntime.ts'
import {
  STREAM_SETTINGS_RPC,
  STREAM_SETTINGS_RPC_CHANNEL,
  type StreamDebugSettingsView,
  type StreamSettingsView,
} from '../src/settings-api.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'

afterEach(() => {
  cleanup()
  debugRuntime.resetRuntime()
})

const developmentView: StreamSettingsView = {
  version: '0.1.0',
  installation: 'development',
  writable: true,
  enabled: true,
  controlScroll: true,
  motionPreference: 'auto',
  thinkAutoExpand: true,
  canUpgrade: false,
}

const developmentDebugView: StreamDebugSettingsView = {
  debugEnabled: false,
  tuning: DEFAULT_STREAM_DEBUG_TUNING,
}

interface BenchOptions {
  view?: StreamSettingsView
  readValue?: unknown
  debugView?: StreamDebugSettingsView
  failRead?: boolean
  readGate?: Promise<void>
  writeGate?: Promise<void>
  failDebugWrite?: boolean
  failWrite?: boolean
  debugReadGate?: Promise<void>
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
  setDebugView: (next: StreamDebugSettingsView) => void
}> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)

  let view = options.view ?? developmentView
  let debugView = options.debugView ?? developmentDebugView
  let debugReadCount = 0
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
      return { ok: true as const, value: options.readValue ?? view }
    }
    if (endpoint === STREAM_SETTINGS_RPC.write) {
      const settings = payload as {
        enabled?: unknown
        thinkAutoExpand?: unknown
        debugEnabled?: unknown
        debugTuning?: unknown
      }
      if (typeof settings.enabled !== 'boolean' || typeof settings.thinkAutoExpand !== 'boolean') {
        return { ok: false as const, error: { code: 'internal', message: 'bad payload' } }
      }
      if (options.failWrite === true) {
        return { ok: false as const, error: { code: 'settings-rejected', message: 'write failed' } }
      }
      await options.writeGate
      view = {
        ...view,
        enabled: settings.enabled,
        thinkAutoExpand: settings.thinkAutoExpand,
      }
      if (typeof settings.debugEnabled === 'boolean' && typeof settings.debugTuning === 'object' && settings.debugTuning !== null) {
        debugView = { debugEnabled: settings.debugEnabled, tuning: settings.debugTuning as StreamDebugSettingsView['tuning'] }
      }
      return { ok: true as const, value: view }
    }
    if (endpoint === STREAM_SETTINGS_RPC.debugRead) {
      const readNumber = debugReadCount++
      const response = debugView
      if (readNumber === 0) await options.debugReadGate
      return { ok: true as const, value: response }
    }
    if (endpoint === STREAM_SETTINGS_RPC.debugWrite) {
      const settings = payload as { debugEnabled?: unknown; tuning?: unknown }
      if (typeof settings.debugEnabled !== 'boolean'
        || typeof settings.tuning !== 'object' || settings.tuning === null) {
        return { ok: false as const, error: { code: 'internal', message: 'bad debug payload' } }
      }
      if (options.failDebugWrite === true) {
        return { ok: false as const, error: { code: 'settings-rejected', message: 'write failed' } }
      }
      debugView = {
        debugEnabled: settings.debugEnabled,
        tuning: settings.tuning as StreamDebugSettingsView['tuning'],
      }
      return { ok: true as const, value: debugView }
    }
    if (endpoint === STREAM_SETTINGS_RPC.upgrade) return { ok: true as const, value: { restartRequired: true } }
    return { ok: false as const, error: { code: 'internal', message: 'unexpected endpoint' } }
  })
  const removeConnection = ctx.provide('connection', {
    api: { settings: { describe: coreDescribe } },
    rpc: { call },
  } as never)

  return {
    ctx,
    slots: ctx.get('slots') as SlotRegistry,
    coreDescribe,
    call,
    removeConnection,
    setDebugView: (next: StreamDebugSettingsView) => { debugView = next },
  }
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

  it('registers the namespace as the keyed slot key for the configurable tab', async () => {
    const { ctx, slots } = await bench()
    slots.register({
      name: 'root',
      children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } },
    } as never, () => null)
    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(slots.entries('settings.plugin.item').map(entry => entry.options.key))
      .toEqual(['smooth-stream'])
  })

  it('registers the card once the plugin-item slot is declared', async () => {
    const { ctx, slots } = await bench()
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(slots.entries('settings.plugin.item').map(entry => ({
      id: entry.options.id,
      key: entry.options.key,
    }))).toEqual([{ id: 'smooth-stream', key: 'smooth-stream' }])
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

  it('rejects a settings response whose control-scroll flag is malformed', async () => {
    const { ctx, slots } = await bench({
      readValue: { ...developmentView, controlScroll: 'true' },
    })
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot().status).toBe('unavailable'))
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
      controlScroll: true,
      motionPreference: 'auto',
      thinkAutoExpand: false,
    })
  })

  it('stages and persists the finished-turn collapse switch independently', async () => {
    const { ctx, slots, call } = await bench()
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot().status).toBe('ready'))

    face.edit({ thinkAutoExpand: false })
    face.save()
    await vi.waitFor(() => {
      expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
        dirty: false,
        thinkAutoExpand: false,
      })
    })
    expect(call).toHaveBeenCalledWith(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.write, {
      enabled: true,
      controlScroll: true,
      motionPreference: 'auto',
      thinkAutoExpand: false,
    })
  })

  it('stages and persists the diagnostics switch through its compatible endpoint', async () => {
    const { ctx, slots, call } = await bench()
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      status: 'ready',
      debugAvailable: true,
    }))

    face.edit({ debugEnabled: true })
    expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({ dirty: true, debugEnabled: true })
    face.save()
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      dirty: false,
      debugEnabled: true,
    }))
    expect(call).toHaveBeenCalledWith(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.debugWrite, {
      debugEnabled: true,
      tuning: DEFAULT_STREAM_DEBUG_TUNING,
    })
  })

  it('saves base and diagnostics settings through one atomic settings write', async () => {
    const { ctx, slots, call } = await bench()
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      status: 'ready',
      debugAvailable: true,
    }))

    const tuning = { ...DEFAULT_STREAM_DEBUG_TUNING, springDamping: 31 }
    face.edit({ enabled: false, debugEnabled: true, debugTuning: tuning })
    face.save()
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      dirty: false,
      enabled: false,
      debugEnabled: true,
      debugTuning: { springDamping: 31 },
    }))

    expect(call).toHaveBeenCalledWith(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.write, {
      enabled: false,
      controlScroll: true,
      motionPreference: 'auto',
      thinkAutoExpand: true,
      debugEnabled: true,
      debugTuning: tuning,
    })
    expect(call).not.toHaveBeenCalledWith(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.debugWrite, expect.anything())
  })

  it('keeps both staged setting groups after an atomic save failure', async () => {
    const { ctx, slots } = await bench({ failWrite: true })
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      status: 'ready',
      debugAvailable: true,
    }))

    face.edit({ enabled: false, debugEnabled: true })
    face.save()
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      dirty: true,
      failed: true,
      enabled: false,
      debugEnabled: true,
    }))
    face.discard()
    expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      dirty: false,
      failed: false,
      enabled: true,
      debugEnabled: false,
    })
  })

  it('ignores a stale debug read after a settings reload', async () => {
    const debugRead = deferred()
    const { ctx, slots, call, setDebugView } = await bench({
      debugView: developmentDebugView,
      debugReadGate: debugRead.promise,
    })
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot().status).toBe('ready'))
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.debugRead, {}))

    setDebugView({
      debugEnabled: true,
      tuning: { ...DEFAULT_STREAM_DEBUG_TUNING, springDamping: 31 },
    })
    face.reload()
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      status: 'ready',
      debugAvailable: true,
    }))
    debugRead.resolve()
    await debugRead.promise
    await Promise.resolve()
    expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      debugEnabled: true,
      debugTuning: { springDamping: 31 },
    })
  })

  it('retains staged diagnostics after a failed save so they can be retried or discarded', async () => {
    const { ctx, slots } = await bench({ failDebugWrite: true })
    declareCardSlot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = cardFace(slots)
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      status: 'ready',
      debugAvailable: true,
    }))

    face.edit({
      debugEnabled: true,
      debugTuning: { ...DEFAULT_STREAM_DEBUG_TUNING, springDamping: 31 },
    })
    face.save()
    await vi.waitFor(() => expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      dirty: true,
      failed: true,
      debugEnabled: true,
      debugTuning: { springDamping: 31 },
    }))

    face.discard()
    expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
      dirty: false,
      failed: false,
      debugEnabled: false,
      debugTuning: { springDamping: DEFAULT_STREAM_DEBUG_TUNING.springDamping },
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
    expect(debugRuntime.getSnapshot()).toMatchObject({ enabled: false, dirty: false })
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
