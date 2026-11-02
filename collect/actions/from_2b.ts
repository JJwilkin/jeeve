import type { Authored, Dir, Features, Water } from '../actions.ts'
import { source as bridge } from './bridge.ts'
import { int, pick } from './common.ts'
import { source as shelter } from './shelter.ts'
import { source as swimAcross } from './swim_across.ts'

// 2B's actions (written by collect/author.ts; pass rates in each file's header), with targets in the shapes their
// trials used. bridge goes straight along x or z, 1–8 blocks; swim_across aims at the far bank's ground block.
const straight = (d: Dir) => d[0] === 0 || d[1] === 0
export const bridgeable = (x: { dir: Dir, width: number }) => straight(x.dir) && x.width <= 8
export const bridgeTarget = (x: { dir: Dir, width: number }, f: Features) => ({ name: pick(f.placeable), count: x.width, dir: x.dir })
export const swimTarget = (w: Water) => ({ at: [w.far[0], w.far[1] - 1, w.far[2]] })

const spans = (f: Features) => [...f.gaps, ...f.waters].filter(bridgeable)
export const BRIDGE: Authored = {
  source: bridge,
  fits: f => f.placeable.length > 0 && spans(f).length > 0,
  target: (_bot, f) => { const x = pick(spans(f)); const t = bridgeTarget(x, f); return { params: { ...x, ...t }, target: t } }
}
export const SWIM_ACROSS: Authored = {
  source: swimAcross,
  fits: f => f.waters.length > 0,
  target: (_bot, f) => { const w = pick(f.waters); const t = swimTarget(w); return { params: { ...w, ...t }, target: t } }
}
export const SHELTER: Authored = {
  source: shelter,
  fits: f => f.placeable.length > 0,
  target: (_bot, f) => { const t = { name: pick(f.placeable), size: int(3, 5), template: pick(['wall', 'hut']) }; return { params: t, target: t } }
}
