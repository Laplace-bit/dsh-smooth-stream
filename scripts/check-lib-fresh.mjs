#!/usr/bin/env node
/**
 * Guard: the dsh host serves lib/ from this working tree through a
 * boot-time-rev'd bundle URL — a stale lib means the host silently runs old
 * engine code no matter what the source says. Exit 1 when lib/ is older than
 * the newest client source file, with the fix command.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const newestSrc = readdirSync(join(root, 'src/client'), { recursive: true })
  .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
  .map(f => statSync(join(root, 'src/client', f)).mtimeMs)
  .reduce((a, b) => Math.max(a, b), 0)
const libClient = join(root, 'lib/client.js')
let libMs = 0
try {
  libMs = statSync(libClient).mtimeMs
} catch {
  console.error('✗ lib/client.js missing — run: pnpm build')
  process.exit(1)
}
if (libMs + 1000 < newestSrc) {
  const staleS = Math.round((newestSrc - libMs) / 1000)
  console.error(`✗ lib/ is stale by ${staleS}s relative to src/client — the dsh host serves the OLD engine until you rebuild and restart it.`)
  console.error('  Fix: pnpm build && restart your dsh web/desktop session (the bundle rev is computed at boot).')
  process.exit(1)
}
console.log('✓ lib/ is fresh (newer than all src/client sources).')
