// Summarize bench/results.jsonl: per commit (in run order), pass rate and median time per scenario, and 2A calls.
//   node scripts/bench-report.ts
import { readFileSync } from 'node:fs'

const rows = readFileSync('bench/results.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l))
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN }
const scenarios = [...new Set(rows.map(r => r.scenario))]
const commits = [...new Set(rows.map(r => r.commit))]
console.log(['commit', 'runs', ...scenarios, '2A calls (median)'].join(' | '))
for (const c of commits) {
  const mine = rows.filter(r => r.commit === c)
  const cells = scenarios.map(s => {
    const xs = mine.filter(r => r.scenario === s)
    return xs.length ? `${xs.filter(r => r.pass).length}/${xs.length}, ${median(xs.map(r => r.s))} s` : '-'
  })
  console.log([c, mine.length, ...cells, median(mine.map(r => r.system2.calls))].join(' | '))
}
const pass = rows.filter(r => r.pass).length
console.log(`total: ${pass}/${rows.length} passed`)
