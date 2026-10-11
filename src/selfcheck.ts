// Offline self-check: node src/selfcheck.ts. No server, no network.
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { coalescing, makeDecider } from './decide.ts'
import { direction, distanceBucket, newHandles } from './encoder.ts'
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

// Options: allowed behaviors on the channel × entities, plus keep_current and stop.
const ents = [{ id: 'E0', desc: 'player Josh, close, ahead' }, { id: 'E1', desc: 'zombie (hostile), close, left' }]
// No duplicates: idle → no `stop`; running → the running option appears only as keep_current.
assert.deepEqual(Object.keys(optionsFor('legs', DEFAULT_PROGRAM.allowed_behaviors, ents, null)),
  ['keep_current', 'navigate:E0', 'navigate:E1', 'follow:E0', 'follow:E1'])
assert.deepEqual(Object.keys(optionsFor('legs', DEFAULT_PROGRAM.allowed_behaviors, ents, 'follow:E0')),
  ['keep_current', 'stop', 'navigate:E0', 'navigate:E1', 'follow:E1'])
assert.deepEqual(Object.keys(optionsFor('hands', DEFAULT_PROGRAM.allowed_behaviors, ents, null)),
  ['keep_current', 'attack_when_ready:E0', 'attack_when_ready:E1'])

// Bounds: the default program passes; one that could exceed 255 options per Choice doesn't.
validate(DEFAULT_PROGRAM)
assert.throws(() => validate({ ...DEFAULT_PROGRAM, encoder: { ...DEFAULT_PROGRAM.encoder, params: { entity_cap: 200, radius: 16 } } }), /options/)
assert.match(version(DEFAULT_PROGRAM), /^v-[0-9a-f]{8}$/)

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

// One decision end to end with a fake bot and a fake Jev: binds handles, skips stale targets, traces.
{
  const me = { id: 1, position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0), yaw: 0, type: 'player', username: 'Jeeve' }
  const josh = { id: 2, position: new Vec3(0, 0, -5), velocity: new Vec3(0, 0, 0), type: 'player', username: 'Josh', height: 1.8 }
  const bot: any = { entity: me, entities: { 1: me, 2: josh }, health: 20, food: 20, heldItem: null }
  const started: string[] = []
  const channels: any = {
    slots: { legs: null, aim: null, hands: null },
    describe: () => ({ legs: 'idle', aim: 'idle', hands: 'idle' }),
    set: (c: string, key: string) => started.push(`${c}=${key}`)
  }
  const traces: any[] = []
  let seen: any
  const decide = makeDecider({
    bot, program: DEFAULT_PROGRAM, handles: newHandles(), channels, trace: r => traces.push(r),
    directive: () => ({ text: 'come here', from: 'Josh', at: 0 }), events: () => [],
    ask: async (state, questions) => {
      seen = { state, questions }
      return { model: 'fake', answers: {
        legs: { choice: 'navigate:E0', confidence: 0.9 },
        aim: { choice: 'track:E9', confidence: 0.9 }, // unknown handle → stale
        hands: { choice: 'keep_current', confidence: 0.2 }, // low confidence → escalate
        escalate: { noul: 0.1 }
      } }
    }
  })
  await decide(['test'])
  assert.deepEqual(started, ['legs=navigate:E0'])
  assert.equal(seen.state.directive.from, 'player Josh (E0)')
  assert.deepEqual(seen.state.entities, [{ id: 'E0', what: 'player Josh', where: 'close, ahead', motion: 'steady' }])
  assert.deepEqual(new Set(Object.keys(seen.questions.legs.criteria)), new Set(['keep_current', 'navigate:E0', 'follow:E0']))
  assert.deepEqual(traces[0].applied, { legs: 'started', aim: 'stale_target', hands: 'kept' })
  assert.equal(traces[0].escalate, true)
  assert.deepEqual(Object.keys(traces[0].option_order), ['legs', 'aim', 'hands'])
}

console.log('selfcheck ok')
