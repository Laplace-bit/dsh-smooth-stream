import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))
const harnessRoot = resolve(root, '../deepseek-harness')

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
  if (!existsSync(harnessRoot)) return null
  const map = JSON.parse(readFileSync(join(root, 'tsconfig.paths.json'), 'utf8')) as PathMap
  const entries = Object.entries(map.compilerOptions.paths)
  const exact = new Map<string, string[]>()
  const wild: Array<{ pattern: string; targets: string[] }> = []
  for (const [pattern, targets] of entries) {
    const resolved = targets.map(target => resolve(root, target))
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
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.tsx'],
  },
})
