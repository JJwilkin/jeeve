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
export type Scene = { trees: Tree[], chest: Xyz | null, jeeve: Xyz, josh: Xyz, instructions: string[], waves: number, item?: string }

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

// Build a scene: clear the area, plant the trees, place the chest, put the players in place. A fill holds at most
// 32768 blocks, so a wide area is cleared in strips.
export function build (command: Command, scene: Scene, instructor = 'Josh', area: { min: Xyz, max: Xyz } = AREA) {
  const h = area.max[1] + 61, depth = area.max[2] - area.min[2] + 1
  const step = Math.max(1, Math.floor(32768 / (h * depth)))
  for (let x = area.min[0]; x <= area.max[0]; x += step) command(`fill ${x} -60 ${area.min[2]} ${Math.min(area.max[0], x + step - 1)} ${area.max[1]} ${area.max[2]} air`)
  for (const t of scene.trees) {
    const top = -60 + t.trunk - 1
    command(`fill ${t.x} -60 ${t.z} ${t.x} ${top} ${t.z} ${t.wood}_log`)
    if (t.canopy) command(`fill ${t.x - 1} ${top + 1} ${t.z - 1} ${t.x + 1} ${top + 3} ${t.z + 1} ${t.wood}_leaves[persistent=true]`)
    else command(`fill ${t.x - 1} ${top + 1} ${t.z - 1} ${t.x + 1} ${top + 1} ${t.z + 1} ${t.wood}_leaves[persistent=true]`)
  }
  if (scene.chest) command(`setblock ${scene.chest.join(' ')} chest`)
  command(`tp Jeeve ${scene.jeeve.join(' ')}`)
  command(`tp ${instructor} ${scene.josh.join(' ')}`)
}

// A camera south of the scene, far enough back to take in all of it.
export function cameraFor (scene: Scene): { at: Xyz, facing: Xyz } {
  const pts = [...scene.trees.map(t => [t.x, t.z]), [scene.jeeve[0], scene.jeeve[2]], ...(scene.chest ? [[scene.chest[0], scene.chest[2]]] : [])]
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1])
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2
  const span = Math.max(12, Math.max(...xs) - Math.min(...xs), (Math.max(...zs) - Math.min(...zs)) * 1.6)
  return { at: [Math.round(cx), -61 + Math.round(span * 0.45), Math.round(Math.max(...zs) + span * 0.75)], facing: [Math.round(cx), -58, Math.round(cz)] }
}
