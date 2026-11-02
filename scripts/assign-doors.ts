// CLI for the door-assignment core — `npm run assign:doors` after placing doors in the dev 🚪 Doors tool.
// Note: the dev server already auto-runs this same core on every door save (see vite.config.ts), so during
// `npm run dev` you normally never need this — it's here for a one-off re-assign or a sanity check. Writes
// config/building-doors.json and patches config/building-icons.json (doors field only). Re-runnable.
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assignDoors, MAX_M } from './assign-doors-core'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!existsSync(resolve(ROOT, 'data/doors.json'))) {
  console.error('[assign:doors] data/doors.json not found — place doors first with the dev 🚪 Doors editor.')
  process.exit(1)
}

const s = assignDoors(ROOT)
console.log(`doors ${s.doors} | assigned ${s.assigned} to ${Object.keys(s.byBuilding).length} buildings | orphans ${s.orphans.length}`)
for (const [id, list] of Object.entries(s.byBuilding)) console.log(`  ${s.nameOf(id)}: ${list.length} door(s)`)
if (s.orphans.length) console.log(`  ⚠ ${s.orphans.length} door(s) > ${MAX_M}m from any building (ignored): ${s.orphans.map((d) => d.map((x) => x.toFixed(5)).join(',')).join(' | ')}`)
