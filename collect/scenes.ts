// Built stress scenes (brain/tasks/world-model-data.md → "Built stress scenes"): an obstacle cut into a level pad of
// natural ground, with the bot facing it along +x. A fresh scene with fresh parameters is built for each scene
// episode, where the bot landed, so the last episode's digging and placing never carries over.
export type Scene = { name: string, [param: string]: string | number | boolean }

const int = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1))
const coin = () => Math.random() < 0.5

export const drawScene = (): Scene => [
  () => ({ name: 'river', width: int(1, 8), depth: int(1, 6), bank: int(0, 5), bent: coin() }),
  () => ({ name: 'ravine', drop: int(3, 20), width: int(2, 10), slope: coin(), cliff: coin() }), // cliff: the far side stays low
  () => ({ name: 'ledge', rise: int(2, 6), overhang: coin() }),
  () => ({ name: 'lava_pool', size: int(2, 6), across: coin() }), // across the path, or beside it
  () => ({ name: 'canopy', height: int(4, 10), on_top: coin() }),
  () => ({ name: 'cave_mouth', width: int(1, 3), down: int(5, 15) })
][int(0, 5)]()

// The fills for scene s with ground (the top solid block) at x, y, z, and where the bot stands. The pad runs x −6…24,
// z −12…12 around it: under 32768 blocks a fill however deep the scene goes.
export function sceneFills (s: Scene, x: number, y: number, z: number): { fills: string[], stand: [number, number, number] } {
  const fills: string[] = []
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, block: string) =>
    fills.push(`fill ${x + x0} ${y + y0} ${z + z0} ${x + x1} ${y + y1} ${z + z1} ${block}`)
  const n = (k: string) => s[k] as number
  const deep = { river: n('depth') + n('bank'), ravine: n('drop'), cave_mouth: n('down') + 1 }[s.name] ?? 1
  box(-6, -deep - 1, -12, 24, -1, 12, 'stone')
  box(-6, 0, -12, 24, 0, 12, 'grass_block')
  box(-6, 1, -12, 24, 12, 12, 'air')
  const e = int(3, 5) // the obstacle's near edge
  let stand = 1
  if (s.name === 'river') {
    const [w, surface] = [n('width'), -n('bank')]
    const shift = s.bent ? int(2, 4) : 0 // a dogleg halfway along, away from the bot
    for (const [z0, z1, dx] of [[-12, 0, 0], [0, 12, shift]]) {
      box(e + dx, surface - n('depth') + 1, z0, e + dx + w - 1, 0, z1, 'air')
      box(e + dx, surface - n('depth') + 1, z0, e + dx + w - 1, surface, z1, 'water')
    }
  } else if (s.name === 'ravine') {
    box(e, -n('drop') + 1, -12, s.cliff ? 24 : e + n('width') - 1, 0, 12, 'air')
    // The slope: steps cut down into the near wall, one a block, as the bench's crossing scenes do.
    if (s.slope) for (let i = 0; i < n('drop'); i++) box(e - 1, -i, -11 + i, e - 1, 0, -11 + i, 'air')
  } else if (s.name === 'ledge') {
    box(e, 1, -12, 24, n('rise'), 12, 'stone')
    if (s.overhang) box(e - 1, n('rise'), -12, e - 1, n('rise'), 12, 'stone')
  } else if (s.name === 'lava_pool') {
    const z0 = s.across ? -Math.floor(n('size') / 2) : 2
    box(e, 0, z0, e + n('size') - 1, 0, z0 + n('size') - 1, 'lava')
  } else if (s.name === 'canopy') {
    box(-6, n('height'), -12, 24, n('height') + 1, 12, 'oak_leaves[persistent=true]')
    for (let tx = -4; tx <= 24; tx += 5) for (let tz = -10; tz <= 10; tz += 5) if (tx || tz) box(tx, 1, tz, tx, n('height') - 1, tz, 'oak_log')
    if (s.on_top) stand = n('height') + 2
  } else if (s.name === 'cave_mouth') {
    // A tunnel 3 high, sloping down one block a block; past the first few blocks the ground is its roof.
    const z0 = -Math.floor((n('width') - 1) / 2)
    for (let i = 0; i < n('down'); i++) box(e + i, -i, z0, e + i, 2 - i, z0 + n('width') - 1, 'air')
    box(e + n('down'), -n('down'), z0 - 1, e + n('down') + 3, 2 - n('down'), z0 + n('width'), 'air') // a small chamber at the bottom
  }
  return { fills, stand: [x, y + stand, z] }
}
