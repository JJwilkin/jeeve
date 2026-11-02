// Start points for one seed (brain/tasks/world-model-data.md → "Worlds"): found once with /locate biome over RCON,
// saved next to the seed's episodes, and pre-generated around with Chunky so bots never wait for chunks.
import type { Rcon } from './rcon.ts'

export type Start = { kind: string, x: number, z: number, biome: string }

// The biome quotas: each kind (and underground, below y 50 under any of them) gets an equal share of natural
// episodes. Ids or tags, as /locate biome takes them.
const KINDS: Record<string, string> = {
  plains: 'minecraft:plains', forest: '#minecraft:is_forest', river: '#minecraft:is_river', ocean_shore: '#minecraft:is_beach',
  mountains: '#minecraft:is_mountain', desert: 'minecraft:desert', swamp: 'minecraft:swamp', snowy: 'minecraft:snowy_plains',
  jungle: '#minecraft:is_jungle', badlands: '#minecraft:is_badlands'
}
// /locate finds the nearest one, so it's asked from a few points ~2000 blocks apart for more than one start per kind.
const PROBES = [[0, 0], [2000, 0], [-1000, 1730], [-1000, -1730]]
// View distance (96) plus how far an episode wanders from its start. Scene spots, 64 out, see past it: the edge of
// their view generates as they arrive.
const PREGEN_RADIUS = 128

export async function locateStarts (r: Rcon, log: (...a: unknown[]) => void): Promise<Start[]> {
  const t0 = Date.now()
  const starts: Start[] = []
  for (const [kind, biome] of Object.entries(KINDS)) {
    for (const [px, pz] of PROBES) {
      // "The nearest #minecraft:is_forest (minecraft:birch_forest) is at [x, y, z] (n blocks away)"
      const reply = await r.command(`execute positioned ${px} 64 ${pz} run locate biome ${biome}`)
      const m = reply.match(/\[(-?\d+), [^,]+, (-?\d+)\]/)
      if (!m) { log(`locate ${biome} from ${px} ${pz}: ${reply}`); continue }
      const [x, z] = [Number(m[1]), Number(m[2])]
      if (!starts.some(s => s.kind === kind && Math.hypot(s.x - x, s.z - z) < 64)) starts.push({ kind, x, z, biome: reply.match(/\((minecraft:\w+)\)/)?.[1] ?? biome })
    }
  }
  log(`${starts.length} starts located in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${[...new Set(starts.map(s => s.kind))].join(', ')}`)
  return starts
}

// One Chunky task per start, one after another (Chunky runs one task per world). A kept world may hold an interrupted
// task, where `chunky start` only asks to confirm: continue that first; the starts it already covered are then
// skipped fast, since Chunky passes over generated chunks.
export async function pregenerate (r: Rcon, starts: Start[], log: (...a: unknown[]) => void) {
  const idle = async () => { while (!/No tasks running/.test(await r.command('chunky progress'))) await new Promise(resolve => setTimeout(resolve, 5000)) }
  const resumed = await r.command('chunky continue')
  if (/^Unknown/.test(resumed)) return log('no Chunky: terrain generates as bots arrive')
  if (!/No tasks/.test(resumed)) { log(`chunky: ${resumed.trim()}`); await idle() }
  const t0 = Date.now()
  for (const [i, s] of starts.entries()) {
    await r.command(`chunky center ${s.x} ${s.z}`)
    await r.command(`chunky radius ${PREGEN_RADIUS}`)
    if (/To start a new task/.test(await r.command('chunky start'))) await r.command('chunky confirm')
    await idle()
    log(`chunky: ${i + 1}/${starts.length} starts generated in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  }
}
