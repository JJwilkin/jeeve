// What the hand-written actions share: drawing parameters, and the helpers every action's code starts with. The code
// runs in the authored-behavior sandbox (src/modules.ts), so the helpers are inlined into each action as source:
// each stays self-contained, and can go into Jeeve's library unchanged.
import type { ModuleSource } from '../../src/modules.ts'
import type { Authored, Features, Xyz } from '../actions.ts'

export const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
export const int = (lo: number, hi: number) => Math.floor(between(lo, hi + 1))
export const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]
export const CARDINAL: Array<[number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1]]

// open: blocks a player walks through (water and lava too: the guards, not the action, keep it out of lava).
// walkTo steers to a column's centre with raw controls until standing there (at the boundary the hitbox still
// rests on the column before, so a step down wouldn't drop yet). stalled: under half a block in a second.
// A vetoed call rejects with "vetoed: …"; code that catches errors rethrows those, so the outcome says vetoed
// (unless the action says otherwise: climb_down_safely and pillar_up handle some vetoes themselves).
// clear: digs a block until it's open (waiting for gravel or sand above to fall in, then digging that too);
// "nothing to dig" means passable too.
const HELPERS = String.raw`
  const OPEN = /^((cave_|void_)?air|water|lava|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|seagrass|tall_seagrass|torch|wall_torch|dandelion|poppy|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley)$|_(flower|tulip|sapling|mushroom|roots|sprouts|petals|bush)$/;
  const open = (x, y, z) => { const n = api.blockAt(x, y, z); return n !== null && OPEN.test(n) };
  const pos = () => api.self().pos;
  const feet = () => pos().map(Math.floor);
  const flat = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
  const face = (dx, dz) => api.turn(Math.atan2(-dx, -dz), 0);
  const vetoed = e => /^vetoed/.test(String(e && e.message));
  const stalled = (() => { let n = 0, mark = null; return () => { if (++n % 20) return false; const p = pos(), was = mark; mark = p; return !!was && flat(p, was) < 0.5 } })();
  const tool = async () => { const t = Object.keys(api.inventory()).find(n => /_pickaxe$/.test(n)) || Object.keys(api.inventory()).find(n => /_shovel$/.test(n)); if (t) await api.equip(t) };
  const clear = async (x, y, z) => {
    for (let k = 0; k < 4 && !open(x, y, z); k++) {
      const falls = /^(gravel|sand|red_sand)$/.test(api.blockAt(x, y + 1, z) || '');
      try { await api.dig(x, y, z) } catch (e) { if (/^nothing to dig/.test(e.message)) return; throw e }
      if (falls) await api.wait(6);
    }
  };
  const walkTo = async (x, z) => {
    for (let i = 0; i < 30; i++) {
      const s = api.self();
      if (flat(s.pos, [x + 0.5, 0, z + 0.5]) < 0.3 && s.on_ground) { await api.control('forward', false); return true }
      await api.turn(Math.atan2(-(x + 0.5 - s.pos[0]), -(z + 0.5 - s.pos[2])), 0);
      await api.control('forward', true);
      await api.wait(1);
    }
    return false;
  };`

// A behavior on all three channels (the only layout with legs and aim together) whose code is HELPERS + body.
export const behavior = (name: string, description: string, body: string, timeout_s = 20): ModuleSource => ({
  kind: 'behavior', name, description, code: `async (api, t) => {${HELPERS}\n${body}\n}`, channels: ['legs', 'aim', 'hands'], targets: 'block', timeout_s
})

// A seeker method: walks to a block with the route-finder; done if it ends there.
export const NAVIGATE_BODY = String.raw`
  try { await api.goto(t.to[0], t.to[1], t.to[2], 0) } catch (e) { if (vetoed(e)) throw e; return 'stuck' }
  return flat(pos(), [t.to[0] + 0.5, 0, t.to[2] + 0.5]) <= 1 && Math.abs(pos()[1] - t.to[1]) < 1 ? 'done' : 'stuck';`

// A feature-seeking action (row 17 of the actions table in brain/tasks/world-model-data.md): one of the features
// find() returns, and a method among those that fit it. Each method gets its own source, so 2B's long ones stay under
// the library's size limit: the code walks to where the feature starts (near) unless it's there already or the method
// says stay (it walks to the edge itself, or makes its own run-up), then runs the method on a target made from the
// feature. A method is another action's body (on HELPERS) or whole code (2B's, which brings its own helpers).
export type Method<F> = ({ body: string } | { code: string }) & { stay?: true, fits?: (x: F, f: Features) => boolean, target: (x: F, f: Features) => unknown }
const APPROACH = "if (t.near) try { await api.goto(t.near[0], t.near[1], t.near[2], 0) } catch (e) { if (/^vetoed/.test(String(e && e.message))) throw e; return 'stuck' }"
// Whole code (2B's) behind the same walk: its target is { near, target }.
export const approaching = (code: string) => `async (api, t) => {\n  ${APPROACH}\n  return (${code})(api, t.target);\n}`
export function seeker<F extends { dist: number, near: Xyz }> (name: string, description: string, find: (f: Features) => F[], methods: Record<string, Method<F>>): Authored {
  const sources = Object.fromEntries(Object.entries(methods).map(([k, m]): [string, ModuleSource] => [k, {
    kind: 'behavior', name, description: `${description}, by ${k}`, channels: ['legs', 'aim', 'hands'], targets: 'block', timeout_s: 20,
    code: 'body' in m
      ? `async (api, t) => {${HELPERS}\n  ${APPROACH}\n  return (async (api, t) => {${m.body}\n  })(api, t.target);\n}`
      : approaching(m.code)
  }]))
  const [first, ...variants] = Object.values(sources)
  return {
    source: first,
    variants,
    fits: f => find(f).length > 0,
    target: (_bot, f) => {
      const x = pick(find(f))
      const [method, m] = pick(Object.entries(methods).filter(([, m]) => m.fits?.(x, f) ?? true))
      return { params: { method, ...x }, target: { near: !m.stay && x.dist > 1 ? x.near : null, target: m.target(x, f) }, source: sources[method] }
    }
  }
}
