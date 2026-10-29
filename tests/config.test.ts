import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const configDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'config')

function loadConfig(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(configDir, name), 'utf8')) as Record<string, unknown>
}

// Smoke test: every config placeholder must be valid JSON and expose the top-level keys
// the later phases read. This catches a broken edit to a config long before the pipeline
// or app tries to consume it. (Values stay blank placeholders in Phase 0 — we only check
// shape, not contents.)
describe('config placeholders', () => {
  const cases: Array<[string, string[]]> = [
    ['campus.json', ['areas']],
    ['schedule.json', ['classEndTimes', 'crowding', 'academicBuildings']],
    ['aliases.json', ['aliases']],
    ['presets.json', ['presets']],
  ]

  it.each(cases)('%s parses and has its required keys', (file, keys) => {
    const cfg = loadConfig(file)
    for (const key of keys) {
      expect(cfg, `${file} missing "${key}"`).toHaveProperty(key)
    }
  })
})
