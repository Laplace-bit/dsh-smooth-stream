import { build } from 'esbuild'
import { resolve } from 'node:path'

const result = await build({
  bundle: true,
  entryPoints: ['benchmarks/stream-engine.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  write: false,
  plugins: [{
    name: 'benchmark-browser-runtime-shim',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /debugRuntime\.ts$/ }, () => ({
        path: resolve('benchmarks/debug-runtime-shim.ts'),
      }))
    },
  }],
})

const output = result.outputFiles?.[0]
if (!output) throw new Error('Benchmark bundle was not generated')

await import(`data:text/javascript;base64,${Buffer.from(output.contents).toString('base64')}`)
