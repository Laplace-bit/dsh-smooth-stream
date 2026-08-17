import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_STREAM_CONFIG, type StreamConfig } from './config.ts'
import { injectStreamConfig } from './boot-config.ts'
import { STREAM_PACKAGE_NAME, STREAM_PACKAGE_VERSION } from './package-meta.ts'
import { inspectProfileInstallation, updateNpmProfilePackage } from './profile-installation.ts'
import { STREAM_SETTINGS_RPC, STREAM_SETTINGS_RPC_CHANNEL, type StreamSettingsView } from './settings-api.ts'
import { DEFAULT_STREAM_SETTINGS, STREAM_SETTINGS_NS, type StreamSettings } from './settings.ts'

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
  thinkAutoExpand: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.thinkAutoExpand),
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
    const scope = settingsCtx.settings.register(
      settingsNamespace(STREAM_SETTINGS_NS),
      StreamSettingsSchema,
      { applies: 'live' },
    )
    settingsCtx.inject(['connection'], (connectionCtx) => {
      let upgrade: Promise<void> | undefined

      const view = (): StreamSettingsView => {
        const installation = inspectProfileInstallation(connectionCtx.baseUrl, STREAM_PACKAGE_NAME)
        return {
          version: STREAM_PACKAGE_VERSION,
          installation: installation.kind,
          writable: connectionCtx.settings.writable,
          thinkAutoExpand: scope.get().thinkAutoExpand,
          canUpgrade: installation.kind === 'npm',
        }
      }

      const handle: ConnectionRpcHandler = async (endpoint, payload) => {
        if (endpoint === STREAM_SETTINGS_RPC.read) return { ok: true, value: view() }
        if (endpoint === STREAM_SETTINGS_RPC.write) {
          if (typeof payload !== 'object' || payload === null
            || typeof (payload as { thinkAutoExpand?: unknown }).thinkAutoExpand !== 'boolean') {
            return {
              ok: false,
              error: {
                code: 'settings-rejected',
                message: 'thinkAutoExpand must be a boolean',
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
            await scope.update({ thinkAutoExpand: (payload as { thinkAutoExpand: boolean }).thinkAutoExpand })
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
