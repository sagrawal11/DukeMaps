// defineConfig comes from vitest/config (a superset of Vite's) so the `test` block
// below is type-checked. At runtime it's identical to Vite's defineConfig.
import { defineConfig } from 'vitest/config'
// Plugin from vitest/config (not 'vite') so it matches the vite version defineConfig expects —
// vitest bundles its own nested vite, and the two Plugin types are otherwise incompatible.
import type { Plugin } from 'vitest/config'
import type { IncomingMessage } from 'node:http'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Dev-only server routes for the graph editor (npm run editor). The editor runs in the browser,
// which can't write repo files, so this middleware persists its edit log and serves the base
// graph. `apply: 'serve'` scopes it to the dev server — `vite build` never includes it, so
// production is unaffected.
//   GET  /__base   -> data/processed/graph.base.json (the pre-edit, pre-prune OSM build)
//   GET  /__edits  -> data/my_edits.json (the EditOp[] log, or [] if absent)
//   POST /__edits  -> write data/my_edits.json atomically (tmp + rename), pretty-printed
// ponytail: single-writer, localhost-only, no auth — fine for a one-person dev tool; add an
// mtime/409 guard only if two editor tabs ever race.
function editorServer(): Plugin {
  return {
    name: 'dukemaps-editor-server',
    apply: 'serve',
    configureServer(server) {
      const editsPath = resolve(server.config.root, 'data/my_edits.json')
      const basePath = resolve(server.config.root, 'data/processed/graph.base.json')
      const readBody = (req: IncomingMessage): Promise<string> =>
        new Promise((ok, err) => {
          let s = ''
          req.on('data', (c) => (s += c))
          req.on('end', () => ok(s))
          req.on('error', err)
        })
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (path === '/__base' && req.method === 'GET') {
          if (!existsSync(basePath)) {
            res.statusCode = 404
            res.end('graph.base.json missing — run `npm run build:graph`')
            return
          }
          res.setHeader('content-type', 'application/json')
          res.end(readFileSync(basePath, 'utf8'))
          return
        }
        if (path === '/__edits' && req.method === 'GET') {
          res.setHeader('content-type', 'application/json')
          res.end(existsSync(editsPath) ? readFileSync(editsPath, 'utf8') : '[]')
          return
        }
        if (path === '/__edits' && req.method === 'POST') {
          void readBody(req).then((raw) => {
            try {
              const ops = JSON.parse(raw) // reject non-JSON before touching the file
              const tmp = `${editsPath}.tmp`
              writeFileSync(tmp, JSON.stringify(ops, null, 2))
              renameSync(tmp, editsPath) // atomic: a crashed write can't truncate my_edits.json
              res.statusCode = 204
              res.end()
            } catch {
              res.statusCode = 400
              res.end('invalid JSON')
            }
          })
          return
        }
        // Door-placement tool (dev-only): persist a flat list of [lon,lat] door positions.
        if (path === '/__doors' && req.method === 'GET') {
          const doorsPath = resolve(server.config.root, 'data/doors.json')
          res.setHeader('content-type', 'application/json')
          res.end(existsSync(doorsPath) ? readFileSync(doorsPath, 'utf8') : '[]')
          return
        }
        if (path === '/__doors' && req.method === 'POST') {
          const doorsPath = resolve(server.config.root, 'data/doors.json')
          void readBody(req).then((raw) => {
            try {
              const doors = JSON.parse(raw)
              const tmp = `${doorsPath}.tmp`
              writeFileSync(tmp, JSON.stringify(doors, null, 2))
              renameSync(tmp, doorsPath)
              res.statusCode = 204
              res.end()
            } catch {
              res.statusCode = 400
              res.end('invalid JSON')
            }
          })
          return
        }
        // Region-drawing tool (dev-only): persist the campus / sub-region polygons for the CCH ordering.
        if (path === '/__regions' && req.method === 'GET') {
          const regionsPath = resolve(server.config.root, 'config/dissection.json')
          res.setHeader('content-type', 'application/json')
          res.end(existsSync(regionsPath) ? readFileSync(regionsPath, 'utf8') : '[]')
          return
        }
        if (path === '/__regions' && req.method === 'POST') {
          const regionsPath = resolve(server.config.root, 'config/dissection.json')
          void readBody(req).then((raw) => {
            try {
              const regions = JSON.parse(raw)
              const tmp = `${regionsPath}.tmp`
              writeFileSync(tmp, JSON.stringify(regions, null, 2))
              renameSync(tmp, regionsPath)
              res.statusCode = 204
              res.end()
            } catch {
              res.statusCode = 400
              res.end('invalid JSON')
            }
          })
          return
        }
        next()
      })
    },
  }
}

// DukeMaps is a fully static site deployed to GitHub Pages. A relative base means
// the build works regardless of the repo subpath it's served from; revisit in
// Phase 7 if the deploy target needs an absolute base.
//
// The editor (editor/index.html) is intentionally NOT listed as a build input, so
// `vite build` excludes it from production. Vite's dev server still serves it at
// /editor/, which is all the brief's "dev-only page" needs.
export default defineConfig({
  base: './',
  plugins: [editorServer()],
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
