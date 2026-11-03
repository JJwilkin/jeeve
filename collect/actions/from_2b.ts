import type { ModuleSource } from '../../src/modules.ts'
import type { Authored, Dir, Features, Water } from '../actions.ts'
import { source as bridge } from './bridge.ts'
import { approaching, int, pick } from './common.ts'
import { source as shelter } from './shelter.ts'
import { source as swimAcrossAsWritten } from './swim_across.ts'

// 2B's actions (written by collect/author.ts; pass rates in each file's header), with targets in the shapes their
// trials used. bridge goes straight along x or z, 1–8 blocks; swim_across aims at the far bank's ground block.
const straight = (d: Dir) => d[0] === 0 || d[1] === 0
export const bridgeable = (x: { dir: Dir, width: number }) => straight(x.dir) && x.width <= 8
export const bridgeTarget = (x: { dir: Dir, width: number }, f: Features) => ({ name: pick(f.placeable), count: x.width, dir: x.dir })
export const swimTarget = (w: Water) => ({ at: [w.far[0], w.far[1] - 1, w.far[2]] })

// swim_across throws `stuck: <its log>` when it gives up instead of returning stuck, which recorded those runs as
// error, and training drops errors (15% of v3's swim_across). Its file stays as 2B wrote it.
export const swimAcross: ModuleSource = {
  ...swimAcrossAsWritten,
  code: `async (api, t) => {\n  try { return await (${swimAcrossAsWritten.code})(api, t) } catch (e) { if (/^stuck/.test(String(e && e.message))) return 'stuck'; throw e }\n}`
}

// bridge only finds the edge along level ground at the bot's own height, so from where it stood it ended none_found
// for half of v3's bridges, mostly water up to 12 blocks out over uneven ground. It now starts at the block before
// water (near), as in its trials; gaps are on level ground within 3 already.
const spans = (f: Features) => [...f.gaps, ...f.waters].filter(bridgeable)
export const BRIDGE: Authored = {
  source: { ...bridge, code: approaching(bridge.code) },
  fits: f => f.placeable.length > 0 && spans(f).length > 0,
  target: (_bot, f) => {
    const x = pick(spans(f))
    const t = bridgeTarget(x, f)
    return { params: { ...x, ...t }, target: { near: 'near' in x && x.dist > 1 ? x.near : null, target: t } }
  }
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
