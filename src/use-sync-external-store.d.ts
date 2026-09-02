/**
 * Local typings for use-sync-external-store 1.2.0: the package ships no types.
 * Mirrors the shim's with-selector build (the only entry this package consumes).
 * Same pattern as the harness's ui-renderer local typings.
 */
declare module 'use-sync-external-store/shim/with-selector' {
  export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => Snapshot,
    getServerSnapshot: undefined | null | (() => Snapshot),
    selector: (snapshot: Snapshot) => Selection,
    isEqual?: (a: Selection, b: Selection) => boolean,
  ): Selection
}

declare module 'use-sync-external-store/shim/with-selector.js' {
  export { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'
}
