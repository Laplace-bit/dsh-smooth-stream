/**
 * Cross-generation bridge over the Harness settings seam.
 *
 * Kernels up to the `0.1.6` line expose `ctx.settings` as a namespace
 * *registry*: a plugin calls `settings.register(ns, schema, { base, applies })`
 * and gets back a scope whose `get()`/`update()` are the durable authority.
 * `0.1.7` replaced that service with a projection over the profile's config
 * entries: the plugin's own `Config` schema becomes the form, user edits live
 * in the profile patch, and `register()` no longer exists. Calling it there
 * threw `settingsCtx.settings.register is not a function` during apply, which
 * left the whole plugin half-activated with no RPC channel and no settings
 * card (issue: Web half dead on 0.1.7).
 *
 * This module detects which seam is present and adapts both directions, so one
 * build serves the desktop `0.1.5-rc` kernel and the Web `0.1.7-alpha` kernel:
 *
 * - legacy (registry): unchanged `register()` semantics. The install-time
 *   `base` still resolves *below* the user layer, which keeps "the user never
 *   chose" distinguishable from "the user chose the composition value".
 * - modern (projection): the same fields are declared on the plugin's `Config`
 *   through {@link streamSettingsSection}, marked with `meta.volatile` so the
 *   profile patch may carry them. Reads project the entry's effective config;
 *   writes go through `settings.update(entryId, patch)`.
 *
 * `meta.volatile` is set through `Schema#extra`, not `Schema#volatile`: the
 * former exists in every schemastery this plugin can meet (3.18.1+), while
 * `volatile()` only arrived in 3.18.4 — calling it would break the desktop
 * kernel, whose schemastery is 3.18.2 and which resolves this package's own
 * dependency (3.18.1) anyway.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import type { StreamConfig } from './config.ts'
import {
  DEFAULT_STREAM_SETTINGS,
  STREAM_SETTINGS_NS,
  type StreamDebugTuning,
  type StreamSettings,
} from './settings.ts'

/**
 * Diagnostic tuning schema, shared by the legacy user section and the modern
 * nested config section so both seams validate identically.
 */
export const streamDebugTuningSchema: Schema<StreamDebugTuning> = Schema.object({
  revealScale: Schema.number().min(0.25).max(2).default(DEFAULT_STREAM_SETTINGS.debugTuning.revealScale),
  queuePressure: Schema.number().min(0).max(2).default(DEFAULT_STREAM_SETTINGS.debugTuning.queuePressure),
  maxRevealCps: Schema.number().min(120).max(1000).default(DEFAULT_STREAM_SETTINGS.debugTuning.maxRevealCps),
  springStiffness: Schema.number().min(40).max(320).default(DEFAULT_STREAM_SETTINGS.debugTuning.springStiffness),
  springDamping: Schema.number().min(8).max(80).default(DEFAULT_STREAM_SETTINGS.debugTuning.springDamping),
  springMass: Schema.number().min(0.5).max(3).default(DEFAULT_STREAM_SETTINGS.debugTuning.springMass),
  runwayPx: Schema.number().min(0).max(120).default(DEFAULT_STREAM_SETTINGS.debugTuning.runwayPx),
  reserveResponseMs: Schema.number().min(60).max(600).default(DEFAULT_STREAM_SETTINGS.debugTuning.reserveResponseMs),
  backpressureMinScale: Schema.number().min(0.25).max(1).default(DEFAULT_STREAM_SETTINGS.debugTuning.backpressureMinScale),
})

/** Schema of the user-owned fields, shared by both seam generations. */
export const streamSettingsSchema: Schema<StreamSettings> = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.enabled),
  controlScroll: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.controlScroll),
  preset: Schema.union([
    Schema.const('realtime'),
    Schema.const('balanced'),
    Schema.const('silky'),
  ] as const).default(DEFAULT_STREAM_SETTINGS.preset),
  motionPreference: Schema.union([
    Schema.const('auto'),
    Schema.const('force-smooth'),
    Schema.const('force-reduced'),
  ] as const).default(DEFAULT_STREAM_SETTINGS.motionPreference),
  thinkAutoExpand: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.thinkAutoExpand),
  logarithmicFade: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.logarithmicFade),
  debugEnabled: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.debugEnabled),
  debugTuning: streamDebugTuningSchema,
})

/**
 * Mark a field editable through the profile patch. `extra` is the
 * version-agnostic spelling of `volatile()`: the modern kernel reads
 * `meta.volatile`, every older schemastery simply ignores the metadata.
 */
function volatileField<S, T>(schema: Schema<S, T>): Schema<S, T> {
  return (schema as unknown as { extra(key: string, value: unknown): Schema<S, T> })
    .extra('volatile', true)
}

/**
 * The modern seam's user-owned fields, declared directly on the plugin's
 * `Config`.
 *
 * They are flat rather than nested under a `settings` object because the seam
 * validates the *effective form value* it projects from the composed entry, and
 * a nested section is rejected as `Config field "…" is not volatile` on the
 * kernels this was tested against (0.1.7-alpha.2). Flat volatile leaves are the
 * shape the built-in plugins use (`dsh-client-locale`), and they persist as
 * ordinary entry config — the profile patch ends up holding
 * `config.enabled`, `config.preset`, … next to the composition fields.
 */
export const streamSettingsSectionSchema: Schema<Partial<StreamSettings>> = Schema.object({
  enabled: volatileField(Schema.boolean().default(DEFAULT_STREAM_SETTINGS.enabled)),
  controlScroll: volatileField(Schema.boolean().default(DEFAULT_STREAM_SETTINGS.controlScroll)),
  preset: volatileField(Schema.union([
    Schema.const('realtime'),
    Schema.const('balanced'),
    Schema.const('silky'),
  ] as const).default(DEFAULT_STREAM_SETTINGS.preset)),
  motionPreference: volatileField(Schema.union([
    Schema.const('auto'),
    Schema.const('force-smooth'),
    Schema.const('force-reduced'),
  ] as const).default(DEFAULT_STREAM_SETTINGS.motionPreference)),
  thinkAutoExpand: volatileField(Schema.boolean().default(DEFAULT_STREAM_SETTINGS.thinkAutoExpand)),
  logarithmicFade: volatileField(Schema.boolean().default(DEFAULT_STREAM_SETTINGS.logarithmicFade)),
  debugEnabled: volatileField(Schema.boolean().default(DEFAULT_STREAM_SETTINGS.debugEnabled)),
  debugTuning: volatileField(streamDebugTuningSchema),
})

/**
 * The entry config as both halves read it: composition fields plus the flat
 * user-owned field bag the settings seams persist.
 */
export type StreamEntryConfig = Partial<StreamSettings> & Partial<StreamConfig>

/**
 * Resolve the effective user settings from either entry-config shape. Legacy
 * kernels keep them in a separate registered namespace; modern kernels keep
 * them flat on the entry config, next to the composition fields.
 * @param config - Schema-validated plugin configuration.
 * @returns Complete settings with both generations' values applied.
 */
export function resolveStreamSettings(
  config: StreamEntryConfig,
): StreamSettings {
  return {
    ...DEFAULT_STREAM_SETTINGS,
    ...config,
    debugTuning: {
      ...DEFAULT_STREAM_SETTINGS.debugTuning,
      ...(config.debugTuning ?? {}),
    },
  }
}

/** Read/write handle the Host half uses, independent of the seam generation. */
export interface StreamSettingsScope {
  /** Current resolved settings: defaults, then composition, then the user layer. */
  get(): StreamSettings
  /**
   * Merge a patch into the user layer and persist it. The seam validates the
   * merged result, so callers cannot store a value the schema rejects.
   * @param patch - Partial settings to merge.
   */
  update<P extends object>(patch: P): Promise<void>
  /** Whether the active profile accepts writes. */
  writable(): boolean
}

/** One modern-seam config form as returned by `settings.describe()`. */
interface ModernForm {
  /** Profile entry id the form belongs to. */
  ns?: unknown
  /** Revision the write calls must quote to detect a concurrent edit. */
  revision?: unknown
  /** Effective entry config; the projection seam's live read side. */
  value?: unknown
  /** Loader entry the form projects, accepted by the profile editor. */
  entry?: unknown
}

/**
 * The profile configuration editor — the service the modern seam writes
 * through. Its `edit()` owns atomic persistence, the file lock, and the
 * Loader reload, so a plugin that must persist a form the seam refuses to own
 * can still do so without touching the profile file itself.
 */
export interface ProfileConfigEditor {
  configuration(): Array<{ entry: unknown }>
  edit(entry: unknown, change: (raw: unknown, inherited: unknown) => unknown): Promise<void>
}

/** Recursive plain-object merge, matching the seam's own layer composition. */
function mergeLayers(under: unknown, over: unknown): unknown {
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : value
  }
  return merged
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow an unknown form value to the settings shape we own, if it is a record. */
function formConfig(value: unknown): StreamEntryConfig | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as StreamEntryConfig
    : undefined
}

/** The modern seam's plugin-facing surface (`0.1.7` and later). */
interface ModernSettingsService {
  writable?: boolean
  describe(options?: { redactSecrets?: boolean }): ModernForm[]
  update(ns: string, patch: unknown, expectedRevision?: unknown): Promise<void>
}

/** The legacy seam's plugin-facing surface (through the `0.1.6` line). */
interface LegacySettingsService {
  writable: boolean
  register(
    ns: SettingsNamespace,
    schema: Schema<StreamSettings>,
    options: { base?: Partial<StreamSettings>; applies?: 'live' | 'startup' },
  ): { get(): StreamSettings; update(patch: object): Promise<void> }
}

/** Detect the modern projection seam: `register` is what the registry had. */
function isModernSeam(service: unknown): service is ModernSettingsService {
  return typeof (service as { register?: unknown } | null | undefined)?.register !== 'function'
    && typeof (service as { describe?: unknown } | null | undefined)?.describe === 'function'
}

/**
 * Register the user-owned settings over whichever seam this kernel ships.
 * @param settingsCtx - Context carrying `ctx.settings`.
 * @param config - Resolved plugin config, used as the composition `base` on the
 * legacy seam and ignored on the modern one (the entry config holds it there).
 * @param editor - Optional profile configuration editor. On the modern seam it
 * is the durable write path: the seam's own writer validates a volatile-form
 * shape this plugin's composed entry does not present, so the update is applied
 * through the same editor the seam itself calls inside `write()`.
 * @returns Scope the Host half reads and writes through.
 */
export function createStreamSettingsScope(
  settingsCtx: Context,
  config: StreamEntryConfig,
  editor?: ProfileConfigEditor,
): StreamSettingsScope {
  const service = settingsCtx.settings as unknown

  if (!isModernSeam(service)) {
    // Legacy registry seam. `settingsNamespace()` was dropped in 0.1.2, so the
    // rc-era brand is reproduced locally instead of importing a removed symbol.
    const legacy = service as LegacySettingsService
    const scope = legacy.register(STREAM_SETTINGS_NS as SettingsNamespace, streamSettingsSchema, {
      // The install-time entry config is the composition base, so it resolves
      // *below* the user layer: a stored pick still wins, while "the user never
      // chose" keeps following the overlay (cordis.patch.yml / profile config).
      // Keeping it out of the schema default is what makes those two states
      // distinguishable at all.
      ...(config.preset === undefined ? {} : { base: { preset: config.preset } }),
      applies: 'live',
    })
    return {
      get: () => scope.get(),
      update: patch => scope.update(patch),
      writable: () => legacy.writable,
    }
  }

  const modern = service
  // `describe()` keys every form by the profile entry id, which is the loader
  // id from the plugin's own bundle patch (`smooth-stream`). A missing form
  // means the entry is not addressable, and writes are refused rather than
  // silently dropped.
  const formOf = (): ModernForm | undefined =>
    modern.describe().find(form => form.ns === STREAM_SETTINGS_NS)

  return {
    // Reads go through the seam, not the apply-time argument: on this
    // generation a user edit lands in the profile patch and only `describe()`
    // shows it, so a captured config would serve stale values until the entry
    // remounts.
    get: () => resolveStreamSettings(formConfig(formOf()?.value) ?? config),
    update: async patch => {
      const form = formOf()
      if (form === undefined) {
        throw new Error(`smooth-stream has no configurable profile entry "${STREAM_SETTINGS_NS}"`)
      }
      // Preferred path: the seam owns validation, conflict detection, and the
      // reload. Tried first so a kernel that accepts this plugin's composed
      // entry keeps the revision-checked semantics.
      try {
        await modern.update(STREAM_SETTINGS_NS, patch, form.revision)
        return
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (editor === undefined || !message.includes('not volatile')) throw cause
      }
      // Fallback: write the layer the seam would have written. Every field in
      // `patch` is declared volatile in this plugin's `Config`, so merging the
      // patch over the raw entry config is equivalent to the `write()` body.
      const row = editor.configuration().find(candidate =>
        (candidate.entry as { options?: { id?: unknown } } | undefined)?.options?.id === STREAM_SETTINGS_NS)
      if (row === undefined) throw new Error(`smooth-stream has no configurable profile entry "${STREAM_SETTINGS_NS}"`)
      await editor.edit(row.entry, (raw: unknown) => mergeLayers(raw, patch))
    },
    // The modern seam refuses writes when the profile has no editable document,
    // so the card must reflect that instead of offering a dead save button.
    writable: () => modern.writable === true && formOf() !== undefined,
  }
}
