// The Tier 1 outcome model live (brain/architecture/world-model-training.md → Export): the recorder's view of the bot
// (collect/recorder.ts, the code training read), turned into a sample's arrays in the action's frame exactly as
// train/data.py's `sample` does, then the two ONNX graphs: one encoding per frame the options need, every option
// scored in one batch. train/tests/test_parity.py checks these arrays against data.py's.
import { existsSync, readFileSync } from 'node:fs'
import { crc32 } from 'node:zlib'
import type { Bot } from 'mineflayer'
import { placeable, terrain, type Dir, type Features, type Xyz } from '../collect/actions.ts'
import type { Seeker } from '../collect/actions/common.ts'
import { CROSS_WATER } from '../collect/actions/cross_water.ts'
import { GET_DOWN_CLIFF } from '../collect/actions/get_down_cliff.ts'
import { REACH_LEDGE } from '../collect/actions/reach_ledge.ts'
import { FAR, RecordWriter, STEP, classTable, type Layout } from '../collect/format.ts'
import { EpisodeRecorder } from '../collect/recorder.ts'
import { authoredSpec, type ApiHost, type Channel, type Spec } from './behaviors.ts'
import type { Handles } from './encoder.ts'
import type { Option } from './program.ts'

export const OUTCOMES = ['done', 'stuck', 'vetoed', 'died', 'timeout']
const POSITION_KEYS = ['place', 'at', 'far', 'floor', 'top', 'near'] // where an action is going, best first
const NOT_PARAMS = new Set([...POSITION_KEYS, 'dir', 'yaw', 'id'])
const P_NUM = 16
const P_CAT = 48
const TARGET = 8
const N = 16 // near and mid views: 16³
const F = 64 // far view: 64²

// ---- one state, in the world frame: a step record and a far record (collect/format.ts), with names for the indices
export type View = {
  near: Uint8Array, mid: Uint8Array, midFlags: Uint8Array, farHeight: Int8Array, farTop: Uint8Array, farDepth: Uint8Array
  entType: Uint8Array, entPos: Float32Array, entVel: Float32Array
  pos: Float64Array, vel: Float32Array, look: Float32Array, flags: number, health: number, food: number, held: number
}

export const bucket = (s: string, n: number) => 1 + crc32(s) % (n - 1) // data.bucket: 0 is "empty"

// A field of a record as a typed array (a copy, so it's aligned). Little-endian hosts only, like the records.
function field<T> (rec: Buffer, l: Layout, name: string, Arr: { new (b: ArrayBuffer): T }): T {
  const f = l.at[name]
  const size = { u1: 1, i1: 1, '<i2': 2, '<u4': 4, '<i4': 4, '<f4': 4, '<f8': 8 }[f.dtype]!
  return new Arr(rec.buffer.slice(rec.byteOffset + f.offset, rec.byteOffset + f.offset + size * f.count) as ArrayBuffer)
}

// A step record and the latest far record → the view; items and entity types name the record's indices.
export function viewOf (step: Buffer, far: Buffer, items: unknown[], entityTypes: unknown[]): View {
  const ent = field(step, STEP, 'ent_type', Int16Array)
  const held = field(step, STEP, 'held', Int16Array)[0]
  return {
    near: field(step, STEP, 'near', Uint8Array), mid: field(step, STEP, 'mid', Uint8Array), midFlags: field(step, STEP, 'mid_flags', Uint8Array),
    farHeight: field(far, FAR, 'height', Int8Array), farTop: field(far, FAR, 'top', Uint8Array), farDepth: field(far, FAR, 'depth', Uint8Array),
    entType: Uint8Array.from(ent, i => i >= 0 ? bucket(String(entityTypes[i]), 256) : 0),
    entPos: field(step, STEP, 'ent_pos', Float32Array), entVel: field(step, STEP, 'ent_vel', Float32Array),
    pos: field(step, STEP, 'pos', Float64Array), vel: field(step, STEP, 'vel', Float32Array), look: field(step, STEP, 'look', Float32Array),
    flags: field(step, STEP, 'flags', Uint8Array)[0], health: field(step, STEP, 'health', Float32Array)[0],
    food: field(step, STEP, 'food', Uint8Array)[0], held: held >= 0 ? bucket(String(items[held]), 256) : 0
  }
}

// The live bot's view now, by the recorder's own code (a recorder that never records an episode).
export function liveViewer (bot: Bot) {
  const rec = new EpisodeRecorder(bot, classTable(bot.registry.blocksArray as any))
  const step = new RecordWriter(STEP)
  const far = new RecordWriter(FAR)
  return {
    rec,
    view: (): View => {
      const feet = rec.fill(step)
      rec.farView(far, feet)
      return viewOf(step.buf, far.buf, rec.items.list, rec.entityTypes.list)
    }
  }
}

// ---- the frame (data.py): g = (swap x and z, mirror x, mirror z), mirrors about the feet block's centre
type G = readonly [boolean, boolean, boolean]
const ROTATIONS: G[] = [[false, false, false], [true, true, false], [false, true, true], [true, false, true]] // 0°, 90°, 180°, 270°

const applyVec = ([swap, fx, fz]: G, x: number, z: number): [number, number] => {
  const [a, b] = swap ? [z, x] : [x, z]
  return [fx ? -a : a, fz ? -b : b]
}
const applyVec3 = (g: G, x: number, y: number, z: number) => { const [a, b] = applyVec(g, x, z); return [a, y, b] }

// grid[x][y][z] (or [x][z] with ny = 1): out[i] = in[g⁻¹(i)]; a mirror maps index i ↔ n − i, and index 0 has no source.
function applyGrid<T extends Uint8Array | Int8Array> ([swap, fx, fz]: G, a: T, n: number, ny: number, fill: number): T {
  const out = new (a.constructor as any)(a.length) as T
  for (let x = 0; x < n; x++) {
    for (let z = 0; z < n; z++) {
      const sx = fx ? n - x : x // the source index, in the swapped grid
      const sz = fz ? n - z : z
      const ok = sx < n && sz < n
      const [ax, az] = swap ? [sz, sx] : [sx, sz]
      for (let y = 0; y < ny; y++) out[(x * ny + y) * n + z] = ok ? a[(ax * ny + y) * n + az] : fill
    }
  }
  return out
}

function canonical (d: [number, number]): G {
  let best = ROTATIONS[0]
  for (const g of ROTATIONS) if (applyVec(g, ...d)[0] > applyVec(best, ...d)[0]) best = g // first of equals, as Python's max
  return best
}

const facing = (yaw: number): [number, number] => [-Math.sin(yaw), -Math.cos(yaw)] // Mineflayer: yaw 0 faces −z

// ---- an action as the model sees it
type Params = Record<string, unknown>
const isNum = (v: unknown): v is number => typeof v === 'number'

export function targetOf (params: Params, pos: ArrayLike<number>): { rel: number[] | null, d: [number, number] | null } {
  let rel: number[] | null = null
  for (const k of POSITION_KEYS) {
    const v = params[k]
    if (Array.isArray(v) && v.length === 3 && v.every(isNum)) { rel = [v[0] + 0.5 - pos[0], v[1] - pos[1], v[2] + 0.5 - pos[2]]; break }
  }
  const dir = params.dir
  let d: [number, number] | null =
    Array.isArray(dir) && dir.length === 2 ? [Number(dir[0]), Number(dir[1])]
      : isNum(dir) ? [Math.cos(dir), Math.sin(dir)] // navigate: an angle, x = cos
        : isNum(params.yaw) ? facing(params.yaw)
          : rel ? [rel[0], rel[2]] : null
  if (d) { const norm = Math.hypot(...d); d = norm > 1e-6 ? [d[0] / norm, d[1] / norm] : null }
  return { rel, d }
}

function * flatParams (params: Params, prefix = ''): Generator<[string, number | string]> {
  for (const [k, v] of Object.entries(params)) {
    if (NOT_PARAMS.has(k)) continue
    const key = prefix + k
    if (v && typeof v === 'object' && !Array.isArray(v)) yield * flatParams(v as Params, key + '.')
    else if (typeof v === 'boolean') yield [key, v ? 'True' : 'False'] // Python's str(bool)
    else if (typeof v === 'string') yield [key, v]
    else if (isNum(v)) yield [key, v]
  }
}

// Numbers into hashed slots (signed log), strings and booleans into hashed buckets (data.param_vector).
export function paramVector (params: Params) {
  const v = new Float32Array(P_NUM + P_CAT)
  for (const [k, x] of flatParams(params)) {
    if (isNum(x)) v[crc32(k) % P_NUM] = Math.sign(x) * Math.log1p(Math.abs(x))
    else v[P_NUM + crc32(`${k}=${x}`) % P_CAT] = 1
  }
  return v
}

export type State = {
  near: Uint8Array, mid: Uint8Array, mid_flags: Uint8Array, far_height: Int8Array, far_top: Uint8Array, far_depth: Uint8Array
  ent_type: Uint8Array, ent: Float32Array, self_vec: Float32Array, held: number
}
export type Sample = { frame: number, state: State, action: number, params: Float32Array, target: Float32Array }

// The state in frame g (data.sample's inputs that don't depend on the action).
function stateIn (g: G, v: View): State {
  const ent = new Float32Array(8 * 6)
  for (let i = 0; i < 8; i++) {
    const p = applyVec3(g, v.entPos[3 * i], v.entPos[3 * i + 1], v.entPos[3 * i + 2])
    ent.set([...p.map(x => x / 16), ...applyVec3(g, v.entVel[3 * i], v.entVel[3 * i + 1], v.entVel[3 * i + 2])], 6 * i)
  }
  const fr = [...v.pos].map(x => x - Math.floor(x))
  const [fa, fb] = g[0] ? [fr[2], fr[0]] : [fr[0], fr[2]]
  const self = [
    ...applyVec3(g, v.vel[0], v.vel[1], v.vel[2]), ...applyVec(g, ...facing(v.look[0])), v.look[1],
    g[1] ? 1 - fa : fa, fr[1], g[2] ? 1 - fb : fb,
    v.flags & 1, (v.flags >> 1) & 1, (v.flags >> 2) & 1, v.health / 20, v.food / 20
  ]
  return {
    near: applyGrid(g, v.near, N, N, 255), mid: applyGrid(g, v.mid, N, N, 255), mid_flags: applyGrid(g, v.midFlags, N, N, 0),
    far_height: applyGrid(g, v.farHeight, F, 1, -128), far_top: applyGrid(g, v.farTop, F, 1, 255), far_depth: applyGrid(g, v.farDepth, F, 1, 0),
    ent_type: v.entType, ent, self_vec: Float32Array.from(self), held: v.held
  }
}

// One action (or none) from this view → its frame and the model's inputs (data.sample, without augmentation).
// elapsed: seconds the action has been running (0 for an option not started yet).
export function sample (v: View, act: { name: string, params: Params } | null, actions: string[], elapsed = 0): Sample {
  const o = optionOf(v, act, actions, elapsed)
  return { ...o, state: stateIn(ROTATIONS[o.frame], v) }
}

// The inputs that depend on the action: its frame (which state encoding it needs), action, parameters and target.
function optionOf (v: View, act: { name: string, params: Params } | null, actions: string[], elapsed = 0): Omit<Sample, 'state'> {
  const { rel, d } = act ? targetOf(act.params, v.pos) : { rel: null, d: null }
  const frame = ROTATIONS.indexOf(canonical(d ?? facing(v.look[0])))
  const g = ROTATIONS[frame]
  const target = new Float32Array(TARGET)
  if (rel) { target.set(applyVec3(g, rel[0], rel[1], rel[2]).map(x => x / 16)); target[3] = 1 }
  if (d) { target.set(applyVec(g, ...d), 4); target[6] = 1 }
  target[7] = Math.fround(elapsed) / 20
  return { frame, action: act ? Math.max(0, actions.indexOf(act.name)) : 0, params: paramVector(act?.params ?? {}), target }
}

// ---- inference
export type Prediction = { p: number[], success: number, duration_s: number, disp: number[], dhealth: number }
export type Scored = { key: string, name: string, params: Params, frame: number, pred: Prediction }

const STATE_SHAPES: Record<keyof State, number[]> = {
  near: [1, N, N, N], mid: [1, N, N, N], mid_flags: [1, N, N, N], far_height: [1, F, F], far_top: [1, F, F], far_depth: [1, F, F],
  ent_type: [1, 8], ent: [1, 8, 6], self_vec: [1, 14], held: [1]
}

export class OutcomeModel {
  actions: string[] // model.json's vocabulary; the calibration temperature is inside query.onnx
  private enc: any
  private qry: any
  private ort: any

  private constructor (ort: any, enc: any, qry: any, info: { actions: string[] }) {
    this.ort = ort
    this.enc = enc
    this.qry = qry
    this.actions = info.actions
  }

  // The exported model in dir (encoder.onnx, query.onnx, model.json), or null if it isn't there.
  static async load (dir: string): Promise<OutcomeModel | null> {
    if (!existsSync(`${dir}/model.json`)) return null
    process.env.ORT_DISABLE_TELEMETRY ??= '1' // onnxruntime's Linux build sends usage telemetry otherwise; read when it loads
    const ort = await import('onnxruntime-node')
    const opts = { intraOpNumThreads: 1, interOpNumThreads: 1, executionProviders: ['cpu'] } // Jeeve shares the VM's cores
    const [enc, qry] = await Promise.all(['encoder', 'query'].map(g => ort.InferenceSession.create(`${dir}/${g}.onnx`, opts)))
    return new OutcomeModel(ort, enc, qry, JSON.parse(readFileSync(`${dir}/model.json`, 'utf8')))
  }

  // Every option, in one encoding per frame they need (at most 4) and one query batch per frame.
  async score (v: View, options: Array<{ key: string, name: string, params: Params }>): Promise<Scored[]> {
    const { Tensor } = this.ort
    const samples = options.map(o => optionOf(v, o, this.actions))
    const out: Scored[] = []
    for (const frame of new Set(samples.map(s => s.frame))) {
      const idx = samples.flatMap((s, i) => s.frame === frame ? [i] : [])
      const st = stateIn(ROTATIONS[frame], v)
      const feeds = Object.fromEntries(Object.entries(STATE_SHAPES).map(([k, shape]) => {
        const x = (st as any)[k]
        return [k, k === 'ent_type' || k === 'held'
          ? new Tensor('int64', BigInt64Array.from(k === 'held' ? [x] : x, (n: number) => BigInt(n)), shape)
          : new Tensor(x instanceof Int8Array ? 'int8' : x instanceof Uint8Array ? 'uint8' : 'float32', x, shape)]
      }))
      const { tokens } = await this.enc.run(feeds)
      const n = idx.length
      const cat = (k: 'params' | 'target', w: number) => { const a = new Float32Array(n * w); idx.forEach((i, j) => a.set(samples[i][k], j * w)); return new Tensor('float32', a, [n, w]) }
      const r = await this.qry.run({
        tokens, action: new Tensor('int64', BigInt64Array.from(idx, i => BigInt(samples[i].action)), [n]),
        params: cat('params', P_NUM + P_CAT), target: cat('target', TARGET)
      })
      idx.forEach((i, j) => {
        const p = Array.from(r.outcome.data.slice(j * 5, j * 5 + 5) as Float32Array)
        out[i] = { ...options[i], frame, pred: { p, success: p[0], duration_s: r.duration_s.data[j], disp: Array.from(r.disp.data.slice(j * 3, j * 3 + 3) as Float32Array), dhealth: r.dhealth.data[j] } }
      })
    }
    return out
  }
}

// ---- Jev's options (src/decide.ts): what each one is to the model, the crossings it picks a method for, and the
// mark on an option it expects to fail. Live behaviors map to the collector's actions with the same parameter shapes
// (collect/actions.ts SEED_ACTIONS); follow, glance and authored behaviors have no match and go unscored.
// success: a crossing must end done within its 20 s, as in the collector; a live behavior has no such limit, so for it
// "timeout" (still going at the collector's 20 s) isn't a failure: success is anything but stuck, vetoed or died.
export const BLOCKED_BELOW = Number(process.env.JEEVE_WM_BLOCKED_BELOW ?? 0.2)
type Feature = { dir: Dir, dist: number, near: Xyz }
const SEEKERS = [CROSS_WATER, GET_DOWN_CLIFF, REACH_LEDGE] as unknown as Array<Seeker<Feature>> // each takes its own feature kind
const WHOLE_BODY: Channel[] = ['legs', 'aim', 'hands'] // the seekers' channels
const COMPASS: Record<string, string> = { '1,0': 'east', '1,1': 'southeast', '0,1': 'south', '-1,1': 'southwest', '-1,0': 'west', '-1,-1': 'northwest', '0,-1': 'north', '1,-1': 'northeast' }
const FAILS: Record<string, string> = { stuck: 'get stuck', vetoed: 'be vetoed by a guard', died: 'die' }

// run: a crossing's behavior; feature: which crossing (its question, kind and direction), shared by its methods
type Asked = { q: string, key: string, name: string, params: Params, run?: { desc: string, behavior: string, spec: Spec, target: unknown }, feature?: string }
export type WmRow = { action: string, success: number, p: number[], duration_s: number, dhealth: number, method?: string, methods?: Record<string, number>, blocked?: boolean }
export type WmTrace = { ms: number, options: Record<string, Record<string, WmRow>>, error?: string }

function asAction (o: Option, bot: Bot, handles: Handles): { name: string, params: Params } | null {
  const e = o.handle === undefined ? undefined : bot.entities[handles.byHandle.get(o.handle) ?? -1]
  const to = ([x, y, z]: number[]) => {
    const me = bot.entity.position
    return { dist: Math.round(Math.hypot(x - me.x, z - me.z)), dir: +Math.atan2(z - me.z, x - me.x).toFixed(2), place: [x, y, z].map(Math.floor) }
  }
  const mob = e && { mob: { id: e.id, name: e.name } }
  switch (o.behavior) {
    case 'navigate': return o.place ? { name: 'navigate', params: to(o.place) } : e ? { name: 'navigate', params: to([e.position.x, e.position.y, e.position.z]) } : null
    case 'collect': return o.block ? { name: 'collect', params: { name: o.block.name, count: o.block.count } } : null
    case 'track': return mob ? { name: 'track', params: mob } : null
    case 'attack_when_ready': return mob ? { name: 'fight', params: mob } : null // fight = follow + track + attack
    case 'wander': return { name: 'wander', params: {} }
    case 'eat': return o.block ? { name: 'eat', params: { food: o.block.name } } : null
    default: return null
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`
const sameSet = (a: Channel[], b: Channel[]) => a.length === b.length && a.every(c => b.includes(c))

// The nearest crossing of each kind (water, drop, ledge) for a whole-body question, once per method that fits it.
function crossingsFor (q: string, f: Features, host: ApiHost): Asked[] {
  return SEEKERS.flatMap(s => {
    const x = s.find(f).toSorted((a, b) => a.dist - b.dist)[0]
    if (!x) return []
    const toward = COMPASS[x.dir.join(',')]
    return s.methods(x, f).map(m => ({
      q, key: `${s.source.name}:${toward}:${m.method}`, name: s.source.name, params: m.params, feature: `${q} ${s.source.name}:${toward}`,
      run: { desc: `${m.source.description} (${toward}, ${x.dist} blocks away)`, behavior: s.source.name, spec: authoredSpec({ ...m.source, version: 1 }, host), target: m.target }
    }))
  })
}

const rowOf = (name: string, pred: Prediction, success: number): WmRow =>
  ({ action: name, success: +success.toFixed(3), p: pred.p.map(x => +x.toFixed(3)), duration_s: +pred.duration_s.toFixed(1), dhealth: +pred.dhealth.toFixed(1) })

// An option the model expects to fail says so, with its most likely failure.
function markLikelyFailure (o: Option, row: WmRow): Option {
  row.blocked = true
  const worst = ['stuck', 'vetoed', 'died'].reduce((a, b) => row.p[OUTCOMES.indexOf(b)] > row.p[OUTCOMES.indexOf(a)] ? b : a)
  return { ...o, desc: `${o.desc} (likely to ${FAILS[worst]}: world model gives ${pct(row.success)} success)` }
}

// Scores every option it can, adds each crossing by the method the model ranks first, and marks options it expects to
// fail. Mutates `options`; returns the trace.
export function jevOptions (bot: Bot, model: OutcomeModel, host: ApiHost, handles: Handles) {
  let viewer: ReturnType<typeof liveViewer> | undefined
  return async (options: Record<string, Record<string, Option>>, claims: Record<string, Channel[]>, cooling = (_key: string) => false): Promise<WmTrace> => {
    const t0 = performance.now()
    viewer ??= liveViewer(bot) // the registry exists only once the bot has logged in
    const view = viewer.view()
    const feet = bot.entity.position.floored()
    const f: Features = { ...terrain(viewer.rec, [feet.x, feet.y, feet.z]), placeable: placeable(bot), inWater: !!(bot.entity as any).isInWater, logs: [], blocks: [], mobs: [], food: [] }
    const asked: Asked[] = Object.entries(options).flatMap(([q, opts]) => [
      ...Object.entries(opts).flatMap(([key, o]) => { const a = asAction(o, bot, handles); return a ? [{ q, key, ...a }] : [] }),
      ...(sameSet(claims[q], WHOLE_BODY) ? crossingsFor(q, f, host) : [])
    ])
    const scored = asked.length ? await model.score(view, asked) : []
    const out: WmTrace['options'] = {}
    const methods = new Map<string, Array<{ a: Asked, row: WmRow }>>() // each crossing's methods
    scored.forEach(({ name, pred }, i) => {
      const a = asked[i]
      if (a.feature) {
        methods.set(a.feature, [...methods.get(a.feature) ?? [], { a, row: { ...rowOf(name, pred, pred.success), method: String(a.params.method) } }])
        return
      }
      const row = (out[a.q] ??= {})[a.key] = rowOf(name, pred, pred.p[0] + pred.p[4])
      if (row.success < BLOCKED_BELOW) options[a.q][a.key] = markLikelyFailure(options[a.q][a.key], row)
    })
    // A crossing is one option, by its best method that isn't cooling (one that just failed there sits out, so the next
    // gets its turn); every method's odds go in the trace.
    for (const ms of methods.values()) {
      const best = ms.filter(m => !cooling(m.a.key)).toSorted((x, y) => y.row.success - x.row.success)[0]
      if (!best) continue
      const { q, key, run } = best.a
      ;(out[q] ??= {})[key] = { ...best.row, methods: Object.fromEntries(ms.map(m => [m.row.method, m.row.success])) }
      options[q][key] = { desc: `${run!.desc} — world model: ${pct(best.row.success)} success, ~${Math.round(best.row.duration_s)} s`, behavior: run!.behavior, run: { spec: run!.spec, target: run!.target } }
    }
    return { ms: Math.round(performance.now() - t0), options: out }
  }
}

// One log line: per question, what Jev picked (with the model's odds, if it scored it) and the model's top options.
export function wmLine (wm: WmTrace, answers: Record<string, { choice?: string }> | undefined) {
  if (wm.error) return `error: ${wm.error}`
  const qs = Object.entries(wm.options).map(([q, rows]) => {
    const pick = answers?.[q]?.choice
    const top = Object.entries(rows).toSorted((a, b) => b[1].success - a[1].success).slice(0, 4)
      .map(([k, r]) => `${k} ${pct(r.success)}${r.blocked ? '✗' : ''}`)
    return `${q} picked ${pick ?? '—'}${pick && rows[pick] ? ` (${pct(rows[pick].success)})` : ''} | ${top.join(', ')}`
  })
  return `${wm.ms} ms; ${qs.join(' ; ')}`
}
