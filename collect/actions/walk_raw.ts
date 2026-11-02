import type { Authored } from '../actions.ts'
import { behavior, between, int, pick } from './common.ts'

// Holds one movement key (sneaking or not) toward a yaw for 1–5 s. Done if it covered a quarter of the distance
// that key would cover on open ground, else stuck.
export const WALK_RAW: Authored = {
  source: behavior('walk_raw', 'walk on raw controls for a few seconds', String.raw`
  await api.turn(t.yaw, 0);
  const start = pos(), keys = t.sneak ? [t.key, 'sneak'] : [t.key], ticks = t.seconds * 20;
  for (let i = 0; i < ticks; i++) {
    if (i === 0 || api.self().on_ground) for (const k of keys) await api.control(k, true);
    await api.wait(1);
  }
  return flat(pos(), start) >= t.seconds * (t.sneak ? 1.3 : 4.3) / 4 ? 'done' : 'stuck';`),
  fits: () => true,
  target: () => {
    const t = { seconds: int(1, 5), yaw: +between(-Math.PI, Math.PI).toFixed(2), key: pick(['forward', 'forward', 'back', 'left', 'right']), sneak: Math.random() < 0.3 }
    return { params: t, target: t }
  }
}
