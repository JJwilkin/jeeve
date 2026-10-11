// Seed behaviors and the channel runtime (brain/architecture/behaviors-and-guards.md).
// Each channel runs one behavior at a time; behaviors keep running between Jev calls.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import pf from 'mineflayer-pathfinder'

const { goals } = pf

export type Channel = 'legs' | 'aim' | 'hands'
export const CHANNELS: Channel[] = ['legs', 'aim', 'hands']
type Emit = (event: string) => void
type Running = { stop: () => void }
type Spec = {
  channel: Channel
  describe: (target: string) => string
  start: (bot: Bot, target: Entity, emit: Emit) => Running
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

export const BEHAVIORS: Record<string, Spec> = {
  navigate: {
    channel: 'legs',
    describe: t => `Walk to where ${t} is right now, then stop`,
    start (bot, target, emit) {
      const p = target.position
      bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 2))
      const off = listen(bot, {
        goal_reached: () => emit('done'),
        path_update: (r: { status: string }) => { if (r.status === 'noPath' || r.status === 'timeout') emit('stuck') }
      })
      return { stop: () => { off(); bot.pathfinder.setGoal(null) } }
    }
  },
  follow: {
    channel: 'legs',
    describe: t => `Keep following ${t}, staying about 2 blocks away`,
    start (bot, target, emit) {
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      const off = listen(bot, {
        ...gone(target, emit),
        path_update: (r: { status: string }) => { if (r.status === 'noPath') emit('stuck') }
      })
      return { stop: () => { off(); bot.pathfinder.setGoal(null) } }
    }
  },
  track: {
    channel: 'aim',
    describe: t => `Keep looking at ${t}`,
    start (bot, target, emit) {
      const off = listen(bot, {
        ...gone(target, emit),
        // Coupling rule: while the pathfinder walks, it steers by looking, so legs own the view.
        physicsTick: () => { if (!bot.pathfinder.isMoving()) bot.lookAt(target.position.offset(0, target.height * 0.9, 0), true) }
      })
      return { stop: off }
    }
  },
  attack_when_ready: {
    channel: 'hands',
    describe: t => `Attack ${t} whenever it is within reach`,
    start (bot, target, emit) {
      let last = 0
      const off = listen(bot, {
        ...gone(target, emit),
        physicsTick: () => {
          // ponytail: fixed 625 ms cooldown (sword); per-weapon attack speed when we hold other weapons.
          if (Date.now() - last < 625 || bot.entity.position.distanceTo(target.position) > 3.5) return
          last = Date.now()
          bot.lookAt(target.position.offset(0, target.height * 0.9, 0), true).then(() => bot.attack(target))
        }
      })
      return { stop: off }
    }
  }
}

// `stop` is valid on every channel: end whatever the channel is running.
export const STOP_DESC: Record<Channel, string> = {
  legs: 'Stand still',
  aim: 'Stop looking at anything in particular',
  hands: 'Keep hands idle'
}

type Slot = { key: string, run: Running, status: string }

export class Channels {
  slots: Record<Channel, Slot | null> = { legs: null, aim: null, hands: null }
  bot: Bot
  onEvent: (channel: Channel, key: string, event: string) => void

  constructor (bot: Bot, onEvent: (channel: Channel, key: string, event: string) => void) {
    this.bot = bot
    this.onEvent = onEvent
  }

  // key is the option key, e.g. `follow:E3`; one owner per channel, the old behavior is stopped first.
  set (channel: Channel, key: string, behavior: string | null, target?: Entity) {
    this.slots[channel]?.run.stop()
    this.slots[channel] = null
    if (!behavior || !target) return
    const slot: Slot = { key, status: 'running', run: { stop () {} } }
    this.slots[channel] = slot
    slot.run = BEHAVIORS[behavior].start(this.bot, target, event => {
      if (this.slots[channel] !== slot || slot.status !== 'running') return
      slot.status = event
      this.onEvent(channel, key, event)
    })
  }

  describe (): Record<Channel, string> {
    return Object.fromEntries(CHANNELS.map(c => {
      const s = this.slots[c]
      return [c, s ? `${s.key} (${s.status})` : 'idle']
    })) as Record<Channel, string>
  }

  stopAll () { for (const c of CHANNELS) this.set(c, 'stop', null) }
}
