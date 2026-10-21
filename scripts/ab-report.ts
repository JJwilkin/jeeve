// The stateful System 1 bench A/B (brain/architecture/stateful-system-1.md): rows from bench/results.jsonl for one
// commit, paired by scenario and seed (both arms play the same layout), with each run's trace read for the doubt metrics.
// Usage: node scripts/ab-report.ts <commit> [--traces traces]
import { existsSync, readFileSync } from 'node:fs'
import { arg, type Row } from './replay-lib.ts'

const commit = process.argv[2]
const TRACES = arg('traces', 'traces')
// The arm: `memory` (or `stateful`, the first A/B's name for memory + the moot filter, commit 5bac02c).
const arm = (r: Row): boolean | undefined => r.memory ?? r.stateful
const rows = readFileSync('bench/results.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.commit === commit && typeof arm(r) === 'boolean')
const DOUBT = new Set(['low_confidence', 'jev_escalate'])

function metrics (r: Row) {
  const f = `${TRACES}/${r.session}.jsonl`
  const t = existsSync(f) ? readFileSync(f, 'utf8').split('\n').flatMap(l => { try { return l ? [JSON.parse(l) as Row] : [] } catch { return [] } }) : []
  const decides = t.filter(x => x.kind === 'decide')
  const calls = t.filter(x => x.kind === 'system2')
  const reasons = (c: Row) => String(c.attrs['jeeve.system2.trigger']).split(',').map(s => s.replace('escalation:', ''))
  const starts = t.filter(x => x.kind === 'behavior_start')
  const ends = new Map(t.filter(x => x.kind === 'behavior_end').map(x => [x.run_id, x]))
  // Reaction: each hit taken while the hands weren't attacking → the next attack_when_ready start.
  const reactions: number[] = []
  for (const d of t.filter(x => x.kind === 'event' && x.name === 'damage')) {
    const attacking = starts.some(s => s.name === 'attack_when_ready' && s.t <= d.t && (ends.get(s.run_id)?.t ?? Infinity) > d.t)
    if (attacking) continue
    const next = starts.find(s => s.name === 'attack_when_ready' && s.t > d.t)
    if (next && next.t - d.t < 15_000) reactions.push(next.t - d.t)
  }
  return {
    pass: r.pass ? 1 : 0,
    s: r.s,
    calls_2a: calls.length,
    doubt_calls_2a: calls.filter(c => reasons(c).every(x => DOUBT.has(x))).length,
    doubtful_pct: decides.length ? 100 * decides.filter(d => d.attrs['jeeve.decide.escalate']).length / decides.length : 0,
    churn: starts.filter(s => { const e = ends.get(s.run_id); return e?.reason === 'replaced' && e.t - s.t < 1000 }).length,
    reaction_ms: reactions.length ? reactions.reduce((a, b) => a + b, 0) / reactions.length : null,
    deaths: r.deaths ?? 0,
    decides: decides.length
  }
}

type M = ReturnType<typeof metrics>
const median = (xs: number[]) => { const a = xs.filter(x => x !== null).sort((p, q) => p - q); return a.length ? +a[a.length >> 1].toFixed(1) : null }
const mean = (xs: number[]) => { const a = xs.filter(x => x !== null); return a.length ? +(a.reduce((p, q) => p + q, 0) / a.length).toFixed(1) : null }
const pairs = new Map<string, { off?: M, on?: M }>()
for (const r of rows) {
  const k = `${r.scenario}/${r.seed}`
  pairs.set(k, { ...pairs.get(k), [arm(r) ? 'on' : 'off']: metrics(r) })
}
const complete = [...pairs.entries()].filter(([, p]) => p.off && p.on) as Array<[string, { off: M, on: M }]>
console.log(`commit ${commit}: ${rows.length} rows, ${complete.length} complete pairs`)
const keys = ['pass', 's', 'calls_2a', 'doubt_calls_2a', 'doubtful_pct', 'churn', 'reaction_ms', 'deaths'] as const
const scenes = ['all', ...new Set(complete.map(([k]) => k.split('/')[0]))]
for (const scene of scenes) {
  const ps = complete.filter(([k]) => scene === 'all' || k.startsWith(`${scene}/`)).map(([, p]) => p)
  console.log(`\n${scene} (${ps.length} pairs)`)
  for (const k of keys) {
    const off = ps.map(p => p.off[k] as number); const on = ps.map(p => p.on[k] as number)
    const diffs = ps.filter(p => p.off[k] !== null && p.on[k] !== null).map(p => (p.on[k] as number) - (p.off[k] as number))
    const better = diffs.filter(d => k === 'pass' ? d > 0 : d < 0).length; const worse = diffs.filter(d => k === 'pass' ? d < 0 : d > 0).length
    console.log(`  ${k.padEnd(15)} off ${String(mean(off)).padStart(7)} (med ${median(off)})   on ${String(mean(on)).padStart(7)} (med ${median(on)})   paired Δ mean ${mean(diffs)}; on better in ${better}, worse in ${worse}`)
  }
}
