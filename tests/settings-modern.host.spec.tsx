/**
 * The modern (`0.1.7`+) settings seam: `ctx.settings` is a projection over the
 * profile's config entries and no longer exposes `register()`. The Host half
 * must load there, serve its RPC, and persist through `settings.update()` —
 * this spec pins that generation so a future kernel change fails loudly here
 * instead of silently half-activating the Web plugin again.
 */

import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, ConnectionRpcHandlerOptions } from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it } from 'vitest'
import { apply, Config } from '../src/plugin.ts'
import { STREAM_SETTINGS_RPC, STREAM_SETTINGS_RPC_CHANNEL } from '../src/settings-api.ts'
import { DEFAULT_STREAM_SETTINGS, STREAM_SETTINGS_NS } from '../src/settings.ts'

interface UpdateCall {
  ns: string
  patch: unknown
  expectedRevision: unknown
}

/**
 * Stand-in for `SettingsForms`: projects one configurable entry, records
 * writes, and — like the real service — refuses writes while the profile has
 * no editable document.
 */
class FakeSettingsForms {
  readonly updates: UpdateCall[] = []
  writable = true
  /** Effective entry config, i.e. what `describe()` reports as the form value. */
  config: Record<string, unknown>
  revision = 3

  constructor(config: Record<string, unknown> = {}) {
    this.config = config
  }

  describe(): Array<{ ns: string; revision: number; value: Record<string, unknown> }> {
    return [{ ns: STREAM_SETTINGS_NS, revision: this.revision, value: this.config }]
  }

  async update(ns: string, patch: unknown, expectedRevision?: unknown): Promise<void> {
    if (!this.writable) throw new Error('settings are read-only')
    this.updates.push({ ns, patch, expectedRevision })
    const record = patch as Record<string, unknown>
    this.config = { ...this.config, ...record }
  }
}

interface RpcRegistration {
  channel: string
  handler: ConnectionRpcHandler
  options: ConnectionRpcHandlerOptions
}

async function mountModern(options: {
  settings?: FakeSettingsForms
  config?: Record<string, unknown>
} = {}): Promise<{
  settings: FakeSettingsForms
  registration: RpcRegistration
  fiber: ReturnType<Context['plugin']>
}> {
  const settings = options.settings ?? new FakeSettingsForms()
  const ctx = new Context()
  ctx.baseUrl = 'file:///tmp/dsh-profile-modern/'
  let registration: RpcRegistration | undefined
  // Deliberately no `register`: this is the generation that broke the plugin.
  ctx.provide('settings', settings as never)
  ctx.provide('connection', {
    baseUrl: 'http://127.0.0.1:3080',
    settings: { writable: true },
    rpc: {
      handle(channel: string, handler: ConnectionRpcHandler, rpcOptions: ConnectionRpcHandlerOptions): () => Promise<void> {
        registration = { channel, handler, options: rpcOptions }
        return async () => undefined
      },
    },
  } as never)
  const fiber = options.config === undefined
    ? ctx.plugin({ apply, Config })
    : ctx.plugin({ apply, Config }, options.config as never)
  await fiber.await()
  if (registration === undefined) throw new Error('smooth-stream RPC was not registered on the modern seam')
  return { settings, registration, fiber }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('smooth-stream on the modern settings seam', () => {
  it('mounts without settings.register and serves the RPC', async () => {
    const { registration, fiber } = await mountModern()

    expect(registration.channel).toBe(STREAM_SETTINGS_RPC_CHANNEL)
    expect(registration.options).toEqual({ authority: 'loopback' })
    const view = await registration.handler(STREAM_SETTINGS_RPC.read, {}, signal())
    expect(view).toMatchObject({
      ok: true,
      value: {
        writable: true,
        enabled: DEFAULT_STREAM_SETTINGS.enabled,
        controlScroll: DEFAULT_STREAM_SETTINGS.controlScroll,
        preset: DEFAULT_STREAM_SETTINGS.preset,
        motionPreference: DEFAULT_STREAM_SETTINGS.motionPreference,
        thinkAutoExpand: DEFAULT_STREAM_SETTINGS.thinkAutoExpand,
        logarithmicFade: DEFAULT_STREAM_SETTINGS.logarithmicFade,
      },
    })
    await fiber.dispose()
  })

  it('reads the flat user fields the projection seam stores edits in', async () => {
    const settings = new FakeSettingsForms({
      enabled: false, preset: 'realtime', logarithmicFade: false,
    })
    const { registration, fiber } = await mountModern({ settings })

    const view = await registration.handler(STREAM_SETTINGS_RPC.read, {}, signal())
    expect(view).toMatchObject({
      ok: true,
      value: { enabled: false, preset: 'realtime', logarithmicFade: false },
    })
    // Fields the user never touched still resolve to the shared defaults.
    expect(view).toMatchObject({ value: { thinkAutoExpand: DEFAULT_STREAM_SETTINGS.thinkAutoExpand } })
    await fiber.dispose()
  })

  it('persists user edits through settings.update with the described revision', async () => {
    const { settings, registration, fiber } = await mountModern()

    const written = await registration.handler(STREAM_SETTINGS_RPC.write, {
      enabled: false,
      controlScroll: false,
      thinkAutoExpand: false,
      preset: 'silky',
      motionPreference: 'force-reduced',
      logarithmicFade: false,
    }, signal())

    expect(written).toMatchObject({
      ok: true,
      value: {
        enabled: false,
        controlScroll: false,
        thinkAutoExpand: false,
        preset: 'silky',
        motionPreference: 'force-reduced',
        logarithmicFade: false,
      },
    })
    expect(settings.updates).toHaveLength(1)
    expect(settings.updates[0]).toMatchObject({
      ns: STREAM_SETTINGS_NS,
      expectedRevision: 3,
      patch: {
        enabled: false,
        controlScroll: false,
        thinkAutoExpand: false,
        preset: 'silky',
        motionPreference: 'force-reduced',
        logarithmicFade: false,
      },
    })
    await fiber.dispose()
  })

  it('keeps the diagnostics endpoints working through the projection', async () => {
    const { settings, registration, fiber } = await mountModern()

    const debugWritten = await registration.handler(STREAM_SETTINGS_RPC.debugWrite, {
      debugEnabled: true,
      tuning: { ...DEFAULT_STREAM_SETTINGS.debugTuning, springDamping: 31 },
    }, signal())
    expect(debugWritten).toMatchObject({
      ok: true,
      value: { debugEnabled: true, tuning: { springDamping: 31 } },
    })
    expect(settings.updates[0]?.patch).toMatchObject({
      debugEnabled: true,
      debugTuning: { springDamping: 31 },
    })

    const debugRead = await registration.handler(STREAM_SETTINGS_RPC.debugRead, {}, signal())
    expect(debugRead).toMatchObject({ ok: true, value: { debugEnabled: true } })
    await fiber.dispose()
  })

  it('reports the card read-only when the profile rejects form edits', async () => {
    const settings = new FakeSettingsForms()
    settings.writable = false
    const { registration, fiber } = await mountModern({ settings })

    const view = await registration.handler(STREAM_SETTINGS_RPC.read, {}, signal())
    expect(view).toMatchObject({ ok: true, value: { writable: false } })

    const rejected = await registration.handler(STREAM_SETTINGS_RPC.write, {
      enabled: false,
      controlScroll: true,
      thinkAutoExpand: true,
    }, signal())
    expect(rejected).toMatchObject({ ok: false, error: { code: 'settings-rejected' } })
    await fiber.dispose()
  })

  it('rejects a write when the entry is not addressable', async () => {
    const settings = new FakeSettingsForms()
    settings.describe = () => []
    const { registration, fiber } = await mountModern({ settings })

    const rejected = await registration.handler(STREAM_SETTINGS_RPC.write, {
      enabled: false,
      controlScroll: true,
      thinkAutoExpand: true,
    }, signal())
    expect(rejected).toMatchObject({ ok: false, error: { code: 'settings-rejected' } })
    await fiber.dispose()
  })
})
