// Unattended scored runs for hill-climbing (brain/architecture/benchmarks.md): each scenario in scripts/clip.ts
// runs with --bench, in parallel on its own port and world, for N rounds. Rows land in bench/results.jsonl.
//   npm run bench -- 3                      three rounds of every scenario
//   npm run bench -- 1 orchard workshop     one round of these
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const rounds = Number(args[0] ?? 1)
const scenarios = args.slice(1).length ? args.slice(1) : ['orchard', 'workshop', 'guard']
const BASE_PORT = 25571 // 25570 is for runs Joshua watches
mkdirSync('bench/logs', { recursive: true })

const run = (scenario: string, port: number, round: number) => new Promise<void>(resolve => {
  const log = createWriteStream(`bench/logs/${scenario}-r${round}-${Date.now()}.log`)
  const child = spawn('node', ['--env-file=../judgment/.env.jeeve', 'scripts/clip.ts', scenario, '--bench'], { env: { ...process.env, JEEVE_PORT: String(port) } })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  child.stdout.on('data', d => { for (const line of String(d).split('\n')) if (/^\[(bench|clip)\] (verify|"|\{)/.test(line)) console.log(`${scenario}#${round}: ${line.slice(0, 300)}`) })
  // A run that hangs past 20 min is killed; it then has no results row.
  const timer = setTimeout(() => child.kill('SIGINT'), 20 * 60_000)
  child.on('exit', () => { clearTimeout(timer); resolve() })
})

const before = readFileSync('bench/results.jsonl', { flag: 'a+' }).toString().split('\n').filter(Boolean).length
for (let r = 1; r <= rounds; r++) {
  console.log(`[bench] round ${r}/${rounds}: ${scenarios.join(', ')}`)
  await Promise.all(scenarios.map((s, i) => run(s, BASE_PORT + i, r)))
}
const rows = readFileSync('bench/results.jsonl', 'utf8').split('\n').filter(Boolean).slice(before).map(l => JSON.parse(l))
for (const s of scenarios) {
  const mine = rows.filter(r => r.scenario === s)
  console.log(`[bench] ${s}: ${mine.filter(r => r.pass).length}/${mine.length} passed; ${mine.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.s}s (${r.detail})`).join('; ')}`)
}
