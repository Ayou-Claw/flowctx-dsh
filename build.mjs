/**
 * ESM host build for flowctx-dsh.
 *
 * Host-only plugin (no client half). @deepseek-ai/* and cordis stay external —
 * they are provided by the DSH profile's node_modules at runtime.
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('lib', { recursive: true })

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*'],
  logLevel: 'info',
})
