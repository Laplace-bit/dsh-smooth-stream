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

function harnessPathsPlugin(): Plugin | null {
  if (harnessRoot === null) return null
  const map = JSON.parse(readFileSync(join(root, 'tsconfig.paths.json'), 'utf8')) as PathMap
  const entries = Object.entries(map.compilerOptions.paths)
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
    resolveId(source) {
      if (!source.startsWith('@deepseek-ai/')) return null
      return resolveSource(source)
    },
  }
}

export default defineConfig({
  root,
  plugins: [harnessPathsPlugin()].filter((plugin): plugin is Plugin => plugin !== null),
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
    include: ['tests/**/*.spec.tsx'],
  },
})
