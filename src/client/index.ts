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
import { DebugPanel } from './DebugPanel.tsx'
import { debugRuntime } from './debugRuntime.ts'
import { NS as SETTINGS_NS, CHAT_NS, en, zh, chatEn, chatZh } from './locales.ts'
import { DEFAULT_STREAM_CONFIG, STREAM_BOOT_GLOBAL, type StreamConfig } from '../config.ts'
import { DEFAULT_STREAM_SETTINGS, STREAM_SETTINGS_NS, type StreamSettings } from '../settings.ts'

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

/**
 * The assistant renderer owns its own character queue and conversation
 * follower, so wrapping it again would create two scroll owners. Human input
 * stays immediate; every Agent-owned output renderer goes through the same
 * generic follow boundary. This is deliberately keyed by the owner that
 * provides the renderer, not by individual tool names, so new Context,
 * Command, and Tool rows are covered automatically.
 *
 * Host chrome and controllers are excluded on a different rule: `turn-process`
 * (the completed-turn process summary control) and `turn-tail` (the turn usage
 * footer) are not Agent output. The Host renders them as bare controls and
 * flips their visibility itself, so wrapping them has three measured costs and
 * no benefit:
 *
 * 1. The wrapper element defeats ChatView's `.flowItem:empty { display: none }`
 *    rule. A `turn-process` renderer returns null whenever the Host's fold is
 *    unavailable (e.g. `processWindowReady === false`), and that null render is
 *    exactly what the `:empty` rule exists to erase; with a wrapper the row
 *    stays in flow and still consumes the 16px column gap, painting an empty
 *    band where the fold control should be.
 * 2. The summary label (`N tool calls · M messages`) is not streamed model
 *    text, so pushing it through the character-reveal engine is wrong by
 *    construction.
 * 3. The row would inherit the generic entrance animation (opacity + clip-path)
 *    on a row the Host may mount and hide inside a single commit.
 */
const SKIP_WRAP = new Set([
  'assistant-step',
  'user',
  'steering',
  'command-input',
  'turn-process',
  'turn-tail',
])

/** React function/class or an exotic component such as memo/forwardRef/lazy. */
function isWrappableComponent(value: unknown): value is ComponentType<FollowWrapProps> {
  return typeof value === 'function'
    || (value !== null && typeof value === 'object' && '$$typeof' in value)
}

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
 * Wrap every Agent-owned keyed Chat row except the assistant renderer in
 * place. A second
 * register with the same `children` table throws because the child slot is
 * already declared, and only the winning entry receives `renderSlot`;
 * swapping `entry.component` keeps the original children, locale, and inject
 * seats. `assistant-step` is replaced below so text and Think use the
 * typewriter reveal. The wrapper owns only the shared layout-growth/follow
 * lifecycle; the Harness keeps each renderer's controls, disclosures, and
 * cards intact.
 * @param ctx - Browser context carrying the slot registry.
 * @returns Restorer that puts the original components back.
 */
function wrapAgentChatRows(
  ctx: ClientContext,
  useControlScroll: () => boolean,
): () => void {
  const restores: Array<() => void> = []
  const wrapped = new WeakSet<object>()

  const wrapAll = (): void => {
    for (const entry of ctx.slots.entries('conversation.chat.node')) {
      const key = entry.options.key
      if (key === undefined || SKIP_WRAP.has(key)) continue
      const current = entry.component
      if (!isWrappableComponent(current) || wrapped.has(current)) continue
      const inner = current as ComponentType<FollowWrapProps>
      const next = wrapFollowNodeView(inner, useControlScroll)
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
 * A live settings cell shared by the renderer lifecycle and React views. It
 * starts on the shared defaults and follows the plugin-owned controller once
 * the optional settings services arrive.
 */
class SettingsCell {
  private readonly listeners = new Set<() => void>()
  private card: SmoothStreamCardController | undefined
  private value: StreamSettings = DEFAULT_STREAM_SETTINGS
  private pending = false

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

  private read(): StreamSettings {
    const snapshot = this.card?.getSnapshot()
    if (snapshot === undefined || snapshot.status !== 'ready') return this.value
    return this.card?.values() ?? this.value
  }

  private refresh(): void {
    const next = this.read()
    const pending = this.card?.getSnapshot().status === 'loading'
    if (
      pending === this.pending
      && next.enabled === this.value.enabled
      && next.controlScroll === this.value.controlScroll
      && next.motionPreference === this.value.motionPreference
      && next.thinkAutoExpand === this.value.thinkAutoExpand
      && next.logarithmicFade === this.value.logarithmicFade
      && next.debugEnabled === this.value.debugEnabled
      && next.debugTuning === this.value.debugTuning
    ) return
    this.pending = pending
    this.value = next
    for (const listener of this.listeners) listener()
  }

  /** False while an available settings service is resolving its authority. */
  takeoverEnabled(): boolean {
    return !this.pending && this.value.enabled
  }

  readonly getSnapshot = (): StreamSettings => this.value

  readonly subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/**
 * Register the typewriter renderer after the conversation package declares the
 * keyed Chat node seat. A lower priority shadows the built-in assistant row;
 * every other keyed renderer is wrapped in place so Context, commands, Tool
 * cards, retries, and workflow runs share one extensible follow boundary. The
 * Host-bridged configuration
 * selects the render direction, smoothing preset, and glide speed; the
 * plugin-owned settings RPC supplies the live auto-expand preference when the
 * settings surface is composed.
 * @param ctx - Browser context carrying the shared slot registry.
 */
export function apply(ctx: ClientContext): void {
  const config = readBootConfig()
  const settings = new SettingsCell()
  const useControlScroll = (): boolean => useSyncExternalStore(
    settings.subscribe,
    () => settings.getSnapshot().controlScroll,
    () => settings.getSnapshot().controlScroll,
  )

  /**
   * Layered `t` for the assistant renderer.
   *
   * The renderer's keys have no single owner: `conversation` owns the
   * `image.*` family in every Harness version, `chat` (0.1.5+) owns
   * `message.think`, and three `message.*` keys MOVED from `conversation` to
   * `chat` between the version this package pins and the current one. Binding
   * the slot to either namespace alone degrades a real slice of the UI to raw
   * keys, which is the defect this replaces.
   *
   * The order is deliberate: `conversation` first, so the pinned Harness keeps
   * resolving the keys it still owns there; then `chat` for what moved or is
   * new; then this plugin's own namespace for keys no Harness version
   * provides. A namespace that is not registered returns its key unchanged
   * (`LocaleRuntime.bind` does not throw), so an older Harness without `chat`
   * falls straight through.
   *
   * The reference is built once and held stable: the seat feeds a memoized
   * renderer, and a fresh identity per render would defeat that memoization.
   * Until the locale service arrives the seat's own binding stays in use.
   */
  let assistantT: AssistantProps['t'] | undefined

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
    const detachSettings = settings.attach(card)
    const syncDebug = (): void => {
      const snapshot = card.getSnapshot()
      debugRuntime.syncSettings({
        available: snapshot.debugAvailable,
        enabled: snapshot.debugEnabled,
        writable: snapshot.writable && !snapshot.saving,
        dirty: snapshot.dirty,
        status: snapshot.status,
        tuning: snapshot.debugTuning,
      })
    }
    const detachBinding = debugRuntime.bindSettings({
      edit: patch => { card.inject().edit(patch) },
      save: () => { card.inject().save() },
      discard: () => { card.inject().discard() },
    })
    const detachDebug = card.subscribe(syncDebug)
    syncDebug()
    card.start()
    settingsCtx.effect(() => settingsCtx.locale.register(SETTINGS_NS, { zh, en }), 'dsh-smooth-stream: settings dictionaries')
    settingsCtx.effect(() => settingsCtx.locale.register(CHAT_NS, { zh: chatZh, en: chatEn }), 'dsh-smooth-stream: conversation fallback dictionary')
    {
      const conversationT = settingsCtx.locale.bind('conversation')
      const chatT = settingsCtx.locale.bind('chat') as (key: string, params?: Record<string, unknown>) => string
      const fallbackT = settingsCtx.locale.bind(CHAT_NS) as (key: string, params?: Record<string, unknown>) => string
      const merged = (key: string, params?: Record<string, unknown>): string => {
        const primary = (conversationT as (k: string, p?: unknown) => string)(key, params)
        if (primary !== key) return primary
        const secondary = chatT(key, params)
        if (secondary !== key) return secondary
        return fallbackT(key, params)
      }
      assistantT = merged as unknown as AssistantProps['t']
    }
    settingsCtx.slots.inject('settings.plugin.item', () => settingsCtx.slots.register({
      name: 'settings.plugin.item',
      id: 'smooth-stream',
      key: STREAM_SETTINGS_NS,
      order: 30,
      locale: SETTINGS_NS,
      inject: () => card.inject(),
    // Older Harness declares this slot as a list (`id`); newer Harness uses a
    // keyed slot filtered by the Host settings namespace (`key`).
    } as never, SmoothStreamCard))
    settingsCtx.slots.inject('conversation.session.header.utilities', () => settingsCtx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'smooth-stream-debug',
      order: 40,
      locale: SETTINGS_NS,
      inject: () => debugRuntime.panelFace(),
    }, DebugPanel))
    return () => {
      card.stop()
      detachDebug()
      detachSettings()
      detachBinding()
    }
  })

  const configured = function StreamConfiguredView(props: AssistantProps) {
    const preferences = useSyncExternalStore(
      settings.subscribe,
      settings.getSnapshot,
      settings.getSnapshot,
    )
    return createElement(TypewriterAssistantNodeView, {
      ...props,
      // Override the seat's single-namespace binding with the layered lookup
      // described above. Falls back to the seat's own binding only if the
      // locale service never arrived (renderer then receives the prop it
      // already had).
      ...(assistantT === undefined ? {} : { t: assistantT }),
      mode: config.mode,
      preset: config.preset,
      revealCharsPerSec: config.revealCharsPerSec,
      scrollSpeedPxPerSec: config.scrollSpeedPxPerSec,
      maxScrollSpeedPxPerSec: config.maxScrollSpeedPxPerSec,
      thinkAutoExpand: preferences.thinkAutoExpand,
      logarithmicFade: preferences.logarithmicFade,
      controlScroll: preferences.controlScroll,
      motionPreference: preferences.motionPreference,
    })
  }
  ctx.slots.inject('conversation.chat.node', () => {
    let releaseTakeover: (() => void) | undefined

    const syncTakeover = (): void => {
      if (!settings.takeoverEnabled()) {
        releaseTakeover?.()
        releaseTakeover = undefined
        return
      }
      if (releaseTakeover !== undefined) return
      const unwrap = wrapAgentChatRows(ctx, useControlScroll)
      const unshadow = ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'assistant-step',
        priority: -100,
        // `conversation` (not `chat`): it is the namespace the pinned Harness
        // actually registers, so it is the one whose keys must keep resolving.
        // The layered `t` handed to the renderer covers what this namespace
        // does not own. A namespace the composition does not declare would
        // degrade every `t()` call to its raw key.
        locale: 'conversation',
        registrant: 'dsh-smooth-stream',
      }, configured)
      releaseTakeover = () => {
        // Stop observing slot changes before the shadow entry is removed.
        unwrap()
        unshadow()
      }
    }

    const unsubscribe = settings.subscribe(syncTakeover)
    syncTakeover()
    return () => {
      unsubscribe()
      releaseTakeover?.()
    }
  })
}
