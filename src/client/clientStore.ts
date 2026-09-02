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

export interface SnapshotStoreLike<T> {
  getSnapshot(): T
  subscribe(listener: (state: T) => void): () => void
  update(mutator: (draft: T) => void): void
  set(next: T): void
}

function fallbackSnapshotStore<T extends object>(init: T): SnapshotStoreLike<T> {
  let state = init
  const listeners = new Set<(state: T) => void>()
  return {
    getSnapshot: () => state,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update: mutator => {
      const draft = Object.create(
        Object.getPrototypeOf(state),
        Object.getOwnPropertyDescriptors(state),
      ) as T
      mutator(draft)
      state = draft
      for (const listener of [...listeners]) listener(state)
    },
    set: next => {
      state = next
      for (const listener of [...listeners]) listener(state)
    },
  }
}

/**
 * Runtime require: the module-loader factory scopes its own resolver over the
 * booting kernel's table; under Node (vitest) there is no global require, so
 * fall back to `createRequire`.
 */
function pickRequire(): NodeRequire | null {
  if (typeof require === 'function') {
    try {
      return require
    } catch {
      return null
    }
  }
  if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
    try {
      const { createRequire } = process.getBuiltinModule('node:module')
      return createRequire(process.cwd() + '/package.json')
    } catch {
      return null
    }
  }
  return null
}

let clientStore: Partial<ClientRuntimeClient> | undefined

try {
  const req = pickRequire()
  if (req !== null) {
    try {
      // 0.1.2+ seeds the split store package directly into the module table.
      clientStore = req('@deepseek-ai/dsh-client-store') as ClientRuntimeClient
    } catch {
      try {
        // ≤ 0.1.1 owns the store engine on the client-runtime client face.
        clientStore = req('@deepseek-ai/dsh-client-runtime/client') as ClientRuntimeClient
      } catch {
        // Fallback below
      }
    }
  }
} catch {
  // Fallback below
}

export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  update(mutator: (draft: T) => void): void
  set(next: T): void
}

export const createSnapshotStore = (clientStore?.createSnapshotStore ?? fallbackSnapshotStore) as <T extends object>(init: T) => SnapshotStore<T>
