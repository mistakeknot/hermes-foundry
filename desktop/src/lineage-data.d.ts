// esbuild and Vitest bundle the data-only JSON slice imported by creature.ts.
declare module '*.json' { const data: unknown; export default data }
