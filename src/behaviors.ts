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
  targets: 'entity' | 'block' | 'item' // block and item targets are { name, count }
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

// ---- behaviors System 2 writes (brain/architecture/behaviors-and-guards.md → "The player action API") ----
// Authored code never holds `bot`. It gets every player action Mineflayer has, one entry each in READS and
// ACTIONS below: plain data in (positions, entity ids, item globs, slots), plain data out. Block queries come
// from the shared world layer (src/world.ts). Every action goes through the bot methods installGuards wrapped,
// and needs the channel it drives. `covers` names the Mineflayer Bot methods an entry stands for: the selfcheck
// fails when Mineflayer has a Bot method that no entry covers and NOT_MAPPED doesn't explain.
export type ApiHost = {
  blockAt: (bot: Bot, pos: [number, number, number]) => string | null
  scan: (bot: Bot, opts: { match: string, radius?: number, los?: boolean, max?: number }) => unknown
  reachable: (bot: Bot, pos: [number, number, number]) => Promise<unknown>
  allowed: string[] // players authored code may whisper to: the instruction allowlist
}
type Xyz = [number, number, number]
// One run's state: the window it opened (hands own windows; closed when the run ends) and its event listeners.
type Ctx = { bot: Bot, host: ApiHost, win: any, offs: Set<() => void> }
type Entry = { ch?: Channel, covers: string[], doc: string, run: (c: Ctx, ...a: any[]) => unknown }

const CONTROLS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'])
const DESTS = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']
const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
const r2 = (v: number) => +v.toFixed(2)
const xyz = (args: unknown[]): Xyz => {
  const [x, y, z] = args.map(Number)
  if (![x, y, z].every(Number.isFinite)) throw new Error('expected x, y, z numbers')
  return [Math.floor(x), Math.floor(y), Math.floor(z)]
}
const entityData = (e: Entity) => ({ id: e.id, name: e.name, type: e.type, username: e.username, pos: [r2(e.position.x), r2(e.position.y), r2(e.position.z)] })
const itemData = (i: any) => i ? { name: i.name, count: i.count, slot: i.slot } : null
const windowData = (w: any) => w && {
  id: w.id, type: w.type, title: plain(w.title), inventory_start: w.inventoryStart,
  slots: w.slots.filter(Boolean).map(itemData),
  ...(w.trades ? { trades: w.trades.map((t: any) => ({ in: [itemData(t.inputItem1), itemData(t.inputItem2)].filter(Boolean), out: itemData(t.outputItem), disabled: t.tradeDisabled })) } : {})
}
// Any Mineflayer value as plain data, for event arguments: entities, blocks, windows and items by shape.
function plain (v: any, depth = 0): unknown {
  if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'bigint' ? null : v ?? null
  if (Object.keys(v).length === 3 && ['x', 'y', 'z'].every(k => typeof v[k] === 'number')) return [r2(v.x), r2(v.y), r2(v.z)]
  if (v.position && typeof v.id === 'number' && 'yaw' in v) return entityData(v)
  if (v.position && typeof v.name === 'string' && 'stateId' in v) return { name: v.name, pos: [v.position.x, v.position.y, v.position.z] }
  if (Array.isArray(v.slots) && 'inventoryStart' in v) return windowData(v)
  if (typeof v.name === 'string' && typeof v.count === 'number') return itemData(v)
  if (depth > 1) return null
  if (Array.isArray(v)) return v.slice(0, 32).map(x => plain(x, depth + 1))
  if (v.toString !== Object.prototype.toString) return String(v) // chat messages
  return Object.fromEntries(Object.entries(v).slice(0, 16).map(([k, x]) => [k, plain(x, depth + 1)]))
}
const blockOf = (bot: Bot, a: unknown[]) => {
  const p = xyz(a)
  const b = bot.blockAt(new Vec3(...p))
  if (!b) throw new Error(`no block loaded at ${p.join(' ')}`)
  return b
}
const entityOf = (bot: Bot, id: unknown) => {
  const e = bot.entities[Number(id)]
  if (!e || e === bot.entity) throw new Error(`no entity with id ${id}`)
  return e
}
const matching = (items: any[], pattern: unknown) => items.filter(i => glob(String(pattern)).test(i.name))
// The window this run opened, if it's still the open one (walking away closes it server-side).
const openWin = (c: Ctx) => {
  if (!c.win || c.bot.currentWindow !== c.win) { c.win = null; throw new Error('no window open: call api.open first') }
  return c.win
}
const closeWin = async (c: Ctx) => {
  if (c.win && c.bot.currentWindow === c.win) await c.bot.closeWindow(c.win)
  c.win = null
}
// Places with the held item at an empty position, against any solid neighbour.
async function against (bot: Bot, a: unknown[], put: (ref: any, face: Vec3) => Promise<unknown>) {
  const t = new Vec3(...xyz(a))
  if (bot.blockAt(t)?.boundingBox !== 'empty') throw new Error(`${t} is not empty`)
  for (const d of FACES) {
    const ref = bot.blockAt(t.offset(d[0], d[1], d[2]))
    if (ref?.boundingBox === 'block') return put(ref, new Vec3(-d[0], -d[1], -d[2]))
  }
  throw new Error(`no solid block next to ${t} to place against`)
}
// Moves up to count (all if null) of the items matching a glob, one item type at a time.
async function moveItems (from: any[], pattern: unknown, count: unknown, move: (type: number, n: number) => Promise<void>) {
  let left = count == null ? Infinity : Math.max(0, Math.floor(Number(count)))
  let moved = 0
  for (const type of new Set(matching(from, pattern).map(i => i.type))) {
    const n = Math.min(left, from.filter(i => i.type === type).reduce((s, i) => s + i.count, 0))
    if (n <= 0) break
    await move(type, n)
    moved += n
    left -= n
  }
  if (!moved) throw new Error(`no items matching ${pattern}`)
  return moved
}

const READS: Record<string, Entry> = {
  self: {
    covers: [], doc: 'self() → { pos, yaw, pitch, on_ground, health, food, held }',
    run: ({ bot }) => {
      const e = bot.entity
      return { pos: [r2(e.position.x), r2(e.position.y), r2(e.position.z)], yaw: r2(e.yaw), pitch: r2(e.pitch), on_ground: e.onGround, health: bot.health, food: bot.food, held: bot.heldItem?.name ?? null }
    }
  },
  inventory: { covers: [], doc: 'inventory() → { item: count }', run: ({ bot }) => inventoryCounts(bot) },
  slots: { covers: [], doc: 'slots() → [{ slot, name, count }] for every filled inventory slot (armor 5-8, main 9-35, hotbar 36-44, off-hand 45)', run: ({ bot }) => bot.inventory.slots.filter(Boolean).map(itemData) },
  held: {
    covers: [], doc: 'held() → { name, count, slot, durability_used, max_durability } or null',
    run: ({ bot }) => bot.heldItem && { ...itemData(bot.heldItem), durability_used: bot.heldItem.durabilityUsed ?? null, max_durability: bot.heldItem.maxDurability ?? null }
  },
  entities: {
    covers: [], doc: 'entities(radius = 32) → [{ id, name, type, username, pos }]',
    run: ({ bot }, radius = 32) => Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(bot.entity.position) <= Number(radius)).map(entityData)
  },
  blockAt: { covers: ['blockAt'], doc: 'blockAt(x, y, z) → name or null', run: ({ bot, host }, ...a) => host.blockAt(bot, xyz(a)) },
  blockInfo: {
    covers: [], doc: 'blockInfo(x, y, z) → { name, properties } (block states, e.g. persistent, axis, facing, age) or null',
    run: ({ bot }, ...a) => { const b = bot.blockAt(new Vec3(...xyz(a))); return b && { name: b.name, properties: b.getProperties() } }
  },
  window: { covers: [], doc: 'window() → the open window { id, type, title, slots, inventory_start, trades? } or null; slots below inventory_start are the container\'s, the rest your inventory', run: ({ bot }) => windowData(bot.currentWindow) },
  recipes: {
    covers: ['recipesAll'], doc: 'recipes(item) → [{ needs_table, makes, uses: { item: count } }], every recipe the game has for an item, those whose ingredients you hold first',
    run: ({ bot }, item) => {
      const id = bot.registry.itemsByName[String(item)]?.id
      if (id === undefined) throw new Error(`no item named ${item}`)
      // Not capped: there's one recipe per wood type, and a cap of 8 hid oak (e2e: a craft gave up at once).
      const all = bot.recipesAll(id, null, true).map((r: any) => ({
        needs_table: r.requiresTable, makes: r.result.count,
        uses: Object.fromEntries(r.delta.filter((d: any) => d.count < 0).map((d: any) => [bot.registry.items[d.id].name, -d.count])) as Record<string, number>
      }))
      const held = inventoryCounts(bot)
      const ready = (r: { uses: Record<string, number> }) => Object.entries(r.uses).every(([k, n]) => (held[k] ?? 0) >= n)
      return [...all.filter(ready), ...all.filter(r => !ready(r))]
    }
  }
}

const ACTIONS: Record<string, Entry> = {
  // Async although they're reads: host time inside a sync call would count against the realm's 20 ms slice.
  scan: { covers: ['findBlocks', 'canSeeBlock'], doc: 'scan({ match: glob, radius, los }) → { total, clusters: [{ count, names, nearest, rel, y_rel, min, max, positions }] }', run: async ({ bot, host }, opts) => host.scan(bot, opts) },
  reachable: {
    covers: [], doc: 'reachable(x, y, z) → { reachable: boolean, status }: can the pathfinder get within reach of that block without building; status "timeout" means it gave up after 1 s, not that it\'s unreachable',
    run: async ({ bot, host }, ...a) => host.reachable(bot, xyz(a))
  },
  wait: { covers: ['waitForTicks'], doc: 'wait(ticks = 1), 20 ticks a second (max 200)', run: async ({ bot }, ticks = 1) => { await bot.waitForTicks(Math.min(200, Math.max(1, Math.floor(Number(ticks))))) } },
  next: {
    covers: ['awaitMessage'], doc: 'next(event, ticks = 100) → the arguments of the next Mineflayer bot event of that name (e.g. "windowOpen", "entityHurt", "entityDead", "playerCollect", "itemDrop", "blockUpdate", "health", "chat", "whisper") as plain data, or null after ticks (max 2400). Events before the call are not buffered',
    run: (c, event, ticks = 100) => new Promise(resolve => {
      const name = String(event)
      const fn = (...args: unknown[]) => { off(); resolve(args.map(a => plain(a))) }
      const timer = setTimeout(() => { off(); resolve(null) }, Math.min(2400, Math.max(1, Number(ticks))) * 50)
      const off = () => { clearTimeout(timer); c.bot.removeListener(name as any, fn); c.offs.delete(off) }
      c.offs.add(off)
      c.bot.on(name as any, fn)
    })
  },
  // Chat policy for the local milestone (brain/architecture/behaviors-and-guards.md): whispers to allowlisted
  // players only, and no commands. Public chat isn't mapped.
  whisper: {
    covers: ['whisper'], doc: 'whisper(player, text): to players allowed to give instructions only; no "/" commands; max 200 characters',
    run: async ({ bot, host }, player, text) => {
      if (!host.allowed.includes(String(player))) throw new Error(`whisper: ${player} is not a player who gives instructions`)
      const t = String(text)
      if (/^\s*\//.test(t)) throw new Error('whisper: no commands')
      bot.whisper(String(player), t.slice(0, 200))
    }
  },

  control: {
    ch: 'legs', covers: ['setControlState'], doc: 'control(name, on) for forward/back/left/right/jump/sneak/sprint',
    run: async ({ bot }, name, on) => {
      if (!CONTROLS.has(String(name))) throw new Error(`control must be one of ${[...CONTROLS].join(', ')}`)
      bot.setControlState(name as any, !!on)
    }
  },
  goto: {
    ch: 'legs', covers: [], doc: 'goto(x, y, z, range = 1) walks there with the pathfinder',
    run: async ({ bot }, ...a) => {
      const [x, y, z] = xyz(a)
      setGoal(bot, new goals.GoalNear(x, y, z, Number(a[3] ?? 1))) // flush a pending stop first
      await new Promise<void>((resolve, reject) => {
        const off = listen(bot, {
          goal_reached: () => { off(); resolve() },
          path_update: (r: { status: string }) => { if (r.status === 'noPath' || r.status === 'timeout') { off(); bot.pathfinder.setGoal(null); reject(new Error(`no path (${r.status})`)) } }
        })
      })
    }
  },
  mount: { ch: 'legs', covers: ['mount'], doc: 'mount(id): get in or on an entity (boat, minecart, horse) → whether you are riding', run: async ({ bot }, id) => { bot.mount(entityOf(bot, id)); await bot.waitForTicks(4); return !!(bot as any).vehicle } },
  dismount: { ch: 'legs', covers: ['dismount'], doc: 'dismount()', run: async ({ bot }) => { bot.dismount() } },
  steer: { ch: 'legs', covers: ['moveVehicle'], doc: 'steer(left, forward): drive the vehicle you ride, each -1, 0 or 1', run: async ({ bot }, left, forward) => { bot.moveVehicle(Number(left), Number(forward)) } },
  sleep: { ch: 'legs', covers: ['sleep'], doc: 'sleep(x, y, z) in the bed there (night or thunder, within reach)', run: async ({ bot }, ...a) => { await bot.sleep(blockOf(bot, a)) } },
  wake: { ch: 'legs', covers: ['wake'], doc: 'wake(): get out of bed', run: async ({ bot }) => { await bot.wake() } },
  fly: { ch: 'legs', covers: ['elytraFly'], doc: 'fly(): start gliding with an equipped elytra (while falling)', run: async ({ bot }) => { await bot.elytraFly() } },

  look: { ch: 'aim', covers: ['lookAt'], doc: 'look(x, y, z) at a point', run: async ({ bot }, ...a) => { const [x, y, z] = a.map(Number); await bot.lookAt(new Vec3(x, y, z), true) } },
  turn: { ch: 'aim', covers: ['look'], doc: 'turn(yaw, pitch) in radians (yaw 0 = north, pitch 0 = level)', run: async ({ bot }, yaw, pitch) => { await bot.look(Number(yaw), Number(pitch), true) } },

  dig: {
    ch: 'hands', covers: ['dig'], doc: 'dig(x, y, z) → the block\'s name, once broken',
    run: async ({ bot }, ...a) => {
      const block = blockOf(bot, a)
      if (block.boundingBox === 'empty') throw new Error(`nothing to dig at ${xyz(a).join(' ')}`)
      await bot.dig(block, true)
      return block.name
    }
  },
  stop_digging: { ch: 'hands', covers: ['stopDigging'], doc: 'stop_digging()', run: async ({ bot }) => { bot.stopDigging() } },
  place: { ch: 'hands', covers: ['placeBlock'], doc: 'place(x, y, z): places the held block there, against any solid neighbour → the block placed', run: async ({ bot }, ...a) => { await against(bot, a, (ref, face) => bot.placeBlock(ref, face)); return bot.blockAt(new Vec3(...xyz(a)))?.name ?? null } },
  place_entity: { ch: 'hands', covers: ['placeEntity'], doc: 'place_entity(x, y, z): places the held boat, minecart, armor stand or spawn egg there → the entity', run: async ({ bot }, ...a) => entityData(await against(bot, a, (ref, face) => bot.placeEntity(ref, face)) as Entity) },
  equip: {
    ch: 'hands', covers: ['equip'], doc: `equip(glob, dest = "hand"), dest one of ${DESTS.join(', ')} → the item equipped`,
    run: async ({ bot }, pattern, dest = 'hand') => {
      if (!DESTS.includes(String(dest))) throw new Error(`dest must be one of ${DESTS.join(', ')}`)
      const item = matching(bot.inventory.items(), pattern)[0]
      if (!item) throw new Error(`no item matching ${pattern}`)
      await bot.equip(item, dest as any)
      return item.name
    }
  },
  unequip: { ch: 'hands', covers: ['unequip'], doc: 'unequip(dest = "hand")', run: async ({ bot }, dest = 'hand') => { await bot.unequip(String(dest) as any) } },
  hotbar: { ch: 'hands', covers: ['setQuickBarSlot'], doc: 'hotbar(slot): select hotbar slot 0-8', run: async ({ bot }, slot) => { bot.setQuickBarSlot(Math.min(8, Math.max(0, Math.floor(Number(slot))))) } },
  toss: { ch: 'hands', covers: ['toss', 'tossStack'], doc: 'toss(glob, count = all) → how many were dropped', run: async ({ bot }, pattern, count) => moveItems(bot.inventory.items(), pattern, count, (type, n) => bot.toss(type, null, n)) },
  attack: { ch: 'hands', covers: ['attack'], doc: 'attack(id): look at an entity within reach (about 3 blocks) and hit it once; mind the attack cooldown (about 0.6 s with a sword)', run: async ({ bot }, id) => { const e = entityOf(bot, id); await bot.lookAt(eyes(e), true); bot.attack(e) } },
  use: { ch: 'hands', covers: ['activateItem'], doc: 'use(offhand = false): start using the held item (eat, drink, draw a bow, raise a shield, throw, place water…) until release()', run: async ({ bot }, offhand) => { bot.activateItem(!!offhand) } },
  release: { ch: 'hands', covers: ['deactivateItem'], doc: 'release(): stop using the held item (shoot the bow, lower the shield)', run: async ({ bot }) => { bot.deactivateItem() } },
  consume: { ch: 'hands', covers: ['consume'], doc: 'consume(): eat or drink the held item, resolving when done', run: async ({ bot }) => { await bot.consume() } },
  fish: { ch: 'hands', covers: ['fish'], doc: 'fish(): cast the held rod and reel in on a bite', run: async ({ bot }) => { await bot.fish() } },
  activate_block: { ch: 'hands', covers: ['activateBlock'], doc: 'activate_block(x, y, z): right-click a block (door, lever, button, bed, note block…)', run: async ({ bot }, ...a) => { await bot.activateBlock(blockOf(bot, a)) } },
  activate_entity: {
    ch: 'hands', covers: ['activateEntity', 'activateEntityAt'], doc: 'activate_entity(id, x?, y?, z?): right-click an entity (breed, shear, name, ride…), optionally at a point on it',
    run: async ({ bot }, id, ...at) => { const e = entityOf(bot, id); await (at.length ? bot.activateEntityAt(e, new Vec3(Number(at[0]), Number(at[1]), Number(at[2]))) : bot.activateEntity(e)) }
  },
  use_on: { ch: 'hands', covers: ['useOn'], doc: 'use_on(id): use the held item on an entity', run: async ({ bot }, id) => { bot.useOn(entityOf(bot, id)) } },
  swing: { ch: 'hands', covers: ['swingArm'], doc: 'swing(): swing the arm', run: async ({ bot }) => { bot.swingArm(undefined) } },
  craft: {
    ch: 'hands', covers: ['craft', 'recipesFor'], doc: 'craft(item, count = 1, table?: [x, y, z]) → how many of the item you now hold. Crafts from the inventory (2×2 grid), or at the crafting table at table (within reach) for recipes that need one',
    run: async ({ bot }, item, count = 1, table) => {
      const id = bot.registry.itemsByName[String(item)]?.id
      if (id === undefined) throw new Error(`no item named ${item}`)
      const t = table ? blockOf(bot, table as unknown[]) : null
      if (t && t.name !== 'crafting_table') throw new Error(`${(table as unknown[]).join(' ')} is ${t.name}, not a crafting_table`)
      const n = Math.max(1, Math.floor(Number(count)))
      const recipe = bot.recipesFor(id, null, n, t as any)[0]
      if (!recipe) throw new Error(!t && bot.recipesAll(id, null, false).length === 0 && bot.recipesAll(id, null, true).length ? `${item} needs a crafting table` : `not enough ingredients for ${n} ${item}`)
      await bot.craft(recipe, Math.ceil(n / recipe.result.count), t ?? undefined)
      return countItem(bot, String(item))
    }
  },
  open: {
    ch: 'hands', covers: ['openBlock', 'openContainer', 'openChest', 'openDispenser', 'openFurnace', 'openEnchantmentTable', 'openAnvil'],
    doc: 'open(x, y, z): open the block\'s window (chest, barrel, furnace, enchanting table, anvil…) within reach → window(). It stays open across ticks until close() or the run ends',
    run: async (c, ...a) => {
      const b = blockOf(c.bot, a)
      await closeWin(c)
      c.win = b.name === 'enchanting_table' ? await c.bot.openEnchantmentTable(b) : /anvil$/.test(b.name) ? await c.bot.openAnvil(b) : await c.bot.openBlock(b)
      return windowData(c.win)
    }
  },
  open_entity: {
    ch: 'hands', covers: ['openEntity', 'openVillager'], doc: 'open_entity(id): open a villager\'s trades, or a horse\'s or chest boat\'s inventory → window()',
    run: async (c, id) => {
      const e = entityOf(c.bot, id)
      await closeWin(c)
      c.win = /villager|trader/.test(e.name ?? '') ? await c.bot.openVillager(e) : await (c.bot.openEntity as any)(e)
      return windowData(c.win)
    }
  },
  click: { ch: 'hands', covers: ['clickWindow', 'moveSlotItem', 'putAway', 'putSelectedItemRange', 'transfer'], doc: 'click(slot, button = 0, mode = 0): a raw click in the open window, or the inventory if none (button 0 left, 1 right; mode 0 click, 1 shift-click, 2 hotbar swap, 4 drop) → window()', run: async ({ bot }, slot, button = 0, mode = 0) => { await bot.clickWindow(Number(slot), Number(button), Number(mode)); return windowData(bot.currentWindow ?? bot.inventory) } },
  deposit: { ch: 'hands', covers: [], doc: 'deposit(glob, count = all): move items from your inventory into the open container → how many moved', run: async (c, pattern, count) => { const w = openWin(c); return moveItems(w.items(), pattern, count, (type, n) => w.deposit(type, null, n)) } },
  withdraw: { ch: 'hands', covers: [], doc: 'withdraw(glob, count = all): move items from the open container into your inventory → how many moved', run: async (c, pattern, count) => { const w = openWin(c); return moveItems(w.containerItems(), pattern, count, (type, n) => w.withdraw(type, null, n)) } },
  close: { ch: 'hands', covers: ['closeWindow'], doc: 'close(): close the window this run opened', run: async c => closeWin(c) },
  trade: { ch: 'hands', covers: ['trade'], doc: 'trade(index, times = 1) with the open villager window (trades in window())', run: async (c, index, times = 1) => { const w = openWin(c); if (!w.trades) throw new Error('the open window is not a villager\'s'); await c.bot.trade(w, Number(index), Number(times)) } },
  enchant: { ch: 'hands', covers: [], doc: 'enchant(choice 0-2) at the open enchanting table, after clicking the item and lapis into slots 0 and 1 → the enchanted item', run: async (c, choice) => { const w = openWin(c); if (!w.enchant) throw new Error('the open window is not an enchanting table'); return itemData(await w.enchant(Number(choice))) } },
  rename: { ch: 'hands', covers: [], doc: 'rename(slot, name) the item in that slot of the open anvil', run: async (c, slot, name) => { const w = openWin(c); if (!w.rename) throw new Error('the open window is not an anvil'); await w.rename(w.slots[Number(slot)], String(name)) } },
  write_book: { ch: 'hands', covers: ['writeBook'], doc: 'write_book(slot, pages): write pages (strings) into the writable book in that inventory slot', run: async ({ bot }, slot, pages) => { await bot.writeBook(Number(slot), (pages as unknown[]).map(String)) } },
  sign: { ch: 'hands', covers: ['updateSign'], doc: 'sign(x, y, z, text, back = false): write a sign\'s text (lines split by \\n)', run: async ({ bot }, x, y, z, text, back) => { bot.updateSign(blockOf(bot, [x, y, z]), String(text), !!back) } }
}

export const API_READS = Object.keys(READS)
export const API_ACTIONS = Object.keys(ACTIONS)
// Mineflayer Bot methods no entry covers, and why. Everything else a player can do is in READS or ACTIONS.
export const NOT_MAPPED: Record<string, string> = Object.fromEntries([
  ...['connect', 'end', 'quit', 'loadPlugin', 'loadPlugins', 'hasPlugin', 'setSettings', 'respawn', 'acceptResourcePack', 'denyResourcePack', 'waitForChunksToLoad', 'updateHeldItem'].map(m => [m, 'the client and its lifecycle belong to the runtime']),
  ...['chatAddPattern', 'addChatPattern', 'addChatPatternSet', 'removeChatPattern'].map(m => [m, 'chat parsing: next("chat") gives the raw messages']),
  ['chat', 'public chat: not allowed for the local milestone (whisper to allowlisted players only)'],
  ['tabComplete', 'command completion: no commands'],
  ['setCommandBlock', 'needs operator rights'],
  ...['blockInSight', 'blockAtCursor', 'blockAtEntityCursor', 'entityAtCursor', 'nearestEntity', 'findBlock', 'canDigBlock', 'digTime', 'isABed', 'getExplosionDamages', 'getControlState', 'getEquipmentDestSlot'].map(m => [m, 'a query code can answer from the reads (blockAt, blockInfo, entities, scan, self)']),
  ['clearControlStates', 'control(name, false); a run\'s controls are cleared when it ends'],
  ['creative', 'creative-mode actions (flying, setting inventory slots); Jeeve plays survival']
])
export const API_COVERS = new Set([...Object.values(READS), ...Object.values(ACTIONS)].flatMap(e => e.covers))
// The API as System 2 (and any builder) reads it, generated from the tables so it can't drift from them.
export const API_DOC = [
  'Reads, synchronous:', ...Object.values(READS).map(e => `- api.${e.doc}`),
  ...([undefined, 'legs', 'aim', 'hands'] as const).flatMap(ch => [
    `Actions ${ch ? `on ${ch}` : 'needing no channel'}, asynchronous (await them):`,
    ...Object.values(ACTIONS).filter(e => e.ch === ch).map(e => `- api.${e.doc}`)
  ])
].join('\n')

// A Spec that runs authored code in a fresh sandbox per run. Ends with what the code returns (done, stuck,
// none_found), `vetoed` if a veto went uncaught, `error` if it threw, `timeout` past its time limit.
export function authoredSpec (m: Pick<Module, 'name' | 'description' | 'code' | 'channels' | 'targets' | 'timeout_s' | 'version'>, host: ApiHost): Spec {
  const channels = m.channels as Channel[]
  return {
    channels,
    targets: m.targets!,
    version: m.version,
    describe: t => `${m.description} (target: ${t})`,
    start (bot, target, emit) {
      const c: Ctx = { bot, host, win: null, offs: new Set() }
      const log: Array<{ call: string, ok: boolean, out: unknown, ms: number }> = [] // the last 30 actions, for System 2
      const inflight = new Set<(err: Error) => void>()
      let error: string | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        clearTimeout(timer)
        for (const off of c.offs) off()
        if (channels.includes('legs')) { for (const ctl of CONTROLS) bot.setControlState(ctl as any, false); bot.pathfinder.setGoal(null) }
        if (channels.includes('hands')) { bot.stopDigging(); void closeWin(c).catch(() => {}) }
      }
      const runner = startBehavior(m.code, target?.position ? entityData(target) : target, {
        reads: API_READS,
        actions: API_ACTIONS,
        read: (name, args) => READS[name].run(c, ...args),
        act: (name, args) => {
          const t0 = Date.now()
          const call = `${name}(${args.map(a => JSON.stringify(a)).join(', ')})`
          let reject: (err: Error) => void = () => {}
          return new Promise((resolve, rej) => {
            reject = rej
            inflight.add(rej)
            const e = ACTIONS[name]
            Promise.resolve().then(() => {
              if (e.ch && !channels.includes(e.ch)) throw new Error(`needs the ${e.ch} channel`)
              return e.run(c, ...args)
            }).then(resolve, rej)
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
