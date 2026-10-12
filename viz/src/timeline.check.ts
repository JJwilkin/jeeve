// Self-check for the timeline core: node src/timeline.check.ts. A synthetic canopy episode, then (if given) a real
// trace file: node src/timeline.check.ts ../traces/<session>.jsonl prints its beats and speed-ups.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { activity, beats, duration, parse, speedups, stateAt, traceTime, type Row } from './timeline.ts'

const code = 'async (api, t) => {\n  await api.place([0, 1, 0], "oak_log")\n  await api.dig([0, 5, 0])\n  return "done"\n}'
const decide = (t: number, pos: number[], changed = false): Row => ({ t, kind: 'decide', attrs: { 'jeeve.decide.changed': changed, 'jeeve.decide.latency_ms': 190, 'jeeve.decide.raw_state': JSON.stringify({ self: { pos, health: 20 } }) }, output: { answers: { body: { type: 'choice', choice: 'keep_current', confidence: 0.9, probabilities: { keep_current: 0.9, collect: 0.1 } }, escalate: { type: 'noul', noul: 0.2 } } } })
const rows: Row[] = [
  { t: 1000, kind: 'goal', attrs: { 'jeeve.goal.path': 'g-1:break the tree', 'jeeve.goal.transition': 'pushed' }, input: { text: 'break the tree', from: { player: 'Josh', via: 'whisper' } } },
  { t: 1000, kind: 'start', name: 'system2', span_id: 's1', attrs: { 'jeeve.system2.trigger': 'instruction' } },
  decide(1500, [0, 0, 0], true),
  { t: 5000, kind: 'system2', span_id: 's1', attrs: { 'jeeve.system2.trigger': 'instruction' }, output: { decision: { note: 'needs a pillaring skill', requests: [{}] } } },
  { t: 5000, kind: 'request', attrs: { 'jeeve.request.id': 'c-1' }, input: { need: 'pillar up to break leaves', pass_when: 'leaves_gone' } },
  { t: 5001, kind: 'start', name: 'builder', span_id: 'b1', attrs: { 'jeeve.request.id': 'c-1' } },
  decide(6000, [0, 0, 0]), decide(30000, [0, 0, 0]), // the builder thinks; nothing moves
  { t: 60000, kind: 'builder_tool', request: 'c-1', tool: 'write_behavior', phase: 'start', input: { name: 'pillar', code } },
  { t: 61000, kind: 'event', name: 'trial_window', attrs: { request: 'c-1', behavior: 'pillar' } },
  { t: 61000, kind: 'behavior_start', run_id: 'r-9', name: 'pillar', attrs: { 'jeeve.behavior.channels': 'legs+aim+hands', 'jeeve.behavior.params': 'pillar:trial' } },
  { t: 61100, kind: 'api_call', run_id: 'r-9', call: 'place(...)', line: 2, phase: 'start' },
  { t: 61400, kind: 'api_call', run_id: 'r-9', call: 'place(...)', line: 2, phase: 'end', ok: true },
  { t: 61500, kind: 'api_call', run_id: 'r-9', call: 'dig(...)', line: 3, phase: 'start' },
  { t: 63000, kind: 'behavior_end', run_id: 'r-9', reason: 'done' },
  { t: 63100, kind: 'trial', attrs: { 'jeeve.request.id': 'c-1', 'jeeve.trial.passed': true, 'jeeve.trial.end': 'done', 'jeeve.module.id': 'pillar@1' } },
  { t: 63200, kind: 'builder_tool', request: 'c-1', tool: 'write_behavior', phase: 'end', output: '{}' },
  { t: 64000, kind: 'builder', span_id: 'b1', attrs: { 'jeeve.builder.status': 'registered' }, input: { request: { id: 'c-1' } }, output: { status: 'registered', behavior: 'pillar@1' } }
]
const text = rows.map(r => JSON.stringify(r)).join('\n')
const tl = parse(text)

let s = stateAt(tl, 2000)
assert.equal(s.system2.thinking, true)
assert.equal(s.messages[0]?.from, 'player') // the instruction, still in flight at +1 s
assert.equal(s.system1.answers[0].choice, 'keep_current')
s = stateAt(tl, 20000)
assert.deepEqual([s.system2.thinking, s.system2.note, s.builder.status, s.builder.request?.id], [false, 'needs a pillaring skill', 'thinking', 'c-1'])
s = stateAt(tl, 60500)
assert.deepEqual([s.builder.status, s.builder.trial, s.code?.name, s.code?.live], ['waiting', 1, 'pillar', false])
s = stateAt(tl, 61600) // the trial runs: line 2 placed, line 3 digging now
assert.deepEqual([s.builder.status, s.code?.live, s.code?.running?.line, s.code?.marks], ['trialling', true, 3, { 2: true }])
assert.equal(s.system1.channels.legs, 'pillar:trial')
s = stateAt(tl, 65000)
assert.deepEqual([s.builder.status, s.builder.result, s.code?.live, s.system1.channels.legs], ['registered', 'registered pillar@1', false, null])

assert.deepEqual(beats(tl).map(b => b.kind), ['instruction', 'request', 'draft', 'trial_window', 'trial_passed'])
// The builder's 55 s of thinking (5.0 → 60.0 s, the bot still) plays in 2 s; the rest at 1×.
const segs = speedups(activity(tl), 1000, 65000)
const fast = segs.filter(x => x.rate > 1)
assert.equal(fast.length, 1)
assert.deepEqual([fast[0].t0, fast[0].t1], [6001, 59000])
assert.equal(Math.round(duration(segs)), 64000 - (59000 - 6001) + 2000)
assert.equal(Math.round(traceTime(segs, 5001 + 1000).t), Math.round(6001 + 1000 * fast[0].rate)) // 1 s into the squash
console.log('timeline check ok')

const file = process.argv[2]
if (file) {
  const real = parse(readFileSync(file, 'utf8'))
  for (const b of beats(real)) console.log(new Date(b.t).toISOString().slice(11, 19), b.kind.padEnd(14), b.text)
  const sp = speedups(activity(real), real[0].t, real.at(-1)!.t)
  console.log(`${real.length} rows, ${((real.at(-1)!.t - real[0].t) / 1000).toFixed(0)} s → ${(duration(sp) / 1000).toFixed(0)} s with ${sp.filter(x => x.rate > 1).length} squashed stretches`)
}
