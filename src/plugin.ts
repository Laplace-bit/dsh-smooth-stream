import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
// Type-only: erased at runtime, so the host entry never link-fails on kernels
// whose dsh-settings no longer ships the value-side helper (issue #17).
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_STREAM_CONFIG, type StreamConfig } from './config.ts'
import { injectStreamConfig } from './boot-config.ts'
import { STREAM_PACKAGE_NAME, STREAM_PACKAGE_VERSION } from './package-meta.ts'
import { inspectProfileInstallation, updateNpmProfilePackage } from './profile-installation.ts'
import {
  STREAM_SETTINGS_RPC,
  STREAM_SETTINGS_RPC_CHANNEL,
  type StreamDebugSettingsView,
  type StreamSettingsView,
} from './settings-api.ts'
import {
  DEFAULT_STREAM_SETTINGS,
  STREAM_SETTINGS_NS,
  type StreamDebugTuning,
  type StreamSettings,
} from './settings.ts'

/** Display name shown by the Host loader while the plugin is mounted. */
export const name = 'dsh-smooth-stream'

/**
 * Plugin configuration accepted from the overlay's `config` section. Cordis
 * validates the value against this schema at load and fills omitted fields
 * from the shared defaults, so an invalid value fails the load loudly.
 */
export interface Config extends StreamConfig {}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['typewriter', 'teleprompter'] as const).default(DEFAULT_STREAM_CONFIG.mode),
  preset: Schema.union(['realtime', 'balanced', 'silky'] as const).default(DEFAULT_STREAM_CONFIG.preset),
  revealCharsPerSec: Schema.number()
    .min(5)
    .max(200)
    .default(DEFAULT_STREAM_CONFIG.revealCharsPerSec),
  scrollSpeedPxPerSec: Schema.number()
    .min(1)
    .max(200)
    .default(DEFAULT_STREAM_CONFIG.scrollSpeedPxPerSec),
  maxScrollSpeedPxPerSec: Schema.number()
    .min(1)
    .max(2000)
    .default(DEFAULT_STREAM_CONFIG.maxScrollSpeedPxPerSec),
})

/**
 * Schema of the user-owned settings section. The Host keeps it in the durable
 * settings provider while the browser edits it through the plugin RPC below.
 */
export const StreamSettingsSchema: Schema<StreamSettings> = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.enabled),
  controlScroll: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.controlScroll),
  motionPreference: Schema.union([
    Schema.const('auto'),
    Schema.const('force-smooth'),
    Schema.const('force-reduced'),
  ] as const).default(DEFAULT_STREAM_SETTINGS.motionPreference),
  thinkAutoExpand: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.thinkAutoExpand),
  debugEnabled: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.debugEnabled),
  debugTuning: Schema.object({
    revealScale: Schema.number().min(0.25).max(2).default(DEFAULT_STREAM_SETTINGS.debugTuning.revealScale),
    queuePressure: Schema.number().min(0).max(2).default(DEFAULT_STREAM_SETTINGS.debugTuning.queuePressure),
    maxRevealCps: Schema.number().min(120).max(1000).default(DEFAULT_STREAM_SETTINGS.debugTuning.maxRevealCps),
    springStiffness: Schema.number().min(40).max(320).default(DEFAULT_STREAM_SETTINGS.debugTuning.springStiffness),
    springDamping: Schema.number().min(8).max(80).default(DEFAULT_STREAM_SETTINGS.debugTuning.springDamping),
    springMass: Schema.number().min(0.5).max(3).default(DEFAULT_STREAM_SETTINGS.debugTuning.springMass),
    runwayPx: Schema.number().min(0).max(120).default(DEFAULT_STREAM_SETTINGS.debugTuning.runwayPx),
    reserveResponseMs: Schema.number().min(60).max(600).default(DEFAULT_STREAM_SETTINGS.debugTuning.reserveResponseMs),
    backpressureMinScale: Schema.number().min(0.25).max(1).default(DEFAULT_STREAM_SETTINGS.debugTuning.backpressureMinScale),
  }),
})

/**
 * Host half: log the resolved configuration and bridge it to the browser
 * half. The web boot graph carries no per-entry config, so the validated
 * value is injected into every served index response as a boot global the
 * client entry reads at apply time.
 * @param ctx - Host context carrying the web server service when composed.
 * @param config - Schema-validated configuration with defaults filled.
 */
export function apply(ctx: Context, config: Config): void {
  console.log(
    `[dsh-smooth-stream] plugin loaded! mode=${config.mode} preset=${config.preset} `
    + `seed=${config.revealCharsPerSec}cps scroll=${config.scrollSpeedPxPerSec}px/s `
    + `maxScroll=${config.maxScrollSpeedPxPerSec}px/s`,
  )
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () => httpCtx.webServer.tapIndex(html => injectStreamConfig(html, config)),
      'dsh-smooth-stream: boot config bridge',
    )
  })
  // The core settings RPC deliberately filters third-party namespaces. Keep
  // the durable provider as the authority, but expose this one schema through
  // the plugin's own loopback-only connection channel instead.
  ctx.inject(['settings'], (settingsCtx) => {
    // 0.1.2 kernels dropped the `settingsNamespace()` helper — a validating
    // identity on ≤ 0.1.1 — and take the raw string, so the rc-era brand is
    // reproduced locally instead of statically importing a removed symbol.
    // The namespace is a compile-time constant matching the kernel's
    // /^[a-z][a-z0-9-]*$/ pattern.
    const settingsNamespace = STREAM_SETTINGS_NS as SettingsNamespace
    const scope = settingsCtx.settings.register(
      settingsNamespace,
      StreamSettingsSchema,
      { applies: 'live' },
    )
    settingsCtx.inject(['connection'], (connectionCtx) => {
      let upgrade: Promise<void> | undefined

      const view = (): StreamSettingsView => {
        const installation = inspectProfileInstallation(connectionCtx.baseUrl, STREAM_PACKAGE_NAME)
        const settings = scope.get()
        return {
          version: STREAM_PACKAGE_VERSION,
          installation: installation.kind,
          writable: connectionCtx.settings.writable,
          enabled: settings.enabled,
          controlScroll: settings.controlScroll,
          motionPreference: settings.motionPreference,
          thinkAutoExpand: settings.thinkAutoExpand,
          canUpgrade: installation.kind === 'npm',
        }
      }

      const debugView = (): StreamDebugSettingsView => {
        const settings = scope.get()
        return {
          debugEnabled: settings.debugEnabled,
          tuning: { ...settings.debugTuning },
        }
      }

      const validDebugTuning = (value: unknown): value is StreamDebugTuning => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
        const tuning = value as Record<string, unknown>
        return typeof tuning.revealScale === 'number'
          && tuning.revealScale >= 0.25 && tuning.revealScale <= 2
          && typeof tuning.queuePressure === 'number'
          && tuning.queuePressure >= 0 && tuning.queuePressure <= 2
          && typeof tuning.maxRevealCps === 'number'
          && tuning.maxRevealCps >= 120 && tuning.maxRevealCps <= 1000
          && typeof tuning.springStiffness === 'number'
          && tuning.springStiffness >= 40 && tuning.springStiffness <= 320
          && typeof tuning.springDamping === 'number'
          && tuning.springDamping >= 8 && tuning.springDamping <= 80
          && typeof tuning.springMass === 'number'
          && tuning.springMass >= 0.5 && tuning.springMass <= 3
          && typeof tuning.runwayPx === 'number'
          && tuning.runwayPx >= 0 && tuning.runwayPx <= 120
          && typeof tuning.reserveResponseMs === 'number'
          && tuning.reserveResponseMs >= 60 && tuning.reserveResponseMs <= 600
          && typeof tuning.backpressureMinScale === 'number'
          && tuning.backpressureMinScale >= 0.25 && tuning.backpressureMinScale <= 1
      }

      const handle: ConnectionRpcHandler = async (endpoint, payload) => {
        if (endpoint === STREAM_SETTINGS_RPC.read) return { ok: true, value: view() }
        if (endpoint === STREAM_SETTINGS_RPC.write) {
          if (typeof payload !== 'object' || payload === null || Array.isArray(payload)
            || typeof (payload as { enabled?: unknown }).enabled !== 'boolean'
            || typeof (payload as { controlScroll?: unknown }).controlScroll !== 'boolean'
            || typeof (payload as { thinkAutoExpand?: unknown }).thinkAutoExpand !== 'boolean'
          ) {
            return {
              ok: false,
              error: {
                code: 'settings-rejected',
                message: 'enabled, controlScroll and thinkAutoExpand must be booleans',
                details: { ns: STREAM_SETTINGS_NS },
              },
            }
          }
          if (!connectionCtx.settings.writable) {
            return {
              ok: false,
              error: {
                code: 'settings-rejected',
                message: 'smooth-stream settings are read-only',
                details: { ns: STREAM_SETTINGS_NS },
              },
            }
          }
          try {
            const next = payload as {
              enabled: boolean
              controlScroll: boolean
              motionPreference?: unknown
              thinkAutoExpand: boolean
              debugEnabled?: unknown
              debugTuning?: unknown
            }
            if (
              next.motionPreference !== undefined
              && next.motionPreference !== 'auto'
              && next.motionPreference !== 'force-smooth'
              && next.motionPreference !== 'force-reduced'
            ) {
              return {
                ok: false,
                error: {
                  code: 'settings-rejected',
                  message: 'motionPreference must be one of auto | force-smooth | force-reduced',
                  details: { ns: STREAM_SETTINGS_NS },
                },
              }
            }
            const hasDebug = next.debugEnabled !== undefined || next.debugTuning !== undefined
            if (hasDebug && (typeof next.debugEnabled !== 'boolean' || !validDebugTuning(next.debugTuning))) {
              return {
                ok: false,
                error: {
                  code: 'settings-rejected',
                  message: 'debugEnabled and debugTuning must be provided together and be valid',
                  details: { ns: STREAM_SETTINGS_NS },
                },
              }
            }
            await scope.update({
              enabled: next.enabled,
              controlScroll: next.controlScroll,
              ...(next.motionPreference === undefined ? {} : { motionPreference: next.motionPreference }),
              thinkAutoExpand: next.thinkAutoExpand,
              ...(hasDebug ? { debugEnabled: next.debugEnabled, debugTuning: next.debugTuning } : {}),
            })
          } catch {
            return {
              ok: false,
              error: {
                code: 'settings-rejected',
                message: 'smooth-stream settings update failed',
                details: { ns: STREAM_SETTINGS_NS },
              },
            }
          }
          return { ok: true, value: view() }
        }
        if (endpoint === STREAM_SETTINGS_RPC.debugRead) return { ok: true, value: debugView() }
        if (endpoint === STREAM_SETTINGS_RPC.debugWrite) {
          if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
            return {
              ok: false,
              error: {
                code: 'settings-rejected',
                message: 'debug settings must be an object',
                details: { ns: STREAM_SETTINGS_NS },
              },
            }
          }
          const next = payload as { debugEnabled?: unknown; tuning?: unknown }
          if (typeof next.debugEnabled !== 'boolean' || !validDebugTuning(next.tuning)) {
            return {
              ok: false,
              error: {
                code: 'settings-rejected',
                message: 'debugEnabled and tuning are malformed',
                details: { ns: STREAM_SETTINGS_NS },
              },
            }
          }
          if (!connectionCtx.settings.writable) {
            return {
              ok: false,
              error: {
                code: 'settings-rejected',
                message: 'smooth-stream debug settings are read-only',
                details: { ns: STREAM_SETTINGS_NS },
              },
            }
          }
          try {
            await scope.update({ debugEnabled: next.debugEnabled, debugTuning: next.tuning })
          } catch {
            return {
              ok: false,
              error: {
                code: 'settings-rejected',
                message: 'smooth-stream debug settings update failed',
                details: { ns: STREAM_SETTINGS_NS },
              },
            }
          }
          return { ok: true, value: debugView() }
        }
        if (endpoint === STREAM_SETTINGS_RPC.upgrade) {
          const installation = inspectProfileInstallation(connectionCtx.baseUrl, STREAM_PACKAGE_NAME)
          if (installation.kind !== 'npm') {
            return { ok: false, error: { code: 'internal', message: 'smooth-stream is not an npm profile dependency', details: {} } }
          }
          if (upgrade !== undefined) {
            return { ok: false, error: { code: 'internal', message: 'smooth-stream update is already running', details: {} } }
          }
          upgrade = updateNpmProfilePackage(installation.profileDir, STREAM_PACKAGE_NAME)
          try {
            await upgrade
          } catch {
            return { ok: false, error: { code: 'internal', message: 'smooth-stream update failed', details: {} } }
          } finally {
            upgrade = undefined
          }
          return { ok: true, value: { restartRequired: true } }
        }
        return { ok: false, error: { code: 'internal', message: `unknown smooth-stream endpoint ${JSON.stringify(endpoint)}`, details: {} } }
      }
      connectionCtx.effect(
        () => connectionCtx.connection.rpc.handle(STREAM_SETTINGS_RPC_CHANNEL, handle, { authority: 'loopback' }),
        'dsh-smooth-stream: settings RPC',
      )
    })
  })
}
