// Offline self-check: node src/selfcheck.ts. No server, no network.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import pf from 'mineflayer-pathfinder'
import registryFor from 'prismarine-registry'
import worldLoader from 'prismarine-world'
import chunkLoader from 'prismarine-chunk'
import { readFileSync } from 'node:fs'
import { API_ACTIONS, API_COVERS, API_DOC, API_READS, authoredSpec, BEHAVIORS, Channels, NOT_MAPPED } from './behaviors.ts'
import { trace } from '@opentelemetry/api'
import { MockLanguageModelV4 } from 'ai/test'
import { build, type CapabilityRequest } from './builder.ts'
import { coalescing, makeDecider } from './decide.ts'
import { direction, distanceBucket, makeEgocentric, newHandles, rawSnapshot } from './encoder.ts'
import { blockAt, notableBlocks, reachable, scan } from './world.ts'
import { compile, glob, Goals } from './goals.ts'
import { controlVector, guardedMovements, unsafeAt } from './guards.ts'
import { compileBehavior, compileModule, ModuleRegistry, startBehavior, type BehaviorHost } from './modules.ts'
import { DEFAULT_PROGRAM, optionsFor, validate, version } from './program.ts'

// Direction is egocentric: yaw 0 faces north (-z), positive turns left.
assert.equal(direction(0, -5, 0), 'ahead')
assert.equal(direction(-5, 0, 0), 'left')
assert.equal(direction(5, 0, 0), 'right')
assert.equal(direction(0, 5, 0), 'behind')
assert.equal(direction(-5, -5, 0), 'ahead-left')
assert.equal(direction(-5, 0, Math.PI / 2), 'ahead') // facing west
assert.equal(distanceBucket(2), 'very close')
assert.equal(distanceBucket(20), 'far')

// Options per question: behaviors whose channel set is the question's × targets; never two that mean the same.
const enc = {
  entities: [{ id: 'E0', desc: 'player Josh, close, ahead' }, { id: 'E1', desc: 'zombie (hostile), close, left' }],
  blocks: [{ name: 'oak_log', desc: 'many, nearest close, ahead' }, { name: 'dandelion', desc: 'one, nearest far, left' }]
}
const allowed = DEFAULT_PROGRAM.allowed_behaviors
const want = (b: string) => b === 'oak_log' ? 4 : 0 // goal met for dandelions → not offered
const keys = (o: object) => Object.keys(o)
assert.deepEqual(keys(optionsFor(['legs'], allowed, enc, null, want)), ['keep_current', 'navigate:E0', 'navigate:E1', 'follow:E0', 'follow:E1'])
assert.deepEqual(keys(optionsFor(['legs'], allowed, enc, 'follow:E0', want)), ['keep_current', 'stop', 'navigate:E0', 'navigate:E1', 'follow:E1'])
assert.deepEqual(keys(optionsFor(['hands'], allowed, enc, null, want)), ['keep_current', 'attack_when_ready:E0', 'attack_when_ready:E1'])
assert.deepEqual(keys(optionsFor(['legs', 'aim', 'hands'], allowed, enc, null, want)), ['keep_current', 'collect:oak_log(4)'])
assert.deepEqual(optionsFor(['legs', 'aim', 'hands'], allowed, enc, null, want)['collect:oak_log(4)'].block, { name: 'oak_log', count: 4 })
// The goal's place: navigate is offered a walk back to it, collect isn't, and a running walk back is only keep_current.
{
  const away = { ...enc, place: { pos: [10, 0, 0] as [number, number, number], desc: 'medium, right' } }
  assert.deepEqual(optionsFor(['legs'], allowed, away, null, want)['navigate:place'], { desc: "Walk back to the goal's place (medium, right), then stop", behavior: 'navigate', place: [10, 0, 0] })
  assert.deepEqual(keys(optionsFor(['legs', 'aim', 'hands'], allowed, away, null, want)), ['keep_current', 'collect:oak_log(4)'])
  assert.ok(!('navigate:place' in optionsFor(['legs'], allowed, away, 'navigate:place', want)))
}

// Bounds: the default passes; too many options, or an allowed behavior no question offers, don't.
validate(DEFAULT_PROGRAM)
assert.throws(() => validate({ ...DEFAULT_PROGRAM, encoder: { ...DEFAULT_PROGRAM.encoder, params: { ...DEFAULT_PROGRAM.encoder.params, entity_cap: 200 } } }), /options/)
assert.throws(() => validate({ ...DEFAULT_PROGRAM, questions: { legs: DEFAULT_PROGRAM.questions.legs } }), /no question offers/)
assert.match(version(DEFAULT_PROGRAM), /^v-[0-9a-f]{8}$/)

// Guards: flat floor at y=0 (stand at y=1), lava at x=5, a 6-deep hole at x=7, water at x=9.
{
  const at = (x: number, y: number, _z: number) => {
    if (y < -10) return null
    if (x === 5 && y === 0) return { name: 'lava', boundingBox: 'empty' }
    if (x === 7 && y > -6) return { name: 'air', boundingBox: 'empty' }
    if (x === 9 && y <= 0 && y > -6) return { name: 'water', boundingBox: 'empty' }
    return y <= 0 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  }
  assert.equal(unsafeAt(at, 0, 1, 0), null)
  assert.equal(unsafeAt(at, 5, 1, 0), 'lava below')
  assert.equal(unsafeAt(at, 7, 1, 0), 'drop of more than 3')
  assert.equal(unsafeAt(at, 9, 1, 0), null) // water breaks the fall
  assert.equal(unsafeAt(() => null, 0, 1, 0), 'void')
  const [fx, fz] = controlVector('forward', 0)!
  assert.ok(Math.abs(fx) < 1e-9 && fz === -1)
  assert.deepEqual(controlVector('left', 0)!.map(Math.round), [-1, 0])
  assert.equal(controlVector('jump', 0), null)
}

// decide(): one call in flight; triggers during a call merge into the next one.
{
  let inflight = 0
  let maxInflight = 0
  const calls: string[][] = []
  const wake = coalescing(async reasons => {
    inflight++; maxInflight = Math.max(maxInflight, inflight); calls.push(reasons)
    await new Promise(r => setTimeout(r, 50))
    inflight--
  }, 0)
  wake('a'); wake('b'); wake('c')
  await new Promise(r => setTimeout(r, 10)); wake('d'); wake('e')
  await new Promise(r => setTimeout(r, 200))
  assert.equal(maxInflight, 1)
  assert.deepEqual(calls, [['a'], ['b', 'c', 'd', 'e']]) // the first trigger starts at once; the rest merge
}

// One decision end to end with a fake bot and a fake Jev.
async function decideWith (answers: Record<string, any>, place: [number, number, number] | null = null) {
  const me = { id: 1, position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0), yaw: 0, type: 'player', username: 'Jeeve' }
  const josh = { id: 2, position: new Vec3(0, 0, -5), velocity: new Vec3(0, 0, 0), type: 'player', username: 'Josh', height: 1.8 }
  const bot: any = {
    entity: me, entities: { 1: me, 2: josh }, health: 20, food: 20, heldItem: null,
    inventory: { items: () => [] },
    blockAt: (p: Vec3) => p.x === 0 && p.y === 0 && p.z === -3 ? { name: 'oak_log', position: p } : null
  }
  const started: string[] = []
  const targets: unknown[] = []
  const channels: any = {
    slots: { legs: null, aim: null, hands: null },
    describe: () => ({ legs: 'idle', aim: 'idle', hands: 'idle' }),
    set: (key: string, _b: string, t: unknown, by: string) => { started.push(`${key}@${by}`); targets.push(t) },
    stop: () => {}
  }
  const traces: any[] = []
  const escalations: string[] = []
  let seen: any
  const decide = makeDecider({
    bot, program: DEFAULT_PROGRAM, handles: newHandles(), channels,
    record: r => { traces.push(r); return 'span-1' },
    escalate: reason => escalations.push(reason),
    directive: () => ({ text: 'collect 10 logs', from: 'Josh', at: 0, inventory: {}, place }), events: () => [],
    remaining: () => 10,
    wanted: () => [],
    ask: async (state, questions) => { seen = { state, questions }; return { model: 'fake', answers } }
  })
  await decide(['test'])
  return { started, targets, trace: traces[0], seen, escalations }
}

{
  const r = await decideWith({
    body: { choice: 'keep_current', confidence: 0.9 },
    legs: { choice: 'navigate:E0', confidence: 0.9 },
    aim: { choice: 'track:E9', confidence: 0.9 }, // not an offered option
    hands: { choice: 'keep_current', confidence: 0.2 }, // low confidence → escalate
    escalate: { noul: 0.1 }
  })
  assert.deepEqual(r.started, ['navigate:E0@span-1']) // decided_by points at the decide span
  assert.equal(r.seen.state.directive.from, 'player Josh (E0)')
  assert.deepEqual(r.seen.state.entities, [{ id: 'E0', what: 'player Josh', where: 'close, ahead', motion: 'steady' }])
  assert.deepEqual(r.seen.state.blocks, [{ name: 'oak_log', count: 'one', nearest: 'very close, ahead' }])
  assert.deepEqual(new Set(keys(r.seen.questions.body.criteria)), new Set(['keep_current', 'collect:oak_log(10)']))
  assert.deepEqual(r.trace.output.applied, { body: 'kept', legs: 'started', aim: 'unknown_option', hands: 'kept' })
  assert.equal(r.trace.attrs['jeeve.decide.escalate'], true)
  assert.equal(r.trace.attrs['jeeve.decide.changed'], true)
  assert.equal(r.trace.attrs['jeeve.decide.trigger'], 'test')
  assert.ok(JSON.parse(r.trace.attrs['jeeve.decide.raw_state']).entities.length === 1)
  assert.deepEqual(r.escalations, ['low_confidence'])
}
{
  // A whole-body start wins its channels for this call; per-channel answers are overridden.
  const r = await decideWith({
    body: { choice: 'collect:oak_log(10)', confidence: 0.9 },
    legs: { choice: 'follow:E0', confidence: 0.9 },
    aim: { choice: 'keep_current', confidence: 0.9 },
    hands: { choice: 'keep_current', confidence: 0.9 },
    escalate: { noul: 0.1 }
  })
  assert.deepEqual(r.started, ['collect:oak_log(10)@span-1'])
  assert.deepEqual(r.trace.output.applied, { body: 'started', legs: 'overridden', aim: 'overridden', hands: 'overridden' })
  assert.equal(r.trace.attrs['jeeve.decide.escalate'], false)
  assert.deepEqual(r.escalations, [])
}

{
  // The goal's place, encoded from the bot (yaw 0 faces -z): offered while away, started as a place target.
  const answers = { legs: { choice: 'navigate:place', confidence: 0.9 }, escalate: { noul: 0.1 } }
  const away = await decideWith(answers, [0, 3, 10])
  assert.equal(away.seen.questions.legs.criteria['navigate:place'], "Walk back to the goal's place (medium, behind, ~3 up), then stop")
  assert.deepEqual([away.started, away.targets], [['navigate:place@span-1'], [{ place: [0, 3, 10] }]])
  assert.equal(away.seen.state.directive.place, "you are not at the goal's place yet; it is medium, behind, ~3 up") // Jev sees where it is from the goal's place
  const there = await decideWith(answers, [1, 5, 1]) // within 3 blocks horizontally: already there
  assert.ok(!('navigate:place' in there.seen.questions.legs.criteria))
  assert.equal(there.seen.state.directive.place, "you are at the goal's place; it is behind-right, ~5 up")
  assert.deepEqual(there.trace.output.applied.legs, 'unknown_option')
}

// navigate walks to a place by x and z only: the block System 2 named may be up in a canopy.
{
  let goal: any
  const bot: any = { pathfinder: { setGoal: (g: unknown) => { goal = g } }, on: () => {}, removeListener: () => {} }
  const ended: string[] = []
  const ch = new Channels(bot, { start: () => {}, event: () => {}, end: (_s, r) => ended.push(r) })
  ch.set('navigate:place', 'navigate', { place: [10, 5, -3] })
  assert.deepEqual([goal.constructor.name, goal.x, goal.z, goal.rangeSq], ['GoalNearXZ', 10, -3, 4])
  // The walk belongs to that place: it keeps going while the place stands, and stops once it moves or goes.
  ch.stopStalePlace([10, 5, -3])
  assert.deepEqual([ch.slots.legs?.status, ended], ['running', []])
  ch.stopStalePlace(null)
  assert.deepEqual([ch.slots.legs, ended], [null, ['place_changed']])
}

// Goal tree: instructions replace the root, checks complete goals, escalate_if waits for for_ms,
// programs stack with goals.
{
  assert.ok(glob('*_log').test('oak_log') && !glob('*_log').test('oak_planks'))
  let inv: Record<string, number> = { oak_log: 2 }
  const bot: any = {
    inventory: { items: () => Object.entries(inv).map(([name, count]) => ({ name, count })) },
    entity: { position: new Vec3(0, 0, 0) },
    players: { Josh: { entity: { position: new Vec3(10, 0, 0) } } }
  }
  const completed: string[] = []
  const escalated: string[] = []
  const goals = new Goals({ completed: g => completed.push(g.id), escalate: (r, g) => escalated.push(`${g.id}:${r}`) })
  const spec = (s: any) => ({ player: null, radius: null, match: null, count: null, negate: false, for_ms: null, ...s })

  const a = goals.instruction('collect 3 logs', { player: 'Josh', via: 'whisper' }, bot).root
  a.done_when = compile(spec({ module: 'inventory_delta', match: '*_log', count: 3 }), a) // counted from the 2 held
  goals.tick(bot)
  assert.deepEqual(goals.progress(bot), { have: 0, want: 3 })
  inv = { oak_log: 4, birch_log: 1 }
  goals.tick(bot)
  assert.deepEqual(completed, [a.id])
  assert.equal(a.status, 'completed')
  assert.equal(goals.leaf(), null)

  const b = goals.instruction('follow me', { player: 'Josh', via: 'whisper' }, bot).root
  b.escalate_if = [compile(spec({ module: 'near_entity', player: 'Josh', radius: 5, negate: true, for_ms: 50 }), b)]
  b.program = { ...DEFAULT_PROGRAM, guidance: 'stay close' }
  goals.tick(bot)
  assert.deepEqual(escalated, []) // far, but not for 50 ms yet
  await new Promise(r => setTimeout(r, 60))
  goals.tick(bot)
  goals.tick(bot)
  assert.deepEqual(escalated, [`${b.id}:escalate_if:near_entity`]) // fires once per episode of the condition
  const child = goals.create('get away from the creeper', b.id, null, bot)
  b.place = [5, 0, 5]
  assert.equal(goals.program()?.guidance, 'stay close') // inherited from the parent
  assert.deepEqual(goals.place(), [5, 0, 5]) // so is the place
  assert.equal(goals.pathText(), `${b.id}:follow me > ${child.id}:get away from the creeper`)
  const c = goals.instruction('come here', { player: 'Josh', via: 'whisper' }, bot)
  assert.deepEqual(c.abandoned.map(g => g.id), [child.id, b.id])
  assert.equal(goals.program(), null) // back to the default
  assert.equal(goals.place(), null)
}

// Modules System 2 writes: sandboxed, trialled before registering, disabled after repeated errors.
{
  const snap = (over: object = {}) => ({ self: { pos: [0, 64, 0], health: 20 }, entities: [], inventory: { oak_log: 3, birch_log: 2 }, world: { time_of_day: 6000, is_day: true }, ...over })
  const night = { kind: 'check' as const, name: 'is_night', description: 'night has fallen', code: '(s) => !s.world.is_day' }
  const reg = new ModuleRegistry()
  const ok = reg.register(night, [snap(), snap({ world: { time_of_day: 14000, is_day: false } })])
  assert.deepEqual([ok.module?.id, ok.trial.trues, ok.trial.errors, ok.trial.error], ['is_night@1', 1, 0, undefined])
  assert.equal(reg.register(night, [snap()]).module?.id, 'is_night@2') // a new version, not a replacement in place
  assert.equal(compileModule({ ...night, code: '(s) => count(s, "*_log") >= 5 && dist(s.self.pos, [3, 64, 4]) === 5' }, 1).run(snap()), true) // prelude helpers

  const reject = (code: string) => reg.register({ ...night, name: 'bad', code }, [snap()]).trial.error ?? ''
  assert.match(reject('(s) => {'), /^compile: SyntaxError/)
  assert.match(reject('42'), /^compile: TypeError: code must be a function/)
  assert.match(reject('(s) => s.world.time_of_day'), /not a boolean/)
  assert.match(reject('(s) => { while (true) {} }'), /timed out/)
  assert.match(reject('(s) => eval("true")'), /Code generation from strings disallowed/)
  assert.equal(reg.get('bad'), undefined) // nothing failing a trial gets registered
  // No Node in the sandbox: these return true only if process/require are absent.
  assert.equal(compileModule({ ...night, code: '(s) => typeof process === "undefined" && typeof require === "undefined"' }, 1).run(snap()), true)

  const disabled: string[] = []
  const flaky = compileModule({ ...night, name: 'flaky', code: '(s) => s.missing.field' }, 1, m => disabled.push(m.id))
  for (let i = 0; i < 5; i++) flaky.run(snap())
  assert.deepEqual([disabled, flaky.stats.errors, flaky.run(snap())], [['flaky@1'], 3, false]) // stops running after 3 errors

  // The library persists across runs: the latest version of each module, with where it came from.
  const file = join(mkdtempSync(join(tmpdir(), 'jeeve-')), 'library.json')
  const first = new ModuleRegistry(() => {}, file)
  const origin = { session: 's-1', goal: 'g-1: wait until dark', created_at: '2026-10-11T00:00:00Z' }
  first.register(night, [snap()], origin)
  first.register({ ...night, name: 'broken_later', code: '(s) => s.world.is_day === true' }, [snap()])
  const broken = first.get('broken_later')!
  broken.code = '(s) => s.nope.nope' // simulate a module that starts failing at runtime
  const live = compileModule(broken, broken.version, (m, r) => first.onDisable(m, r))
  first.modules.set('broken_later', live)
  for (let i = 0; i < 3; i++) live.run(snap())
  const second = new ModuleRegistry(() => {}, file)
  const loaded = second.load()
  assert.deepEqual([loaded.loaded, loaded.skipped.length, second.get('is_night')?.origin, second.get('is_night')?.run(snap({ world: { is_day: false } }))],
    [['is_night@1'], 1, origin, true]) // disabled modules stay off across runs
}

// World queries: scan groups matches into clusters with exact counts and heights; the summary and the raw
// snapshot carry notable blocks with exact small counts, heights and positions.
{
  // A 5-log trunk at (3, 0..4, 0) with leaves from +3 to +5, and a lone log at (-6, 0, 0). Bot feet at (0, 0, 0).
  const world = new Map<string, string>()
  for (let y = 0; y < 5; y++) world.set(`3,${y},0`, 'oak_log')
  for (let y = 3; y < 6; y++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) world.set(`${3 + dx},${y},${dz}`, 'oak_leaves')
  world.set('-6,0,0', 'oak_log')
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) world.set(`${x},-1,${z}`, 'grass_block')
  const names = ['air', 'oak_log', 'oak_leaves', 'birch_log', 'grass_block']
  const bot: any = {
    username: 'W', entity: { position: new Vec3(0.5, 0, 0.5), yaw: 0 },
    registry: { blocksArray: names.map((name, id) => ({ name, id })) },
    blockAt: (p: Vec3) => ({ name: world.get(`${p.x},${p.y},${p.z}`) ?? 'air', position: p.clone() }),
    findBlocks: ({ matching, maxDistance }: { matching: number[], maxDistance: number }) => [...world.entries()]
      .filter(([, n]) => matching.includes(names.indexOf(n)))
      .map(([k]) => new Vec3(...k.split(',').map(Number) as [number, number, number]))
      .filter(p => p.distanceTo(new Vec3(0, 0, 0)) <= maxDistance),
    canSeeBlock: (b: { position: Vec3 }) => b.position.x > 0
  }
  const logs = scan(bot, { match: '*_log', radius: 16 })
  assert.deepEqual(logs.clusters.map(c => [c.count, c.nearest, c.y_rel, c.min, c.max]), [
    [5, [3, 0, 0], [0, 4], [3, 0, 0], [3, 4, 0]],
    [1, [-6, 0, 0], [0, 0], [-6, 0, 0], [-6, 0, 0]]
  ])
  assert.equal(logs.total, 6)
  assert.deepEqual(scan(bot, { match: '*_log', radius: 16, los: true }).clusters.map(c => c.count), [5]) // line of sight hides one
  const leaves = scan(bot, { match: 'oak_leaves' })
  assert.deepEqual([leaves.total, leaves.clusters.length, leaves.clusters[0].y_rel], [12, 1, [3, 5]])
  assert.equal(scan(bot, { match: 'diamond_ore' }).total, 0)
  assert.equal(blockAt(bot, [3, 2, 0]), 'oak_log')

  const notable = notableBlocks(bot, 8, 64)
  assert.deepEqual(notable.map(n => [n.name, n.count]), [['oak_log', 6], ['oak_leaves', 12]]) // grass (289) is terrain
  const raw = rawSnapshot({ ...bot, inventory: undefined, entities: {}, health: 20, food: 20 } as any)
  assert.deepEqual(raw.blocks.oak_log.slice(0, 2), [[3, 0, 0], [3, 1, 0]])
  const encoded = makeEgocentric({ entity_cap: 8, radius: 16, block_radius: 8, block_cap: 6, rare_max: 64 })(
    { ...bot, entities: {}, health: 20, food: 20, heldItem: null, inventory: { items: () => [] } } as any,
    { handles: newHandles(), directive: null, channels: {}, events: [] })
  assert.deepEqual(encoded.state.blocks, [
    { name: 'oak_log', count: 'many (6)', nearest: 'close, right' },
    { name: 'oak_leaves', count: 'many', nearest: 'close, right, ~3 up' }
  ])
}

// reachable: the real pathfinder and guarded Movements on a flat world. An unreachable block exhausts the box
// around the bot and the block (noPath, not timeout); a path that detours 12 blocks still fits in it.
{
  const registry = registryFor('1.21.8')
  const World = (worldLoader as any)(registry)
  const Chunk = (chunkLoader as any)(registry)
  const world = new World().sync
  const set = (x: number, y: number, z: number, name: string) => world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState)
  for (let cx = -4; cx < 4; cx++) for (let cz = -4; cz < 4; cz++) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }))
  for (let x = -64; x < 64; x++) for (let z = -64; z < 64; z++) set(x, -1, z, 'grass_block')
  set(6, 0, 0, 'oak_log')
  for (let y = 0; y < 12; y++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) set(-10 + dx, y, dz, 'stone')
  set(-10, 12, 0, 'oak_log') // on top of a stone pillar: no placing, and stone can't be broken
  for (let z = -12; z <= 12; z++) for (let y = 0; y < 3; y++) set(12, y, z, 'stone')
  set(14, 0, 0, 'oak_log') // behind a wall: the path goes round its end
  const bot: any = Object.assign(new EventEmitter(), {
    registry, world, game: { minY: -64 }, entities: {}, inventory: { items: () => [], slots: [] },
    entity: { position: new Vec3(0.5, 0, 0.5), onGround: true, effects: {}, height: 1.8 },
    blockAt: (p: Vec3) => world.getBlock(p), clearControlStates () {}
  })
  pf.pathfinder(bot)
  bot.pathfinder.setMovements(guardedMovements(bot))
  const status = async (p: [number, number, number]) => (await reachable(bot, p)).status
  assert.deepEqual([await status([6, 0, 0]), await status([-10, 12, 0]), await status([14, 0, 0])], ['success', 'noPath', 'success'])
}

// Behaviors System 2 writes: async code in a fresh realm per run, talking to the host only through strings.
{
  const run = (code: string, over: Partial<BehaviorHost> = {}) => new Promise<{ value?: unknown, error?: string }>(resolve => {
    startBehavior(code, { name: 'oak_leaves', count: 2 }, {
      reads: ['blockAt'], actions: ['wait'],
      read: (_n, [x]) => x === 0 ? 'oak_log' : null,
      act: async (_n, [t]) => { await new Promise(r => setTimeout(r, 5)); return t },
      end: resolve, ...over
    })
  })
  // Sync reads, awaited actions, the target as plain data.
  assert.deepEqual(await run('async (api, t) => [api.blockAt(0, 0, 0), api.blockAt(1, 0, 0), await api.wait(3), t.name].join(",")'), { value: 'oak_log,,3,oak_leaves' })
  assert.deepEqual(await run('async (api) => { await api.wait(1); throw new Error("boom") }'), { error: 'boom' })
  // No way back to the host: no bridge, no host Function through the api, no Node, no string eval.
  assert.deepEqual(await run('async (api) => [typeof __bridge, typeof process, typeof require].join()'), { value: 'undefined,undefined,undefined' })
  assert.match((await run('async (api) => api.blockAt.constructor("return process")()')).error!, /Code generation from strings disallowed/)
  // A busy loop after an await is killed by the per-entry timeout instead of freezing the bot.
  assert.match((await run('async (api) => { await api.wait(1); while (true) {} }')).error!, /timed out/)
  // A cancelled run is never entered again and reports nothing.
  {
    let ended = false
    const r = startBehavior('async (api) => { await api.wait(1); return "done" }', null, { reads: [], actions: ['wait'], read: () => null, act: () => new Promise(res => setTimeout(res, 20)), end: () => { ended = true } })
    r.cancel()
    await new Promise(res => setTimeout(res, 50))
    assert.equal(ended, false)
  }
  // A run whose actions keep failing at once still yields to the event loop, so timers (its time limit, the
  // heartbeat, guards) still run. Settling in microtasks starved them: a Sonnet-written craft loop froze the agent.
  {
    let ticked = false
    const r = startBehavior('async (api) => { for (;;) { try { await api.wait(1) } catch (e) {} } }', null, {
      reads: [], actions: ['wait'], read: () => null, act: async () => { throw new Error('no') }, end: () => {}
    })
    await new Promise(res => setTimeout(() => { ticked = true; res(null) }, 30))
    r.cancel()
    assert.ok(ticked)
  }
  const shape = { kind: 'behavior' as const, name: 'pillar', description: 'pillar up', code: 'async (api, t) => "done"', channels: ['legs', 'aim', 'hands'], targets: 'block' as const, timeout_s: 30 }
  compileBehavior(shape)
  compileBehavior({ ...shape, channels: ['hands'] })
  assert.throws(() => compileBehavior({ ...shape, channels: ['legs', 'hands'] }), /channels must be one of/)
  assert.throws(() => compileBehavior({ ...shape, timeout_s: 600 }), /timeout_s/)
  assert.throws(() => compileBehavior({ ...shape, code: '42' }), /function expression/)

  // On the channel runtime, with a fake bot whose guard vetoes every forward: the veto rejects the call.
  const fakeWorld = { blockAt: () => null, scan: () => ({}), reachable: async () => ({ reachable: false }), allowed: ['Josh'] }
  const ended: string[] = []
  const events: string[] = []
  let channels: Channels
  const whispered: string[] = []
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true }, entities: {}, health: 20, food: 20, heldItem: null,
    whisper: (to: string, text: string) => whispered.push(`${to}: ${text}`),
    inventory: { items: () => [] },
    setControlState: (_c: string, on: boolean) => { if (on) channels.veto('legs', 'forward: drop of more than 3') },
    pathfinder: { setGoal: () => {} }, stopDigging: () => {}, waitForTicks: async () => {}
  })
  channels = new Channels(bot, { start: () => {}, event: (_s, e) => events.push(e), end: (_s, r) => ended.push(r) })
  const play = async (code: string, ch = ['legs'], ms = 30) => {
    ended.length = 0
    events.length = 0
    const spec = authoredSpec({ ...shape, code, channels: ch, version: 1 }, fakeWorld)
    channels.set('t:trial', 't', { name: 'stone', count: 1 }, 'operator', { spec, pinned: true })
    await new Promise(r => setTimeout(r, ms))
    return { end: ended[0], events: [...events], detail: channels.slots[ch[0] as 'legs']?.run.detail?.() as any }
  }
  const vetoed = await play('async (api) => { await api.control("forward", true); return "done" }')
  assert.deepEqual([vetoed.end, vetoed.events], ['vetoed', ['vetoed (forward: drop of more than 3)', 'vetoed']])
  assert.deepEqual(vetoed.detail.actions.map((a: any) => [a.call, a.ok]), [['control("forward", true)', false]])
  assert.equal((await play('async (api) => { try { await api.control("forward", true) } catch (e) { return "stuck" } }')).end, 'stuck') // caught: the code adapts
  assert.match((await play('async (api) => { await api.dig(0, 0, 0) }')).detail.error, /needs the hands channel/)
  assert.match((await play('async (api) => "finished"')).detail.error, /returned "finished"/)
  // Chat policy: whispers reach players who give instructions only, and never run a command.
  const said = await play('async (api) => { await api.whisper("Josh", "logs are in the chest"); for (const [p, t] of [["Stranger", "hi"], ["Josh", "/op Stranger"]]) { try { await api.whisper(p, t); return "stuck" } catch {} } return "done" }')
  assert.deepEqual([said.end, whispered], ['done', ['Josh: logs are in the chest']], JSON.stringify(said.detail))
  // Events: next() resolves with the next bot event's arguments as plain data, and null on timeout.
  setTimeout(() => bot.emit('entityHurt', { id: 7, name: 'zombie', type: 'hostile', position: new Vec3(1, 2, 3), yaw: 0 }, null), 5)
  assert.equal((await play('async (api) => { const e = await api.next("entityHurt", 20); return e[0].name === "zombie" && e[0].pos[2] === 3 && e[1] === null ? "done" : "stuck" }', ['hands'])).end, 'done')
  assert.equal((await play('async (api) => (await api.next("never", 1)) === null ? "done" : "stuck"', ['legs'], 80)).end, 'done')
  assert.equal(bot.listenerCount('entityHurt') + bot.listenerCount('never'), 0) // listeners don't outlive the call

  // The library keeps behaviors with their channels and target type, and reloads them.
  const file = join(mkdtempSync(join(tmpdir(), 'jeeve-')), 'library.json')
  new ModuleRegistry(() => {}, file).addBehavior(shape, 1, { target: { block: 'oak_leaves', count: 2, entity: null }, end: 'done', ms: 1200 })
  const again = new ModuleRegistry(() => {}, file)
  assert.deepEqual(again.load().loaded, ['pillar@1'])
  assert.deepEqual([again.get('pillar')?.channels, again.get('pillar')?.targets, again.nextVersion('pillar')], [['legs', 'aim', 'hands'], 'block', 2])
}

// The action API covers Mineflayer: every Bot method is covered by a read or an action, or NOT_MAPPED says why.
// A Mineflayer upgrade that adds a method fails here until someone decides what it is.
{
  const dts = readFileSync(new URL('../node_modules/mineflayer/index.d.ts', import.meta.url), 'utf8')
  const body = dts.slice(dts.indexOf('export interface Bot extends'), dts.indexOf('\n}', dts.indexOf('export interface Bot extends')))
  const methods = [...body.matchAll(/^ {2}(\w+)\??: \(/gm)].map(m => m[1]).concat('creative')
  assert.ok(methods.length > 80, `parsed ${methods.length} Bot methods`)
  assert.deepEqual(methods.filter(m => !API_COVERS.has(m) && !NOT_MAPPED[m]), [], 'Bot methods neither covered nor in NOT_MAPPED')
  assert.deepEqual([...API_COVERS, ...Object.keys(NOT_MAPPED)].filter(m => !methods.includes(m)), [], 'covers or NOT_MAPPED name a method Mineflayer lacks')
  for (const n of [...API_READS, ...API_ACTIONS]) assert.ok(API_DOC.includes(`api.${n}(`), `API_DOC documents ${n}`)
}

// Item targets: Jev is offered an item behavior for the item the goal still needs, like collect for blocks.
{
  BEHAVIORS.make_it = { channels: ['hands'], targets: 'item', describe: t => `Craft ${t}`, start: () => ({ stop () {} }) }
  const opts = optionsFor(['hands'], ['make_it'], { entities: [], blocks: [], place: null }, null, () => 0, [{ name: 'wooden_pickaxe', count: 1 }])
  assert.deepEqual(opts['make_it:wooden_pickaxe(1)'], { desc: 'Craft 1 wooden_pickaxe', behavior: 'make_it', block: { name: 'wooden_pickaxe', count: 1 } })
  assert.deepEqual(Object.keys(optionsFor(['hands'], ['make_it'], { entities: [], blocks: [], place: null }, null, () => 0)), ['keep_current'])
  delete BEHAVIORS.make_it
}

// The builder (2B): it trials what it writes and stops once a trial passes; it never grades its own work.
{
  const draft = (code: string) => ({ name: 'reach_up', description: 'build up to a block', code, channels: ['legs', 'aim', 'hands'], targets: 'block', timeout_s: 30, usage: 'pick it for blocks out of reach' })
  const turn = (input: object, id: string) => ({
    content: [{ type: 'tool-call' as const, toolCallId: id, toolName: 'write_behavior', input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: { inputTokens: {}, outputTokens: {} } as any, warnings: []
  })
  const model = new MockLanguageModelV4({ doGenerate: [turn(draft('async () => "stuck"'), 'a'), turn(draft('async () => "done"'), 'b'), turn(draft('async () => "done"'), 'c')] })
  const req: CapabilityRequest = { id: 'c-1', need: 'break blocks out of reach', constraints: [], targets: 'block', trial: { block: 'oak_leaves', count: 9 }, pass_when: 'no_leaves' }
  const trials: string[] = []
  const result = await build(req, { request: req }, {
    // The runtime runs the trial and judges it with the request's pass_when: here, code that returns "done" passes.
    trial: async d => { trials.push(d.code); const ok = d.code.includes('done'); return { behavior: `${d.name}@${trials.length}`, passed: ok, end: ok ? 'done' : 'stuck', ms: 1, preempted: 0 } },
    perceive: async () => ({})
  }, new AbortController().signal, trace.getTracer('selfcheck').startSpan('builder'), 's', model)
  assert.equal(trials.length, 2) // stopped after the passing trial
  assert.deepEqual(result.status === 'registered' && [result.behavior, result.usage, result.attempts.map(a => a.end)], ['reach_up@2', 'pick it for blocks out of reach', ['stuck', 'done']])
}

console.log('selfcheck ok')
