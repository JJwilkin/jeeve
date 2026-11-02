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

// Crossing scenes (rivers, ravines, ledges): success and 2A calls per crossing, by scene and size.
const crossings = rows.filter(r => r.crossing)
if (crossings.length) {
  console.log('\nscene | size | runs | crossed | 2A calls (median) | Jev decisions (median) | vetoes | deaths | median s | spend')
  const key = (r: any) => `${r.scenario} | ${r.crossing.size}`
  for (const k of [...new Set(crossings.map(key))].sort()) {
    const xs = crossings.filter(r => key(r) === k)
    const sum = (f: (r: any) => number) => xs.reduce((n: number, r: any) => n + (f(r) ?? 0), 0)
    console.log([k, xs.length, `${xs.filter(r => r.pass).length}/${xs.length}`, median(xs.map(r => r.system2.calls)), median(xs.map(r => r.jev)),
      sum(r => r.vetoes), sum(r => r.deaths), median(xs.map(r => r.s)), `$${sum(r => r.usd).toFixed(2)}`].join(' | '))
  }
}
