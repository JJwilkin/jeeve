import type { Authored } from '../actions.ts'
import { behavior, int, pick } from './common.ts'

// Jumps and places a block under the feet, n times (features → placeable: blocks in the kit). The place waits until
// the feet are a block up, or the guards veto it as suffocating; a failed place is retried, up to 4 failures.
export const PILLAR_UP_BODY = String.raw`
  if (!api.inventory()[t.item]) return 'none_found';
  await api.equip(t.item);
  const y0 = feet()[1];
  let fails = 0;
  for (let i = 0; i < t.n * 30 && fails < 4; i++) {
    const s = api.self(), [x, y, z] = feet();
    if (s.on_ground && y >= y0 + t.n) return 'done';
    if (!api.inventory()[t.item]) return 'stuck';
    await api.control('jump', true);
    if (!s.on_ground && open(x, y - 1, z) && !open(x, y - 2, z)) { try { await api.place(x, y - 1, z) } catch (e) { fails++ } }
    await api.wait(1);
  }
  return 'stuck';`
export const PILLAR_UP: Authored = {
  source: behavior('pillar_up', 'pillar up a few blocks by jumping and placing under the feet', PILLAR_UP_BODY),
  fits: f => f.placeable.length > 0,
  target: (_bot, f) => { const t = { n: int(2, 8), item: pick(f.placeable) }; return { params: t, target: t } }
}
