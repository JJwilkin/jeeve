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
// Only blocks the bot can see (visible(): a ray to a face), no x-ray (decided 2026-10-12).
export function scan (bot: Bot, q: { match: string, radius?: number }) {
  const radius = Math.min(Math.max(1, Math.round(q.radius ?? 16)), SCAN_LIMITS.radius)
  const re = glob(q.match)
  const ids = bot.registry.blocksArray.filter(b => re.test(b.name)).map(b => b.id)
  const found = ids.length ? bot.findBlocks({ matching: ids, maxDistance: radius, count: SCAN_LIMITS.blocks }) : []
  const truncated = found.length >= SCAN_LIMITS.blocks
  const eyes = eyesOf(bot)
  const blocks = found.map(p => bot.blockAt(p)!).filter(b => b && visible(bot, eyes, b.position))
  return { match: q.match, radius, total: blocks.length, truncated, clusters: clusters(bot, blocks).slice(0, SCAN_LIMITS.clusters) }
}

// 26-connected clusters of blocks, nearest first: exact counts, names, bounds, heights relative to the feet.
function clusters (bot: Bot, blocks: Array<{ name: string, position: Vec3 }>) {
  const key = (p: Vec3) => `${p.x},${p.y},${p.z}`
  const left = new Map(blocks.map(b => [key(b.position), b]))
  const me = feet(bot)
  const out = []
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
    out.push({
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
  return out.sort((a, c) => a.dist - c.dist)
}

// Can the guarded pathfinder get to where the block is within arm's reach (the goal collectblock uses),
// without placing blocks or breaking anything but logs and leaves? Async: A* yields between chunks. It judges
// the world as it is now: a log hidden behind other logs is unreachable until they're gone, though collect
// gets there by digging in order. The search stays inside the box around the bot and the block, padded by
// REACH_PAD: on open ground an unbounded A* never runs out of nodes, so "no" could only ever be `timeout`.
// `noPath`: no path inside that box. `timeout`: the box wasn't exhausted within the time limit.
export const REACH_PAD = 16
export async function reachable (bot: Bot, p: Pos, timeoutMs = 1000) {
  const goal = new pf.goals.GoalLookAtBlock(new Vec3(p[0], p[1], p[2]), bot.world)
  const me = feet(bot)
  const lo = [Math.min(me.x, p[0]), Math.min(me.y, p[1]), Math.min(me.z, p[2])].map(v => v - REACH_PAD)
  const hi = [Math.max(me.x, p[0]), Math.max(me.y, p[1]), Math.max(me.z, p[2])].map(v => v + REACH_PAD)
  // A per-call view of the shared Movements: same rules, neighbors outside the box dropped. Writes (the entity
  // collision index) land on the view, not the shared one.
  const shared = bot.pathfinder.movements
  const moves: typeof shared = Object.create(shared)
  moves.getNeighbors = n => shared.getNeighbors.call(moves, n).filter(m =>
    m.x >= lo[0] && m.x <= hi[0] && m.y >= lo[1] && m.y <= hi[1] && m.z >= lo[2] && m.z <= hi[2])
  let r: { status: string, cost: number, path: unknown[] } | undefined
  for (const step of bot.pathfinder.getPathFromTo(moves, bot.entity.position, goal, { timeout: timeoutMs })) {
    r = (step as { result: typeof r }).result
    if (r!.status !== 'partial') break
    await new Promise(resolve => setImmediate(resolve))
  }
  return { reachable: r?.status === 'success', status: r?.status ?? 'noPath', ...(r?.status === 'success' ? { steps: r.path.length } : {}) }
}

// ---- what the bot has seen: line of sight only, no x-ray (brain/architecture/perception.md → "Seen memory") ----
// observe() runs every 250 ms. Each block within SEEN.radius that has an empty neighbour and that a ray from the
// eyes reaches is remembered with when it was seen; a remembered block whose spot the bot now sees empty, or as
// something else, is updated. Blocks out of sight stay as last seen: what Jeeve believes, not what the server says.
// keepWithin: how far from the bot remembered blocks are kept once the memory is large.
export const SEEN = { radius: 8, far: 24, down: 6, up: 16, common: 512, keepWithin: 96, warnMs: 60 }
type Seen = { name: string, pos: Pos, t: number }
const memories = new WeakMap<Bot, Map<string, Seen>>()
const memory = (bot: Bot) => { let m = memories.get(bot); if (!m) memories.set(bot, m = new Map()); return m }
const empty = (b: { name: string } | null) => !b || NOTHING.has(b.name)

// A block is seen when a ray from the eyes reaches the centre of one of its faces that has an empty neighbour and
// faces the eyes. (bot.canSeeBlock casts one ray at the centre with a range measured to the corner, so blocks below
// eye level or half hidden read as unseen: the bot "saw" 3 of a tree's 27 leaves, 2026-10-12.)
const eyesOf = (bot: Bot) => bot.entity.position.offset(0, (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62, 0)
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
export function visible (bot: Bot, eyes: Vec3, p: Vec3) {
  for (const [x, y, z] of FACES) {
    const face = p.offset(0.5 + x * 0.5, 0.5 + y * 0.5, 0.5 + z * 0.5)
    const d = face.minus(eyes)
    if (d.x * x + d.y * y + d.z * z >= 0) continue // the face looks away from the eyes
    if (!empty(bot.blockAt(p.offset(x, y, z)))) continue // covered by a neighbour
    const range = d.norm()
    const hit = bot.world.raycast(eyes, d.scaled(1 / range), range + 0.05)
    if (hit && (hit as unknown as { position: Vec3 }).position.equals(p)) return true
  }
  return false
}

// near: every block within SEEN.radius, every 250 ms. far (every 2 s): out to SEEN.far horizontally and SEEN.up above
// the feet, skipping types with more than SEEN.common blocks there (ground, air), so a tree across the field is seen
// without walking over to it. A wider look finds what an objective needs; the near one keeps what's close current.
export function observe (bot: Bot, far = false) {
  const t0 = performance.now()
  const mem = memory(bot)
  const me = feet(bot)
  const eyes = eyesOf(bot)
  const r = far ? SEEN.far : SEEN.radius
  const [down, up] = far ? [SEEN.down, SEEN.up] : [SEEN.radius, SEEN.radius]
  const p = new Vec3(0, 0, 0)
  const now = Date.now()
  // An empty spot is seen when a ray from the eyes to its centre hits nothing on the way.
  const seesEmpty = (q: Vec3) => {
    const to = q.offset(0.5, 0.5, 0.5)
    const range = eyes.distanceTo(to)
    return !bot.world.raycast(eyes, to.minus(eyes).normalize(), range - 0.5)
  }
  const each = (f: (name: string | null, key: string) => void) => {
    for (let dx = -r; dx <= r; dx++) for (let dy = -down; dy <= up; dy++) for (let dz = -r; dz <= r; dz++) {
      p.set(me.x + dx, me.y + dy, me.z + dz)
      f(bot.blockAt(p)?.name ?? null, `${p.x},${p.y},${p.z}`)
    }
  }
  const common = new Set<string>()
  if (far) {
    const n = new Map<string, number>()
    each(name => { if (name) n.set(name, (n.get(name) ?? 0) + 1) })
    for (const [name, c] of n) if (c > SEEN.common) common.add(name)
  }
  each((name, key) => {
    if (!name || NOTHING.has(name)) { if (mem.has(key) && seesEmpty(p)) mem.delete(key); return }
    if (common.has(name)) return
    if (visible(bot, eyes, p)) mem.set(key, { name, pos: [p.x, p.y, p.z], t: now })
  })
  if (mem.size > 20_000) for (const [k, v] of mem) if (Math.abs(v.pos[0] - me.x) + Math.abs(v.pos[2] - me.z) > SEEN.keepWithin) mem.delete(k)
  // Coverage: the 16-block cells the far look has swept (its whole box), for System 2 to search where it hasn't looked.
  if (far) {
    let cells = coveredBy.get(bot)
    if (!cells) coveredBy.set(bot, cells = new Set())
    for (let cx = Math.floor((me.x - r) / 16); cx <= Math.floor((me.x + r) / 16); cx++) for (let cz = Math.floor((me.z - r) / 16); cz <= Math.floor((me.z + r) / 16); cz++) {
      // A cell counts once the look's box covers most of it.
      const ox = Math.min(me.x + r, cx * 16 + 15) - Math.max(me.x - r, cx * 16), oz = Math.min(me.z + r, cz * 16 + 15) - Math.max(me.z - r, cz * 16)
      if (ox >= 10 && oz >= 10) cells.add(`${cx * 16 + 8},${cz * 16 + 8}`)
    }
  }
  const ms = performance.now() - t0
  if (ms > SEEN.warnMs) console.warn(`[world] observe${far ? ' (far)' : ''} took ${ms.toFixed(0)} ms`)
}

// Blocks the bot placed itself (scaffolding, a pillar), remembered until the bot sees them gone. A step that clears a
// spot isn't done while its own placed blocks stand there (goals.ts cleared): an oak-only check passed with two
// birch-log pillar blocks left (orchard bench, 2026-10-12).
const placedBy = new WeakMap<Bot, Set<string>>()
export const notePlaced = (bot: Bot, p: Pos) => { let s = placedBy.get(bot); if (!s) placedBy.set(bot, s = new Set()); s.add(p.join(',')) }
// The bot's placed blocks it still believes are there (in the seen memory, which drops a spot once it's seen empty).
export function placedStanding (bot: Bot): Pos[] {
  const mem = memory(bot)
  return [...placedBy.get(bot) ?? []].filter(k => mem.has(k)).map(k => k.split(',').map(Number) as Pos)
}

// Where the bot has looked: centres [x, z] of the 16-block cells its far look has swept. A forage search went west,
// north and south, then said it had covered the east too: every tree it never saw was east (bench, 2026-10-12).
const coveredBy = new WeakMap<Bot, Set<string>>()
export const explored = (bot: Bot) => [...coveredBy.get(bot) ?? []].map(k => k.split(',').map(Number))

// The frontier, for search: in each of 8 compass directions from the bot, the nearest cell not yet looked over that
// borders one that was (frontier-based exploration). Picking unexplored directions from a list of cell centres was
// too hard for 2A: it searched west four times while the trees it never saw were north and south (forage bench).
const DIRS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] // +x is east, +z is south
export function frontier (bot: Bot, within = 128): Array<{ dir: string, at: [number, number], dist: number }> {
  const seen = coveredBy.get(bot) ?? new Set<string>()
  const me = bot.entity.position
  const best = new Map<string, { dir: string, at: [number, number], dist: number }>()
  for (const k of seen) {
    const [x, z] = k.split(',').map(Number)
    for (const [dx, dz] of [[16, 0], [-16, 0], [0, 16], [0, -16], [16, 16], [16, -16], [-16, 16], [-16, -16]]) {
      const nx = x + dx, nz = z + dz
      if (seen.has(`${nx},${nz}`)) continue
      const dist = Math.hypot(nx - me.x, nz - me.z)
      if (dist > within) continue
      const dir = DIRS[(Math.round(Math.atan2(nz - me.z, nx - me.x) / (Math.PI / 4)) + 8) % 8]
      if (!best.has(dir) || dist < best.get(dir)!.dist) best.set(dir, { dir, at: [nx, nz], dist: Math.round(dist) })
    }
  }
  if (!seen.size) for (const [i, dir] of DIRS.entries()) best.set(dir, { dir, at: [Math.round(me.x + Math.cos(i * Math.PI / 4) * 32), Math.round(me.z + Math.sin(i * Math.PI / 4) * 32)], dist: 32 })
  return DIRS.flatMap(d => best.has(d) ? [best.get(d)!] : [])
}

// Remembered blocks within radius of the feet, by type, nearest first.
export function seenTypes (bot: Bot, radius: number): Map<string, Pos[]> {
  const me = feet(bot)
  const out = new Map<string, Pos[]>()
  for (const v of memory(bot).values()) {
    if (Math.max(Math.abs(v.pos[0] - me.x), Math.abs(v.pos[1] - me.y), Math.abs(v.pos[2] - me.z)) > radius) continue
    const list = out.get(v.name)
    if (list) list.push(v.pos); else out.set(v.name, [v.pos])
  }
  const m1 = (a: Pos) => Math.abs(a[0] - me.x) + Math.abs(a[1] - me.y) + Math.abs(a[2] - me.z)
  for (const list of out.values()) list.sort((a, c) => m1(a) - m1(c))
  return out
}

// The map System 2 gets with every call: what the bot has seen within radius, as clusters (a tree is one cluster of
// logs and leaves), ground left out. Positions are dropped; bounds, counts and heights stay.
// Ground is told by shape, not by name or count: a type with most of its blocks on one height level over a wide
// area (a floor of grass, sand or stone). A count cutoff alone kept the partly seen grass floor of the orchard, and
// it swallowed every tree that touched it.
// radius 64: a map of 32 around the bot dropped a tree it had walked past by the next 2A call (forage bench).
export const MAP_LIMITS = { radius: 64, common: 2048, clusters: 20, groundMin: 48, groundShare: 0.8 }
const isGround = (ps: Pos[]) => {
  if (ps.length < MAP_LIMITS.groundMin) return false
  const byY = new Map<number, number>()
  for (const p of ps) byY.set(p[1], (byY.get(p[1]) ?? 0) + 1)
  return Math.max(...byY.values()) / ps.length >= MAP_LIMITS.groundShare
}
export function seenMap (bot: Bot, radius = MAP_LIMITS.radius) {
  const blocks = [...seenTypes(bot, radius).entries()].filter(([, ps]) => ps.length <= MAP_LIMITS.common && !isGround(ps))
    .flatMap(([name, ps]) => ps.map(p => ({ name, position: new Vec3(p[0], p[1], p[2]) })))
  return clusters(bot, blocks).slice(0, MAP_LIMITS.clusters).map(({ positions: _, ...c }) => c)
}

// Notable blocks: remembered types that are rare in the cube around the bot (≤ rareMax), so terrain drops out
// without a hand-written list. Exact count and positions nearest first. Feeds Jev's summary and the raw snapshot.
export type Notable = { name: string, count: number, positions: Pos[] }
export function notableBlocks (bot: Bot, radius = 8, rareMax = 64): Notable[] {
  const m1 = (a: Pos) => { const me = feet(bot); return Math.abs(a[0] - me.x) + Math.abs(a[1] - me.y) + Math.abs(a[2] - me.z) }
  return [...seenTypes(bot, radius).entries()]
    .filter(([, ps]) => ps.length <= rareMax)
    .map(([name, ps]) => ({ name, count: ps.length, positions: ps }))
    .sort((a, c) => m1(a.positions[0]) - m1(c.positions[0]))
}
