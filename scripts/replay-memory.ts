// Replay experiment for brain/architecture/stateful-system-1.md, offline over recorded bench traces.
// 1. Escalation counterfactual (no Jev calls): which low_confidence escalations survive other rules.
// 2. Memory A/B (Jev calls): ask doubtful questions again with and without a memory block rebuilt from the trace.
// Usage: node --env-file=../judgment/.env.jeeve scripts/replay-memory.ts [--traces DIR] [--runs 59] [--n 200] [--no-jev]
import { writeFileSync } from 'node:fs'
import { ago, arg, askJev, changedNothing, CHOICES, loadSessions, MOOT, optionTarget, reorder, type Row } from './replay-lib.ts'

const N = Number(arg('n', '200'))
const NO_JEV = process.argv.includes('--no-jev')
const KEYS = arg('keys', '') // only these memory lines, e.g. plan,doing (an ablation)
const OUT = arg('out', 'bench/replay-memory.json')
const CONF = Number(arg('conf', '0.5')) // the escalation threshold replayed (the program's confidence_below)
const sessions = loadSessions()
const unsure = (d: Row) => CHOICES.filter(q => d.output?.answers?.[q]?.confidence < CONF)

// ---------- 1. counterfactual ----------
type Flag = { sess: number, scenario: string, span: string, t: number, today: boolean, live: boolean, persist: boolean, dither: boolean, change: boolean }
const flags: Flag[] = []
const sent = new Map<string, { sess: number, scenario: string, t: number, acted: boolean | null, risky: boolean }>() // decide span → the low_confidence escalation it caused
for (const [si, s] of sessions.entries()) {
  const hist: Record<string, Array<{ u: boolean, c: string }>> = {}
  const danger = s.rows.filter(r => (r.kind === 'event' && (r.name === 'damage' || r.name === 'owner_damage')) || (r.kind === 'escalation_sent' && ['owner_hurt', 'stalled', 'death'].includes(r.reason))).map(r => r.t)
  for (const d of s.rows) {
    if (d.kind !== 'decide') continue
    const ans = d.output?.answers ?? {}
    const applied = d.output?.applied ?? {}
    let today = false; let live = false; let persist = false; let dither = false; let change = false
    for (const q of CHOICES) {
      if (!ans[q]) continue
      const u = ans[q].confidence < CONF
      const moot = MOOT.has(applied[q])
      const h = (hist[q] ??= [])
      h.push({ u: u && !moot, c: optionTarget(ans[q].choice) })
      if (h.length > 5) h.shift()
      if (!u) continue
      today = true
      if (moot) continue
      live = true
      if (ans[q].choice !== 'keep_current') change = true // doubt about switching, not about carrying on
      const doubts = h.filter(e => e.u)
      if (doubts.length >= 3) { persist = true; if (new Set(doubts.map(e => e.c)).size > 1) dither = true }
    }
    if (today) flags.push({ sess: si, scenario: s.scenario, span: d.span_id, t: d.t, today, live, persist, dither, change })
  }
  for (const e of s.rows) {
    if (e.kind !== 'escalation_sent' || e.reason !== 'low_confidence' || !e.detail?.decide_span) continue
    const call = s.rows.find(r => r.kind === 'system2' && r.t > e.t && r.input?.triggers?.some((t: Row) => t.detail?.decide_span === e.detail.decide_span))
    const d = call?.output?.decision
    sent.set(e.detail.decide_span, { sess: si, scenario: s.scenario, t: e.t, acted: d ? !changedNothing(d) : null, risky: danger.some(t => Math.abs(t - e.t) <= 10_000) })
  }
}
const rules = { today: (f: Flag) => f.today, live: (f: Flag) => f.live, persist: (f: Flag) => f.persist, dither: (f: Flag) => f.dither, change: (f: Flag) => f.change } as const
const cf: Record<string, unknown> = { decides: sessions.reduce((a, s) => a + s.rows.filter(r => r.kind === 'decide').length, 0) }
// A rule that waits for persistence raises the same doubt a call or two later, so a sent escalation counts as kept
// when the rule fires on that session within LATE_MS of it; the delay is reported.
const LATE_MS = 5000
for (const [name, keep] of Object.entries(rules)) {
  const kept = flags.filter(keep)
  const sentRows = [...sent.values()]
  const delays: number[] = []
  const dropped = sentRows.filter(v => {
    const f = kept.find(f => f.sess === v.sess && f.t >= v.t - 1000 && f.t <= v.t + LATE_MS)
    if (f) delays.push(Math.max(0, f.t - v.t))
    return !f
  })
  delays.sort((a, b) => a - b)
  cf[name] = {
    flagged_calls: kept.length,
    sent_kept: sentRows.length - dropped.length,
    kept_delay_ms_p50: delays[Math.floor(delays.length / 2)] ?? null,
    kept_delay_ms_p90: delays[Math.floor(delays.length * 0.9)] ?? null,
    sent_dropped: dropped.length,
    dropped_2a_acted: dropped.filter(v => v.acted).length,
    dropped_2a_nothing: dropped.filter(v => v.acted === false).length,
    dropped_near_damage_or_stall: dropped.filter(v => v.risky).length
  }
}
console.log('counterfactual', JSON.stringify(cf, null, 1))

// ---------- 2. memory A/B ----------
const times = (n: number) => n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`

// The memory block of the proposal, rebuilt from what the trace held before the decide at t. Code-written facts only.
function memoryAt (rows: Row[], i: number) {
  const t = rows[i].t
  const before = rows.slice(0, i)
  const pushed = before.filter(r => r.kind === 'goal' && r.attrs?.['jeeve.goal.transition'] === 'pushed')
  const closed = new Set(before.filter(r => r.kind === 'goal' && r.attrs?.['jeeve.goal.transition'] !== 'pushed').map(r => r.attrs['jeeve.goal.id']))
  const open = pushed.filter(r => !closed.has(r.attrs['jeeve.goal.id']))
  const root = open.find(r => !r.attrs['jeeve.goal.plan_step']) ?? open[0]
  const step = open.findLast(r => r.attrs['jeeve.goal.plan_step'])
  const memory: Record<string, unknown> = {}
  if (step) {
    const [k, n] = String(step.attrs['jeeve.goal.plan_step']).split('/').map(Number)
    const plan = before.findLast(r => r.kind === 'system2' && r.output?.decision?.plan?.length)?.output.decision.plan
    const next = plan?.[k]?.text
    memory.plan = `you are on step ${k} of ${n}: ${step.input?.text}${next ? `; the next step is: ${next}` : k === n ? '; it is the last step' : ''}`
  }
  const rootAt = root?.t ?? 0
  const starts = before.filter(r => r.kind === 'behavior_start' && r.t >= rootAt)
  const ends = new Map(before.filter(r => r.kind === 'behavior_end').map(r => [r.run_id, r]))
  const triggerOf = new Map(before.filter(r => r.kind === 'decide').map(r => [r.span_id, r.attrs['jeeve.decide.trigger']]))
  const doing: string[] = []
  for (const s of starts.filter(s => !ends.has(s.run_id))) {
    const by = s.attrs['jeeve.behavior.decided_by']
    const why = triggerOf.get(by)
    doing.push(`${s.attrs['jeeve.behavior.params']} on ${s.attrs['jeeve.behavior.channels'].replaceAll('+', ', ')}, started ${ago(t - s.t)}${why ? ` (you chose it on ${String(why).split(',')[0].replace(/^.*:/, '')})` : ''}`)
  }
  if (doing.length) memory.doing = doing
  // The last behavior that was replaced by something else lately: what to come back to.
  const replaced = starts.findLast(s => ends.get(s.run_id)?.reason === 'replaced' && t - ends.get(s.run_id).t < 30_000)
  if (replaced) memory.interrupted = `${replaced.attrs['jeeve.behavior.params']} was replaced ${ago(t - ends.get(replaced.run_id).t)}`
  const tried = new Map<string, { n: number, how: Map<string, number>, last: number }>()
  for (const s of starts) {
    const e = ends.get(s.run_id)
    if (!e || e.reason === 'replaced') continue
    const k = optionTarget(s.attrs['jeeve.behavior.params'])
    const x = tried.get(k) ?? { n: 0, how: new Map(), last: 0 }
    x.n++; x.how.set(e.reason, (x.how.get(e.reason) ?? 0) + 1); x.last = Math.max(x.last, e.t)
    tried.set(k, x)
  }
  const triedLines = [...tried.entries()].sort((a, b) => b[1].last - a[1].last).slice(0, 4)
    .map(([k, x]) => `${k}: ${[...x.how.entries()].map(([how, n]) => `${how} ${times(n)}`).join(', ')}, last ${ago(t - x.last)}`)
  if (triedLines.length) memory.tried = triedLines
  if (starts.some(s => !ends.has(s.run_id) && s.attrs['jeeve.behavior.channels'].includes('+'))) memory.held = 'a running whole-body task can only be changed by the body question, unless the bot is under threat'
  return memory
}

type Sample = { scenario: string, q: string, state: Row, question: Row, label: string, original: Row, memory: Record<string, unknown> }
const pool: Sample[] = []
for (const s of sessions) {
  s.rows.forEach((d, i) => {
    if (d.kind !== 'decide' || !sent.has(d.span_id)) return
    const esc = sent.get(d.span_id)!
    const call = s.rows.find(r => r.kind === 'system2' && r.t > esc.t && r.input?.triggers?.some((t: Row) => t.detail?.decide_span === d.span_id))
    if (!call?.output?.decision) return
    const after = s.rows.find(r => r.kind === 'decide' && r.t > call.t)
    for (const q of unsure(d)) {
      if (MOOT.has(d.output.applied?.[q])) continue
      const options = Object.keys(d.input.questions[q].criteria).map(optionTarget)
      const label = changedNothing(call.output.decision) ? optionTarget(d.output.answers[q].choice) : optionTarget(after?.output?.answers?.[q]?.choice ?? '')
      if (!options.includes(label)) continue // the next call offered something else: no label
      pool.push({ scenario: s.scenario, q, state: d.input.state, question: d.input.questions[q], label, original: d.output.answers[q], memory: memoryAt(s.rows, i) })
    }
  })
}
// Stratified by scene and question, round-robin, seeded order so reruns pick the same sample.
const groups = new Map<string, Sample[]>()
for (const p of pool) { const k = `${p.scenario}/${p.q}`; groups.set(k, [...(groups.get(k) ?? []), p]) }
const sample: Sample[] = []
let seed = 7
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
for (const g of groups.values()) g.sort(() => rand() - 0.5)
while (sample.length < N && [...groups.values()].some(g => g.length)) for (const g of groups.values()) if (g.length && sample.length < N) sample.push(g.pop()!)
console.log(`pool ${pool.length} labelled doubtful questions; sampled ${sample.length}`, Object.fromEntries([...groups.keys()].map(k => [k, sample.filter(s => `${s.scenario}/${s.q}` === k).length])))
if (NO_JEV) { for (const s of sample.filter((_, i) => i % 50 === 3)) console.log(s.scenario, s.q, 'label', s.label, JSON.stringify(s.memory, null, 1)); process.exit(0) }

const ask = async (state: Row, q: Row, reverse: boolean) => (await askJev(state, { q: reorder(q, reverse) })).q
type Cell = { fwd: Row, rev: Row }
const out: Array<{ s: Sample, A: Cell, B: Cell }> = []
let next = 0
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < sample.length) {
    const s = sample[next++]
    const withMemory = { ...s.state, memory: KEYS ? Object.fromEntries(Object.entries(s.memory).filter(([k]) => KEYS.split(',').includes(k))) : s.memory }
    const [af, ar, bf, br] = await Promise.all([ask(s.state, s.question, false), ask(s.state, s.question, true), ask(withMemory, s.question, false), ask(withMemory, s.question, true)])
    out.push({ s, A: { fwd: af, rev: ar }, B: { fwd: bf, rev: br } })
  }
}))

function score (cells: Cell[], labels: string[]) {
  let doubt = 0; let agree = 0; let flips = 0; let dbDoubt = 0; let dbAgree = 0
  cells.forEach((c, i) => {
    for (const a of [c.fwd, c.rev]) { if (a.confidence < CONF) doubt++; if (optionTarget(a.choice) === labels[i]) agree++ }
    if (optionTarget(c.fwd.choice) !== optionTarget(c.rev.choice)) flips++
    // Debiased: probabilities and confidence averaged over the two orders.
    const p: Record<string, number> = {}
    for (const a of [c.fwd, c.rev]) for (const [k, v] of Object.entries(a.probabilities as Record<string, number>)) p[k] = (p[k] ?? 0) + v / 2
    const top = Object.entries(p).sort((x, y) => y[1] - x[1])[0][0]
    if ((c.fwd.confidence + c.rev.confidence) / 2 < CONF) dbDoubt++
    if (optionTarget(top) === labels[i]) dbAgree++
  })
  const n = cells.length
  const pct = (x: number, d: number) => +(100 * x / d).toFixed(1)
  return { n, doubt_pct: pct(doubt, 2 * n), agree_pct: pct(agree, 2 * n), flip_pct: pct(flips, n), debiased_doubt_pct: pct(dbDoubt, n), debiased_agree_pct: pct(dbAgree, n) }
}
const report: Record<string, unknown> = { counterfactual: cf }
const slices: Record<string, typeof out> = { all: out }
for (const o of out) { (slices[o.s.scenario] ??= []).push(o); (slices[`q:${o.s.q}`] ??= []).push(o); (slices[o.s.memory.plan ? 'with_plan' : 'no_plan'] ??= []).push(o) }
for (const [k, v] of Object.entries(slices)) {
  const labels = v.map(o => o.s.label)
  report[k] = { A: score(v.map(o => o.A), labels), B: score(v.map(o => o.B), labels) }
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(report).filter(([k]) => k !== 'counterfactual')), null, 1))
writeFileSync(OUT, JSON.stringify({ report, samples: out.map(o => ({ scenario: o.s.scenario, q: o.s.q, label: o.s.label, memory: o.s.memory, original: o.s.original, A: o.A, B: o.B })) }, null, 1))
console.log(`wrote ${OUT}`)
