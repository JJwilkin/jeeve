// The default `egocentric` encoder: raw Mineflayer state → Jev's `state` (brain/architecture/system-1.md).
// Distances, directions and motion are named buckets computed here, because Jev is weak with numbers.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'

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

export type Directive = { text: string, from: string, at: number }
export type Encoded = { state: Record<string, unknown>, entities: Array<{ id: string, desc: string }> }

export function makeEgocentric (params: { entity_cap: number, radius: number }) {
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
    const speaker = ctx.directive && Object.values(bot.entities).find(e => e.username === ctx.directive!.from)
    return {
      state: {
        directive: ctx.directive
          ? { text: ctx.directive.text, from: `player ${ctx.directive.from}${speaker ? ` (${handleFor(ctx.handles, speaker.id)})` : ' (not in view)'}` }
          : 'none yet: stay safe and wait',
        self: { health: healthBucket(bot.health), food: healthBucket(bot.food), held: bot.heldItem?.name ?? 'empty hand' },
        channels: ctx.channels,
        entities,
        recent_events: ctx.events
      },
      entities: entities.map(e => ({ id: e.id, desc: `${e.what}, ${e.where}` }))
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
