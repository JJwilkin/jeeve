import type { Ledge } from '../actions.ts'
import { NAVIGATE_BODY, pick, seeker } from './common.ts'
import { PILLAR_UP_BODY } from './pillar_up.ts'

// Pillars up to the ledge's height where it stands (at the ledge's foot), then walks onto it.
const PILLAR_ONTO_BODY = String.raw`
  const r = await (async (api, t) => {${PILLAR_UP_BODY}
  })(api, t);
  if (r !== 'done') return r;
  return (await walkTo(t.top[0], t.top[2])) && feet()[1] >= t.top[1] ? 'done' : 'stuck';`

// Up onto a ledge 2–4 up (features → ledges): the route-finder (a way round, or steps it can jump), or pillar up
// with a block from the kit.
export const REACH_LEDGE = seeker<Ledge>('reach_ledge', 'get up onto a ledge 2–4 blocks up', f => f.ledges, {
  navigate: { body: NAVIGATE_BODY, target: l => ({ to: l.top }) },
  pillar_up: { body: PILLAR_ONTO_BODY, fits: (_l, f) => f.placeable.length > 0, target: (l, f) => ({ n: l.height, item: pick(f.placeable), top: l.top }) }
})
