import type { Water } from '../actions.ts'
import { NAVIGATE, seeker } from './common.ts'
import { JUMP_GAP } from './jump_gap.ts'

// Across water to land on the far bank (features → waters), by a method that fits: jump it (up to 3 wide) or the
// route-finder (around, or swimming).
export const CROSS_WATER = seeker<Water>('cross_water', 'get across water to the far bank', f => f.waters, {
  jump_gap: { code: JUMP_GAP.source.code, fits: w => w.width <= 3, target: w => ({ dir: w.dir, dist: 1, width: w.width }) },
  navigate: { code: NAVIGATE, target: w => ({ to: w.far }) }
  // 2B's bridge and swim_across join here once they're in collect/actions/: { code: BRIDGE.source.code, target: w => <its target> }
})
