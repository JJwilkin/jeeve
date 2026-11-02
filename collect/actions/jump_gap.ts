import type { Authored } from '../actions.ts'
import { behavior, pick } from './common.ts'

// Sprints at a gap 1–3 wide (features → gaps, or cross_water) and jumps where the floor ahead ends. Done if it
// lands past the gap no more than a block lower; stuck if it falls in or stalls. A gap deeper than 3 is vetoed
// by the guards at the edge.
export const JUMP_GAP: Authored = {
  source: behavior('jump_gap', 'sprint-jump across a gap', String.raw`
  const [dx, dz] = t.dir, len = Math.hypot(dx, dz), ux = dx / len, uz = dz / len;
  await face(dx, dz);
  const o = pos(), y0 = feet()[1];
  let jumped = false;
  for (let i = 0; i < 80; i++) {
    const s = api.self();
    if (s.on_ground) {
      if (jumped) return s.pos[1] > y0 - 1.5 && (s.pos[0] - o[0]) * ux + (s.pos[2] - o[2]) * uz > (t.dist + t.width - 1) * len ? 'done' : 'stuck';
      jumped = open(Math.floor(s.pos[0] + ux * 0.5), y0 - 1, Math.floor(s.pos[2] + uz * 0.5));
      for (const k of jumped ? ['forward', 'sprint', 'jump'] : ['forward', 'sprint']) await api.control(k, true);
    }
    await api.wait(1);
    if (stalled()) return 'stuck';
  }
  return 'stuck';`),
  fits: f => f.gaps.length > 0,
  target: (_bot, f) => { const g = pick(f.gaps); return { params: g, target: g } }
}
