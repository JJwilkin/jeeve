// Seed behaviors and the channel runtime (brain/architecture/seed-behaviors.md, behaviors-and-guards.md).
// A behavior claims a set of channels; starting it replaces whatever holds any of them.
// Behaviors keep running between Jev calls.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import pf from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { inventoryCounts } from './encoder.ts'
import { glob } from './goals.ts'
import { BEHAVIOR_ENDINGS, startBehavior, type Module } from './modules.ts'

const { goals } = pf

export type Channel = 'legs' | 'aim' | 'hands'
export const CHANNELS: Channel[] = ['legs', 'aim', 'hands']
// terminal events end the run's status (done, stuck, vetoed…); progress events are only recorded.
type Emit = (event: string, terminal?: boolean) => void
// onVeto: an authored run handles a guard veto itself (the vetoed call rejects); detail goes on its span.
type Running = { stop: () => void, onVeto?: (reason: string) => void, detail?: () => unknown }
export type Spec = {
  channels: Channel[]
  targets: 'entity' | 'block'
  describe: (target: string) => string
  describePlace?: (where: string) => string // also takes the goal's place as a target ({ place: [x, y, z] })
  start: (bot: Bot, target: any, emit: Emit) => Running
  version?: number // authored behaviors; seed behaviors are version 1
  disabled?: string // an authored behavior that kept failing: no longer offered
}

// Subscribe to bot events for the lifetime of one behavior run.
function listen (bot: Bot, handlers: Record<string, (...args: any[]) => void>): () => void {
  for (const [ev, fn] of Object.entries(handlers)) bot.on(ev as any, fn)
  return () => { for (const [ev, fn] of Object.entries(handlers)) bot.removeListener(ev as any, fn) }
}

const gone = (target: Entity, emit: Emit) => ({
  entityGone: (e: Entity) => { if (e.id === target.id) emit('target_lost') },
  entityDead: (e: Entity) => { if (e.id === target.id) emit('target_dead') }
})

// pathfinder.stop() is deferred, and setGoal() runs a pending stop at once, wiping the new goal.
// collectblock's cancel leaves exactly such a stop behind, so flush it first.
function setGoal (bot: Bot, goal: InstanceType<typeof goals.Goal>, dynamic = false) {
  bot.pathfinder.setGoal(null)
  bot.pathfinder.setGoal(goal, dynamic)
}

const eyes = (e: Entity) => e.position.offset(0, e.height * 0.9, 0)
const countItem = (bot: Bot, name: string) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)

export const BEHAVIORS: Record<string, Spec> = {
  navigate: {
    channels: ['legs'],
    targets: 'entity',
    describe: t => `Walk to where ${t} is right now, then stop`,
    describePlace: where => `Walk back to the goal's place (${where}), then stop`,
    start (bot, target: Entity | { place: Xyz }, emit) {
      // ponytail: a place ignores height (the trunk or canopy System 2 scanned may not be standable); a goal
      // underground would need GoalNear with a standable spot.
      if ('place' in target) setGoal(bot, new goals.GoalNearXZ(target.place[0], target.place[2], 2))
      else setGoal(bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2))
      const off = listen(bot, {
        goal_reached: () => emit('done'),
        path_update: (r: { status: string }) => { if (r.status === 'noPath' || r.status === 'timeout') emit('stuck') }
      })
      return { stop: () => { off(); bot.pathfinder.setGoal(null) } }
    }
  },
  follow: {
    channels: ['legs'],
    targets: 'entity',
    describe: t => `Keep following ${t}, staying about 2 blocks away`,
    start (bot, target: Entity, emit) {
      setGoal(bot, new goals.GoalFollow(target, 2), true)
      const off = listen(bot, {
        ...gone(target, emit),
        path_update: (r: { status: string }) => { if (r.status === 'noPath') emit('stuck') }
      })
      return { stop: () => { off(); bot.pathfinder.setGoal(null) } }
    }
  },
  track: {
    channels: ['aim'],
    targets: 'entity',
    describe: t => `Keep looking at ${t}`,
    start (bot, target: Entity, emit) {
      const off = listen(bot, {
        ...gone(target, emit),
        // Coupling rule: while the pathfinder walks, it steers by looking, so legs own the view.
        physicsTick: () => { if (!bot.pathfinder.isMoving()) void bot.lookAt(eyes(target), true) }
      })
      return { stop: off }
    }
  },
  attack_when_ready: {
    channels: ['hands'],
    targets: 'entity',
    describe: t => `Attack ${t} whenever it is within reach`,
    start (bot, target: Entity, emit) {
      let last = 0
      const off = listen(bot, {
        ...gone(target, emit),
        physicsTick: () => {
          // ponytail: fixed 625 ms cooldown (sword); per-weapon attack speed when we hold other weapons.
          if (Date.now() - last < 625 || bot.entity.position.distanceTo(target.position) > 3.5) return
          last = Date.now()
          void bot.lookAt(eyes(target), true).then(() => bot.attack(target))
        }
      })
      return { stop: off }
    }
  },
  // Wraps mineflayer-collectblock, which paths, looks, equips a tool and digs: it claims the whole body.
  collect: {
    channels: ['legs', 'aim', 'hands'],
    targets: 'block',
    describe: t => `Collect ${t} (walks, digs and picks up; uses the whole body)`,
    start (bot, target: { name: string, count: number }, emit) {
      let alive = true
      const start = countItem(bot, target.name)
      const id = bot.registry.blocksByName[target.name]?.id
      void (async () => {
        while (alive) {
          const got = countItem(bot, target.name) - start
          if (got >= target.count) return emit('done')
          const blocks = bot.findBlocks({ matching: id, maxDistance: 32, count: target.count - got }).map(p => bot.blockAt(p)!).filter(Boolean)
          if (!blocks.length) return emit('none_found')
          try { await bot.collectBlock.collect(blocks) } catch { if (alive) return emit('stuck') }
          if (!alive) return
          const now = countItem(bot, target.name) - start
          if (now === got) return emit('stuck') // a pass that collected nothing won't do better next time
          emit(`progress ${now}/${target.count}`, false)
        }
      })()
      return { stop: () => { alive = false; bot.stopDigging(); void bot.collectBlock.cancelTask() } }
    }
  }
}

export const STOP_DESC: Record<Channel, string> = {
  legs: 'Stand still',
  aim: 'Stop looking at anything in particular',
  hands: 'Keep hands idle'
}

// pinned: a trial System 2 started; Jev can't replace it.
type Slot = { key: string, runId: string, behavior: string, version: number, channels: Channel[], run: Running, status: string, emit: Emit, target: unknown, decidedBy?: string, pinned?: boolean }
export type ChannelHooks = {
  event: (slot: Slot, event: string) => void // every event, terminal or progress
  start: (slot: Slot) => void
  end: (slot: Slot, reason: string) => void // terminal event, or replaced/stopped
}

export class Channels {
  slots: Record<Channel, Slot | null> = { legs: null, aim: null, hands: null }
  bot: Bot
  hooks: ChannelHooks
  runs = 0

  constructor (bot: Bot, hooks: ChannelHooks) {
    this.bot = bot
    this.hooks = hooks
  }

  // key is the option key, e.g. `follow:E3`. One owner per channel: holders of any claimed channel stop first.
  // spec: a behavior not in BEHAVIORS yet (an authored one on trial).
  set (key: string, behavior: string, target: Entity | { name: string, count: number } | { place: Xyz }, decidedBy?: string, opts: { spec?: Spec, pinned?: boolean } = {}) {
    const spec = opts.spec ?? BEHAVIORS[behavior]
    this.stop(spec.channels)
    const slot: Slot = { key, runId: `r-${++this.runs}`, behavior, version: spec.version ?? 1, channels: spec.channels, status: 'running', run: { stop () {} }, emit: () => {}, target, decidedBy, pinned: opts.pinned }
    slot.emit = (event, terminal = true) => {
      if (slot.status !== 'running') return
      if (terminal) slot.status = event
      this.hooks.event(slot, event)
      if (terminal) this.hooks.end(slot, event.split(' ')[0])
    }
    for (const c of spec.channels) this.slots[c] = slot
    this.hooks.start(slot)
    slot.run = spec.start(this.bot, target, slot.emit)
  }

  // Stop whatever holds any of these channels (a multi-channel behavior is stopped as a whole).
  stop (channels: Channel[], reason = 'replaced') {
    for (const c of channels) {
      const holder = this.slots[c]
      if (!holder) continue
      holder.run.stop()
      if (holder.status === 'running') { holder.status = reason; this.hooks.end(holder, reason) }
      for (const hc of holder.channels) if (this.slots[hc] === holder) this.slots[hc] = null
    }
  }

  // A guard blocked something on this channel: the behavior holding it learns it was vetoed.
  // An authored run gets the veto as a rejected call and may carry on, so there it's only recorded.
  veto (channel: Channel, reason: string) {
    const slot = this.slots[channel]
    if (!slot?.run.onVeto) return slot?.emit(`vetoed (${reason})`)
    slot.emit(`vetoed (${reason})`, false)
    slot.run.onVeto(reason)
  }

  // A walk back to a goal's place belongs to that place: it stops once the goal's place moves or goes.
  stopStalePlace (place: Xyz | null) {
    const at = (this.slots.legs?.target as { place?: Xyz } | undefined)?.place
    if (at && this.slots.legs?.status === 'running' && String(at) !== String(place)) this.stop(['legs'], 'place_changed')
  }

  describe (): Record<Channel, string> {
    return Object.fromEntries(CHANNELS.map(c => {
      const s = this.slots[c]
      return [c, s ? `${s.key} (${s.status})` : 'idle']
    })) as Record<Channel, string>
  }
}

// ---- behaviors System 2 writes (brain/architecture/behaviors-and-guards.md → "Runtime-authored behaviors") ----
// Authored code never holds `bot`. It gets an API: read-only world queries (src/world.ts, shared with
// perception), the bot's own state, and actions. Every action goes through the bot methods installGuards
// wrapped, so a guard vetoes authored code exactly as it vetoes a seed behavior, and each action needs the
// channel it drives, so a behavior can't move legs it doesn't hold.
export type WorldReads = {
  blockAt: (bot: Bot, pos: [number, number, number]) => string | null
  scan: (bot: Bot, opts: { match: string, radius?: number, los?: boolean, max?: number }) => unknown
  reachable: (bot: Bot, pos: [number, number, number]) => Promise<unknown>
}
type Xyz = [number, number, number]
const CONTROLS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'])
const r2 = (v: number) => +v.toFixed(2)
const xyz = (args: unknown[]): Xyz => {
  const [x, y, z] = args.map(Number)
  if (![x, y, z].every(Number.isFinite)) throw new Error('expected x, y, z numbers')
  return [Math.floor(x), Math.floor(y), Math.floor(z)]
}
const entityData = (e: Entity) => ({ id: e.id, name: e.name, type: e.type, username: e.username, pos: [r2(e.position.x), r2(e.position.y), r2(e.position.z)] })

export const API_READS = ['self', 'inventory', 'entities', 'blockAt']
export const API_ACTIONS = ['scan', 'reachable', 'control', 'look', 'dig', 'place', 'equip', 'wait', 'goto']

function actionApi (bot: Bot, channels: Channel[], world: WorldReads) {
  const need = (c: Channel) => { if (!channels.includes(c)) throw new Error(`needs the ${c} channel`) }
  const reads: Record<string, (...a: unknown[]) => unknown> = {
    self: () => {
      const e = bot.entity
      return { pos: [r2(e.position.x), r2(e.position.y), r2(e.position.z)], yaw: r2(e.yaw), pitch: r2(e.pitch), on_ground: e.onGround, health: bot.health, food: bot.food, held: bot.heldItem?.name ?? null }
    },
    inventory: () => inventoryCounts(bot),
    entities: (radius = 32) => Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(bot.entity.position) <= Number(radius)).map(entityData),
    blockAt: (...a) => world.blockAt(bot, xyz(a))
  }
  const actions: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    // Async although it's a read: host time inside a sync call would count against the realm's 20 ms slice.
    scan: async (opts) => world.scan(bot, opts as Parameters<WorldReads['scan']>[1]),
    reachable: async (...a) => world.reachable(bot, xyz(a)),
    control: async (name, on) => {
      need('legs')
      if (!CONTROLS.has(String(name))) throw new Error(`control must be one of ${[...CONTROLS].join(', ')}`)
      bot.setControlState(name as any, !!on)
    },
    look: async (...a) => { need('aim'); const [x, y, z] = a.map(Number); await bot.lookAt(new Vec3(x, y, z), true) },
    dig: async (...a) => {
      need('hands')
      const block = bot.blockAt(new Vec3(...xyz(a)))
      if (!block || block.boundingBox === 'empty') throw new Error(`nothing to dig at ${xyz(a).join(' ')}`)
      await bot.dig(block, true)
      return block.name
    },
    // Places the held block at a position, against any solid neighbour.
    place: async (...a) => {
      need('hands')
      const t = new Vec3(...xyz(a))
      if (bot.blockAt(t)?.boundingBox !== 'empty') throw new Error(`${t} is not empty`)
      for (const d of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
        const ref = bot.blockAt(t.offset(d[0], d[1], d[2]))
        if (ref?.boundingBox === 'block') { await bot.placeBlock(ref, new Vec3(-d[0], -d[1], -d[2])); return bot.blockAt(t)?.name ?? null }
      }
      throw new Error(`no solid block next to ${t} to place against`)
    },
    equip: async (pattern) => {
      need('hands')
      const item = bot.inventory.items().find(i => glob(String(pattern)).test(i.name))
      if (!item) throw new Error(`no item matching ${pattern}`)
      await bot.equip(item, 'hand')
      return item.name
    },
    wait: async (ticks = 1) => { await bot.waitForTicks(Math.min(200, Math.max(1, Math.floor(Number(ticks))))) },
    goto: async (...a) => {
      need('legs')
      const [x, y, z] = xyz(a)
      setGoal(bot, new goals.GoalNear(x, y, z, Number(a[3] ?? 1))) // flush a pending stop first
      await new Promise<void>((resolve, reject) => {
        const off = listen(bot, {
          goal_reached: () => { off(); resolve() },
          path_update: (r: { status: string }) => { if (r.status === 'noPath' || r.status === 'timeout') { off(); bot.pathfinder.setGoal(null); reject(new Error(`no path (${r.status})`)) } }
        })
      })
    }
  }
  return { reads, actions }
}

// A Spec that runs authored code in a fresh sandbox per run. Ends with what the code returns (done, stuck,
// none_found), `vetoed` if a veto went uncaught, `error` if it threw, `timeout` past its time limit.
export function authoredSpec (m: Pick<Module, 'name' | 'description' | 'code' | 'channels' | 'targets' | 'timeout_s' | 'version'>, world: WorldReads): Spec {
  const channels = m.channels as Channel[]
  return {
    channels,
    targets: m.targets!,
    version: m.version,
    describe: t => `${m.description} (target: ${t})`,
    start (bot, target, emit) {
      const { reads, actions } = actionApi(bot, channels, world)
      const log: Array<{ call: string, ok: boolean, out: unknown, ms: number }> = [] // the last 30 actions, for System 2
      const inflight = new Set<(err: Error) => void>()
      let error: string | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        clearTimeout(timer)
        if (channels.includes('legs')) { for (const c of CONTROLS) bot.setControlState(c as any, false); bot.pathfinder.setGoal(null) }
        if (channels.includes('hands')) bot.stopDigging()
      }
      const runner = startBehavior(m.code, target?.position ? entityData(target) : target, {
        reads: Object.keys(reads),
        actions: Object.keys(actions),
        read: (name, args) => reads[name](...args),
        act: (name, args) => {
          const t0 = Date.now()
          const call = `${name}(${args.map(a => JSON.stringify(a)).join(', ')})`
          let reject: (err: Error) => void = () => {}
          return new Promise((resolve, rej) => {
            reject = rej
            inflight.add(rej)
            actions[name](...args).then(resolve, rej)
          }).then(
            out => { log.push({ call, ok: true, out, ms: Date.now() - t0 }); return out },
            err => { log.push({ call, ok: false, out: String(err.message ?? err), ms: Date.now() - t0 }); throw err }
          ).finally(() => { inflight.delete(reject); if (log.length > 30) log.shift() })
        },
        // Deferred: code that fails at once would otherwise end the run inside Channels.set, before it has a slot.
        end: r => queueMicrotask(() => {
          cleanup()
          const value = r.value ?? 'done'
          const ok = BEHAVIOR_ENDINGS.includes(value as string)
          error = r.error ?? (ok ? undefined : `returned ${JSON.stringify(value)}, not one of ${BEHAVIOR_ENDINGS.join(', ')}`)
          emit(r.error?.startsWith('vetoed') ? 'vetoed' : error ? 'error' : value as string)
        })
      })
      timer = setTimeout(() => { runner.cancel(); cleanup(); error = `time limit of ${m.timeout_s} s`; emit('timeout') }, m.timeout_s! * 1000)
      return {
        stop: () => { runner.cancel(); cleanup() },
        onVeto: reason => { for (const reject of inflight) reject(new Error(`vetoed: ${reason}`)); inflight.clear() },
        detail: () => ({ error, actions: log })
      }
    }
  }
}
