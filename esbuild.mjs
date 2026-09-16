import { build, context } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })
copyFileSync('src/bridge.js', 'dist/bridge.js')

/** Shared build options for the extension host bundle. */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: true,
  logLevel: 'info',
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('watching extension host bundle...')
} else {
  await build(options)
}
