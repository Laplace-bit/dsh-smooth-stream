import { createElement, useSyncExternalStore, type ComponentType } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the connection Context merge and the plugins section's SlotMap
// entry ('settings.plugin.item').
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TypewriterAssistantNodeView } from './TypewriterAssistantNodeView.tsx'
import { wrapFollowNodeView, type FollowWrapProps } from './TypewriterToolNodeView.tsx'
import { SmoothStreamCard } from './SmoothStreamCard.tsx'
import { SmoothStreamCardController } from './smooth-stream-card-controller.ts'
import { createSmoothStreamSettingsApi } from './smooth-stream-settings-api.ts'
import { NS as SETTINGS_NS, en, zh } from './locales.ts'
import { DEFAULT_STREAM_CONFIG, STREAM_BOOT_GLOBAL, type StreamConfig } from '../config.ts'
import { DEFAULT_STREAM_SETTINGS } from '../settings.ts'

/**
 * Cordis services required by the browser half. Only `slots` is load-bearing
 * for the stream itself; locale and Connection power the configuration card
 * and are wired through `ctx.inject` below so a deployment without them still
 * streams with defaults.
 */
export const inject = ['slots']

type AssistantProps = ChatNodeViewProps<'assistant-step'>

const STREAM_MODES: readonly string[] = ['typewriter', 'teleprompter']
const STREAM_PRESETS: readonly string[] = ['realtime', 'balanced', 'silky']

/** Human-authored rows stay on the built-in renderer; `assistant-step` is replaced. */
const SKIP_WRAP = new Set(['assistant-step', 'user', 'steering', 'command-input'])

/**
 * Read the Host-bridged boot config. The inline script is produced by this
 * plugin's Host half from a schema-validated value, so only the structural
 * guarantees that could break between the two halves are re-checked: the
 * global is absent when the client runs without its Host entry (defaults
 * apply), and any present-but-malformed value fails loudly instead of
 * rendering a half-configured view.
 * @returns The resolved configuration for the assistant node view.
 */
function readBootConfig(): StreamConfig {
  const raw = (globalThis as Record<string, unknown>)[STREAM_BOOT_GLOBAL]
  if (raw === undefined) {
    console.info('[dsh-smooth-stream] no host config bridge; using defaults')
    return DEFAULT_STREAM_CONFIG
  }
  if (
    typeof raw !== 'object' || raw === null
    || !STREAM_MODES.includes((raw as StreamConfig).mode)
    || !STREAM_PRESETS.includes((raw as StreamConfig).preset)
    || typeof (raw as StreamConfig).revealCharsPerSec !== 'number'
    || typeof (raw as StreamConfig).scrollSpeedPxPerSec !== 'number'
    || typeof (raw as StreamConfig).maxScrollSpeedPxPerSec !== 'number'
  ) {
    throw new Error(`[dsh-smooth-stream] malformed ${STREAM_BOOT_GLOBAL} boot global: ${JSON.stringify(raw)}`)
  }
  return raw as StreamConfig
}

/**
 * Wrap every keyed Chat row except `assistant-step` in place. A second
 * register with the same `children` table throws because the child slot is
 * already declared, and only the winning entry receives `renderSlot`;
 * swapping `entry.component` keeps the original children, locale, and inject
 * seats. `assistant-step` is replaced below so text and Think use the
 * typewriter reveal.
 * @param ctx - Browser context carrying the slot registry.
 * @returns Restorer that puts the original components back.
 */
function wrapGrowingChatRows(ctx: ClientContext): () => void {
  const restores: Array<() => void> = []
  const wrapped = new WeakSet<object>()

  const wrapAll = (): void => {
    for (const entry of ctx.slots.entries('conversation.chat.node')) {
      const key = entry.options.key
      if (key === undefined || SKIP_WRAP.has(key)) continue
      const current = entry.component
      if (typeof current !== 'function' || wrapped.has(current)) continue
      const inner = current as ComponentType<FollowWrapProps>
      const next = wrapFollowNodeView(inner)
      wrapped.add(next)
      entry.component = next
      restores.push(() => {
        if (entry.component === next) entry.component = inner
      })
    }
  }

  wrapAll()
  const off = ctx.on('slots/changed', (key: string) => {
    if (key === 'conversation.chat.node') wrapAll()
  })
  return () => {
    off()
    for (const restore of restores) restore()
  }
}

/**
 * A live preference cell read by `useSyncExternalStore`. It starts on the
 * shared default and, once the plugin-owned settings controller is attached,
 * tracks the resolved `thinkAutoExpand` value. A composition (or test) that
 * ships no settings surface keeps the cell on the default.
 */
class PreferenceCell {
  private readonly listeners = new Set<() => void>()
  private card: SmoothStreamCardController | undefined
  private value = DEFAULT_STREAM_SETTINGS.thinkAutoExpand

  /** Re-point the cell at the plugin-owned settings controller. */
  attach(card: SmoothStreamCardController): () => void {
    this.card = card
    this.refresh()
    const unsubscribe = card.subscribe(() => { this.refresh() })
    return () => {
      unsubscribe()
      if (this.card !== card) return
      this.card = undefined
      this.refresh()
    }
  }

  private read(): boolean {
    return this.card?.getSnapshot().thinkAutoExpand ?? DEFAULT_STREAM_SETTINGS.thinkAutoExpand
  }

  private refresh(): void {
    const next = this.read()
    if (next === this.value) return
    this.value = next
    for (const listener of this.listeners) listener()
  }

  readonly getSnapshot = (): boolean => this.value

  readonly subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/**
 * Register the typewriter renderer after the conversation package declares the
 * keyed Chat node seat. A lower priority shadows the built-in assistant row;
 * every other growing row is wrapped in place so Tool cards, retries, and
 * workflow runs share conversation follow. The Host-bridged configuration
 * selects the render direction, smoothing preset, and glide speed; the
 * plugin-owned settings RPC supplies the live auto-expand preference when the
 * settings surface is composed.
 * @param ctx - Browser context carrying the shared slot registry.
 */
export function apply(ctx: ClientContext): void {
  const config = readBootConfig()
  const preference = new PreferenceCell()

  // The card talks to the plugin-owned loopback RPC, so the core settings
  // namespace allowlist cannot make it disappear. The stream still applies
  // with defaults when the optional Settings UI or Connection is absent.
  ctx.inject(['slots', 'locale', 'connection'], (settingsCtx) => {
    const card = new SmoothStreamCardController(
      // The shared Context augmentation also carries the Host-side Connection
      // shape. This browser entry runs after the client provider installs its
      // handle, so narrow through unknown to its client contract here.
      createSmoothStreamSettingsApi(settingsCtx.get('connection') as unknown as ConnectionHandle),
    )
    const detachPreference = preference.attach(card)
    card.start()
    settingsCtx.effect(() => settingsCtx.locale.register(SETTINGS_NS, { zh, en }), 'dsh-smooth-stream: settings dictionaries')
    settingsCtx.slots.inject('settings.plugin.item', () => settingsCtx.slots.register({
      name: 'settings.plugin.item',
      id: 'smooth-stream',
      order: 30,
      locale: SETTINGS_NS,
      inject: () => card.inject(),
    }, SmoothStreamCard))
    return () => {
      card.stop()
      detachPreference()
    }
  })

  const configured = function StreamConfiguredView(props: AssistantProps) {
    const thinkAutoExpand = useSyncExternalStore(
      preference.subscribe,
      preference.getSnapshot,
      preference.getSnapshot,
    )
    return createElement(TypewriterAssistantNodeView, {
      ...props,
      mode: config.mode,
      preset: config.preset,
      revealCharsPerSec: config.revealCharsPerSec,
      scrollSpeedPxPerSec: config.scrollSpeedPxPerSec,
      maxScrollSpeedPxPerSec: config.maxScrollSpeedPxPerSec,
      thinkAutoExpand,
    })
  }
  ctx.slots.inject('conversation.chat.node', () => {
    const unwrap = wrapGrowingChatRows(ctx)
    const unshadow = ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'assistant-step',
      priority: -100,
      locale: 'conversation',
      registrant: 'dsh-smooth-stream',
    }, configured)
    return () => {
      unshadow()
      unwrap()
    }
  })
}
