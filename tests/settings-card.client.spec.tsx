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
  thinkAutoExpand: true,
  canUpgrade: false,
}

interface BenchOptions {
  view?: StreamSettingsView
  failRead?: boolean
}

/** Compose only the optional browser services used by the configuration card. */
async function bench(options: BenchOptions = {}): Promise<{
  ctx: Context
  slots: SlotRegistry
  coreDescribe: ReturnType<typeof vi.fn>
  call: ReturnType<typeof vi.fn>
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
      return { ok: true as const, value: view }
    }
    if (endpoint === STREAM_SETTINGS_RPC.write) {
      const value = (payload as { thinkAutoExpand?: unknown }).thinkAutoExpand
      if (typeof value !== 'boolean') return { ok: false as const, error: { code: 'internal', message: 'bad payload' } }
      view = { ...view, thinkAutoExpand: value }
      return { ok: true as const, value: view }
    }
    if (endpoint === STREAM_SETTINGS_RPC.upgrade) return { ok: true as const, value: { restartRequired: true } }
    return { ok: false as const, error: { code: 'internal', message: 'unexpected endpoint' } }
  })
  ctx.provide('connection', {
    api: { settings: { describe: coreDescribe } },
    rpc: { call },
  } as never)

  return { ctx, slots: ctx.get('slots') as SlotRegistry, coreDescribe, call }
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

    face.edit(false)
    expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({ dirty: true, thinkAutoExpand: false })
    face.save()
    await vi.waitFor(() => {
      expect(face.hooks.smoothStreamCard.getSnapshot()).toMatchObject({
        dirty: false,
        thinkAutoExpand: false,
      })
    })
    expect(call).toHaveBeenCalledWith(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.write, {
      thinkAutoExpand: false,
    })
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
