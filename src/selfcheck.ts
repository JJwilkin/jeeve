// Offline self-check: node src/selfcheck.ts. No server, no network.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import { coalescing, makeDecider } from './decide.ts'
import { direction, distanceBucket, newHandles } from './encoder.ts'
import { compile, glob, Goals } from './goals.ts'
import { controlVector, unsafeAt } from './guards.ts'
import { compileModule, ModuleRegistry } from './modules.ts'
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
async function decideWith (answers: Record<string, any>) {
  const me = { id: 1, position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0), yaw: 0, type: 'player', username: 'Jeeve' }
  const josh = { id: 2, position: new Vec3(0, 0, -5), velocity: new Vec3(0, 0, 0), type: 'player', username: 'Josh', height: 1.8 }
  const bot: any = {
    entity: me, entities: { 1: me, 2: josh }, health: 20, food: 20, heldItem: null,
    inventory: { items: () => [] },
    blockAt: (p: Vec3) => p.x === 0 && p.y === 0 && p.z === -3 ? { name: 'oak_log', position: p } : null
  }
  const started: string[] = []
  const channels: any = {
    slots: { legs: null, aim: null, hands: null },
    describe: () => ({ legs: 'idle', aim: 'idle', hands: 'idle' }),
    set: (key: string, _b: string, _t: unknown, by: string) => started.push(`${key}@${by}`),
    stop: () => {}
  }
  const traces: any[] = []
  const escalations: string[] = []
  let seen: any
  const decide = makeDecider({
    bot, program: DEFAULT_PROGRAM, handles: newHandles(), channels,
    record: r => { traces.push(r); return 'span-1' },
    escalate: reason => escalations.push(reason),
    directive: () => ({ text: 'collect 10 logs', from: 'Josh', at: 0, inventory: {} }), events: () => [],
    remaining: () => 10,
    ask: async (state, questions) => { seen = { state, questions }; return { model: 'fake', answers } }
  })
  await decide(['test'])
  return { started, trace: traces[0], seen, escalations }
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
  assert.equal(goals.program()?.guidance, 'stay close') // inherited from the parent
  assert.equal(goals.pathText(), `${b.id}:follow me > ${child.id}:get away from the creeper`)
  const c = goals.instruction('come here', { player: 'Josh', via: 'whisper' }, bot)
  assert.deepEqual(c.abandoned.map(g => g.id), [child.id, b.id])
  assert.equal(goals.program(), null) // back to the default
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

console.log('selfcheck ok')
