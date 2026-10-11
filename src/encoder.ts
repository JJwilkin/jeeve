// The default `egocentric` encoder: raw Mineflayer state → Jev's `state` (brain/architecture/system-1.md).
// Distances, directions and motion are named buckets computed here, because Jev is weak with numbers.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'

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

export const describeEntity = (e: Entity) =>
  e.type === 'player' ? `player ${e.username}` : `${e.name ?? 'unknown'}${e.type === 'hostile' ? ' (hostile)' : ''}`

export type Directive = { text: string, from: string, at: number, inventory: Record<string, number>, goal?: string | null }
export type Encoded = {
  state: Record<string, unknown>
  entities: Array<{ id: string, desc: string }>
  blocks: Array<{ name: string, desc: string }>
}

export const inventoryCounts = (bot: Bot) => {
  const counts: Record<string, number> = {}
  for (const i of bot.inventory.items()) counts[i.name] = (counts[i.name] ?? 0) + i.count
  return counts
}

const countBucket = (n: number) => n === 1 ? 'one' : n <= 5 ? 'a few' : 'many'
const NOTHING = new Set(['air', 'cave_air', 'void_air'])

// Notable blocks: types that are rare in the cube around the bot (≤ rare_max), so terrain drops out
// without a hand-written list. Each with a count bucket and where the nearest one is.
function notableBlocks (bot: Bot, radius: number, rareMax: number, cap: number) {
  const me = bot.entity.position.floored()
  const seen = new Map<string, { n: number, nearest: Vec3, d: number }>()
  const p = new Vec3(0, 0, 0)
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const b = bot.blockAt(p.set(me.x + dx, me.y + dy, me.z + dz))
        if (!b || NOTHING.has(b.name)) continue
        const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
        const s = seen.get(b.name)
        if (!s) seen.set(b.name, { n: 1, nearest: b.position.clone(), d })
        else { s.n++; if (d < s.d) { s.d = d; s.nearest = b.position.clone() } }
      }
    }
  }
  const pos = bot.entity.position
  return [...seen.entries()]
    .filter(([, s]) => s.n <= rareMax)
    .sort((a, b) => a[1].d - b[1].d)
    .slice(0, cap)
    .map(([name, s]) => ({
      name,
      count: countBucket(s.n),
      nearest: `${distanceBucket(s.nearest.offset(0.5, 0, 0.5).distanceTo(pos))}, ${direction(s.nearest.x + 0.5 - pos.x, s.nearest.z + 0.5 - pos.z, bot.entity.yaw)}`
    }))
}

export function makeEgocentric (params: { entity_cap: number, radius: number, block_radius: number, block_cap: number, rare_max: number }) {
  const lastDistance = new Map<number, { d: number, t: number }>()
  return function encode (bot: Bot, ctx: { handles: Handles, directive: Directive | null, channels: Record<string, string>, events: string[] }): Encoded {
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
        what: describeEntity(e),
        where: `${distanceBucket(d)}, ${direction(e.position.x - me.position.x, e.position.z - me.position.z, me.yaw)}`,
        motion: motionBucket(closing),
        ...(held ? { held } : {})
      }
    })
    const blocks = notableBlocks(bot, params.block_radius, params.rare_max, params.block_cap)
    const speaker = ctx.directive && Object.values(bot.entities).find(e => e.username === ctx.directive!.from)
    return {
      state: {
        directive: ctx.directive
          ? { text: ctx.directive.text, from: `player ${ctx.directive.from}${speaker ? ` (${handleFor(ctx.handles, speaker.id)})` : ' (not in view)'}`, ...(ctx.directive.goal ? { goal: ctx.directive.goal } : {}) }
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
      blocks: blocks.map(b => ({ name: b.name, desc: `${b.count}, nearest ${b.nearest}` }))
    }
  }
}

// Compact raw snapshot logged with every decision, so a new encoder can be replayed on old states.
// ponytail: no block cube yet; add a 16³ cube (logged only on change) once an encoder needs terrain.
export function rawSnapshot (bot: Bot, radius = 32) {
  const me = bot.entity
  const r = (v: { x: number, y: number, z: number }) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]
  return {
    self: { pos: r(me.position), yaw: +me.yaw.toFixed(3), health: bot.health, food: bot.food, held: bot.heldItem?.name ?? null },
    entities: Object.values(bot.entities)
      .filter(e => e !== me && e.position.distanceTo(me.position) <= radius)
      .map(e => ({ id: e.id, name: e.name, type: e.type, username: e.username, pos: r(e.position), vel: r(e.velocity) }))
  }
}
