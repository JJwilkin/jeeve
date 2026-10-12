// The recorded world (clips/<dir>/world.jsonl, written by scripts/clip.ts): the view box's blocks once, each change
// in it, and the entities near it ten times a second. worldAt(t) rebuilds what a camera would show at time t, without
// a Minecraft client. Pure, so the monitor and Remotion share it.

export type WorldRow =
  | { t: number, kind: 'blocks', min: number[], max: number[], palette: string[], cells: number[], camera: { at: number[], facing: number[] } }
  | { t: number, kind: 'block', pos: number[], name: string }
  | { t: number, kind: 'entities', list: Entity[] }
export type Entity = { id: number, name: string, username?: string, pos: number[], yaw: number, pitch: number }
export type Block = { name: string, pos: [number, number, number] }

export const parseWorld = (text: string): WorldRow[] => text.split('\n').filter(Boolean).map(l => JSON.parse(l))

const AIR = new Set(['air', 'cave_air', 'void_air'])

// A replayer: blocks at time t (only those with an empty neighbour, the ones a camera can see) and entities
// interpolated between the two frames around t. Moving forward applies changes incrementally; going back rebuilds.
export function makeWorld (rows: WorldRow[]) {
  const base = rows.find(r => r.kind === 'blocks') as Extract<WorldRow, { kind: 'blocks' }> | undefined
  const changes = rows.filter(r => r.kind === 'block') as Array<Extract<WorldRow, { kind: 'block' }>>
  const frames = rows.filter(r => r.kind === 'entities') as Array<Extract<WorldRow, { kind: 'entities' }>>
  if (!base) return null
  const [x0, y0, z0] = base.min
  const [nx, ny, nz] = [base.max[0] - x0 + 1, base.max[1] - y0 + 1, base.max[2] - z0 + 1]
  const index = (x: number, y: number, z: number) => ((x - x0) * ny + (y - y0)) * nz + (z - z0)
  const inBox = (x: number, y: number, z: number) => x >= x0 && y >= y0 && z >= z0 && x < x0 + nx && y < y0 + ny && z < z0 + nz
  const palette = [...base.palette]
  let grid = Int32Array.from(base.cells)
  let applied = 0
  let cache: { applied: number, blocks: Block[] } | null = null

  const code = (name: string) => { let k = palette.indexOf(name); if (k < 0) k = palette.push(name) - 1; return k }
  const empty = (x: number, y: number, z: number) => !inBox(x, y, z) || AIR.has(palette[grid[index(x, y, z)]])

  function blocksAt (t: number): Block[] {
    let n = changes.findIndex(c => c.t > t)
    if (n < 0) n = changes.length
    if (n < applied) { grid = Int32Array.from(base!.cells); applied = 0 }
    for (; applied < n; applied++) {
      const c = changes[applied]
      if (inBox(c.pos[0], c.pos[1], c.pos[2])) grid[index(c.pos[0], c.pos[1], c.pos[2])] = code(c.name)
    }
    if (cache?.applied === applied) return cache.blocks
    const out: Block[] = []
    for (let x = x0; x < x0 + nx; x++) for (let y = y0; y < y0 + ny; y++) for (let z = z0; z < z0 + nz; z++) {
      const name = palette[grid[index(x, y, z)]]
      if (AIR.has(name)) continue
      if (empty(x + 1, y, z) || empty(x - 1, y, z) || empty(x, y + 1, z) || empty(x, y - 1, z) || empty(x, y, z + 1) || empty(x, y, z - 1)) out.push({ name, pos: [x, y, z] })
    }
    cache = { applied, blocks: out }
    return out
  }

  function entitiesAt (t: number): Entity[] {
    let i = frames.findIndex(f => f.t > t)
    if (i === 0) return frames[0]?.list ?? []
    if (i < 0) return frames.at(-1)?.list ?? []
    const a = frames[i - 1], b = frames[i]
    const k = (t - a.t) / Math.max(1, b.t - a.t)
    return a.list.map(e => {
      const n = b.list.find(m => m.id === e.id)
      return n ? { ...e, pos: e.pos.map((v, j) => v + (n.pos[j] - v) * k), yaw: e.yaw + (n.yaw - e.yaw) * k } : e
    })
  }

  return { camera: base.camera, blocksAt, entitiesAt, start: base.t }
}

// Block colours: a flat look, no textures. Unknown names get a stable grey.
export const COLORS: Record<string, string> = {
  grass_block: '#5d9b3c', dirt: '#7b5634', oak_log: '#6e5233', oak_leaves: '#3d7a2c', oak_planks: '#b48c55',
  crafting_table: '#8a5a2e', chest: '#a87631', stone: '#8a8a8a', cobblestone: '#7a7a7a', bedrock: '#3a3a3a', pumpkin: '#d98a22'
}
export const colorFor = (name: string) => COLORS[name] ?? COLORS[name.replace(/^\w+?_/, 'oak_')] ?? '#9a9a9a'
