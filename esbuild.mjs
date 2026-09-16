import { build, context } from 'esbuild'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

mkdirSync('dist', { recursive: true })
writeFileSync('dist/bridge.js', readFileSync('src/connection-recovery.js', 'utf8') + '\n' + readFileSync('src/bridge.js', 'utf8'))
copyFileSync('src/recovery-shell.js', 'dist/recovery-shell.js')

/** Shared build options for the extension host bundle. */
const options = {
  entryPoints: ['src/extension.ts', 'src/runtime-guardian.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  external: ['vscode'],
  outdir: 'dist',
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
