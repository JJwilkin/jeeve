import type { Water } from '../actions.ts'
import { source as bridge } from './bridge.ts'
import { NAVIGATE_BODY, seeker } from './common.ts'
import { bridgeTarget, bridgeable, swimAcross, swimTarget } from './from_2b.ts'
import { JUMP_GAP_BODY } from './jump_gap.ts'

// Across water to land on the far bank (features → waters), by a method that fits: jump it (up to 3 wide, from where
// the bot stands for a run-up, to a bank at most a block up) the route-finder (around, or swimming),
// 2B's bridge (from the block before the water: it finds the edge only along level ground) or swim_across (from where
// the bot stands: it threw from the bank's edge).
export const CROSS_WATER = seeker<Water>('cross_water', 'get across water to the far bank', f => f.waters, {
  jump_gap: { body: JUMP_GAP_BODY, stay: true, fits: w => w.dist <= 3 && w.width <= 3 && w.far[1] - w.near[1] <= 1, target: w => ({ dir: w.dir, dist: w.dist, width: w.width }) },
  navigate: { body: NAVIGATE_BODY, target: w => ({ to: w.far }) },
  bridge: { code: bridge.code, fits: (w, f) => bridgeable(w, f) && f.placeable.length > 0, target: bridgeTarget },
  swim_across: { code: swimAcross.code, stay: true, target: swimTarget }
})
