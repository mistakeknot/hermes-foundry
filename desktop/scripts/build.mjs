// Bundle a plugin entry into ONE plain-ESM file for $HERMES_HOME/desktop-plugins/<id>/plugin.js.
// Only @hermes/plugin-sdk, react and react/jsx-runtime may stay as imports (the host rewrites them
// to shim blobs); everything else, three.js included, is bundled in.
// usage: node scripts/build.mjs [entry=src/plugin.ts] [out=plugin.js]
import { build } from 'esbuild'
import { statSync } from 'node:fs'

const entry = process.argv[2] ?? 'src/plugin.ts'
const out = process.argv[3] ?? 'plugin.js'

await build({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  external: ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info'
})
console.log(`${out}: ${(statSync(out).size / 1024).toFixed(0)} KiB`)
