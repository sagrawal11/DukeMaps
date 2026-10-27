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
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
