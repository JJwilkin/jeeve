import type { Authored } from '../actions.ts'
import { behavior, pick } from './common.ts'

// From up high, down to the floor below a drop of 4+ (features → drops): the route-finder first (it only plans
// drops the guards allow), and where it finds no way, digging straight down, which the guards allow only while the
// block under the dug one is within 3. Done once standing at the floor's height or lower,
// wherever that is: a shaft dug where the route-finder stopped counts.
export const CLIMB_DOWN_SAFELY_BODY = String.raw`
  const down = () => api.self().on_ground && pos()[1] <= t.floor[1] + 0.5;
  // A veto here is the guards stopping the route-finder at the edge: also no way down. Its goal is replaced by the spot it's on.
  try { await api.goto(t.floor[0], t.floor[1], t.floor[2], 1) } catch { const [x, y, z] = feet(); await api.goto(x, y, z, 1).catch(() => {}) }
  if (down()) return 'done';
  await tool();
  for (let i = 0; i < 24 && !down(); i++) {
    const [x, y, z] = feet();
    if (!open(x, y - 1, z)) await api.dig(x, y - 1, z);
    for (let k = 0; k < 20; k++) { await api.wait(1); if (api.self().on_ground) break }
  }
  return down() ? 'done' : 'stuck';`
export const CLIMB_DOWN_SAFELY: Authored = {
  source: behavior('climb_down_safely', 'get down from up high without a fall', CLIMB_DOWN_SAFELY_BODY),
  fits: f => f.drops.length > 0,
  target: (_bot, f) => { const d = pick(f.drops); return { params: d, target: d } }
}
