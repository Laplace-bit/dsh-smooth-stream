/**
 * Locale routing for the assistant renderer.
 *
 * The renderer is registered on the `conversation.chat.node` / `assistant-step`
 * seat, and the seat binds `t` to ONE namespace: `kit['t'] = localeSeat(face,
 * entry.locale)`. `LocaleRuntime.translate` falls back to the key itself when a
 * lookup misses, so choosing the wrong namespace silently degrades real UI to
 * raw keys instead of failing loudly. That is the defect these tests pin.
 *
 * The keys cannot all come from one namespace:
 *
 * - `conversation` (`dsh-client-ui-conversation`) owns the `image.*` family.
 * - `chat` (`dsh-client-ui-chat`, 0.1.5+) owns `message.think`.
 * - `message.stopped`, `message.unknownBlock` and `json.truncated` MOVED from
 *   `conversation` to `chat` between the version this package pins
 *   (`0.1.0-rc.6`) and the current one.
 *
 * So these tests exercise the layered lookup `index.ts` installs, against real
 * `LocaleRuntime` instances and REAL dictionaries — never a stubbed `t`, which
 * is what let the original defect through.
 *
 * VERSION NOTE: the dictionaries come from a sibling `../deepseek-harness`
 * checkout, whose revision decides which keys exist. Assertions below were
 * measured against `dsh-v0.1.5-rc.2`. On an rc.6-era checkout `ui-chat` does
 * not exist and this file cannot load at all, which is precisely the migration
 * the plugin has to bridge.
 *
 * TYPE NOTE: `tsconfig.json` does not reference `tsconfig.paths.json`, so
 * `pnpm typecheck` resolves `@deepseek-ai/*` to the pinned rc.6 packages while
 * Vitest resolves them to the source checkout. This file therefore widens the
 * runtime surface locally: exercising the `chat` namespace is the whole point,
 * and the pinned types do not declare it.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { zh as conversationZh, en as conversationEn } from '../../deepseek-harness/packages/client/ui-conversation/src/client/locales.ts'
import { zh as chatZh, en as chatEn } from '../../deepseek-harness/packages/client/ui-chat/src/client/locale.ts'
import { zh as commonZh, en as commonEn } from '../../deepseek-harness/packages/client/locale/src/locales/index.ts'

/** The runtime surface under test, free of the pinned key unions. */
interface LooseLocaleRuntime {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  setLocale(id: string): void
}

/** The plugin-owned fallback namespace (mirrors locales.ts CHAT_NS). */
const PLUGIN_NS = 'smoothStream.chat'
const pluginZh = { 'message.think': '思考', 'image.serviceUnavailable': '图片服务不可用' }

/**
 * Keys the assistant renderer resolves through `t`, excluding `message.think`
 * (asserted separately, since its absence from the pinned dictionaries is the
 * origin of the defect).
 */
const RENDERER_KEYS = [
  'image.label',
  'image.openOriginal',
  'image.openOriginalLabel',
  'image.loading',
  'image.loadFailed',
  'image.preview',
  'image.closePreview',
  'row.running',
  'copy',
  'copied',
  'markdown.footnotes',
  'message.unknownBlock',
  'json.truncated',
  'message.stopped',
] as const

/** The layered lookup `index.ts` installs for the assistant renderer. */
function layeredT(locale: LooseLocaleRuntime): (key: string) => string {
  const conversation = locale.bind('conversation')
  const chat = locale.bind('chat')
  const fallback = locale.bind(PLUGIN_NS)
  return (key: string): string => {
    const primary = conversation(key)
    if (primary !== key) return primary
    const secondary = chat(key)
    if (secondary !== key) return secondary
    return fallback(key)
  }
}

function runtimeWith(namespaces: readonly string[]): LooseLocaleRuntime {
  const ctx = new Context()
  const locale = new LocaleRuntime(ctx) as unknown as LooseLocaleRuntime
  // The locale plugin's own apply() registers `common`, the shared vocabulary
  // consulted after a namespace misses every locale in its fallback chain.
  locale.register('common', { zh: commonZh, en: commonEn })
  if (namespaces.includes('conversation')) {
    locale.register('conversation', { zh: conversationZh, en: conversationEn })
  }
  if (namespaces.includes('chat')) {
    locale.register('chat', { zh: chatZh, en: chatEn })
  }
  locale.register(PLUGIN_NS, { zh: pluginZh })
  // The runtime opens in English (its documented fallback for a browser that
  // names no registered language); pin Chinese to read the zh dictionaries.
  locale.setLocale('zh')
  return locale
}

describe('assistant renderer locale routing', () => {
  it('resolves every renderer key through the layered lookup', () => {
    const t = layeredT(runtimeWith(['conversation', 'chat']))
    // The regression guard: any key that resolves nowhere shows its raw name.
    expect(RENDERER_KEYS.filter(key => t(key) === key)).toEqual([])
    expect(t('message.think')).toBe('思考')
  })

  it('binds no key to an English-literal fallback', () => {
    // The Think title must come from a dictionary in both shipped locales, not
    // from a hardcoded string or an `<html lang>` guess. With the dictionaries
    // absent, a hardcoded default would still answer; a dictionary-only lookup
    // reports the raw key, which is the observable difference.
    const bare = layeredT(runtimeWith([]))
    expect(bare('message.think')).toBe('思考') // plugin fallback still owns it
    expect(bare('image.label')).toBe('image.label') // no silent English
  })

  it('prefers conversation, then chat, then the plugin fallback', () => {
    const locale = runtimeWith(['conversation', 'chat'])
    const t = layeredT(locale)
    // conversation owns the image family.
    expect(t('image.label')).toBe('图片')
    // chat owns the Think title.
    expect(locale.bind('chat')('message.think')).toBe('思考')
    // The three migrated keys resolve through chat when conversation misses.
    for (const key of ['message.stopped', 'message.unknownBlock', 'json.truncated']) {
      expect(locale.bind('conversation')(key)).toBe(key)
      expect(t(key)).not.toBe(key)
    }
  })

  it('keeps resolving on an older Harness without the chat namespace', () => {
    // rc.6 has `conversation` and no `chat` at all. bind() must not throw for
    // an unregistered namespace, and the image family plus the plugin fallback
    // must still answer.
    const locale = runtimeWith(['conversation'])
    expect(() => locale.bind('chat')).not.toThrow()
    const t = layeredT(locale)
    expect(t('image.label')).toBe('图片')
    expect(t('message.think')).toBe('思考')
  })

  it('never registers into a namespace the Harness owns', () => {
    // Why the plugin needs its own namespace: register() throws when the
    // (namespace, locale) pair already has an owner.
    const locale = runtimeWith(['conversation', 'chat'])
    expect(() => locale.register('chat', { zh: { 'message.think': '思考' } })).toThrow()
    expect(() => locale.register('conversation', { zh: { 'image.label': '图片' } })).toThrow()
  })

  it('covers the key the current Harness dictionaries dropped', () => {
    // `image.serviceUnavailable` had an owner in rc.6's `conversation` and has
    // none in 0.1.5. The plugin interpolates it into a thrown Error, so the raw
    // key must never reach a reader; the plugin fallback is what covers it.
    const locale = runtimeWith(['conversation', 'chat'])
    expect(locale.bind('conversation')('image.serviceUnavailable')).toBe('image.serviceUnavailable')
    expect(locale.bind('chat')('image.serviceUnavailable')).toBe('image.serviceUnavailable')
    expect(layeredT(locale)('image.serviceUnavailable')).toBe('图片服务不可用')
  })
})
