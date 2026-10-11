// Read-only world queries (brain/architecture/perception.md): one block view shared by System 2's perception
// tools, the encoder and raw snapshot, and behaviors System 2 writes. Plain JSON out: absolute
// positions as [x, y, z], heights relative to the block at the bot's feet. Nothing here moves the bot.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import pf from 'mineflayer-pathfinder'
import { glob } from './goals.ts'

export type Pos = [number, number, number]
const NOTHING = new Set(['air', 'cave_air', 'void_air'])
const feet = (bot: Bot) => bot.entity.position.floored()
const tuple = (v: { x: number, y: number, z: number }): Pos => [v.x, v.y, v.z]
const centerDist = (bot: Bot, p: Pos) => +bot.entity.position.distanceTo(new Vec3(p[0] + 0.5, p[1], p[2] + 0.5)).toFixed(1)

export const SCAN_LIMITS = { radius: 32, blocks: 512, clusters: 8, positions: 32 }

// The block name at a position, or null if its chunk isn't loaded.
export function blockAt (bot: Bot, p: Pos): string | null {
  return bot.blockAt(new Vec3(p[0], p[1], p[2]))?.name ?? null
}

// Blocks whose name matches a glob, grouped into 26-connected clusters, nearest cluster first.
// los: only blocks the bot can see (otherwise it sees through walls; fairness is a setting).
export function scan (bot: Bot, q: { match: string, radius?: number, los?: boolean }) {
  const radius = Math.min(Math.max(1, Math.round(q.radius ?? 16)), SCAN_LIMITS.radius)
  const los = q.los ?? false
  const re = glob(q.match)
  const ids = bot.registry.blocksArray.filter(b => re.test(b.name)).map(b => b.id)
  const found = ids.length ? bot.findBlocks({ matching: ids, maxDistance: radius, count: SCAN_LIMITS.blocks }) : []
  const truncated = found.length >= SCAN_LIMITS.blocks
  const blocks = found.map(p => bot.blockAt(p)!).filter(b => b && (!los || bot.canSeeBlock(b)))

  const key = (p: Vec3) => `${p.x},${p.y},${p.z}`
  const left = new Map(blocks.map(b => [key(b.position), b]))
  const me = feet(bot)
  const clusters = []
  for (const b of blocks) {
    if (!left.has(key(b.position))) continue
    left.delete(key(b.position))
    const members = [b]
    for (let i = 0; i < members.length; i++) {
      const p = members[i].position
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const k = `${p.x + dx},${p.y + dy},${p.z + dz}`
        const n = left.get(k)
        if (n) { left.delete(k); members.push(n) }
      }
    }
    const ps = members.map(m => tuple(m.position)).sort((a, c) => centerDist(bot, a) - centerDist(bot, c))
    const names: Record<string, number> = {}
    for (const m of members) names[m.name] = (names[m.name] ?? 0) + 1
    const axis = (i: number, f: (...n: number[]) => number) => f(...ps.map(p => p[i]))
    clusters.push({
      count: members.length,
      names,
      nearest: ps[0],
      dist: centerDist(bot, ps[0]),
      rel: [ps[0][0] - me.x, ps[0][1] - me.y, ps[0][2] - me.z],
      y_rel: [axis(1, Math.min) - me.y, axis(1, Math.max) - me.y],
      min: [axis(0, Math.min), axis(1, Math.min), axis(2, Math.min)],
      max: [axis(0, Math.max), axis(1, Math.max), axis(2, Math.max)],
      positions: ps.slice(0, SCAN_LIMITS.positions)
    })
  }
  clusters.sort((a, c) => a.dist - c.dist)
  return { match: q.match, radius, los, total: blocks.length, truncated, clusters: clusters.slice(0, SCAN_LIMITS.clusters) }
}

// Can the guarded pathfinder get to where the block is within arm's reach (the goal collectblock uses),
// without placing blocks or breaking anything but logs and leaves? Async: A* yields between chunks. It judges
// the world as it is now: a log hidden behind other logs is unreachable until they're gone, though collect
// gets there by digging in order. `timeout`: no path found within the time limit.
export async function reachable (bot: Bot, p: Pos, timeoutMs = 1000) {
  const goal = new pf.goals.GoalLookAtBlock(new Vec3(p[0], p[1], p[2]), bot.world)
  let r: { status: string, cost: number, path: unknown[] } | undefined
  for (const step of bot.pathfinder.getPathFromTo(bot.pathfinder.movements, bot.entity.position, goal, { timeout: timeoutMs })) {
    r = (step as { result: typeof r }).result
    if (r!.status !== 'partial') break
    await new Promise(resolve => setImmediate(resolve))
  }
  return { reachable: r?.status === 'success', status: r?.status ?? 'noPath', ...(r?.status === 'success' ? { steps: r.path.length } : {}) }
}

// Notable blocks: types that are rare in the cube around the bot (≤ rareMax), so terrain drops out without
// a hand-written list. Exact count and positions nearest first. Feeds Jev's summary and the raw snapshot.
// Memoized until the bot moves to another block or any block changes, since one decide reads it twice
// (snapshot + encoder) and watch modules read it every 250 ms.
const changes = new WeakMap<Bot, { n: number }>()
let memo: { key: string, v: Notable[] } | null = null
export type Notable = { name: string, count: number, positions: Pos[] }
export function notableBlocks (bot: Bot, radius = 8, rareMax = 64): Notable[] {
  let c = changes.get(bot)
  if (!c) {
    const counter = c = { n: 0 }
    changes.set(bot, c)
    bot.on?.('blockUpdate', () => { counter.n++ })
  }
  const me = feet(bot)
  const key = `${bot.username}|${me}|${radius}|${rareMax}|${c.n}`
  if (memo?.key === key) return memo.v
  const seen = new Map<string, Pos[]>()
  const p = new Vec3(0, 0, 0)
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const b = bot.blockAt(p.set(me.x + dx, me.y + dy, me.z + dz))
        if (!b || NOTHING.has(b.name)) continue
        const s = seen.get(b.name)
        if (!s) seen.set(b.name, [[p.x, p.y, p.z]])
        else s.push([p.x, p.y, p.z])
      }
    }
  }
  const m1 = (a: Pos) => Math.abs(a[0] - me.x) + Math.abs(a[1] - me.y) + Math.abs(a[2] - me.z)
  const v = [...seen.entries()]
    .filter(([, ps]) => ps.length <= rareMax)
    .map(([name, ps]) => ({ name, count: ps.length, positions: ps.sort((a, c) => m1(a) - m1(c)) }))
    .sort((a, c) => m1(a.positions[0]) - m1(c.positions[0]))
  memo = { key, v }
  return v
}
