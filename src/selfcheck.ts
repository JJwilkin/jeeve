// Offline self-check: node src/selfcheck.ts. No server, no network.
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { coalescing, makeDecider } from './decide.ts'
import { direction, distanceBucket, newHandles } from './encoder.ts'
import { controlVector, unsafeAt } from './guards.ts'
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
    set: (key: string) => started.push(key),
    stop: () => {}
  }
  const traces: any[] = []
  let seen: any
  const decide = makeDecider({
    bot, program: DEFAULT_PROGRAM, handles: newHandles(), channels, trace: r => traces.push(r),
    directive: () => ({ text: 'collect 10 logs', from: 'Josh', at: 0, inventory: {} }), events: () => [],
    remaining: () => 10,
    ask: async (state, questions) => { seen = { state, questions }; return { model: 'fake', answers } }
  })
  await decide(['test'])
  return { started, trace: traces[0], seen }
}

{
  const r = await decideWith({
    body: { choice: 'keep_current', confidence: 0.9 },
    legs: { choice: 'navigate:E0', confidence: 0.9 },
    aim: { choice: 'track:E9', confidence: 0.9 }, // not an offered option
    hands: { choice: 'keep_current', confidence: 0.2 }, // low confidence → escalate
    escalate: { noul: 0.1 }
  })
  assert.deepEqual(r.started, ['navigate:E0'])
  assert.equal(r.seen.state.directive.from, 'player Josh (E0)')
  assert.deepEqual(r.seen.state.entities, [{ id: 'E0', what: 'player Josh', where: 'close, ahead', motion: 'steady' }])
  assert.deepEqual(r.seen.state.blocks, [{ name: 'oak_log', count: 'one', nearest: 'very close, ahead' }])
  assert.deepEqual(new Set(keys(r.seen.questions.body.criteria)), new Set(['keep_current', 'collect:oak_log(10)']))
  assert.deepEqual(r.trace.applied, { body: 'kept', legs: 'started', aim: 'unknown_option', hands: 'kept' })
  assert.equal(r.trace.escalate, true)
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
  assert.deepEqual(r.started, ['collect:oak_log(10)'])
  assert.deepEqual(r.trace.applied, { body: 'started', legs: 'overridden', aim: 'overridden', hands: 'overridden' })
  assert.equal(r.trace.escalate, false)
}

console.log('selfcheck ok')
