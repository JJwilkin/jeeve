import type { Drop } from '../actions.ts'
import { CLIMB_DOWN_SAFELY } from './climb_down_safely.ts'
import { NAVIGATE, seeker } from './common.ts'

// Down a drop of 4+ to its floor (features → drops): the route-finder alone, or climb_down_safely (the route-finder,
// then digging down where it finds no way). Not step_down: walking off 4+ is always vetoed by the guards.
export const GET_DOWN_CLIFF = seeker<Drop>('get_down_cliff', 'get down a drop of 4 or more', f => f.drops, {
  navigate: { code: NAVIGATE, target: d => ({ to: d.floor }) },
  climb_down_safely: { code: CLIMB_DOWN_SAFELY.source.code, target: d => d }
})
