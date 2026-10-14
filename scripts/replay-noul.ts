// Does the memory raise Jev's escalate Noul? (brain/architecture/stateful-system-1.md → Bench A/B.) Plan-step states
// from the A/B's "on" arm, asked with and without their memory, and with only the plan or only the doing line.
// Usage: node --env-file=../judgment/.env.jeeve scripts/replay-noul.ts <commit> [--n 150]
import { readFileSync } from 'node:fs'
import { arg, askJev, pool, seeded, type Row } from './replay-lib.ts'

const rows = readFileSync('bench/results.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.commit === process.argv[2] && (r.memory ?? r.stateful))
const states = rows.flatMap(r => readFileSync(`traces/${r.session}.jsonl`, 'utf8').split('\n').flatMap(l => { try { return l ? [JSON.parse(l) as Row] : [] } catch { return [] } }))
  .filter(x => x.kind === 'decide' && x.input.state.memory?.plan)
const rand = seeded(3)
const sample = states.sort(() => rand() - 0.5).slice(0, Number(arg('n', '150')))
const without = (s: Row, k?: string) => { const { memory, ...rest } = s; return k ? { ...rest, memory: { [k]: memory[k] } } : rest }
const arms: Record<string, (s: Row) => Row> = { none: s => without(s), plan: s => without(s, 'plan'), doing: s => without(s, 'doing'), both: s => s }
const out = await pool(sample, async d => Object.fromEntries(await Promise.all(Object.entries(arms).map(async ([k, f]) => [k, (await askJev(f(d.input.state), { escalate: d.input.questions.escalate })).escalate.noul]))))
for (const k of Object.keys(arms)) {
  const xs = out.map(o => o[k] as number)
  console.log(k.padEnd(6), 'mean noul', (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3), 'noul>0.5', (100 * xs.filter(x => x > 0.5).length / xs.length).toFixed(1) + '%')
}
