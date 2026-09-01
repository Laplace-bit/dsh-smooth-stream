/**
 * Kernel compatibility for the client store engine.
 *
 * DSH 0.1.2 split the snapshot store out of `@deepseek-ai/dsh-client-runtime`
 * into a bare `@deepseek-ai/dsh-client-store` module-table seed, while ≤ 0.1.1
 * kernels keep it on the client-runtime client face. The client module table
 * only answers what the booting kernel actually ships, so the face must be
 * probed at runtime: a static require of either specifier kills the whole
 * loader tree on the other generation (issue #17: a top-level
 * `require("@deepseek-ai/dsh-client-runtime/client")` took down the web UI on
 * DSH Desktop 2.0.4 / kernel 0.1.2-alpha.1).
 */

type ClientRuntimeClient = typeof import('@deepseek-ai/dsh-client-runtime/client')

/**
 * Runtime require: the module-loader factory scopes its own resolver over the
 * booting kernel's table; under Node (vitest) there is no global require, so
 * fall back to `createRequire`.
 */
function pickRequire(): NodeRequire {
  if (typeof require === 'function') return require
  if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
    const { createRequire } = process.getBuiltinModule('node:module')
    return createRequire(process.cwd() + '/package.json')
  }
  throw new TypeError('dsh-smooth-stream: no client module resolver available')
}

let clientStore: ClientRuntimeClient

try {
  // 0.1.2+ seeds the split store package directly into the module table.
  clientStore = pickRequire()('@deepseek-ai/dsh-client-store') as ClientRuntimeClient
} catch {
  // ≤ 0.1.1 owns the store engine on the client-runtime client face.
  clientStore = pickRequire()('@deepseek-ai/dsh-client-runtime/client') as ClientRuntimeClient
}

export const createSnapshotStore = clientStore.createSnapshotStore
export type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
