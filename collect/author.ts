// 2B writes the collector's three hard actions (brain/tasks/world-model-data.md → "How they're made"): bridge, swim
// across and shelter. For each, build() (src/builder.ts) gets a capability request and a pass check as 2A would give
// them, and trials its drafts on practice scenes. The behavior it registers then runs on 20 validation scenes (fixed
// seeds, so reruns compare); below the bar, the failing scenes go back to 2B as evidence for another round. Accepted
// actions are written to collect/actions/<name>.ts; the report (per-scene pass/fail, rounds, cost) to authoring/.
//   AUTHOR_RCON_PASSWORD=… npm run author -- [bridge,swim_across,shelter] [--stub]
// One Paper server, superflat (scripts/scenes.ts builds on its ground, top at y = -61), reached through AUTHOR_HOST,
// AUTHOR_PORT, AUTHOR_RCON_HOST, AUTHOR_RCON_PORT; the bot is named Jeeve, as the scenes expect. --stub replays canned
// drafts (collect/author-stub.ts) instead of calling the model.
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { authoredSpec, CHANNELS, Channels, type ApiHost } from '../src/behaviors.ts'
import { build, BUILDER_LIMITS, BUILDER_MODEL, type BehaviorDraft, type BuildResult, type CapabilityRequest, type TrialReport } from '../src/builder.ts'
import { PRICES, usd } from '../src/budget.ts'
import { rawSnapshot } from '../src/encoder.ts'
import { guardedMovements, installGuards } from '../src/guards.ts'
import { compileBehavior } from '../src/modules.ts'
import { Recorder } from '../src/trace.ts'
import { blockAt, reachable, scan } from '../src/world.ts'
import { AREA, build as buildScene, crossingScene, rng, type Scene, type Tree } from '../scripts/scenes.ts'
import { stubModel } from './author-stub.ts'
import { rconWhenUp } from './rcon.ts'

const env = process.env
const args = process.argv.slice(2)
const STUB = args.includes('--stub')
const ROUNDS = Number(env.AUTHOR_ROUNDS ?? 3)
const MAX_USD = Number(env.AUTHOR_MAX_USD ?? 25)
const BAR = 0.5
const LIMIT_S = 20 // the collector runs an action for at most 20 s
const VALIDATION = Array.from({ length: Number(env.AUTHOR_SCENES ?? 20) }, (_, i) => i + 1)
const practiceSeed = (round: number, trial: number) => 1000 + round * 10 + trial // never a validation seed

type Xyz = [number, number, number]
type Case = { seed: number, scene: Scene, target: Record<string, unknown>, about: Record<string, unknown>, give: string[], start: Xyz, gap?: [number, number], rows: [number, number] }
// What a pass check reads: the world after the run, the bot, and whether it was in water at any point of the run.
type Judged = { block: (x: number, y: number, z: number) => string | null, solid: (x: number, y: number, z: number) => boolean, self: { pos: Xyz, on_ground: boolean, in_water: boolean }, wet: boolean }
type Task = { name: string, need: string, constraints: string[], trial: CapabilityRequest['trial'], scene: (seed: number) => Omit<Case, 'start' | 'rows'>, passWhen: string, pass: (w: Judged, c: Case) => boolean }

const crossing = (kind: 'river' | 'ravine', seed: number) => {
  const scene = crossingScene(kind, false, seed) // no way round: the kit has blocks
  const { width, depth, bank, drop } = scene.crossing!
  return { scene, about: { seed, kind, width, depth, bank, drop } }
}

// ---- the three actions: the request 2A would make, the scenes, and the pass check (its source is shown to 2B) ----
const TASKS: Task[] = [
  {
    name: 'bridge',
    need: 'bridge across a gap or water: walk to the edge, then place blocks out from it one by one, walking onto each, until count are placed or the far side is reached',
    constraints: [
      'target: { name: the block to place (in the inventory), count: blocks to place, 1-8, dir: [dx, dz], the unit step along x or z to bridge toward }',
      'the bot may start a few blocks behind the edge; the gap is water (any depth, banks 0-5 above it) or a drop of 4+ that the guards won\'t let it walk off',
      `timeout_s at most ${LIMIT_S}`
    ],
    trial: { block: 'cobblestone', count: 8 },
    scene: seed => {
      const { scene, about } = crossing(seed % 2 ? 'river' : 'ravine', seed)
      return { seed, scene, about, give: [], target: { name: 'cobblestone', count: scene.crossing!.width, dir: [1, 0] } }
    },
    passWhen: 'Every column of the gap (x from gap[0] to gap[1] - 1) has a solid block at the bank\'s level (start y - 1) on some row, and the bot stands dry on the far side (x >= gap[1]) at the bank\'s height. count is the gap\'s width.',
    pass: (w, c) => {
      const [x, y] = w.self.pos.map(Math.floor)
      const [g0, g1] = c.gap!
      for (let gx = g0; gx < g1; gx++) {
        let spanned = false
        for (let z = c.rows[0]; z <= c.rows[1] && !spanned; z++) spanned = w.solid(gx, c.start[1] - 1, z)
        if (!spanned) return false
      }
      return w.self.on_ground && !w.self.in_water && x >= g1 && y >= c.start[1]
    }
  },
  {
    name: 'swim_across',
    need: 'swim across water to an aim point on the far bank, and get out onto it',
    constraints: [
      'target: { at: [x, y, z] }, the block on the far bank to stand on',
      'swim, don\'t bridge: the pass check needs the bot to have been in the water',
      'banks are 0-5 blocks above the water, so climbing out may need blocks: the bot carries cobblestone',
      `timeout_s at most ${LIMIT_S}`
    ],
    trial: { block: 'gold_block', count: 1 },
    scene: seed => {
      const { scene, about } = crossing('river', seed)
      return { seed, scene, about, give: [], target: { at: scene.goal } }
    },
    passWhen: 'The bot was in water during the run, and ends on the ground, out of the water, standing on the aim block\'s level within 2.5 blocks (horizontally) of its centre.',
    pass: (w, c) => {
      const [x, y, z] = w.self.pos
      const [ax, ay, az] = c.target.at as Xyz
      return w.wet && w.self.on_ground && !w.self.in_water && Math.floor(y) >= ay + 1 && Math.hypot(x - ax - 0.5, z - az - 0.5) <= 2.5
    }
  },
  {
    name: 'shelter',
    need: 'build a wall or a small shelter out of blocks from the inventory, where the bot stands',
    constraints: [
      'target: { name: the block to build with (in the inventory), size: 3-5, template: "wall" or "hut" }',
      'wall: a straight wall size long and 2 high, within 4 blocks of where the bot starts',
      'hut: walls 2 high and a roof that close the bot in, no further than size blocks from where it ends',
      `timeout_s at most ${LIMIT_S}`
    ],
    trial: { block: 'cobblestone', count: 64 },
    scene: seed => {
      const r = rng(seed)
      const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
      const template = r() < 0.5 ? 'wall' : 'hut'
      const size = int(3, 5)
      const name = ['cobblestone', 'dirt', 'oak_planks'][int(0, 2)]
      const jeeve: Xyz = [int(26, 48), -60, int(-18, -6)]
      const trees: Tree[] = Array.from({ length: int(0, 2) }, () => ({ x: jeeve[0] + int(5, 7) * (r() < 0.5 ? -1 : 1), z: jeeve[2] + int(-6, 6), wood: 'oak' as const, trunk: int(4, 6), canopy: false }))
      const scene: Scene = { trees, chest: null, waves: 0, jeeve, josh: [jeeve[0] - 8, -60, jeeve[2]], instructions: [] }
      return { seed, scene, about: { seed, template, size, name, trees: trees.length }, give: [`${name} 64`], target: { name, size, template } }
    },
    passWhen: 'wall: some straight run of size columns (along x or z, within 4 blocks of the start), each with the target block at the start\'s feet and head height. hut: the bot is on the ground and closed in: walking 4 ways from its feet (2-high gaps), it can\'t get further than size blocks, and every cell it can reach has a block 2 or 3 above the feet.',
    pass: (w, c) => {
      const t = c.target as { name: string, size: number, template: string }
      if (t.template === 'wall') {
        const [sx, sy, sz] = c.start
        const col = (x: number, z: number) => w.block(x, sy, z) === t.name && w.block(x, sy + 1, z) === t.name
        let best = 0
        for (let a = -4; a <= 4; a++) for (const along of [true, false]) {
          let run = 0
          for (let b = -8; b <= 8; b++) best = Math.max(best, run = (along ? col(sx + b, sz + a) : col(sx + a, sz + b)) ? run + 1 : 0)
        }
        return best >= t.size
      }
      const [x, y, z] = w.self.pos.map(Math.floor)
      const open = (cx: number, cz: number) => !w.solid(cx, y, cz) && !w.solid(cx, y + 1, cz)
      const seen = new Set([`${x},${z}`])
      const todo = [[x, z]]
      while (todo.length) {
        const [cx, cz] = todo.pop()!
        if (Math.max(Math.abs(cx - x), Math.abs(cz - z)) > t.size) return false
        if (!w.solid(cx, y + 2, cz) && !w.solid(cx, y + 3, cz)) return false
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = `${cx + dx},${cz + dz}`
          if (!seen.has(k) && open(cx + dx, cz + dz)) { seen.add(k); todo.push([cx + dx, cz + dz]) }
        }
      }
      return w.self.on_ground
    }
  }
]

// ---- the server and the bot ----
const r = await rconWhenUp(env.AUTHOR_RCON_HOST ?? env.AUTHOR_HOST ?? 'localhost', Number(env.AUTHOR_RCON_PORT ?? 25575), env.AUTHOR_RCON_PASSWORD ?? '', 24)
const bot = mineflayer.createBot({ host: env.AUTHOR_HOST ?? 'localhost', port: Number(env.AUTHOR_PORT ?? 25565), username: 'Jeeve', auth: 'offline' })
bot.loadPlugin(pf.pathfinder)
bot.on('kicked', reason => console.log('[author] kicked:', JSON.stringify(reason)))
bot.on('error', err => console.log('[author] error:', err.message))
await new Promise<void>(resolve => bot.once('spawn', () => resolve()))
// As in src/main.ts: the hitbox fix, the guarded Movements, the guards (their vetoes reach the running behavior).
;(bot.physics as unknown as { playerHalfWidth: number }).playerHalfWidth = Math.fround(0.6) / 2
bot.pathfinder.setMovements(guardedMovements(bot))
let ended: ((detail: { error?: string, actions?: unknown[] } | undefined, reason: string) => void) | null = null
const channels = new Channels(bot, { event: () => {}, start: () => {}, end: (slot, reason) => ended?.(slot.run.detail?.() as never, reason) })
installGuards(bot, (channel, reason) => channels.veto(channel, reason))
const HOST: ApiHost = { blockAt, scan, reachable, allowed: [] }
for (const cmd of ['gamerule spawn_mobs false', 'gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set day', 'kill @e[type=!player]', 'gamemode survival Jeeve']) await r.command(cmd)

const at = (x: number, y: number, z: number) => bot.blockAt(new Vec3(x, y, z))
const solid = (x: number, y: number, z: number) => at(x, y, z)?.boundingBox === 'block'

async function setup (task: Task, seed: number): Promise<Case> {
  const c: Case = { ...task.scene(seed), start: [0, 0, 0], rows: [AREA.min[2] + 1, AREA.max[2] - 1] }
  const cmds = ['clear Jeeve', 'kill @e[type=item]', 'effect give Jeeve instant_health 1 10 true', 'effect give Jeeve saturation 1 10 true']
  buildScene(cmd => cmds.push(cmd), c.scene)
  const [x, y, z] = c.scene.jeeve
  cmds.push(`tp Jeeve ${x + 0.5} ${y} ${z + 0.5} -90 0`, ...c.give.map(g => `give Jeeve ${g}`)) // centred, facing east
  for (const cmd of cmds) await r.command(cmd)
  await bot.waitForTicks(40) // land, and let the fills and the kit arrive
  c.start = c.scene.jeeve
  if (task.name === 'bridge') { // where the gap is, along the start row: first open column, then the first solid one after it
    let gx = x
    while (solid(gx, y - 1, z) && gx < x + 20) gx++
    const edge = gx
    while (!solid(gx, y - 1, z) && gx < edge + 20) gx++
    c.gap = [edge, gx]
  }
  return c
}

type Outcome = { end: string, passed: boolean, ms: number, error?: string, actions?: unknown[], self: Judged['self'] & { wet: boolean } }
async function run (task: Task, c: Case, d: BehaviorDraft): Promise<Outcome> {
  const spec = authoredSpec({ ...d, version: 1 }, HOST)
  let wet = false
  const tick = () => { wet ||= (bot.entity as any).isInWater }
  bot.on('physicsTick', tick)
  const t0 = Date.now()
  const { end, detail } = await new Promise<{ end: string, detail?: { error?: string, actions?: unknown[] } }>(resolve => {
    const timer = setTimeout(() => { ended = null; channels.stop(CHANNELS, 'timeout'); resolve({ end: 'timeout' }) }, (d.timeout_s! + 5) * 1000) // a backstop: the spec has its own limit
    ended = (detail, end) => { clearTimeout(timer); ended = null; resolve({ end, detail }) }
    channels.set(`${d.name}:author`, d.name, c.target as never, 'author', { spec })
  })
  const ms = Date.now() - t0
  bot.removeListener('physicsTick', tick)
  bot.clearControlStates()
  await bot.waitForTicks(3) // as live trials: judge once the view has caught up
  const p = bot.entity.position
  const w: Judged = { block: (x, y, z) => at(x, y, z)?.name ?? null, solid, self: { pos: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)], on_ground: bot.entity.onGround, in_water: (bot.entity as any).isInWater }, wet }
  const passed = end === 'done' && task.pass(w, c)
  const error = detail?.error ?? (end === 'done' && !passed ? 'returned done, but the pass check is false' : undefined)
  return { end, passed, ms, error, actions: detail?.actions, self: { ...w.self, wet } }
}

// ---- authoring ----
const session = `author-${new Date().toISOString().replace(/[:.]/g, '-')}`
const rec = await Recorder.init(env.JEEVE_PROJECT ?? 'jeeve-test', session)
const cap = new AbortController()
let spent = 0
const ask = (task: Task, n: number) => STUB ? stubModel(task.name, n) : undefined // undefined: build()'s default, Opus

type Scored = Outcome & { scene: Record<string, unknown> }
type Round = { round: number, build: BuildResult['status'], reason?: string, trials: string[], draft: BehaviorDraft | null, validation?: Scored[], rate: number }
const trim = (o: Scored) => ({ scene: o.scene, end: o.end, error: o.error, self: o.self, actions: o.actions?.slice(-15) })

async function round (task: Task, n: number, prev: Round | null): Promise<Round> {
  let k = 0
  let accepted: BehaviorDraft | null = null
  let last = prev?.draft ?? null
  const req: CapabilityRequest = { id: `${task.name}-r${n}`, need: task.need, constraints: task.constraints, targets: 'block', trial: task.trial, pass_when: `${task.name}_passes` }
  const first = await setup(task, practiceSeed(n, 0))
  const snap = rawSnapshot(bot)
  const failed = prev?.validation?.filter(o => !o.passed)
  const brief = {
    request: req,
    pass_when: { id: req.pass_when, description: task.passWhen, code: `(w, c) => …\n${task.pass.toString()}`, reads: 'w: { block(x, y, z) → name, solid(x, y, z), self: { pos, on_ground, in_water }, wet: in water at any point of the run }; c: the scene: { start: [x, y, z] the start block, target, gap: [first gap x, first far x] (bridge), rows: [z0, z1] the scene\'s z range }' },
    trials: `Each trial runs on a fresh practice scene of the same kind (another seed); its result's self.scene describes it, and this brief's scene is the first. The behavior that passes a trial then runs on ${VALIDATION.length} validation scenes and must pass ${BAR * 100}% of them.`,
    target: first.target,
    library: last ? [{ id: `${task.name}@round${n - 1}`, description: last.description, channels: last.channels, targets: last.targets, code: last.code }] : [],
    previous_round: prev && (failed
      ? { result: `passed ${(prev.rate * 100).toFixed(0)}% of validation`, passing: prev.validation!.filter(o => o.passed).map(o => o.scene), failing: failed.slice(0, 6).map(trim), more_failing: failed.slice(6).map(o => ({ scene: o.scene, end: o.end, error: o.error })) }
      : { result: `no trial passed: ${prev.reason ?? prev.build}`, trials: prev.trials }),
    self: snap.self, inventory: snap.inventory, blocks: snap.blocks, entities: snap.entities
  }
  const trial = async (d: BehaviorDraft): Promise<TrialReport> => {
    last = d
    const refuse = (error: string): TrialReport => ({ behavior: d.name, passed: false, end: 'refused', ms: 0, error, preempted: 0 })
    if (d.targets !== 'block') return refuse('targets must be "block", as the request says')
    if (!(d.timeout_s! <= LIMIT_S)) return refuse(`timeout_s must be at most ${LIMIT_S}`)
    try { compileBehavior({ kind: 'behavior', ...d }) } catch (err) { return refuse(String(err)) }
    const c = k === 0 ? first : await setup(task, practiceSeed(n, k))
    const o = await run(task, c, d)
    if (o.passed) accepted = d
    console.log(`[author] ${req.id} trial ${++k}: ${o.end}${o.passed ? ' (passed)' : o.error ? ` (${o.error})` : ''} on ${JSON.stringify(c.about)}`)
    return { behavior: `${d.name}@${k}`, passed: o.passed, end: o.end, ms: o.ms, error: o.error, actions: o.actions, self: { ...o.self, scene: c.about }, preempted: 0 }
  }
  const span = rec.openTrace('builder', { 'jeeve.request.id': req.id, 'jeeve.builder.model': STUB ? 'stub' : BUILDER_MODEL })
  const result = await build(req, brief, {
    trial,
    perceive: async (tool, input) => tool === 'scan' ? scan(bot, input as { match: string }) : reachable(bot, input.position as Xyz),
    log: row => rec.jsonl({ request: req.id, ...row }),
    usage: u => {
      spent += usd(PRICES.anthropic, { non_cached_input_tokens: u.inputTokenDetails.noCacheTokens, output_tokens: u.outputTokens, cache_read_input_tokens: u.inputTokenDetails.cacheReadTokens, cache_creation_input_tokens: u.inputTokenDetails.cacheWriteTokens })
      if (spent >= MAX_USD) cap.abort(`dollar cap: $${spent.toFixed(2)} of $${MAX_USD}`)
    }
  }, cap.signal, span, session, ask(task, n)).catch((err): BuildResult => ({ request: req.id, status: 'failed', reason: String(err), attempts: [] }))
  rec.finish(span, 'builder', { attrs: { 'jeeve.builder.status': result.status, 'jeeve.builder.trials': result.attempts.length }, input: brief, output: result })
  const out: Round = { round: n, build: result.status, reason: result.status === 'failed' ? result.reason : undefined, trials: result.attempts.map(a => a.end), draft: accepted ?? last, rate: 0 }
  console.log(`[author] ${req.id} build ${result.status} after ${result.attempts.length} trials${out.reason ? `: ${out.reason}` : ''} ($${spent.toFixed(2)} spent)`)
  if (!accepted) return out
  out.validation = []
  for (const seed of VALIDATION) {
    const c = await setup(task, seed)
    const o = await run(task, c, accepted)
    out.validation.push({ ...o, scene: c.about })
    console.log(`[author] ${req.id} validation ${seed}: ${o.passed ? 'pass' : `fail (${o.end}${o.error ? `: ${o.error.slice(0, 120)}` : ''})`} ${JSON.stringify(c.about)}`)
  }
  out.rate = out.validation.filter(o => o.passed).length / VALIDATION.length
  return out
}

function write (task: Task, d: BehaviorDraft, rounds: Round[]) {
  const last = rounds.at(-1)!
  const passed = last.validation!.filter(o => o.passed).length
  const source = { kind: 'behavior', name: task.name, description: d.description, code: d.code, channels: d.channels, targets: d.targets, timeout_s: d.timeout_s, usage: d.usage }
  writeFileSync(`collect/actions/${task.name}.ts`, `// Written by 2B (collect/author.ts, ${STUB ? 'stubbed builder' : BUILDER_MODEL}) on ${new Date().toISOString().slice(0, 10)}, round ${last.round} of ${ROUNDS}:
// passed ${passed} of ${VALIDATION.length} validation scenes (${(last.rate * 100).toFixed(0)}%). Report: authoring/${session}.json.
// ${task.constraints[0]}
import type { ModuleSource } from '../../src/modules.ts'

export const source: ModuleSource = ${JSON.stringify(source, null, 2)}
`)
}

const names = args.find(a => !a.startsWith('--'))?.split(',') ?? TASKS.map(t => t.name)
const tasks = names.map(n => TASKS.find(t => t.name === n) ?? (() => { throw new Error(`no action ${n}`) })())
console.log(`[author] ${names.join(', ')}: up to ${ROUNDS} rounds each, bar ${BAR * 100}% of ${VALIDATION.length} scenes, ${BUILDER_LIMITS.trials} trials a round; ` +
  (STUB ? 'stubbed builder, no model calls' : `${BUILDER_MODEL}, dollar cap $${MAX_USD}`))
mkdirSync('authoring', { recursive: true })
mkdirSync('collect/actions', { recursive: true })
const report: Array<{ action: string, accepted: boolean, rate: number, rounds: Array<Omit<Round, 'draft'> & { code?: string }> }> = []
const save = () => writeFileSync(`authoring/${session}.json`, JSON.stringify({ session, stub: STUB, model: STUB ? 'stub' : BUILDER_MODEL, usd: +spent.toFixed(2), bar: BAR, report }, null, 2))
for (const task of tasks) {
  const rounds: Round[] = []
  for (let n = 1; n <= ROUNDS && !cap.signal.aborted; n++) {
    rounds.push(await round(task, n, rounds.at(-1) ?? null))
    if (rounds.at(-1)!.rate >= BAR) break
  }
  const best = rounds.at(-1)
  const accepted = !!best && best.rate >= BAR
  if (accepted) write(task, best.draft!, rounds)
  report.push({ action: task.name, accepted, rate: best?.rate ?? 0, rounds: rounds.map(({ draft, validation, ...o }) => ({ ...o, code: draft?.code, validation: validation?.map(v => ({ ...v, actions: v.passed ? undefined : v.actions?.slice(-15) })) })) })
  save()
  console.log(`[author] ${task.name}: ${accepted ? `accepted at ${(best!.rate * 100).toFixed(0)}% → collect/actions/${task.name}.ts` : `not accepted (best round ${((best?.rate ?? 0) * 100).toFixed(0)}%)`} after ${rounds.length} rounds`)
}
console.log(`[author] done: ${report.map(a => `${a.action} ${a.accepted ? 'accepted' : 'not accepted'} ${(a.rate * 100).toFixed(0)}%`).join(', ')}; $${spent.toFixed(2)} spent; report authoring/${session}.json`)
for (const a of report) for (const n of a.rounds) console.log(`  ${a.action} round ${n.round}: build ${n.build}, trials [${n.trials.join(', ')}]${n.validation ? `, validation ${n.validation.map(v => v.passed ? '✓' : '✗').join('')}` : ''}`)
await rec.shutdown('author_end')
r.close()
bot.quit()
process.exit(0)
