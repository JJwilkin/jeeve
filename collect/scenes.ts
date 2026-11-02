// Built stress scenes (brain/tasks/world-model-data.md → "Built stress scenes"): an obstacle cut into a level pad of
// the local ground, with the bot facing it along +x. A fresh scene with fresh parameters is built for each scene
// episode, where the bot landed, so the last episode's digging and placing never carries over.
export type Scene = { name: string, [param: string]: string | number | boolean }

const int = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1))
const coin = () => Math.random() < 0.5

// box(x0, y0, z0, x1, y1, z1, block), relative to the ground block under the bot; e is the obstacle's near edge.
type Box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, block: string) => void
// Each scene: its parameters, how deep the pad must go, and its fills; build returns the bot's height above ground.
const scene = <P>(s: { draw: () => P, deep?: (p: P) => number, build: (p: P, box: Box, e: number) => number | void }) => s
const SCENES = {
  river: scene({
    draw: () => ({ width: int(1, 8), depth: int(1, 6), bank: int(0, 5), bent: coin() }),
    deep: p => p.depth + p.bank,
    build: (p, box, e) => {
      const shift = p.bent ? int(2, 4) : 0 // a dogleg halfway along, away from the bot
      for (const [z0, z1, dx] of [[-12, 0, 0], [0, 12, shift]]) {
        box(e + dx, -p.bank - p.depth + 1, z0, e + dx + p.width - 1, 0, z1, 'air')
        box(e + dx, -p.bank - p.depth + 1, z0, e + dx + p.width - 1, -p.bank, z1, 'water')
      }
    }
  }),
  ravine: scene({
    // A cliff has no far wall (to the pad's end, x 24), so no width.
    draw: () => { const p = { drop: int(3, 20), slope: coin() }; return coin() ? { ...p, cliff: true } : { ...p, width: int(2, 10) } },
    deep: p => p.drop,
    build: (p, box, e) => {
      box(e, -p.drop + 1, -12, 'width' in p ? e + p.width - 1 : 24, 0, 12, 'air')
      // The slope: steps cut down into the near wall, one a block, as the bench's crossing scenes do.
      if (p.slope) for (let i = 0; i < p.drop; i++) box(e - 1, -i, -11 + i, e - 1, 0, -11 + i, 'air')
    }
  }),
  ledge: scene({
    draw: () => ({ rise: int(2, 6), overhang: coin() }),
    build: (p, box, e) => {
      box(e, 1, -12, 24, p.rise, 12, 'stone')
      if (p.overhang) box(e - 1, p.rise, -12, e - 1, p.rise, 12, 'stone')
    }
  }),
  lava_pool: scene({
    draw: () => ({ size: int(2, 6), across: coin() }), // across the path, or beside it
    build: (p, box, e) => {
      const z0 = p.across ? -Math.floor(p.size / 2) : 2
      box(e, 0, z0, e + p.size - 1, 0, z0 + p.size - 1, 'lava')
    }
  }),
  canopy: scene({
    draw: () => ({ height: int(4, 10), on_top: coin() }),
    build: (p, box) => {
      box(-6, p.height, -12, 24, p.height + 1, 12, 'oak_leaves[persistent=true]')
      for (let tx = -4; tx <= 24; tx += 5) for (let tz = -10; tz <= 10; tz += 5) if (tx || tz) box(tx, 1, tz, tx, p.height - 1, tz, 'oak_log')
      return p.on_top ? p.height + 2 : 1
    }
  }),
  cave_mouth: scene({
    draw: () => ({ width: int(1, 3), down: int(5, 15) }),
    deep: p => p.down + 1,
    build: (p, box, e) => {
      // A tunnel 3 high, sloping down one block a block; past the first few blocks the ground is its roof.
      const z0 = -Math.floor((p.width - 1) / 2)
      for (let i = 0; i < p.down; i++) box(e + i, -i, z0, e + i, 2 - i, z0 + p.width - 1, 'air')
      box(e + p.down, -p.down, z0 - 1, e + p.down + 3, 2 - p.down, z0 + p.width, 'air') // a small chamber at the bottom
    }
  })
}
type Name = keyof typeof SCENES

export const drawScene = (): Scene => {
  const names = Object.keys(SCENES) as Name[]
  const name = names[int(0, names.length - 1)]
  return { name, ...SCENES[name].draw() }
}

// The fills for scene s with ground (the top solid block, top) at x, y, z, and where the bot stands. The pad runs
// x −6…24, z −12…12 around it: under 32768 blocks a fill however deep the scene goes.
export function sceneFills (s: Scene, x: number, y: number, z: number, top: string): { fills: string[], stand: [number, number, number] } {
  const fills: string[] = []
  const box: Box = (x0, y0, z0, x1, y1, z1, block) => fills.push(`fill ${x + x0} ${y + y0} ${z + z0} ${x + x1} ${y + y1} ${z + z1} ${block}`)
  const def = SCENES[s.name as Name] as ReturnType<typeof scene<any>>
  box(-6, -(def.deep?.(s) ?? 1) - 1, -12, 24, -1, 12, 'stone')
  box(-6, 0, -12, 24, 0, 12, top)
  box(-6, 1, -12, 24, 12, 12, 'air')
  return { fills, stand: [x, y + (def.build(s, box, int(3, 5)) ?? 1), z] }
}
