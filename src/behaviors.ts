// Seed behaviors and the channel runtime (brain/architecture/seed-behaviors.md, behaviors-and-guards.md).
// A behavior claims a set of channels; starting it replaces whatever holds any of them.
// Behaviors keep running between Jev calls.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import pf from 'mineflayer-pathfinder'

const { goals } = pf

export type Channel = 'legs' | 'aim' | 'hands'
export const CHANNELS: Channel[] = ['legs', 'aim', 'hands']
// terminal events end the run's status (done, stuck, vetoed…); progress events are only recorded.
type Emit = (event: string, terminal?: boolean) => void
type Running = { stop: () => void }
type Spec = {
  channels: Channel[]
  targets: 'entity' | 'block'
  describe: (target: string) => string
  start: (bot: Bot, target: any, emit: Emit) => Running
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
    start (bot, target: Entity, emit) {
      const p = target.position
      setGoal(bot, new goals.GoalNear(p.x, p.y, p.z, 2))
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

type Slot = { key: string, runId: string, behavior: string, channels: Channel[], run: Running, status: string, emit: Emit, decidedBy?: string }
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
  set (key: string, behavior: string, target: Entity | { name: string, count: number }, decidedBy?: string) {
    const spec = BEHAVIORS[behavior]
    this.stop(spec.channels)
    const slot: Slot = { key, runId: `r-${++this.runs}`, behavior, channels: spec.channels, status: 'running', run: { stop () {} }, emit: () => {}, decidedBy }
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
  veto (channel: Channel, reason: string) { this.slots[channel]?.emit(`vetoed (${reason})`) }

  describe (): Record<Channel, string> {
    return Object.fromEntries(CHANNELS.map(c => {
      const s = this.slots[c]
      return [c, s ? `${s.key} (${s.status})` : 'idle']
    })) as Record<Channel, string>
  }
}
