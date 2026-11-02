import type { Authored } from '../actions.ts'
import { CARDINAL, behavior, int, pick } from './common.ts'

// Digs a staircase down: per step, the three blocks ahead (head, feet, and the one below, retried while gravel or
// sand falls in), then walks into the hole and drops into it. With the best tool in the kit. Stuck if a step's walk fails.
export const DIG_STAIRS_DOWN: Authored = {
  source: behavior('dig_stairs_down', 'dig a staircase down', String.raw`
  await tool();
  for (let n = 0; n < t.steps; n++) {
    const [x, y, z] = feet(), nx = x + t.dir[0], nz = z + t.dir[1];
    for (const dy of [1, 0, -1]) for (let k = 0; k < 4 && !open(nx, y + dy, nz); k++) await api.dig(nx, y + dy, nz);
    if (!(await walkTo(nx, nz))) return 'stuck';
    for (let k = 0; k < 10 && (feet()[1] >= y || !api.self().on_ground); k++) await api.wait(1); // land first: digging in the air is 5× slower
  }
  return 'done';`),
  fits: () => true,
  target: () => { const t = { steps: int(3, 12), dir: pick(CARDINAL) }; return { params: t, target: t } }
}
