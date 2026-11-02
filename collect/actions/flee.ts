import type { Authored } from '../actions.ts'
import { int, pick, behavior } from './common.ts'

// Runs from a mob with the route-finder, to a point straight away from it, until it's at least dist away (or gone):
// up to three legs, each re-aimed at where the mob is now. Stuck if there's no route or it keeps up.
export const FLEE: Authored = {
  source: behavior('flee', 'run away from a mob', String.raw`
  const mob = () => api.entities(64).find(e => e.id === t.id);
  if (!mob()) return 'none_found';
  for (let leg = 0; leg < 3; leg++) {
    const m = mob();
    if (!m) return 'done';
    const p = pos(), dx = p[0] - m.pos[0], dz = p[2] - m.pos[2], d = Math.hypot(dx, dz) || 1;
    if (d >= t.dist) return 'done';
    const run = t.dist - d + 4;
    try { await api.goto(p[0] + dx / d * run, p[1], p[2] + dz / d * run, 3) } catch (e) { if (vetoed(e)) throw e; return 'stuck' }
  }
  const m = mob();
  return !m || flat(pos(), m.pos) >= t.dist ? 'done' : 'stuck';`),
  fits: f => f.mobs.length > 0,
  target: (_bot, f) => {
    const e = pick(f.mobs)
    const t = { id: e.id, name: e.name, dist: int(8, 20) }
    return { params: t, target: t }
  }
}
