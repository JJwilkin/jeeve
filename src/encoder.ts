// The default `egocentric` encoder: raw Mineflayer state → Jev's `state` (brain/architecture/system-1.md).
// Distances, directions and motion are named buckets computed here, because Jev is weak with numbers.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import { notableBlocks, type Pos } from './world.ts'

export type Handles = { byId: Map<number, string>, byHandle: Map<string, number>, next: number }
export const newHandles = (): Handles => ({ byId: new Map(), byHandle: new Map(), next: 0 })

// Stable per-session handle, so an option like `follow:E3` binds back to a real entity.
export function handleFor (h: Handles, id: number): string {
  let handle = h.byId.get(id)
  if (!handle) {
    handle = `E${h.next++}`
    h.byId.set(id, handle)
    h.byHandle.set(handle, id)
  }
  return handle
}

export const distanceBucket = (d: number) => d < 3 ? 'very close' : d < 8 ? 'close' : d < 16 ? 'medium' : 'far'

// Mineflayer yaw: 0 faces north (-z), positive turns left (counter-clockwise from above).
export function direction (dx: number, dz: number, yaw: number): string {
  let rel = (Math.atan2(-dx, -dz) - yaw) * 180 / Math.PI
  rel = ((rel % 360) + 540) % 360 - 180
  const side = rel > 0 ? 'left' : 'right'
  const a = Math.abs(rel)
  return a < 22.5 ? 'ahead' : a < 67.5 ? `ahead-${side}` : a < 112.5 ? side : a < 157.5 ? `behind-${side}` : 'behind'
}

export const motionBucket = (closing: number) =>
  closing > 1.5 ? 'closing fast' : closing > 0.3 ? 'closing' : closing < -0.3 ? 'moving away' : 'steady'

export const healthBucket = (hp: number) =>
  hp >= 20 ? 'full' : hp >= 14 ? 'high' : hp >= 8 ? 'half' : hp >= 4 ? 'low' : 'critical'

const IGNORED_TYPES = new Set(['object', 'orb', 'projectile', 'other', 'global'])

// Mineflayer's `hostile` type misses mobs like slimes (typed `mob`), so damage attributed to its source marks
// anything as attacking, with no list of hostile mobs (brain/architecture/system-1.md → "Threats").
// ponytail: 10 s memory is a guess; tune it from traces.
export type Attackers = Map<number, number> // entity id → when it last hurt the bot
export const attacking = (attackers: Attackers | undefined, id: number) => Date.now() - (attackers?.get(id) ?? -Infinity) < 10_000
export const describeEntity = (e: Entity, attackingMe = false) =>
  `${e.type === 'player' ? `player ${e.username}` : `${e.name ?? 'unknown'}${e.type === 'hostile' ? ' (hostile)' : ''}`}${attackingMe ? ' (attacking you)' : ''}`

export type Directive = { text: string, from: string, at: number, inventory: Record<string, number>, goal?: string | null, place?: Pos | null }
export type Encoded = {
  state: Record<string, unknown>
  entities: Array<{ id: string, desc: string }>
  blocks: Array<{ name: string, desc: string }>
  place?: { pos: Pos, desc: string } | null // the goal's place, unless the bot is already there
}

export const inventoryCounts = (bot: Bot) => {
  const counts: Record<string, number> = {}
  for (const i of bot.inventory.items()) counts[i.name] = (counts[i.name] ?? 0) + i.count
  return counts
}

const countBucket = (n: number) => n === 1 ? 'one' : n <= 5 ? 'a few' : 'many'
// Exact where it's small, a bucket where it isn't: Jev is weak with numbers (brain/research/jev-measurements.md).
const blockCount = (n: number) => n === 1 ? 'one' : n <= 9 ? `${countBucket(n)} (${n})` : 'many'
const vertical = (dy: number) => dy > 1 ? `, ~${dy} up` : dy < -1 ? `, ~${-dy} down` : ''

// Notable blocks (src/world.ts) for Jev: exact small counts, and where the nearest one is, height included.
function describeBlocks (bot: Bot, radius: number, rareMax: number, cap: number) {
  const pos = bot.entity.position
  const feetY = Math.floor(pos.y)
  return notableBlocks(bot, radius, rareMax).slice(0, cap).map(({ name, count, positions: [[x, y, z]] }) => ({
    name,
    count: blockCount(count),
    nearest: `${distanceBucket(new Vec3(x + 0.5, y, z + 0.5).distanceTo(pos))}, ${direction(x + 0.5 - pos.x, z + 0.5 - pos.z, bot.entity.yaw)}${vertical(y - feetY)}`
  }))
}

export function makeEgocentric (params: { entity_cap: number, radius: number, block_radius: number, block_cap: number, rare_max: number }) {
  const lastDistance = new Map<number, { d: number, t: number }>()
  return function encode (bot: Bot, ctx: { handles: Handles, directive: Directive | null, channels: Record<string, string>, events: string[], attackers?: Attackers }): Encoded {
    const me = bot.entity
    const now = Date.now()
    const near = Object.values(bot.entities)
      .filter(e => e !== me && !IGNORED_TYPES.has(e.type) && e.position.distanceTo(me.position) <= params.radius)
      .sort((a, b) => a.position.distanceTo(me.position) - b.position.distanceTo(me.position))
      .slice(0, params.entity_cap)
    const entities = near.map(e => {
      const d = e.position.distanceTo(me.position)
      const prev = lastDistance.get(e.id)
      const closing = prev && now > prev.t ? (prev.d - d) / ((now - prev.t) / 1000) : 0
      lastDistance.set(e.id, { d, t: now })
      const held = e.heldItem?.name
      return {
        id: handleFor(ctx.handles, e.id),
        what: describeEntity(e, attacking(ctx.attackers, e.id)),
        where: `${distanceBucket(d)}, ${direction(e.position.x - me.position.x, e.position.z - me.position.z, me.yaw)}`,
        motion: motionBucket(closing),
        ...(held ? { held } : {})
      }
    })
    const blocks = describeBlocks(bot, params.block_radius, params.rare_max, params.block_cap)
    const at = ctx.directive?.place
    // Horizontal, as navigate walks to a place; height is shown apart. Already there (navigate's range):
    // walking back would mean the same as standing still.
    const [pdx, pdz] = at ? [at[0] + 0.5 - me.position.x, at[2] + 0.5 - me.position.z] : [0, 0]
    // Said as at / not at: given "far" or "close" (vs "very close") Jev often stood still short of the place
    // (brain/architecture/behaviors-and-guards.md → "Going back to a place").
    const bucket = distanceBucket(Math.hypot(pdx, pdz))
    const where = `${direction(pdx, pdz, me.yaw)}${vertical(at ? at[1] - Math.floor(me.position.y) : 0)}`
    const place = at && bucket !== 'very close' ? { pos: at, desc: `${bucket}, ${where}` } : null
    const speaker = ctx.directive && Object.values(bot.entities).find(e => e.username === ctx.directive!.from)
    return {
      state: {
        directive: ctx.directive
          ? { text: ctx.directive.text, from: `player ${ctx.directive.from}${speaker ? ` (${handleFor(ctx.handles, speaker.id)})` : ' (not in view)'}`, ...(ctx.directive.goal ? { goal: ctx.directive.goal } : {}), ...(at ? { place: `you are ${place ? 'not at the goal\'s place yet' : 'at the goal\'s place'}; it is ${place ? `${bucket}, ` : ''}${where}` } : {}) }
          : 'none yet: stay safe and wait',
        self: {
          health: healthBucket(bot.health),
          food: healthBucket(bot.food),
          held: bot.heldItem?.name ?? 'empty hand',
          inventory: Object.entries(inventoryCounts(bot)).map(([name, n]) => `${name} (${countBucket(n)})`)
        },
        channels: ctx.channels,
        entities,
        blocks,
        recent_events: ctx.events
      },
      entities: entities.map(e => ({ id: e.id, desc: `${e.what}, ${e.where}` })),
      blocks: blocks.map(b => ({ name: b.name, desc: `${b.count}, nearest ${b.nearest}` })),
      place
    }
  }
}

// Compact raw snapshot logged with every decision, so a new encoder can be replayed on old states.
// It is also the input to modules System 2 writes (src/modules.ts), so keep it plain JSON.
// Blocks: each notable type's nearest 8 positions (src/world.ts). A common type (more than 64 in the 17³ cube)
// is absent, so a missing name doesn't mean none; ask world.scan for that.
export function rawSnapshot (bot: Bot, radius = 32) {
  const me = bot.entity
  const r = (v: { x: number, y: number, z: number }) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]
  return {
    t: Date.now(),
    self: {
      pos: r(me.position), yaw: +me.yaw.toFixed(3), health: bot.health, food: bot.food,
      held: bot.heldItem?.name ?? null, below: bot.blockAt?.(me.position.offset(0, -1, 0))?.name ?? null
    },
    inventory: bot.inventory ? inventoryCounts(bot) : {},
    blocks: Object.fromEntries(notableBlocks(bot).slice(0, 12).map(n => [n.name, n.positions.slice(0, 8)])),
    world: { time_of_day: bot.time?.timeOfDay ?? null, is_day: bot.time?.isDay ?? null, raining: bot.isRaining ?? null },
    entities: Object.values(bot.entities)
      .filter(e => e !== me && e.position.distanceTo(me.position) <= radius)
      .map(e => ({ id: e.id, name: e.name, type: e.type, username: e.username, pos: r(e.position), vel: r(e.velocity) }))
  }
}
