// Unattended scored runs for hill-climbing (brain/architecture/benchmarks.md): each scenario in scripts/clip.ts
// runs with --bench, in parallel on its own port and world, for N rounds. Rows land in bench/results.jsonl.
//   npm run bench -- 3                      three rounds of every scenario
//   npm run bench -- 1 orchard workshop     one round of these
//   npm run bench -- 3 --fresh              start from an empty skill library
// An A/B runs two benches at once, each on its own ports and library, on the same layouts:
//   JEEVE_BENCH_PORT=25571 JEEVE_BENCH_LIBRARY=bench/lib-a.json JEEVE_BENCH_SEED=1000 JEEVE_STATEFUL=0 npm run bench -- 3
// Learning: every run starts from bench/library.json, the skills and checks Jeeve learned in earlier runs, and what
// a run learns is merged back after its round. One Jeeve that keeps what it learned, across runs and scenarios.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const flags = process.argv.slice(2).filter(a => a.startsWith('--'))
const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const rounds = Number(args[0] ?? 1)
const scenarios = args.slice(1).length ? args.slice(1) : ['orchard', 'workshop', 'guard', 'forage']
const SHARED = process.env.JEEVE_BENCH_LIBRARY ?? 'bench/library.json'
// Same base seed → the same layout per round and scenario, so two arms of an A/B are paired.
const seedFor = (round: number, i: number) => process.env.JEEVE_BENCH_SEED ? { JEEVE_SEED: String(Number(process.env.JEEVE_BENCH_SEED) + round * 100 + i) } : {}
mkdirSync('bench', { recursive: true })
if (flags.includes('--fresh') && existsSync(SHARED)) rmSync(SHARED)
const portLibrary = (port: number) => `traces/clip-module-library-${port}.json`
type Stored = { kind: string, name: string, version: number, origin?: { created_at?: string } }
const modulesIn = (file: string): Stored[] => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).modules : []
// The shared library keeps the newest version of each module by name, and is curated: a check or watch module unused
// for RETIRE_AFTER rounds in a row is retired (they pile up tied to one layout: birch_tree_43_cleared). Skills stay.
const RETIRE_AFTER = 2
type Shared = Stored & { used_at?: string, idle_rounds?: number }
function merge (files: string[], roundStart: string) {
  const by = new Map<string, Shared>(modulesIn(SHARED).map(m => [`${m.kind}:${m.name}`, m]))
  const used = new Set<string>()
  for (const f of files) for (const m of modulesIn(f) as Shared[]) {
    const k = `${m.kind}:${m.name}`
    if ((m.used_at ?? '') >= roundStart) used.add(k)
    const old = by.get(k)
    if (!old || (m.origin?.created_at ?? '') > (old.origin?.created_at ?? '')) by.set(k, { ...m, idle_rounds: old?.idle_rounds })
  }
  const retired: string[] = []
  for (const [k, m] of by) {
    m.idle_rounds = used.has(k) ? 0 : (m.idle_rounds ?? 0) + 1
    if (m.kind !== 'behavior' && m.idle_rounds >= RETIRE_AFTER) { by.delete(k); retired.push(m.name) }
  }
  writeFileSync(SHARED, JSON.stringify({ modules: [...by.values()] }, null, 2) + '\n')
  return `${by.size} modules${retired.length ? `, retired ${retired.join(', ')}` : ''}`
}
const BASE_PORT = Number(process.env.JEEVE_BENCH_PORT ?? 25571) // 25570 is for runs Joshua watches
mkdirSync('bench/logs', { recursive: true })

const run = (scenario: string, port: number, round: number, i: number) => new Promise<void>(resolve => {
  const log = createWriteStream(`bench/logs/${scenario}-r${round}-${Date.now()}.log`)
  if (existsSync(SHARED)) copyFileSync(SHARED, portLibrary(port)); else rmSync(portLibrary(port), { force: true })
  const child = spawn('node', ['--env-file=../judgment/.env.jeeve', 'scripts/clip.ts', scenario, '--bench'], { env: { ...process.env, JEEVE_PORT: String(port), JEEVE_KEEP_LIBRARY: '1', ...seedFor(round, i) } })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  child.stdout.on('data', d => { for (const line of String(d).split('\n')) if (/^\[(bench|clip)\] (verify|"|\{)/.test(line)) console.log(`${scenario}#${round}: ${line.slice(0, 300)}`) })
  // A run that hangs past 20 min is killed; it then has no results row.
  const timer = setTimeout(() => child.kill('SIGINT'), 20 * 60_000)
  child.on('exit', () => {
    clearTimeout(timer)
    // The all-seeing eye on every run: <dir>/gaps.md (scripts/gaps.ts).
    const row = readFileSync('bench/results.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l)).findLast(r => r.scenario === scenario)
    if (row?.dir) spawnSync('node', ['scripts/gaps.ts', row.dir], { stdio: 'ignore' })
    resolve()
  })
})

const before = readFileSync('bench/results.jsonl', { flag: 'a+' }).toString().split('\n').filter(Boolean).length
for (let r = 1; r <= rounds; r++) {
  console.log(`[bench] round ${r}/${rounds}: ${scenarios.join(', ')}`)
  const roundStart = new Date().toISOString()
  await Promise.all(scenarios.map((s, i) => run(s, BASE_PORT + i, r, i)))
  console.log(`[bench] round ${r}: the shared library has ${merge(scenarios.map((_, i) => portLibrary(BASE_PORT + i)), roundStart)}`)
}
const rows = readFileSync('bench/results.jsonl', 'utf8').split('\n').filter(Boolean).slice(before).map(l => JSON.parse(l))
for (const s of scenarios) {
  const mine = rows.filter(r => r.scenario === s)
  console.log(`[bench] ${s}: ${mine.filter(r => r.pass).length}/${mine.length} passed; ${mine.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.s}s (${r.detail})`).join('; ')}`)
}
