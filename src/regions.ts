// Region graph and height map for System 2A (brain/architecture/region-graph.md). Code splits what the bot has seen
// into regions it can walk around in, joined by typed links with rough costs, using the guards' rules (unsafeAt,
// MAX_DROP), so 2A plans routes over conclusions and the map can't promise a move a guard would veto.
import type { Bot } from 'mineflayer'
import { MAX_DROP, unsafeAt } from './guards.ts'
import { compass, LIQUIDS, seenGrid, type Pos } from './world.ts'

// radius: how far around the bot the graph reaches. bridgeMax: the widest gap a bridge link spans. regions/links: how
// many lines 2A's brief shows (~1,800 characters at most). mapRadius: the widest height map terrain returns (33×33).
export const REGION_LIMITS = { radius: 40, down: 16, up: 16, bridgeMax: 8, minCells: 4, regions: 10, links: 16, mapRadius: 16 }

export type Seen = Map<string, string> // "x,y,z" → a block the bot has seen; absent is air, or not seen
export type Region = { id: string, name: string, kind: 'land' | 'water', here: boolean, cells: number, y: [number, number], x: [number, number], z: [number, number], at: Pos, width: number, has: Record<string, number> }
export type Link = { from: string, to: string, type: 'drop' | 'climb' | 'swim' | 'bridge' | 'unseen', n: number, cost: number, at: Pos, dir?: string }
type Cell = { x: number, y: number, z: number, water: boolean, region: number }

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const WORDS: Record<string, string> = { E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west', N: 'north', NE: 'north-east' }
const AIR = { name: 'air', boundingBox: 'empty' }
// Rough seconds: walking is ~4 blocks/s; placing a block (bridge, pillar) or getting in or out of water ~2 s.
const COST = { drop: () => 1, climb: (n: number) => 2 * n, swim: () => 2, bridge: (n: number) => 2 * n, unseen: () => 0 }

// Cells are where feet can be: on top of a solid block with two free blocks above (land), or on a water surface.
// A region is a set of cells connected by steps of at most one block up or down, so walking inside one is free of
// links; anything else between regions is a link.
export function regionGraph (seen: Seen, me: Pos, solid: (name: string) => boolean, radius = REGION_LIMITS.radius) {
  const at = (x: number, y: number, z: number) => seen.get(`${x},${y},${z}`)
  const isSolid = (x: number, y: number, z: number) => { const n = at(x, y, z); return !!n && solid(n) }
  const columns = new Map<string, Cell[]>()
  const lowest = new Map<string, number>() // the lowest seen block per column: above it, an unremembered spot is air
  for (const [k, n] of seen) {
    const [x, y, z] = k.split(',').map(Number)
    const col = `${x},${z}`
    lowest.set(col, Math.min(lowest.get(col) ?? y, y))
    const above = at(x, y + 1, z)
    const cell = n === 'water' ? (above !== 'water' && !isSolid(x, y + 1, z) ? { x, y, z, water: true, region: -1 } : null)
      : solid(n) && !isSolid(x, y + 1, z) && !isSolid(x, y + 2, z) && !LIQUIDS.has(above ?? '') ? { x, y: y + 1, z, water: false, region: -1 } : null
    if (cell) columns.set(col, [...columns.get(col) ?? [], cell])
  }
  // The guards' rule over what was seen: an unseen column reads as void, so it's never safe to drop into.
  const blockAt = (x: number, y: number, z: number) => {
    const n = at(x, y, z)
    if (n) return { name: n, boundingBox: solid(n) ? 'block' : 'empty' }
    return (lowest.get(`${x},${z}`) ?? Infinity) < y ? AIR : null
  }
  const beside = (c: Cell) => SIDES.flatMap(([dx, dz]) => columns.get(`${c.x + dx},${c.z + dz}`) ?? [])

  // Flood fill.
  const groups: Cell[][] = []
  for (const c of [...columns.values()].flat()) {
    if (c.region >= 0) continue
    c.region = groups.length
    const g = [c]
    for (let i = 0; i < g.length; i++) {
      for (const d of beside(g[i])) if (d.region < 0 && d.water === g[i].water && Math.abs(d.y - g[i].y) <= 1) { d.region = c.region; g.push(d) }
    }
    groups.push(g)
  }

  // Links: per region pair and type, the cheapest crossing, nearest the bot on a tie.
  const links = new Map<string, Link & { a: number, b: number }>()
  const dist = (p: Pos) => Math.hypot(p[0] - me[0], p[2] - me[2])
  const add = (a: number, b: number, type: Link['type'], n: number, c: Cell, dir?: string) => {
    const k = `${a}>${b}>${type}`
    const l = { a, b, from: '', to: '', type, n, cost: COST[type](n), at: [c.x, c.y, c.z] as Pos, dir }
    const old = links.get(k)
    if (!old || l.cost < old.cost || (l.cost === old.cost && dist(l.at) < dist(old.at))) links.set(k, l)
  }
  for (const c of [...columns.values()].flat()) {
    for (const d of beside(c)) {
      if (d.region === c.region) continue
      const dy = d.y - c.y
      // Off an edge, the guards allow what unsafeAt allows from the spot beside it at the same height.
      const offEdge = !unsafeAt(blockAt, d.x, c.y, d.z)
      if (c.water) { if (d.water || dy <= 1) add(c.region, d.region, 'swim', 0, c); else add(c.region, d.region, 'climb', dy, c) }
      else if (d.water) { if (offEdge && dy >= -MAX_DROP - 1) add(c.region, d.region, 'swim', 0, c) } // deeper: no way in
      else if (dy >= 2) add(c.region, d.region, 'climb', dy, c)
      else if (offEdge && dy >= -MAX_DROP) add(c.region, d.region, 'drop', -dy, c) // a longer drop is no link: the guards veto it
    }
    if (!c.water) {
      for (const [dx, dz] of SIDES) {
        // Bridge: straight across a gap (water, lava, a drop) to another land region at about the same height.
        for (let k = 1; k <= REGION_LIMITS.bridgeMax + 1; k++) {
          const x = c.x + dx * k, z = c.z + dz * k
          if (isSolid(x, c.y, z) || isSolid(x, c.y + 1, z)) break // a wall, not a gap
          const land = (columns.get(`${x},${z}`) ?? []).find(e => !e.water && Math.abs(e.y - c.y) <= 1)
          if (land) { if (land.region !== c.region) add(c.region, land.region, 'bridge', k - 1, c); break }
        }
        // Unseen: the next column holds nothing the bot has seen.
        const x = c.x + dx, z = c.z + dz
        if (!lowest.has(`${x},${z}`) && Math.max(Math.abs(x - me[0]), Math.abs(z - me[2])) <= radius) add(c.region, -1, 'unseen', 0, c, compass(x - me[0], z - me[2]))
      }
    }
  }

  // Regions: the bot's own first, then nearest first, small ones (a tree stump's top) last.
  const centre = (g: Cell[]) => { const mx = g.reduce((s, c) => s + c.x, 0) / g.length, mz = g.reduce((s, c) => s + c.z, 0) / g.length; return g.reduce((b, c) => Math.hypot(c.x - mx, c.z - mz) < Math.hypot(b.x - mx, b.z - mz) ? c : b) }
  const hereCell = (columns.get(`${me[0]},${me[2]}`) ?? []).filter(c => Math.abs(c.y - me[1]) <= 1).sort((a, b) => Math.abs(a.y - me[1]) - Math.abs(b.y - me[1]))[0]
  const order = groups.map((g, i) => ({ g, i, c: centre(g) }))
    .sort((a, b) => Number(b.i === hereCell?.region) - Number(a.i === hereCell?.region) ||
      Number(b.g.length >= REGION_LIMITS.minCells) - Number(a.g.length >= REGION_LIMITS.minCells) || dist([a.c.x, a.c.y, a.c.z]) - dist([b.c.x, b.c.y, b.c.z]))
  const ids = new Map(order.map((o, n) => [o.i, `R${n + 1}`]))
  // Terrain: block types many cells stand on (grass, stone, sand). Left out of what a region has.
  const floors = new Map<string, number>()
  for (const c of [...columns.values()].flat()) { const n = at(c.x, c.y - 1, c.z); if (n) floors.set(n, (floors.get(n) ?? 0) + 1) }
  const regions: Region[] = order.map(({ g, i, c }) => {
    const ax = (f: (c: Cell) => number) => [Math.min(...g.map(f)), Math.max(...g.map(f))] as [number, number]
    const x = ax(c => c.x), z = ax(c => c.z)
    // What's there: blocks beside or above its cells up to head height and a bit, not its floor or terrain.
    const has: Record<string, number> = {}
    const counted = new Set<string>()
    for (const e of g) {
      for (const [dx, dz] of [[0, 0], ...SIDES]) {
        for (let y = e.y - 1; y <= e.y + 3; y++) {
          const n = at(e.x + dx, y, e.z + dz)
          const k = `${e.x + dx},${y},${e.z + dz}`
          if (!n || n === 'water' || (floors.get(n) ?? 0) >= 16 || counted.has(k) || (y < e.y && n !== 'lava')) continue
          counted.add(k)
          has[n] = (has[n] ?? 0) + 1
        }
      }
    }
    return { id: ids.get(i)!, name: '', kind: c.water ? 'water' : 'land', here: i === hereCell?.region, cells: g.length, y: ax(c => c.y - me[1]), x, z, at: [c.x, c.y, c.z], width: Math.round(g.length / Math.max(x[1] - x[0] + 1, z[1] - z[0] + 1)), has }
  })
  const out = [...links.values()].map(l => ({ ...l, from: ids.get(l.a)!, to: l.b < 0 ? 'unseen' : ids.get(l.b)! }))
  name(regions, out, groups, order.map(o => o.i), seen, solid, me)
  return { regions, links: out.map(({ a: _a, b: _b, ...l }) => l) as Link[] }
}

// Plain-word names where code can tell: river, pond or lake by shape; bank beside water; ravine floor or low ground
// 4+ below the bot; high ground 4+ above; treetops on leaves; shelter under a roof (a hut). A compass word from the
// bot tells apart the rest ("west bank"); the bot's own region has none.
function name (regions: Region[], links: Link[], groups: Cell[][], index: number[], seen: Seen, solid: (n: string) => boolean, me: Pos) {
  const taken = new Set<string>()
  regions.forEach((r, n) => {
    const g = groups[index[n]]
    const share = (f: (c: Cell) => boolean) => g.filter(f).length / g.length
    const longest = Math.max(r.x[1] - r.x[0], r.z[1] - r.z[0]) + 1
    const nearWater = links.some(l => l.from === r.id && l.type === 'swim' && regions.find(o => o.id === l.to)?.kind === 'water')
    const roofed = (c: Cell) => [2, 3, 4, 5].some(dy => { const b = seen.get(`${c.x},${c.y + dy},${c.z}`); return !!b && solid(b) && !b.endsWith('_leaves') })
    const noun = r.kind === 'water' ? (longest >= 3 * r.width ? 'river' : r.cells <= 30 ? 'pond' : 'lake')
      : share(c => !!seen.get(`${c.x},${c.y - 1},${c.z}`)?.endsWith('_leaves')) > 0.5 ? 'treetops'
        : share(roofed) > 0.5 ? 'shelter'
          : r.y[1] <= -4 ? (Math.min(r.x[1] - r.x[0], r.z[1] - r.z[0]) < 8 ? 'ravine floor' : 'low ground')
            : r.y[0] >= 4 ? 'high ground'
              : nearWater ? 'bank' : 'ground'
    let base = r.here || r.kind === 'water' ? noun : `${WORDS[compass(r.at[0] - me[0], r.at[2] - me[2])]} ${noun}`
    if (r.kind === 'water' && taken.has(base)) base = `${WORDS[compass(r.at[0] - me[0], r.at[2] - me[2])]} ${noun}`
    let nm = base
    for (let i = 2; taken.has(nm); i++) nm = `${base} ${i}`
    taken.add(nm)
    r.name = nm
  })
}

const sign = (n: number) => n > 0 ? `+${n}` : `${n}`
const span = ([a, b]: [number, number]) => a === b ? sign(a) : `${sign(a)}..${sign(b)}`

// The collapsed graph as text lines for 2A's brief: the bot's region, then the nearest regions of at least minCells, and
// the links among them, the bot's own first. Within REGION_LIMITS (~1,800 characters).
export function describeGraph (g: { regions: Region[], links: Link[] }) {
  const shown = g.regions.filter(r => r.here || r.cells >= REGION_LIMITS.minCells).slice(0, REGION_LIMITS.regions)
  const ids = new Set(shown.map(r => r.id))
  const here = g.regions.find(r => r.here)?.id
  const lines = shown.map(r => {
    const has = Object.entries(r.has).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} ${c}`).join(', ')
    return `${r.id} ${r.name}${r.here ? ' (you are here)' : ''}: ${r.kind === 'water' ? `water ~${r.width} wide, ` : ''}${r.cells} blocks, y ${span(r.y)}, x ${r.x[0]}..${r.x[1]} z ${r.z[0]}..${r.z[1]}, at [${r.at}]${has ? `, has ${has}` : ''}`
  })
  const label = (l: Link) => l.type === 'drop' ? `drop ${l.n}` : l.type === 'climb' ? `climb ${l.n} (pillar ${l.n} blocks)` : l.type === 'bridge' ? `bridge ${l.n} (${l.n} blocks)` : l.type
  const links = g.links.filter(l => ids.has(l.from) && (l.to === 'unseen' || ids.has(l.to)))
    .sort((a, b) => Number(b.from === here || b.to === here) - Number(a.from === here || a.to === here) ||
      Number(a.type === 'unseen') - Number(b.type === 'unseen') || a.cost - b.cost)
  const done = new Set<Link>()
  for (const l of links) {
    if (done.has(l)) continue
    done.add(l)
    // Swim and bridge links that go both ways print once.
    const back = l.type === 'swim' || l.type === 'bridge' ? links.find(o => !done.has(o) && o.from === l.to && o.to === l.from && o.type === l.type && o.n === l.n) : undefined
    if (back) done.add(back)
    lines.push(l.type === 'unseen' ? `${l.from}→unseen to the ${l.dir} at [${l.at}]` : `${l.from}${back ? '↔' : '→'}${l.to} ${label(l)} ~${l.cost}s at [${l.at}]`)
    if (lines.length >= shown.length + REGION_LIMITS.links) break
  }
  return lines
}

// A height map as text rows around a point: per column, the ground height relative to the bot's feet (the top seen
// block you could stand on or swim in; leaves only where nothing else is seen), north up. One row per z.
export function heightMap (seen: Seen, center: Pos, me: Pos, solid: (name: string) => boolean, radius = 10) {
  const r = Math.min(Math.max(2, Math.round(radius)), REGION_LIMITS.mapRadius)
  const top = new Map<string, { y: number, name: string, leaf: boolean }>()
  for (const [k, n] of seen) {
    const [x, y, z] = k.split(',').map(Number)
    if (Math.abs(x - center[0]) > r || Math.abs(z - center[2]) > r || !(solid(n) || LIQUIDS.has(n))) continue
    const leaf = n.endsWith('_leaves')
    const t = top.get(`${x},${z}`)
    if (!t || (t.leaf && !leaf) || (t.leaf === leaf && y > t.y)) top.set(`${x},${z}`, { y, name: n, leaf })
  }
  const h = (x: number, z: number) => { const t = top.get(`${x},${z}`); return t && t.y + 1 - me[1] }
  const xs = Array.from({ length: 2 * r + 1 }, (_, i) => center[0] - r + i)
  const rows = [
    `height map around [${center}], offsets from it, north up, east right. Ground height relative to your feet (y=${me[1]}), ±9 means 9 or more. ~ water, L lava, ? not seen, @ you, v more than ${MAX_DROP} below a neighbour (the guards won't drop there).`,
    '    ' + xs.map(x => (x - center[0]) % 5 ? '   ' : sign(x - center[0]).padStart(3)).join('')
  ]
  for (let z = center[2] - r; z <= center[2] + r; z++) {
    rows.push(sign(z - center[2]).padStart(3) + ' ' + xs.map(x => {
      const t = top.get(`${x},${z}`)
      if (x === me[0] && z === me[2]) return ' @ '
      if (!t) return ' ? '
      if (LIQUIDS.has(t.name)) return t.name === 'water' ? ' ~ ' : ' L '
      const v = h(x, z)!
      const drop = SIDES.some(([dx, dz]) => (h(x + dx, z + dz) ?? -Infinity) - v > MAX_DROP)
      return sign(Math.max(-9, Math.min(9, v))).padStart(2) + (drop ? 'v' : ' ')
    }).join(''))
  }
  return rows
}

// ---- on the bot: over its seen memory (src/world.ts seenGrid) ----
const solidOf = (bot: Bot) => (n: string) => bot.registry.blocksByName[n]?.boundingBox === 'block'
const feetOf = (bot: Bot): Pos => { const p = bot.entity.position.floored(); return [p.x, p.y, p.z] }
const R = REGION_LIMITS

export function regionsNear (bot: Bot) {
  const me = feetOf(bot)
  return regionGraph(seenGrid(bot, me, R.radius, R.down, R.up), me, solidOf(bot))
}

// 2A's terrain tool: the height map around a point, or over a region of the graph (by id or name).
export function terrain (bot: Bot, q: { at?: Pos | null, region?: string | null, radius?: number | null }) {
  const me = feetOf(bot)
  let center = q.at ?? me
  let radius = q.radius ?? 10
  if (q.region) {
    const r = regionsNear(bot).regions.find(r => r.id === q.region || r.name === q.region)
    if (!r) return { error: `no region ${q.region} in the graph now; give a point (at) instead` }
    center = r.at
    radius = q.radius ?? Math.ceil(Math.max(r.x[1] - r.x[0], r.z[1] - r.z[0]) / 2) + 2
  }
  radius = Math.min(Math.max(2, radius), R.mapRadius)
  return { map: heightMap(seenGrid(bot, center, radius, R.down, R.up), center, me, solidOf(bot), radius) }
}
