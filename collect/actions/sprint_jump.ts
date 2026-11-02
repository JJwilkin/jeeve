import type { Authored } from '../actions.ts'
import { behavior, between, int } from './common.ts'

// Sprint-jumps a number of times toward a yaw. Done after that many landings; stuck if it stops making headway.
export const SPRINT_JUMP: Authored = {
  source: behavior('sprint_jump', 'sprint-jump a few times in one direction', String.raw`
  await api.turn(t.yaw, 0);
  let landed = 0, air = false;
  for (let i = 0; i < t.jumps * 25 + 20; i++) {
    if (api.self().on_ground) {
      if (air && ++landed >= t.jumps) return 'done';
      air = false;
      for (const k of ['forward', 'sprint', 'jump']) await api.control(k, true);
    } else air = true;
    await api.wait(1);
    if (stalled()) return 'stuck';
  }
  return 'stuck';`),
  fits: () => true,
  target: () => { const t = { jumps: int(2, 10), yaw: +between(-Math.PI, Math.PI).toFixed(2) }; return { params: t, target: t } }
}
