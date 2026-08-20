import { build } from 'esbuild'

const result = await build({
  bundle: true,
  entryPoints: ['benchmarks/stream-engine.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  write: false,
})

const output = result.outputFiles?.[0]
if (!output) throw new Error('Benchmark bundle was not generated')

await import(`data:text/javascript;base64,${Buffer.from(output.contents).toString('base64')}`)
