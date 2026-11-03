// Jeeve's side of the parity check (test_parity.py): src/wm.ts must turn a state into the arrays data.py trains on.
//   node train/tests/parity.ts episodes <out>            → <out>/train/<seed>/<n>.ep.gz, random episodes (seeded)
//   node train/tests/parity.ts inputs <requests.json>     → stdout: one JSON line of model inputs per request
// A request names an episode, a step, the far record data.py pairs with it, the action (or null) and its elapsed time.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { FAR, FAR_EVERY, RecordWriter, STEP, encodeEpisode } from '../../collect/format.ts'
import { sample, viewOf } from '../../src/wm.ts'

let seed = 7
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 }
const r = (lo: number, hi: number) => lo + rand() * (hi - lo)
const ri = (lo: number, hi: number) => Math.floor(r(lo, hi + 1))
const N = 120

function episode (k: number) {
  const s = new RecordWriter(STEP)
  const f = new RecordWriter(FAR)
  const steps: Buffer[] = []
  const far: Buffer[] = []
  const at = (x: number) => [Math.floor(x), ri(60, 70), ri(-20, 20)]
  // Every parameter shape the collector writes: positions, a dir angle or step, a yaw, nested, strings, booleans.
  const acts: Array<[string, Record<string, unknown>]> = [
    ['navigate', { dist: 12, dir: r(-3, 3), place: at(r(-30, 30)) }],
    ['sprint_jump', { jumps: 3, yaw: r(-4, 4) }],
    ['wander', {}],
    ['bridge', { dir: [1, 1], dist: 2, width: 3, near: at(5), far: at(9), name: 'cobblestone', count: 3 }],
    ['cross_water', { method: 'swim_across', dir: [-1, 0], dist: 2, width: 5, near: at(-4), far: at(-9) }],
    ['reach_ledge', { method: 'pillar_up', dir: [0, -1], dist: 1, height: 3, near: at(0), top: at(0) }],
    ['get_down_cliff', { method: 'navigate', dir: [-1, 1], dist: 3, depth: 6, near: at(1), floor: at(-2) }],
    ['track', { mob: { id: 5, name: 'zombie' } }],
    ['collect', { name: 'oak_log', count: 3 }],
    ['walk_raw', { seconds: 2.5, yaw: r(-4, 4), key: 'left', sneak: true }],
    ['tunnel', { n: 5, dir: [0, 1] }],
    ['step_down', { dir: [1, -1], dist: 2, depth: -3 }],
    ['made_up', { a: { b: 1.5, c: false }, at: [1, 2] }] // not in the vocabulary; a 2-long `at` is no position
  ]
  let t = 0
  const entries = acts.map(([name, params], i) => {
    const start = (t += ri(1, 4))
    const end = (t += ri(3, 9))
    return { name, params, start_step: start, end_step: Math.min(end, N), outcome: ['done', 'stuck', 'vetoed: drop', 'died', 'timeout', 'target_lost'][i % 6], ms: (end - start) * 200 }
  })
  for (let i = 0; i < N; i++) {
    s.set('t_ms', i * 200)
    s.set('pos', r(-40, 40), r(50, 80), r(-40, 40))
    s.set('vel', r(-1, 1), r(-1, 1), r(-1, 1))
    s.set('look', r(-7, 7), r(-1.5, 1.5))
    s.set('flags', ri(0, 31))
    s.set('health', r(0, 20))
    s.set('food', ri(0, 20))
    s.set('held', ri(-1, 1))
    s.set('action', entries.findIndex(a => i >= a.start_step && i < a.end_step))
    s.set('ent_type', ...Array.from({ length: 8 }, () => ri(-1, 2)))
    s.set('ent_pos', ...Array.from({ length: 24 }, () => r(-32, 32)))
    s.set('ent_vel', ...Array.from({ length: 24 }, () => r(-1, 1)))
    for (const v of ['near', 'mid'] as const) s.bytes(v).forEach((_, j, a) => { a[j] = rand() < 0.05 ? 255 : ri(0, 62) })
    s.bytes('mid_flags').forEach((_, j, a) => { a[j] = ri(0, 7) })
    if (i % FAR_EVERY === 0) {
      f.set('step', i)
      f.bytes('height').forEach((_, j, a) => { a[j] = ri(0, 255) })
      f.bytes('top').forEach((_, j, a) => { a[j] = rand() < 0.05 ? 255 : ri(0, 62) })
      f.bytes('depth').forEach((_, j, a) => { a[j] = ri(0, 20) })
      far.push(f.take())
    }
    steps.push(s.take())
  }
  const header = {
    bot: `parity${k}`, seed: 1, biome: 'plains', scene: 'natural', start: new Date(0).toISOString(), end: 'episode_end',
    classes: ['air'], class_blocks: {}, kit: [], items: ['cobblestone', 'oak_planks'], entity_types: ['zombie', 'player', 'item'], vetoes: ['drop'],
    actions: entries
  }
  return encodeEpisode(header, steps, far)
}

type Request = { file: string, step: number, far: number, act: { name: string, params: Record<string, unknown> } | null, elapsed: number, actions: string[] }

if (process.argv[2] === 'episodes') {
  const out = `${process.argv[3]}/train/1`
  mkdirSync(out, { recursive: true })
  for (let k = 0; k < 4; k++) writeFileSync(`${out}/${k}.ep.gz`, episode(k))
} else {
  const raw = new Map<string, { header: any, steps: number, far: number, buf: Buffer }>()
  const open = (file: string) => {
    let e = raw.get(file)
    if (!e) {
      const buf = gunzipSync(readFileSync(file))
      const n = buf.readUInt32LE(0)
      const header = JSON.parse(buf.toString('utf8', 4, 4 + n))
      raw.set(file, e = { header, buf, steps: 4 + n, far: 4 + n + header.steps.count * STEP.size })
    }
    return e
  }
  for (const q of JSON.parse(readFileSync(process.argv[3], 'utf8')) as Request[]) {
    const e = open(q.file)
    const step = e.buf.subarray(e.steps + q.step * STEP.size, e.steps + (q.step + 1) * STEP.size)
    const far = e.buf.subarray(e.far + q.far * FAR.size, e.far + (q.far + 1) * FAR.size) // data.py's far record: one is taken at step 0
    const x = sample(viewOf(step, far, e.header.items, e.header.entity_types), q.act, q.actions, q.elapsed)
    const arr = (a: ArrayLike<number>) => Array.from(a)
    console.log(JSON.stringify({
      frame: x.frame, ...Object.fromEntries(Object.entries(x.state).map(([k, v]) => [k, typeof v === 'number' ? v : arr(v)])),
      action: x.action, params: arr(x.params), target: arr(x.target)
    }))
  }
}
