// The scripted actions the collector runs (brain/tasks/world-model-data.md → "Scripted actions"), the noise
// injected while they run, and random input. Every action starts Jeeve's own behaviors through `Channels`
// (src/behaviors.ts), under the same guards: seed behaviors by name, authored ones through `authoredSpec`.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { authoredSpec, type ApiHost, type Spec } from '../src/behaviors.ts'
import { IGNORED_TYPES } from '../src/encoder.ts'
import { ModuleRegistry, type ModuleSource } from '../src/modules.ts'
import { blockAt, reachable, scan } from '../src/world.ts'
import type { EpisodeRecorder } from './recorder.ts'

export type Features = { logs: string[], blocks: string[], mobs: Entity[], food: string[], drop: boolean }
export type Run = { behavior: string, target: unknown, spec?: Spec }
export type Draw = { params: Record<string, unknown>, runs: Run[], limit_s: number }
export type Action = { name: string, fits: (f: Features) => boolean, draw: (bot: Bot, f: Features) => Draw }

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
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
  const food = bot.food < 20 ? [...new Set(bot.inventory.items().filter(i => bot.registry.foodsByName[i.name]).map(i => i.name))] : []
  // A drop of 4+ within 5 blocks in any of 8 directions.
  const f = me.floored()
  const drop = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]].some(([dx, dz]) => [2, 3, 4, 5].some(d => {
    for (let k = 1; k <= 4; k++) if (rec.at(f.x + dx * d, f.y - k, f.z + dz * d) !== 0) return false
    return true
  }))
  return { logs: blocks.filter(b => b.endsWith('_log')), blocks, mobs, food, drop }
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
type Authored = { source: ModuleSource, fits: (f: Features) => boolean, target: (bot: Bot, f: Features) => { params: Record<string, unknown>, target: unknown } }
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

// Reused from Jeeve's library (modules/library.json), when it's there.
const FROM_LIBRARY: Record<string, Omit<Authored, 'source'>> = {
  climb_down_safely: { fits: f => f.drop, target: () => ({ params: {}, target: null }) }
}
export function libraryActions (file: string): Action[] {
  const lib = new ModuleRegistry(undefined, file)
  lib.load()
  return Object.entries(FROM_LIBRARY).flatMap(([name, a]) => {
    const m = lib.get(name)
    return m?.kind === 'behavior' ? [authored({ source: m, ...a })] : []
  })
}

// Phase 2 (brain/tasks/world-model-data.md): the hand-written actions (sprint-jump, raw-control walks, step down,
// pillar, dig stairs, tunnel, jump a gap, flee, feature-seeking) and 2B's (bridge, swim across, shelter) go in
// collect/actions/, one file each exporting an `Authored`, and are listed here.
export const HAND_WRITTEN: Action[] = ([] as Authored[]).map(authored)

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
