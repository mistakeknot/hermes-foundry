import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Tests only. The product bundle is built by scripts/build.mjs, where @hermes/plugin-sdk stays external.
export default defineConfig({
  resolve: { alias: { '@hermes/plugin-sdk': fileURLToPath(new URL('./test/sdk-stub.ts', import.meta.url)) } },
})
