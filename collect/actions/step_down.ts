import type { Authored } from '../actions.ts'
import { behavior, pick } from './common.ts'

// Walks forward off a step down of 1–4 blocks (features → edges). Done once standing that much lower; stuck if it
// stalls or walks past without dropping. A step of 4 is more than the guards allow: those runs end vetoed.
export const STEP_DOWN: Authored = {
  source: behavior('step_down', 'walk off a step down of a few blocks', String.raw`
  await face(t.dir[0], t.dir[1]);
  const start = pos();
  for (let i = 0; i < 40 + t.dist * 10; i++) {
    const s = api.self();
    if (s.on_ground && s.pos[1] <= start[1] - t.depth + 0.5) return 'done';
    if (s.on_ground) await api.control('forward', true);
    await api.wait(1);
    if (stalled() || flat(pos(), start) > t.dist * 1.5 + 2) return 'stuck';
  }
  return 'stuck';`),
  fits: f => f.edges.length > 0,
  target: (_bot, f) => { const e = pick(f.edges); return { params: e, target: e } }
}
