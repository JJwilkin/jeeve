// The scripted actions the collector runs (brain/tasks/world-model-data.md → "Scripted actions"), the noise
// injected while they run, and random input. Every action starts Jeeve's own behaviors through `Channels`
// (src/behaviors.ts), under the same guards: seed behaviors by name, authored ones through `authoredSpec`.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { authoredSpec, type ApiHost, type Spec } from '../src/behaviors.ts'
import { IGNORED_TYPES } from '../src/encoder.ts'
import { ModuleRegistry, type ModuleSource } from '../src/modules.ts'
import { blockAt, reachable, scan } from '../src/world.ts'
import { between, pick } from './actions/common.ts'
import { CLIMB_DOWN_SAFELY } from './actions/climb_down_safely.ts'
import { CROSS_WATER } from './actions/cross_water.ts'
import { DIG_STAIRS_DOWN } from './actions/dig_stairs_down.ts'
import { FLEE } from './actions/flee.ts'
import { GET_DOWN_CLIFF } from './actions/get_down_cliff.ts'
import { JUMP_GAP } from './actions/jump_gap.ts'
import { PILLAR_UP } from './actions/pillar_up.ts'
import { REACH_LEDGE } from './actions/reach_ledge.ts'
import { SPRINT_JUMP } from './actions/sprint_jump.ts'
import { STEP_DOWN } from './actions/step_down.ts'
import { TUNNEL } from './actions/tunnel.ts'
import { WALK_RAW } from './actions/walk_raw.ts'
import type { EpisodeRecorder } from './recorder.ts'

export type Xyz = [number, number, number]
export type Dir = [number, number] // a step in x, z: one of 8 directions
// Terrain features in one direction, nearest first. dist: blocks out to the feature's first column. near: where to
// stand just before it; floor, top, far: where to stand at the bottom, on top, across.
export type Edge = { dir: Dir, dist: number, depth: number } // a step down of 1–4, level ground before it
export type Drop = { dir: Dir, dist: number, depth: number, near: Xyz, floor: Xyz } // a drop of 4+ (to a floor within 16)
export type Ledge = { dir: Dir, dist: number, height: number, near: Xyz, top: Xyz } // a rise of 2–4
export type Gap = { dir: Dir, dist: number, width: number, depth: number } // 1–3 wide and 2+ deep (16: 16 or more), level ground before it
export type Water = { dir: Dir, dist: number, width: number, near: Xyz, far: Xyz } // water with land on both sides
export type Terrain = { edges: Edge[], drops: Drop[], ledges: Ledge[], gaps: Gap[], waters: Water[] }
export type Features = Terrain & { logs: string[], blocks: string[], mobs: Entity[], food: string[], placeable: string[] }
export type Run = { behavior: string, target: unknown, spec?: Spec }
export type Draw = { params: Record<string, unknown>, runs: Run[], limit_s: number }
export type Action = { name: string, fits: (f: Features) => boolean, draw: (bot: Bot, f: Features) => Draw }

const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())
const limit = () => Math.round(between(5, 20))
const short = (e: Entity) => ({ id: e.id, name: e.name })

// What's around, for which actions fit. Collectable: blocks the guarded Movements lets the bot break (src/guards.ts).
const COLLECTABLE = /_(log|leaves)$/
export function features (bot: Bot, rec: EpisodeRecorder): Features {
  const ids = bot.registry.blocksArray.filter(b => COLLECTABLE.test(b.name)).map(b => b.id)
  const blocks = [...new Set(bot.findBlocks({ matching: ids, maxDistance: 24, count: 64 }).map(p => bot.blockAt(p)?.name).filter(Boolean) as string[])]
  const me = bot.entity.position
  const mobs = Object.values(bot.entities).filter(e => e !== bot.entity && !IGNORED_TYPES.has(e.type) && e.type !== 'player' && e.position.distanceTo(me) <= 24)
  const items = bot.inventory.items()
  const food = bot.food < 20 ? [...new Set(items.filter(i => bot.registry.foodsByName[i.name]).map(i => i.name))] : []
  const placeable = [...new Set(items.filter(i => bot.registry.blocksByName[i.name]?.boundingBox === 'block').map(i => i.name))]
  const f = me.floored()
  return { logs: blocks.filter(b => b.endsWith('_log')), blocks, mobs, food, placeable, ...terrain(rec, [f.x, f.y, f.z]) }
}

// ---- the terrain queries, on the recorder's view of the chunks (rec.at: a block's class) ----
// Walks out up to 12 blocks in each of 8 directions, reading each column's ground: the first block that isn't open,
// from 4 above the feet down to 16 below. Stops at the first feature, a wall (a rise of 5+), lava or an unloaded chunk.
// About 8 × 12 × 21 class lookups at most, once per action choice.
const OPEN_CLASSES = new Set(['air', 'plant', 'passable_other', 'crop', 'light', 'rail', 'climbable', 'snow_layer', 'cobweb', 'sugar_cane_bamboo'])
const [OPEN, WATER, SOLID, STOP] = [0, 1, 2, 3]
const DIRS: Dir[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
const REACH = 12
const kinds = new WeakMap<object, Uint8Array>()
const kindsOf = (names: string[]) => {
  const k = new Uint8Array(256).fill(STOP) // 255: not loaded
  names.forEach((n, i) => { k[i] = OPEN_CLASSES.has(n) ? OPEN : n === 'water' || n === 'water_plant' ? WATER : n === 'lava' || n === 'fire' ? STOP : SOLID })
  return k
}
export function terrain (rec: Pick<EpisodeRecorder, 'at' | 'classes'>, [fx, fy, fz]: Xyz): Terrain {
  let kind = kinds.get(rec.classes)
  if (!kind) kinds.set(rec.classes, kind = kindsOf(rec.classes.names))
  const out: Terrain = { edges: [], drops: [], ledges: [], gaps: [], waters: [] }
  // A column's ground height relative to the block under the feet (0: level), or null where the walk must stop.
  const ground = (x: number, z: number) => {
    for (let y = fy + 4; y >= fy - 16; y--) {
      const k = kind[rec.at(x, y, z)]
      if (k !== OPEN) return k === STOP ? null : { rel: y - fy + 1, water: k === WATER, deep: false }
    }
    return { rel: -16, water: false, deep: true }
  }
  for (const dir of DIRS) {
    const [dx, dz] = dir
    const col = (d: number) => ground(fx + dx * d, fz + dz * d)
    const stand = (d: number, rel: number): Xyz => [fx + dx * d, fy + rel, fz + dz * d]
    let prev = 0
    let level = true
    for (let d = 1; d <= REACH; d++) {
      const c = col(d)
      if (!c) break
      const step = c.rel - prev
      if (c.water) {
        for (let e = d + 1; e <= REACH; e++) {
          const b = col(e)
          if (b?.water) continue
          if (b && !b.deep && b.rel >= c.rel && b.rel <= c.rel + 3) out.waters.push({ dir, dist: d, width: e - d, near: stand(d - 1, prev), far: stand(e, b.rel) })
          break
        }
        break
      }
      if (level && d <= 4 && step <= -1 && step >= -4) out.edges.push({ dir, dist: d, depth: -step })
      if (step <= -4 && !c.deep) out.drops.push({ dir, dist: d, depth: -step, near: stand(d - 1, prev), floor: stand(d, c.rel) })
      if (step <= -2) {
        for (let w = 1; level && d <= 3 && w <= 3; w++) {
          const b = col(d + w)
          if (!b || b.water) break
          if (b.rel - prev <= -2) continue
          if (b.rel - prev <= 1) out.gaps.push({ dir, dist: d, width: w, depth: -step })
          break
        }
        break
      }
      if (step >= 2) {
        if (step <= 4) out.ledges.push({ dir, dist: d, height: step, near: stand(d - 1, prev), top: stand(d, c.rel) })
        break
      }
      if (step) level = false
      prev = c.rel
    }
  }
  return out
}

export const SEED_ACTIONS: Action[] = [
  {
    name: 'navigate',
    fits: () => true,
    draw: bot => {
      const dist = Math.round(between(5, 40))
      const dir = +between(0, 2 * Math.PI).toFixed(2)
      const p = bot.entity.position
      const place = [Math.floor(p.x + Math.cos(dir) * dist), Math.floor(p.y), Math.floor(p.z + Math.sin(dir) * dist)]
      return { params: { dist, dir, place }, runs: [{ behavior: 'navigate', target: { place } }], limit_s: 20 }
    }
  },
  { name: 'wander', fits: () => true, draw: () => ({ params: {}, runs: [{ behavior: 'wander', target: null }], limit_s: limit() }) },
  {
    name: 'collect',
    fits: f => f.blocks.length > 0,
    draw: (_bot, f) => {
      const target = { name: pick(Math.random() < 0.7 && f.logs.length ? f.logs : f.blocks), count: Math.round(between(1, 4)) }
      return { params: target, runs: [{ behavior: 'collect', target }], limit_s: 20 }
    }
  },
  {
    name: 'track',
    fits: f => f.mobs.length > 0,
    draw: (_bot, f) => { const e = pick(f.mobs); return { params: { mob: short(e) }, runs: [{ behavior: 'track', target: e }], limit_s: limit() } }
  },
  {
    name: 'fight', // follow + track + attack_when_ready on one mob
    fits: f => f.mobs.length > 0,
    draw: (_bot, f) => {
      const e = pick(f.mobs)
      return { params: { mob: short(e) }, runs: [{ behavior: 'follow', target: e }, { behavior: 'track', target: e }, { behavior: 'attack_when_ready', target: e }], limit_s: 20 }
    }
  },
  {
    name: 'eat',
    fits: f => f.food.length > 0,
    draw: (_bot, f) => { const name = pick(f.food); return { params: { food: name }, runs: [{ behavior: 'eat', target: { name } }], limit_s: 10 } }
  }
]

// ---- authored actions: `async (api, target) => 'done' | 'stuck' | 'none_found'`, run by authoredSpec ----
// fits/target say when the action applies and what it's aimed at; the code is a library module or hand-written.
export type Authored = { source: ModuleSource, fits: (f: Features) => boolean, target: (bot: Bot, f: Features) => { params: Record<string, unknown>, target: unknown } }
const HOST: ApiHost = { blockAt, scan, reachable, allowed: [] }
const authored = (a: Authored): Action => ({
  name: a.source.name,
  fits: a.fits,
  draw: (bot, f) => {
    const t = a.target(bot, f)
    const spec = authoredSpec({ ...a.source, version: 1 }, HOST)
    return { params: t.params, runs: [{ behavior: a.source.name, target: t.target, spec }], limit_s: Math.min(20, a.source.timeout_s ?? 20) }
  }
})

// Reused from Jeeve's library (modules/library.json), when it's there. None yet: climb_down_safely turned out not to
// be in it, so it's hand-written below.
const FROM_LIBRARY: Record<string, Omit<Authored, 'source'>> = {}
export function libraryActions (file: string): Action[] {
  const lib = new ModuleRegistry(undefined, file)
  lib.load()
  return Object.entries(FROM_LIBRARY).flatMap(([name, a]) => {
    const m = lib.get(name)
    return m?.kind === 'behavior' ? [authored({ source: m, ...a })] : []
  })
}

// Hand-written (collect/actions/, one file each; brain/tasks/world-model-data.md → "Scripted actions"). 2B's bridge,
// swim across and shelter go here too, and bridge and swim join cross_water's methods (collect/actions/cross_water.ts).
export const WRITTEN: Authored[] = [
  SPRINT_JUMP, WALK_RAW, STEP_DOWN, CLIMB_DOWN_SAFELY, PILLAR_UP, DIG_STAIRS_DOWN, TUNNEL, JUMP_GAP, FLEE, CROSS_WATER, GET_DOWN_CLIFF, REACH_LEDGE
]
export const HAND_WRITTEN: Action[] = WRITTEN.map(authored)

// ---- random input: correlated look drift and random key holds ----
const KEYS: Array<[string, number]> = [['forward', 0.6], ['back', 0.15], ['left', 0.25], ['right', 0.25], ['jump', 0.3], ['sprint', 0.3], ['sneak', 0.1]]
export const RANDOM_INPUT: Spec = {
  channels: ['legs', 'aim'],
  targets: 'none',
  describe: () => 'random input',
  start (bot, target: { duration_s: number }, emit) {
    let ticks = Math.round(target.duration_s * 20)
    let yawRate = 0
    let pitch = bot.entity.pitch
    const until = new Map<string, number>(KEYS.map(([k]) => [k, 0]))
    const tick = () => {
      if (--ticks <= 0) { stop(); return emit('done') }
      yawRate = yawRate * 0.95 + gauss() * 0.012 // an Ornstein–Uhlenbeck drift, not jitter
      pitch = Math.max(-1.2, Math.min(1.2, pitch * 0.98 + gauss() * 0.02))
      void bot.look(bot.entity.yaw + yawRate, pitch, true)
      for (const [k, p] of KEYS) {
        const left = until.get(k)! - 1
        if (left > 0) { until.set(k, left); continue }
        until.set(k, Math.round(between(5, 60)))
        bot.setControlState(k as any, Math.random() < p)
      }
    }
    const stop = () => { bot.removeListener('physicsTick', tick); bot.clearControlStates() }
    bot.on('physicsTick', tick)
    return { stop, onVeto: () => {} } // a vetoed key is recorded and the burst goes on, instead of ending it
  }
}
export const randomInput = (): Draw => {
  const duration_s = Math.round(between(2, 10))
  return { params: { duration_s }, runs: [{ behavior: 'random_input', target: { duration_s }, spec: RANDOM_INPUT }], limit_s: duration_s + 1 }
}

// ---- DART-style noise while a scripted action runs: small yaw wobbles, an extra jump, a brief key release, a pause.
// Runs after the behaviors' own physicsTick handlers (the pathfinder's included), so it overrides them for a tick,
// and they correct it: "slightly off, then recovered". Per-tick odds: wobble ~2, jump/release ~1, pause ~0.4 per 10 s.
export function startNoise (bot: Bot, rec: EpisodeRecorder) {
  let wobble = 0
  let wobbleRate = 0
  let release = 0
  let pause = 0
  const tick = () => {
    if (!wobble && Math.random() < 0.01) { wobble = Math.round(between(5, 15)); wobbleRate = gauss() * 0.03 }
    if (Math.random() < 0.005) { rec.noise('jump'); bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 100) }
    if (!release && Math.random() < 0.005) release = Math.round(between(2, 6))
    if (!pause && Math.random() < 0.002) pause = Math.round(between(10, 30))
    if (wobble) { wobble--; rec.noise('wobble'); void bot.look(bot.entity.yaw + wobbleRate, bot.entity.pitch, true) }
    if (release) { release--; rec.noise('release'); bot.setControlState('forward', false); bot.setControlState('sprint', false) }
    if (pause) { pause--; rec.noise('pause'); for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint'] as const) bot.setControlState(c, false) }
  }
  bot.on('physicsTick', tick)
  return () => bot.removeListener('physicsTick', tick)
}
