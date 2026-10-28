// defineConfig comes from vitest/config (a superset of Vite's) so the `test` block
// below is type-checked. At runtime it's identical to Vite's defineConfig.
import { defineConfig } from 'vitest/config'

// DukeMaps is a fully static site deployed to GitHub Pages. A relative base means
// the build works regardless of the repo subpath it's served from; revisit in
// Phase 7 if the deploy target needs an absolute base.
//
// The editor (editor/index.html) is intentionally NOT listed as a build input, so
// `vite build` excludes it from production. Vite's dev server still serves it at
// /editor/, which is all the brief's "dev-only page" needs.
export default defineConfig({
  base: './',
  // maplibre-gl v6 loads a web worker (maplibre-gl-worker.mjs) via a relative URL. Vite's dep
  // optimizer pre-bundles maplibre but doesn't copy that worker into .vite/deps, so the worker
  // 404s and the map hangs forever on "Loading…". Excluding it from pre-bundling makes the
  // worker resolve from the real package files.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
