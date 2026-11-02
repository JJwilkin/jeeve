// Tiny synthetic episodes in the real format (collect/format.ts's encoder), for train/tests:
//   node train/tests/fixture.ts <out>   → <out>/{train,heldout}/<seed>/<n>.ep.gz
// A bot walks +x at 1 block/s over stone, toward a river (water class) 31–33 blocks out; its actions use the collector's parameter shapes.
import { mkdirSync, writeFileSync } from 'node:fs'
import { FAR, FAR_EVERY, RecordWriter, STEP, encodeEpisode } from '../../collect/format.ts'

const CLASSES = ['air', 'water', 'lava', 'stone', 'grass_block', 'log', 'leaves']
const [AIR, WATER, , STONE] = [0, 1, 2, 3]
const N = 300 // 60 s

function episode (seed: number, k: number) {
  const s = new RecordWriter(STEP)
  const f = new RecordWriter(FAR)
  const steps: Buffer[] = []
  const far: Buffer[] = []
  // [name, params, start, end, outcome]
  const acts: Array<[string, Record<string, unknown>, number, number, string]> = [
    ['navigate', { dist: 10, dir: 0, place: [10, 64, 0] }, 1, 50, 'done'],
    ['sprint_jump', { jumps: 3, yaw: -Math.PI / 2 }, 50, 80, 'stuck: no headway'],
    ['wander', {}, 80, 120, 'timeout'],
    ['bridge', { dir: [1, 0], dist: 2, width: 3, near: [30, 64, 0], far: [34, 64, 0], name: 'cobblestone', count: 3 }, 120, 140, 'none_found'],
    ['cross_water', { method: k % 2 ? 'bridge' : 'navigate', dir: [1, 0], dist: 2, width: 3, near: [30, 64, 0], far: [34, 64, 0] }, 140, 200, k % 2 ? 'done' : 'vetoed'],
    ['tunnel', { n: 5, dir: [0, 1] }, 200, 220, 'error'],
    ['walk_raw', { seconds: 2, yaw: 0, key: 'forward', sneak: false }, 230, N, 'episode_end']
  ]
  for (let i = 0; i < N; i++) {
    const x = i / 5
    s.set('t_ms', i * 200)
    s.set('pos', x + 0.25, 64, 0.5)
    s.set('vel', 0.2, 0, 0)
    s.set('look', -Math.PI / 2, 0)
    s.set('flags', 1)
    s.set('health', i >= 150 && i < 160 ? 14 : 20)
    s.set('food', 20)
    s.set('held', i < 100 ? 0 : -1)
    s.set('veto', i === 145 ? 0 : -1)
    s.set('action', acts.findIndex(([, , a, b]) => i >= a && i < b))
    const types = [0, -1, -1, -1, -1, -1, -1, -1]
    s.set('ent_type', ...types)
    s.set('ent_pos', 3, 0, 1, ...Array(21).fill(0))
    s.set('ent_vel', ...Array(24).fill(0))
    const near = s.bytes('near')
    for (let a = 0; a < 16; a++) for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) {
      const bx = Math.floor(x) - 8 + a
      near[(a * 16 + y) * 16 + z] = y < 6 ? (bx >= 31 && bx < 34 && y === 5 ? WATER : STONE) : AIR
    }
    s.bytes('mid').fill(AIR)
    if (i % FAR_EVERY === 0) {
      f.set('step', i)
      const h = f.bytes('height') as unknown as Uint8Array
      for (let j = 0; j < 4096; j++) h[j] = 255 // −1 as an i1: the ground just under the feet
      f.bytes('top').fill(STONE)
      far.push(f.take())
    }
    steps.push(s.take())
  }
  const header = {
    bot: `fixture${k}`, seed, biome: 'plains', scene: 'river', start: new Date(0).toISOString(), end: 'episode_end',
    classes: CLASSES, items: ['cobblestone'], entity_types: ['zombie'], vetoes: ['drop of 4'],
    actions: acts.map(([name, params, start_step, end_step, outcome]) => ({ name, params, start_step, end_step, outcome, ms: (end_step - start_step) * 200 }))
  }
  return encodeEpisode(header, steps, far)
}

const out = process.argv[2]
for (const [split, seeds] of [['train', [11, 12]], ['heldout', [21, 22]]] as const) {
  for (const seed of seeds) {
    mkdirSync(`${out}/${split}/${seed}`, { recursive: true })
    for (let k = 0; k < 2; k++) writeFileSync(`${out}/${split}/${seed}/${k}.ep.gz`, episode(seed, k))
  }
}
