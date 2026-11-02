// The collector for one Paper server and one seed (brain/tasks/world-model-data.md → "Infrastructure"): finds the
// seed's start points and pre-generates around them (collect/worlds.ts), then runs one bot process per bot
// (collect/bot.ts), rotating the server's time and weather every 10 minutes, until the seed has its step budget.
// deploy/collect/run.sh moves each server on to its next seed. Measurements per episode go to stdout; starts and
// coverage counts to <out>/<split>/<seed>/{starts,coverage}.json, and a re-run on a kept world resumes from them.
//   COLLECT_HOST=paper-1 COLLECT_SEED=123 COLLECT_BOTS=4 COLLECT_SEED_STEPS=80000 node collect/main.ts
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rconWhenUp } from './rcon.ts'
import { locateStarts, pregenerate } from './worlds.ts'

const env = process.env
const HOST = env.COLLECT_HOST ?? 'localhost'
const SEED = env.COLLECT_SEED ?? 'unknown'
const BOTS = Number(env.COLLECT_BOTS ?? 2)
const TARGET = Number(env.COLLECT_SEED_STEPS ?? Infinity)
const SPLIT = (env.COLLECT_HELDOUT ?? '').split(',').includes(SEED) ? 'heldout' : 'train'
const DIR = `${env.COLLECT_OUT ?? 'episodes'}/${SPLIT}/${SEED}`
const ROTATE_MS = 10 * 60_000
const CONDITIONS = [['day', 'clear'], ['night', 'clear'], ['day', 'rain'], ['night', 'rain']]
const log = (...a: unknown[]) => console.log(`[collect] ${HOST} ${SEED}`, ...a)

mkdirSync(DIR, { recursive: true })
const prior = existsSync(`${DIR}/coverage.json`) ? JSON.parse(readFileSync(`${DIR}/coverage.json`, 'utf8')) : { steps: 0, counts: {} }
if (prior.steps >= TARGET) { log(`done already (${prior.steps} steps)`); process.exit(0) }
let total: number = prior.steps
let stopping = false
const children = new Map<ChildProcess, string>()
// Per bot: its biome|action|outcome counts. Per seed, so the scheduler balances each seed on its own.
const counts = new Map<string, Record<string, number>>([['prior', prior.counts]])

function merged () {
  const all: Record<string, number> = {}
  for (const c of counts.values()) for (const [k, n] of Object.entries(c)) all[k] = (all[k] ?? 0) + n
  return all
}
const save = () => writeFileSync(`${DIR}/coverage.json`, JSON.stringify({ steps: total, counts: merged() }, null, 1))

// Paper refuses a second login from one address within 4 s (bukkit.yml connection-throttle): bots that connected
// together kicked each other in a loop (smoke run, 2026-11-02). So logins go one at a time, at least 5 s apart.
let nextLogin = 0
const loginIn = (min = 0) => { const t = Math.max(Date.now() + min, nextLogin); nextLogin = t + 5000; return t - Date.now() }

function startBot (index: number) {
  const name = `C_${index}`
  const child = fork('collect/bot.ts', [], { env: { ...env, COLLECT_NAME: name, COLLECT_INDEX: String(index), COLLECT_SPLIT: SPLIT } })
  children.set(child, name)
  child.on('message', (m: { steps: number, wall_ms: number, cpu_ms: number, bytes: number, capture_ms: number, counts: Record<string, number>, biome: string, scene: string, episode: number }) => {
    total += m.steps
    counts.set(name, m.counts)
    const all = merged()
    for (const c of children.keys()) c.connected && c.send({ counts: all })
    console.log(`[collect] ${name} ep ${m.episode} (${m.biome}, ${m.scene}): ${m.steps} steps in ${(m.wall_ms / 1000).toFixed(1)} s = ${(m.steps / m.wall_ms * 1000).toFixed(2)} steps/s; ` +
      `cpu ${(m.cpu_ms / m.wall_ms * 100).toFixed(0)}%; capture ${m.capture_ms.toFixed(1)} ms/step; ${(m.bytes / m.steps / 1024).toFixed(2)} KB/step gz; total ${total}`)
    if (total >= TARGET) void stop()
  })
  child.on('exit', code => {
    children.delete(child)
    if (!stopping) { const ms = loginIn(5000); console.log(`[collect] ${name} exited (${code}); restarting in ${(ms / 1000).toFixed(0)} s`); setTimeout(() => startBot(index), ms) }
  })
}

async function stop () {
  if (stopping) return
  stopping = true
  log(`stopping at ${total} steps`)
  for (const c of children.keys()) c.kill('SIGTERM') // each writes its episode so far
  const deadline = Date.now() + 90_000
  while (children.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500))
  for (const c of children.keys()) c.kill('SIGKILL')
  save()
  process.exit(0)
}
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
setInterval(save, 60_000)

const r = await rconWhenUp(HOST, Number(env.COLLECT_RCON_PORT ?? 25575), env.COLLECT_RCON_PASSWORD ?? '')
// Time and weather stay where the rotation puts them (1.21.11+ rule names).
for (const cmd of ['gamerule advance_time false', 'gamerule advance_weather false', 'difficulty easy']) await r.command(cmd)
let k = Math.floor(Math.random() * CONDITIONS.length) // servers start at different points of the rotation
const rotate = async () => {
  const [time, weather] = CONDITIONS[k++ % CONDITIONS.length]
  await r.command(`time set ${time}`)
  await r.command(`weather ${weather}`)
}
await rotate()
setInterval(() => void rotate().catch(() => {}), ROTATE_MS)

// The starts are found once per seed; a kept world (or a re-run of the same seed) reuses them.
const startsFile = `${DIR}/starts.json`
const starts = existsSync(startsFile) ? JSON.parse(readFileSync(startsFile, 'utf8')).starts : await locateStarts(r, log)
writeFileSync(startsFile, JSON.stringify({ seed: SEED, starts }, null, 1))
await pregenerate(r, starts, log)
for (let b = 1; b <= BOTS; b++) setTimeout(() => startBot(b), loginIn())
