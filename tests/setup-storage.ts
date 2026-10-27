/**
 * Restore `localStorage` when the Node runtime shadows the one jsdom installs.
 *
 * Node 26 enables its experimental WebStorage globals by default. Without
 * `--localstorage-file` the `localStorage` global resolves to `undefined` and
 * keeps that slot on `globalThis`, so the Storage that jsdom would provide is
 * never reachable: every spec touching it fails with "cannot read properties
 * of undefined". Replacing the shadow with a plain in-memory Storage keeps the
 * suite runnable on that runtime without requiring `NODE_OPTIONS` on every
 * invocation. When jsdom's implementation is intact, this file does nothing.
 */

/** Minimal in-memory Storage; specs only need set/get/remove/clear/length/key. */
function memoryStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() { return entries.size },
    clear: () => { entries.clear() },
    getItem: key => entries.get(key) ?? null,
    key: index => [...entries.keys()][index] ?? null,
    removeItem: key => { entries.delete(key) },
    setItem: (key, value) => { entries.set(key, value) },
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: memoryStorage(),
  })
}
