/**
 * Browser-bundle shim for `@deepseek-ai/dsh-client-runtime(/client)`. The real
 * package is a prebuilt harness bundle that registers through
 * `window.__ModuleLoader__` at module scope, which does not exist outside the
 * host. The audit graph only needs `createSnapshotStore`; this mirror keeps
 * the same shape (zustand-style snapshot store with an immer-style mutable
 * draft) without per-update deep clones, so reportStream's per-frame writes
 * do not distort frame timing.
 */
export interface SnapshotStoreLike<T> {
  getSnapshot(): T
  subscribe(listener: (state: T) => void): () => void
  update(mutator: (draft: T) => void): void
  set(next: T): void
}

export function createSnapshotStore<T extends object>(init: T): SnapshotStoreLike<T> {
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

export { SlotRegistry } from '../../../deepseek-harness/packages/client/ui-renderer/src/client/registry.ts'
