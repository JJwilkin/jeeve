import type { Authored } from '../actions.ts'
import { CARDINAL, behavior, int, pick } from './common.ts'

// Digs a 1×2 tunnel straight ahead, n blocks: the two blocks ahead (retried while gravel or sand falls in), then a
// walk into them. With the best tool in the kit. Where there's nothing to dig, it walks.
export const TUNNEL: Authored = {
  source: behavior('tunnel', 'dig a 1×2 tunnel straight ahead', String.raw`
  await tool();
  for (let n = 0; n < t.n; n++) {
    const [x, y, z] = feet(), nx = x + t.dir[0], nz = z + t.dir[1];
    for (const dy of [0, 1]) await clear(nx, y + dy, nz);
    if (!(await walkTo(nx, nz))) return 'stuck';
  }
  return 'done';`),
  fits: () => true,
  target: () => { const t = { n: int(3, 15), dir: pick(CARDINAL) }; return { params: t, target: t } }
}
