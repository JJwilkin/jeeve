// Checks for the world-model format: the class table, an encode → decode round trip, and the Python reader on the
// same file (via python3 with numpy, or uv). `npm run collect:check`, or with a recorded file:
// `node collect/check.ts episodes/train/<seed>/<file>.ep.gz` reads it back with both readers and compares.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mcData from 'minecraft-data'
import { FAR, RecordWriter, STEP, UNLOADED, classTable, decodeEpisode, encodeEpisode } from './format.ts'

// ---- the class table ----
const reg = mcData('26.1.2')
const t = classTable(reg.blocksArray as any)
assert.ok(t.names.length <= 64 && t.names.length < UNLOADED, `${t.names.length} classes`)
assert.equal(new Set(t.names).size, t.names.length)
const classOf = (name: string) => t.names[t.ofState[reg.blocksByName[name].defaultState]]
for (const [block, cls] of Object.entries({
  air: 'air', cave_air: 'air', water: 'water', lava: 'lava', kelp: 'water_plant', oak_log: 'log', stripped_birch_wood: 'log',
  oak_leaves: 'leaves', grass_block: 'grass_block', dirt: 'dirt', stone: 'stone', deepslate_diamond_ore: 'ore_diamond',
  oak_slab: 'slab', sandstone_stairs: 'stairs', ladder: 'climbable', short_grass: 'plant', poppy: 'plant', cactus: 'hazard_plant',
  sand: 'sand', gravel: 'gravel', bricks: 'solid_pickaxe', oak_planks: 'planks', glass: 'glass', snow: 'snow_layer'
})) assert.equal(classOf(block), cls, block)
assert.equal(t.names[0], 'air') // the recorder treats class 0 as air
const states = (reg.blocksArray as any[]).reduce((n, b) => n + b.maxStateId - b.minStateId + 1, 0)
assert.equal(t.ofState.length, states) // every state id is covered

// ---- round trip ----
const s = new RecordWriter(STEP)
const steps: Buffer[] = []
for (let i = 0; i < 3; i++) {
  s.set('t_ms', i * 200)
  s.set('pos', 100.25 + i, -60, -12.5)
  s.set('ent_type', 0, -1, -1, -1, -1, -1, -1, 3)
  s.set('ent_pos', ...Array.from({ length: 24 }, (_, k) => k / 4))
  s.set('veto', i === 1 ? 0 : -1)
  s.bytes('near').fill(i + 1)
  s.bytes('mid_flags')[4095] = 5
  steps.push(s.take())
}
const f = new RecordWriter(FAR)
f.set('step', 0)
f.set('height', ...Array.from({ length: 4096 }, (_, k) => (k % 97) - 48))
const gz = encodeEpisode({ format: 'jeeve-episode/1', classes: t.names, vetoes: ['forward: drop of more than 3'] }, steps, [f.take()])
const ep = decodeEpisode(gz)
assert.equal(ep.header.steps.count, 3)
assert.equal(ep.header.far.count, 1)
assert.deepEqual(ep.step(2, 'pos'), [102.25, -60, -12.5])
assert.deepEqual(ep.step(1, 't_ms'), [200])
assert.deepEqual(ep.step(1, 'veto'), [0])
assert.deepEqual(ep.step(0, 'ent_type'), [0, -1, -1, -1, -1, -1, -1, 3])
assert.equal(ep.step(0, 'ent_pos')[23], 23 / 4)
assert.ok(ep.step(2, 'near').every(v => v === 3))
assert.equal(ep.step(0, 'mid_flags')[4095], 5)
assert.deepEqual(ep.far(0, 'height').slice(0, 3), [-48, -47, -46])
console.log(`format ok: ${STEP.size} B a step, ${FAR.size} B a far view, ${t.names.length} classes`)

// ---- the Python reader, on this file or a recorded one ----
const file = process.argv[2] ?? join(mkdtempSync(join(tmpdir(), 'episode-')), 'check.ep.gz')
if (!process.argv[2]) writeFileSync(file, gz)
const py = (() => {
  for (const cmd of [['python3', '-c', 'import numpy'], ['uv', '--version']]) {
    try { execFileSync(cmd[0], cmd.slice(1), { stdio: 'ignore' }); return cmd[0] === 'uv' ? ['uv', 'run', '--quiet', '--with', 'numpy', 'python3'] : ['python3'] } catch {}
  }
  return null
})()
if (!py) { console.log('python reader skipped: no python3 with numpy, and no uv'); process.exit(0) }
const out = JSON.parse(execFileSync(py[0], [...py.slice(1), 'collect/read_episode.py', file], { encoding: 'utf8' }))
const mine = decodeEpisode(readFileSync(file))
assert.equal(out.steps, mine.header.steps.count)
assert.equal(out.far, mine.header.far.count)
if (out.steps) assert.deepEqual(out.first_pos, mine.step(0, 'pos').map(v => +v.toFixed(2)))
console.log(`python reader ok: ${JSON.stringify(out).slice(0, 400)}`)
