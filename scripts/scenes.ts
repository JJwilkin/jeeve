// Scenes the e2e and the clips share (scripts/e2e.ts, scripts/clip.ts), set up through server commands.
type Command = (cmd: string) => void

// A tree whose canopy is out of reach from the ground (eyes at -58.4, lowest leaf centre at -53.5): 6 logs, 27
// persistent leaves (as player-placed leaves are, so none decay instead of being broken). Jeeve 3 blocks west.
export const CANOPY = { x: 30, z: -12, instruction: "break that whole tree, leaves included. The leaves won't decay on their own" }
export function canopy (command: Command, instructor = 'Josh') {
  const { x, z } = CANOPY
  command(`fill ${x - 6} -60 ${z - 6} ${x + 6} -45 ${z + 6} air`) // the world persists between runs
  command('fill 4 -60 6 20 -50 20 air') // logs "collect 10 logs" left, and older runs' oaks: collect would walk off to them
  tree(command, x, z)
  command(`tp Jeeve ${x - 3} -60 ${z}`)
  command(`tp ${instructor} ${x - 6} -60 ${z + 4}`)
}

const tree = (command: Command, x: number, z: number) => {
  command(`fill ${x} -60 ${z} ${x} -55 ${z} oak_log`)
  command(`fill ${x - 1} -54 ${z - 1} ${x + 1} -52 ${z + 1} oak_leaves[persistent=true]`)
}

// ---- randomized scenes for the bench (brain/architecture/bench-hill-climb.md) ----
// Layouts vary per run from a seed (recorded with the results), so a skill or a plan has to generalize instead of
// fitting one layout. Everything stays inside AREA on the superflat ground (top at y = -61).
type Xyz = [number, number, number]
export const AREA = { min: [18, -61, -26] as Xyz, max: [56, -36, 2] as Xyz }
// mulberry32: a small seeded PRNG.
export function rng (seed: number) {
  let a = seed >>> 0
  return () => { a = a + 0x6D2B79F5 >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}
const pick = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]
const between = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))

// canopy: leaves above reach (a 3×3×3 crown on top of the trunk); otherwise one low layer of leaves.
export type Tree = { x: number, z: number, wood: 'oak' | 'birch', trunk: number, canopy: boolean }
export type Scene = {
  trees: Tree[], chest: Xyz | null, jeeve: Xyz, josh: Xyz, instructions: string[], waves: number, item?: string,
  fills?: string[], kit?: string[], goal?: Xyz, crossing?: Crossing // crossing scenes: terrain, Jeeve's kit, the block to reach
}

function placeTrees (r: () => number, n: number, o: { canopy: boolean, trunk: [number, number], near?: Xyz, within?: number }): Tree[] {
  const trees: Tree[] = []
  for (let tries = 0; trees.length < n && tries < 500; tries++) {
    const x = o.near ? o.near[0] + between(r, -o.within!, o.within!) : between(r, AREA.min[0] + 4, AREA.max[0] - 4)
    const z = o.near ? o.near[2] + between(r, -o.within!, o.within!) : between(r, AREA.min[2] + 4, AREA.max[2] - 4)
    if (trees.some(t => Math.max(Math.abs(t.x - x), Math.abs(t.z - z)) < 5)) continue
    if (o.near && Math.max(Math.abs(o.near[0] - x), Math.abs(o.near[2] - z)) < 3) continue
    trees.push({ x, z, wood: pick(r, ['oak', 'birch'] as const), trunk: between(r, o.trunk[0], o.trunk[1]), canopy: o.canopy })
  }
  return trees
}

export function orchardScene (seed: number): Scene {
  const r = rng(seed)
  const trees = placeTrees(r, between(r, 3, 5), { canopy: true, trunk: [5, 7] })
  const first = trees[0]
  return {
    trees, chest: null, waves: 0,
    jeeve: [first.x - 3, -60, first.z], josh: [first.x - 2, -60, first.z + 4],
    instructions: [
      "break the tree closest to you, leaves included. The leaves won't decay on their own",
      `now break the other ${trees.length - 1} trees the same way, leaves included`
    ]
  }
}

export function workshopScene (seed: number): Scene {
  const r = rng(seed)
  const jeeve: Xyz = [between(r, 28, 46), -60, between(r, -18, -6)]
  const trees = placeTrees(r, between(r, 2, 3), { canopy: false, trunk: [3, 4], near: jeeve, within: 8 })
  const chest: Xyz = [jeeve[0] + pick(r, [-5, -4, 4, 5]), -60, jeeve[2] + pick(r, [-4, 3, 4])]
  // A different tool each run, so a skill has to be general (craft what's asked), not one per item.
  const item = pick(r, ['wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel'])
  return { trees, chest, waves: 0, item, jeeve, josh: [jeeve[0] - 3, -60, jeeve[2] + 3], instructions: [`make a ${item.replace('_', ' ')} and put it in the chest`] }
}

export function guardScene (seed: number): Scene {
  const r = rng(seed)
  return { trees: [], chest: null, waves: between(r, 3, 5), jeeve: [30, -60, -10], josh: [32, -60, -10], instructions: ['follow me and keep me safe'] }
}

// Forage: small trees scattered 40–60 blocks from the start, beyond the far look (24 out, about 34 on a diagonal):
// nothing is in sight, so the task is search. Its own, wider area around the origin.
export const FORAGE_AREA = { min: [-66, -61, -66] as Xyz, max: [66, -50, 66] as Xyz }
export function forageScene (seed: number): Scene {
  const r = rng(seed)
  const trees: Tree[] = []
  for (let tries = 0; trees.length < between(r, 6, 8) && tries < 500; tries++) {
    const a = r() * Math.PI * 2, d = 40 + r() * 20
    const x = Math.round(Math.cos(a) * d), z = Math.round(Math.sin(a) * d)
    if (trees.some(t => Math.max(Math.abs(t.x - x), Math.abs(t.z - z)) < 6)) continue
    trees.push({ x, z, wood: pick(r, ['oak', 'birch'] as const), trunk: between(r, 4, 5), canopy: false })
  }
  return { trees, chest: null, waves: 0, jeeve: [0, -60, 0], josh: [2, -60, 2], instructions: ['get me 16 logs'] }
}

// Crossing: a river, a ravine or a ledge between Jeeve and a gold block set in the far side's surface; "go to" it.
// Terrain is built up from the superflat (never dug into it, so other scenes on the same world find it flat), and
// barrier walls on AREA's edge keep the crossing inside. way: there's a way round (a dry strip past one end of the
// river, stairs down and up the ravine, stairs up the ledge); without one, Jeeve gets blocks to bridge or pillar.
export type Crossing = {
  kind: 'river' | 'ravine' | 'ledge', way: boolean, size: string, kit: string[],
  width?: number, depth?: number, bank?: number, drop?: number, height?: number
}
const [X0, Z0, X1, Z1] = [AREA.min[0] + 1, AREA.min[2] + 1, AREA.max[0] - 1, AREA.max[2] - 1] // inside the walls
const surface = (h: number) => -61 + h // y of the top block, with land h above the superflat
const walls = () => {
  const [x0, , z0] = AREA.min, [x1, y1, z1] = AREA.max
  return [`${x0} -60 ${z0} ${x1} ${y1} ${z0}`, `${x0} -60 ${z1} ${x1} ${y1} ${z1}`, `${x0} -60 ${z0} ${x0} ${y1} ${z1}`, `${x1} -60 ${z0} ${x1} ${y1} ${z1}`].map(b => `fill ${b} barrier`)
}

export function crossingScene (kind: Crossing['kind'], way: boolean, seed: number): Scene {
  const r = rng(seed)
  const edge = between(r, 28, 32) // x where the obstacle starts; Jeeve is west of it, the goal east
  const [jx, jz] = [edge - between(r, 3, 5), between(r, -18, -6)]
  const fills = walls()
  const stairs = (steps: number) => between(r, Z0, Z1 - steps + 1) // z of a staircase's first step, running +z
  let near: number, far: number, beyond: number, crossing: Omit<Crossing, 'kind' | 'way' | 'kit'>
  if (kind === 'river') {
    const width = between(r, 1, 8), depth = between(r, 1, 6), bank = between(r, 0, 5)
    near = far = depth + bank
    beyond = edge + width
    // The channel runs wall to wall, or stops 2 short of one wall: the way round.
    const [z0, z1] = !way ? [Z0, Z1] : r() < 0.5 ? [Z0 + 2, Z1] : [Z0, Z1 - 2]
    fills.push(`fill ${X0} -60 ${Z0} ${X1} ${surface(near)} ${Z1} stone`, `fill ${edge} -60 ${z0} ${beyond - 1} ${surface(near)} ${z1} air`,
      `fill ${edge} -60 ${z0} ${beyond - 1} ${surface(depth)} ${z1} water`)
    crossing = { size: width <= 3 ? 'narrow' : 'wide', width, depth, bank }
  } else if (kind === 'ravine') {
    const width = between(r, 2, 6), drop = between(r, 4, 12)
    near = far = drop
    beyond = edge + width
    fills.push(`fill ${X0} -60 ${Z0} ${edge - 1} ${surface(drop)} ${Z1} stone`, `fill ${beyond} -60 ${Z0} ${X1} ${surface(drop)} ${Z1} stone`)
    // The gentle way: stairs cut into both walls, down the near one and up the far one, meeting at the floor.
    if (way) {
      const z = stairs(drop)
      for (let i = 0; i < drop; i++) for (const x of [edge - 1, beyond]) fills.push(`fill ${x} ${surface(drop - i)} ${z + i} ${x} ${surface(drop)} ${z + i} air`)
    }
    crossing = { size: drop <= 7 ? 'shallow' : 'deep', width, drop }
  } else {
    const height = between(r, 2, 6)
    near = 0
    far = height
    beyond = edge
    fills.push(`fill ${edge} -60 ${Z0} ${X1} ${surface(height)} ${Z1} stone`)
    if (way) {
      const z = stairs(height)
      for (let i = 0; i < height; i++) fills.push(`fill ${edge - 1} -60 ${z + i} ${edge - 1} ${surface(i + 1)} ${z + i} stone`)
    }
    crossing = { size: height <= 3 ? 'low' : 'high', height }
  }
  const goal: Xyz = [beyond + between(r, 3, 6), surface(far), jz + between(r, -3, 3)]
  fills.push(`setblock ${goal.join(' ')} gold_block`)
  const across = kind === 'ledge' ? 'on top of the ledge' : `across the ${kind}`
  return {
    trees: [], chest: null, waves: 0, fills, goal,
    jeeve: [jx, -60 + near, jz], josh: [jx - 2, -60 + near, jz + 3],
    instructions: [`go to the gold block ${across}`],
    crossing: { kind, way, kit: way ? [] : ['cobblestone 32'], ...crossing }
  }
}

// Build a scene: clear the area, plant the trees, place the chest, put the players in place. A fill holds at most
// 32768 blocks, so a wide area is cleared in strips.
export function build (command: Command, scene: Scene, instructor = 'Josh', area: { min: Xyz, max: Xyz } = AREA) {
  const h = area.max[1] + 61, depth = area.max[2] - area.min[2] + 1
  const step = Math.max(1, Math.floor(32768 / (h * depth)))
  for (let x = area.min[0]; x <= area.max[0]; x += step) command(`fill ${x} -60 ${area.min[2]} ${Math.min(area.max[0], x + step - 1)} ${area.max[1]} ${area.max[2]} air`)
  for (const c of scene.fills ?? []) command(c)
  for (const t of scene.trees) {
    const top = -60 + t.trunk - 1
    command(`fill ${t.x} -60 ${t.z} ${t.x} ${top} ${t.z} ${t.wood}_log`)
    if (t.canopy) command(`fill ${t.x - 1} ${top + 1} ${t.z - 1} ${t.x + 1} ${top + 3} ${t.z + 1} ${t.wood}_leaves[persistent=true]`)
    else command(`fill ${t.x - 1} ${top + 1} ${t.z - 1} ${t.x + 1} ${top + 1} ${t.z + 1} ${t.wood}_leaves[persistent=true]`)
  }
  if (scene.chest) command(`setblock ${scene.chest.join(' ')} chest`)
  command(`tp Jeeve ${scene.jeeve.join(' ')}`)
  command(`tp ${instructor} ${scene.josh.join(' ')}`)
  for (const k of scene.crossing?.kit ?? []) command(`give Jeeve ${k}`)
}

// A camera south of the scene, far enough back to take in all of it.
export function cameraFor (scene: Scene): { at: Xyz, facing: Xyz } {
  const pts = [...scene.trees.map(t => [t.x, t.z]), [scene.jeeve[0], scene.jeeve[2]], ...[scene.chest, scene.goal].filter(p => p).map(p => [p![0], p![2]])]
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1])
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2
  const span = Math.max(12, Math.max(...xs) - Math.min(...xs), (Math.max(...zs) - Math.min(...zs)) * 1.6)
  return { at: [Math.round(cx), -61 + Math.round(span * 0.45), Math.round(Math.max(...zs) + span * 0.75)], facing: [Math.round(cx), -58, Math.round(cz)] }
}
