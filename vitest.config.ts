import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * The path map targets `../deepseek-harness`, which holds when this plugin is
 * checked out beside the harness. A checkout inside the harness's own
 * `local-plugins/` directory reaches the same tree two levels up, so resolve
 * the sibling layout first and fall back to the nested one; without a hit the
 * `@deepseek-ai/*` specifiers fall through to prebuilt client bundles that
 * expect a loader global and throw on import.
 */
function findHarnessRoot(): string | null {
  for (const candidate of [
    resolve(root, '../deepseek-harness'),
    resolve(root, '../..'),
  ]) {
    if (existsSync(join(candidate, 'packages')) && existsSync(join(candidate, 'vendor'))) {
      return candidate
    }
  }
  return null
}

const harnessRoot = findHarnessRoot()

interface PathMap {
  compilerOptions: { paths: Record<string, string[]> }
}

function existingFile(base: string): string | null {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function wildcardMatch(pattern: string, source: string): string | null {
  const star = pattern.indexOf('*')
  if (star < 0) return null
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) return null
  return source.slice(prefix.length, source.length - suffix.length)
}

function expandTarget(target: string, captured: string): string {
  return target.replaceAll('*', captured)
}

/**
 * Remove `//` and block comments from the Host's JSONC facade.
 *
 * The Host keeps its alias table in a commented `tsconfig.base.json`; Node has
 * no JSONC parser, so scan once and drop comments outside strings. Comment
 * markers inside quoted paths stay intact because strings win.
 * @param text - raw JSONC source.
 * @returns the same document with comments replaced by whitespace.
 */
function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    const next = text[index + 1] ?? ''
    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += char
      }
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        index += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (char === '\\') {
        out += next
        index += 1
      } else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      index += 1
      continue
    }
    out += char
  }
  return out
}

/**
 * The Host's own alias table for the checked-out generation.
 *
 * `tsconfig.paths.json` mirrors the Host specifiers this plugin resolved when
 * it was last updated; the Host's `tsconfig.base.json` is the live authority
 * for its own consumers. New Host generations add specifiers their client
 * sources import (0.2.x, for example, reached for
 * `@deepseek-ai/dsh-util-workspace-path` from `ui-primitives`), and a stale
 * mirror turns every one of those into an unresolvable import. Reading the
 * facade as a fallback keeps the suite running across Host updates without
 * waiting for the mirror to be regenerated; entries the mirror already maps
 * keep winning, and `resolve.alias` below still outranks both.
 * @param mirror - parsed `tsconfig.paths.json`.
 * @returns alias entries in precedence order: mirror first, Host facade after.
 */
function mergedHarnessPaths(mirror: PathMap): Array<[string, string[]]> {
  const entries = Object.entries(mirror.compilerOptions.paths)
  const facade = join(harnessRoot ?? '', 'tsconfig.base.json')
  if (harnessRoot === null || !existsSync(facade)) return entries
  const host = JSON.parse(stripJsonComments(readFileSync(facade, 'utf8'))) as PathMap
  const seen = new Set(entries.map(([pattern]) => pattern))
  for (const [pattern, targets] of Object.entries(host.compilerOptions.paths)) {
    if (seen.has(pattern)) continue
    seen.add(pattern)
    // Facade targets are relative to the Host root, not to this checkout.
    entries.push([pattern, targets.map(target => join(harnessRoot, target))])
  }
  return entries
}

function harnessPathsPlugin(): Plugin | null {
  if (harnessRoot === null) return null
  const map = JSON.parse(readFileSync(join(root, 'tsconfig.paths.json'), 'utf8')) as PathMap
  const entries = mergedHarnessPaths(map)
  const exact = new Map<string, string[]>()
  const wild: Array<{ pattern: string; targets: string[] }> = []
  // Every target is written against the sibling layout; re-root it so a nested
  // checkout resolves the same source files.
  const reroot = (target: string): string => resolve(
    root,
    target.startsWith('../deepseek-harness/')
      ? join(harnessRoot, target.slice('../deepseek-harness/'.length))
      : target,
  )
  for (const [pattern, targets] of entries) {
    const resolved = targets.map(reroot)
    if (pattern.includes('*')) wild.push({ pattern, targets: resolved })
    else exact.set(pattern, resolved)
  }

  const resolveSource = (source: string): string | null => {
    const exactTargets = exact.get(source)
    if (exactTargets !== undefined) {
      for (const target of exactTargets) {
        const hit = existingFile(target)
        if (hit !== null) return hit
      }
    }
    for (const { pattern, targets } of wild) {
      const captured = wildcardMatch(pattern, source)
      if (captured === null) continue
      for (const target of targets) {
        const hit = existingFile(expandTarget(target, captured))
        if (hit !== null) return hit
      }
    }
    return null
  }

  return {
    name: 'harness-src-paths',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@deepseek-ai/dsh-settings' && importer?.includes('.host.spec.')) return null
      if (!source.startsWith('@deepseek-ai/')) return null
      return resolveSource(source)
    },
  }
}

export default defineConfig({
  root,

  resolve: {
    alias: {
      react: resolve(root, 'node_modules/react'),
      'react/jsx-runtime': resolve(root, 'node_modules/react/jsx-runtime.js'),
      'react/jsx-dev-runtime': resolve(root, 'node_modules/react/jsx-dev-runtime.js'),
      'react-dom': resolve(root, 'node_modules/react-dom'),
      'react-dom/client': resolve(root, 'node_modules/react-dom/client.js'),
      '@deepseek-ai/dsh-client-runtime/client': resolve(root, 'repro/shims/client-runtime.ts'),
      '@deepseek-ai/dsh-client-runtime': resolve(root, 'repro/shims/client-runtime.ts'),
      '@deepseek-ai/dsh-client-store': resolve(root, 'repro/shims/client-runtime.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    projects: [
      {
        extends: true,
        test: {
          name: 'host',
          environment: 'jsdom',
          include: ['tests/**/*.host.spec.tsx'],
          setupFiles: ['./tests/setup-storage.ts'],
        },
      },
      {
        extends: true,
        plugins: [harnessPathsPlugin()].filter((plugin): plugin is Plugin => plugin !== null),
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['tests/**/*.spec.tsx'],
          exclude: ['tests/**/*.host.spec.tsx'],
          setupFiles: ['./tests/setup-storage.ts', './tests/setup.ts'],
        },
      },
    ],
  },
})
