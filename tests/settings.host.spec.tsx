/** Host half keeps the setting durable and exposes it on a loopback-only RPC. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, ConnectionRpcHandlerOptions } from '@deepseek-ai/dsh-client-connection'
import * as DshSettings from '@deepseek-ai/dsh-settings'
const { SettingsProvider } = DshSettings
type SettingsNamespace = DshSettings.SettingsNamespace
const toNs = (ns: string): SettingsNamespace =>
  typeof (DshSettings as unknown as { settingsNamespace?: (v: string) => SettingsNamespace }).settingsNamespace === 'function'
    ? (DshSettings as unknown as { settingsNamespace: (v: string) => SettingsNamespace }).settingsNamespace(ns)
    : (ns as SettingsNamespace)
import { afterEach, describe, expect, it } from 'vitest'
import { STREAM_PACKAGE_NAME, STREAM_PACKAGE_VERSION } from '../src/package-meta.ts'
import { apply, Config } from '../src/plugin.ts'
import { STREAM_SETTINGS_RPC, STREAM_SETTINGS_RPC_CHANNEL } from '../src/settings-api.ts'
import { STREAM_SETTINGS_NS, DEFAULT_STREAM_SETTINGS } from '../src/settings.ts'

/** In-memory settings provider -- same shape as the Harness's own specs. */
class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

interface RpcRegistration {
  channel: string
  handler: ConnectionRpcHandler
  options: ConnectionRpcHandlerOptions
}

const tempProfiles = new Set<string>()

afterEach(() => {
  for (const directory of tempProfiles) rmSync(directory, { recursive: true, force: true })
  tempProfiles.clear()
})

function profileBaseUrl(specifier: string, bundled = true): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-smooth-stream-profile-'))
  tempProfiles.add(directory)
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    private: true,
    dsh: { profile: { bundles: bundled ? [STREAM_PACKAGE_NAME] : [] } },
    dependencies: { [STREAM_PACKAGE_NAME]: specifier },
  }), 'utf8')
  return `${pathToFileURL(directory).href}/`
}

async function mountHost(baseUrl: string): Promise<{
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  registration: RpcRegistration
  removed: () => number
}> {
  const ctx = new Context()
  ctx.baseUrl = baseUrl
  let registration: RpcRegistration | undefined
  let removeCalls = 0
  ctx.provide('connection', {
    rpc: {
      handle(channel: string, handler: ConnectionRpcHandler, options: ConnectionRpcHandlerOptions): () => Promise<void> {
        registration = { channel, handler, options }
        return async () => { removeCalls += 1 }
      },
    },
  } as never)
  await ctx.plugin(MemorySettings).await()
  const fiber = ctx.plugin({ apply, Config })
  await fiber.await()
  if (registration === undefined) throw new Error('smooth-stream RPC was not registered')
  return { ctx, fiber, registration, removed: () => removeCalls }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('smooth-stream host settings', () => {
  it('reads the running package version from its manifest', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string; version: string }
    expect(STREAM_PACKAGE_NAME).toBe(manifest.name)
    expect(STREAM_PACKAGE_VERSION).toBe(manifest.version)
  })

  it('registers the namespace with the default and disposes it with the fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply, Config })
    await fiber.await()

    const ns = toNs(STREAM_SETTINGS_NS)
    expect(ctx.settings.get(ns)).toEqual(DEFAULT_STREAM_SETTINGS)

    await ctx.settings.update(ns, { enabled: false, thinkAutoExpand: false })
    expect(ctx.settings.get(ns)).toEqual({
      ...DEFAULT_STREAM_SETTINGS,
      enabled: false,
      thinkAutoExpand: false,
    })

    await expect(ctx.settings.update(ns, { thinkAutoExpand: 'nope' })).rejects.toThrow()

    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('serves the durable setting over a loopback-only plugin RPC', async () => {
    const { ctx, fiber, registration, removed } = await mountHost(profileBaseUrl(`link:${process.cwd()}`))

    expect(registration.channel).toBe(STREAM_SETTINGS_RPC_CHANNEL)
    expect(registration.options).toEqual({ authority: 'loopback' })
    const initial = await registration.handler(STREAM_SETTINGS_RPC.read, {}, signal())
    expect(initial).toEqual({
      ok: true,
      value: {
        version: STREAM_PACKAGE_VERSION,
        installation: 'development',
        writable: true,
        enabled: DEFAULT_STREAM_SETTINGS.enabled,
        controlScroll: DEFAULT_STREAM_SETTINGS.controlScroll,
        motionPreference: DEFAULT_STREAM_SETTINGS.motionPreference,        thinkAutoExpand: DEFAULT_STREAM_SETTINGS.thinkAutoExpand,
        canUpgrade: false,
      },
    })

    const updated = await registration.handler(
      STREAM_SETTINGS_RPC.write,
      { enabled: false, controlScroll: true, thinkAutoExpand: false },
      signal(),
    )
      expect(updated).toMatchObject({ ok: true, value: { enabled: false, controlScroll: true, thinkAutoExpand: false } })
    expect(ctx.settings.get(toNs(STREAM_SETTINGS_NS))).toEqual({
      ...DEFAULT_STREAM_SETTINGS,
      enabled: false,
      controlScroll: true,
      thinkAutoExpand: false,
    })

    const debugInitial = await registration.handler(STREAM_SETTINGS_RPC.debugRead, {}, signal())
    expect(debugInitial).toEqual({
      ok: true,
      value: {
        debugEnabled: DEFAULT_STREAM_SETTINGS.debugEnabled,
        tuning: DEFAULT_STREAM_SETTINGS.debugTuning,
      },
    })
    const debugUpdated = await registration.handler(STREAM_SETTINGS_RPC.debugWrite, {
      debugEnabled: true,
      tuning: { ...DEFAULT_STREAM_SETTINGS.debugTuning, springDamping: 31 },
    }, signal())
    expect(debugUpdated).toMatchObject({
      ok: true,
      value: { debugEnabled: true, tuning: { springDamping: 31 } },
    })
    expect(ctx.settings.get(toNs(STREAM_SETTINGS_NS))).toMatchObject({
      debugEnabled: true,
      debugTuning: { springDamping: 31 },
    })

    const atomicUpdated = await registration.handler(
      STREAM_SETTINGS_RPC.write,
      {
        enabled: true,
        controlScroll: true,
        thinkAutoExpand: true,
        debugEnabled: false,
        debugTuning: { ...DEFAULT_STREAM_SETTINGS.debugTuning, springDamping: 34 },
      },
      signal(),
    )
    expect(atomicUpdated).toMatchObject({ ok: true, value: { enabled: true, thinkAutoExpand: true } })
    expect(ctx.settings.get(toNs(STREAM_SETTINGS_NS))).toMatchObject({
      enabled: true,
      thinkAutoExpand: true,
      debugEnabled: false,
      debugTuning: { springDamping: 34 },
    })

    const partialDebug = await registration.handler(
      STREAM_SETTINGS_RPC.write,
      { enabled: false, controlScroll: true, thinkAutoExpand: false, debugEnabled: true },
      signal(),
    )
    expect(partialDebug).toMatchObject({ ok: false, error: { code: 'settings-rejected' } })
    expect(ctx.settings.get(toNs(STREAM_SETTINGS_NS))).toMatchObject({
      enabled: true,
      thinkAutoExpand: true,
      debugEnabled: false,
    })

    const malformedDebug = await registration.handler(STREAM_SETTINGS_RPC.debugWrite, {
      debugEnabled: true,
      tuning: { ...DEFAULT_STREAM_SETTINGS.debugTuning, springMass: 99 },
    }, signal())
    expect(malformedDebug).toMatchObject({ ok: false, error: { code: 'settings-rejected' } })

    const malformed = await registration.handler(STREAM_SETTINGS_RPC.write, { thinkAutoExpand: 'false' }, signal())
    expect(malformed).toMatchObject({ ok: false, error: { code: 'settings-rejected' } })

    const missingControlScroll = await registration.handler(
      STREAM_SETTINGS_RPC.write,
      { enabled: true, thinkAutoExpand: true },
      signal(),
    )
    expect(missingControlScroll).toMatchObject({ ok: false, error: { code: 'settings-rejected' } })

    const blockedUpdate = await registration.handler(STREAM_SETTINGS_RPC.upgrade, {}, signal())
    expect(blockedUpdate).toMatchObject({ ok: false, error: { code: 'internal' } })
    await fiber.dispose()
    expect(removed()).toBe(1)
  })

  it('enables the upgrade action only for a confirmed npm profile dependency', async () => {
    const npm = await mountHost(profileBaseUrl('^0.1.0'))
    const npmRead = await npm.registration.handler(STREAM_SETTINGS_RPC.read, {}, signal())
    expect(npmRead).toMatchObject({
      ok: true,
      value: { installation: 'npm', canUpgrade: true },
    })
    await npm.fiber.dispose()

    const npmAlias = await mountHost(profileBaseUrl(`npm:${STREAM_PACKAGE_NAME}@^0.1.0`))
    const aliasRead = await npmAlias.registration.handler(STREAM_SETTINGS_RPC.read, {}, signal())
    expect(aliasRead).toMatchObject({
      ok: true,
      value: { installation: 'npm', canUpgrade: true },
    })
    await npmAlias.fiber.dispose()

    const localAlias = await mountHost(profileBaseUrl(`npm:${STREAM_PACKAGE_NAME}@file:../smooth-stream`))
    const localAliasRead = await localAlias.registration.handler(STREAM_SETTINGS_RPC.read, {}, signal())
    expect(localAliasRead).toMatchObject({
      ok: true,
      value: { installation: 'unmanaged', canUpgrade: false },
    })
    await localAlias.fiber.dispose()

    const unmanaged = await mountHost(profileBaseUrl('workspace:*'))
    const unmanagedRead = await unmanaged.registration.handler(STREAM_SETTINGS_RPC.read, {}, signal())
    expect(unmanagedRead).toMatchObject({
      ok: true,
      value: { installation: 'unmanaged', canUpgrade: false },
    })
    await unmanaged.fiber.dispose()

    const catalog = await mountHost(profileBaseUrl('catalog:smooth-stream'))
    const catalogRead = await catalog.registration.handler(STREAM_SETTINGS_RPC.read, {}, signal())
    expect(catalogRead).toMatchObject({
      ok: true,
      value: { installation: 'unmanaged', canUpgrade: false },
    })
    await catalog.fiber.dispose()

    const unbundled = await mountHost(profileBaseUrl('^0.1.0', false))
    const unbundledRead = await unbundled.registration.handler(STREAM_SETTINGS_RPC.read, {}, signal())
    expect(unbundledRead).toMatchObject({
      ok: true,
      value: { installation: 'unmanaged', canUpgrade: false },
    })
    await unbundled.fiber.dispose()
  })

  it('applies without a settings service present', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ apply, Config })
    await fiber.await()
    // No throw means the optional settings injection skipped cleanly.
    await fiber.dispose()
  })
})
