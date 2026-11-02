import type { Drop } from '../actions.ts'
import { CLIMB_DOWN_SAFELY_BODY } from './climb_down_safely.ts'
import { NAVIGATE_BODY, seeker } from './common.ts'

// Down a drop of 4+ to its floor (features → drops): the route-finder alone, or climb_down_safely (the route-finder,
// then digging down where it finds no way). Not step_down: walking off 4+ is always vetoed by the guards.
export const GET_DOWN_CLIFF = seeker<Drop>('get_down_cliff', 'get down a drop of 4 or more', f => f.drops, {
  navigate: { body: NAVIGATE_BODY, target: d => ({ to: d.floor }) },
  climb_down_safely: { body: CLIMB_DOWN_SAFELY_BODY, target: d => d }
})
