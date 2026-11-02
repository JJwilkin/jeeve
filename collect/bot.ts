// One collector bot (one process, started by collect/main.ts): episodes of 60 s, each starting with a teleport and a
// random kit over RCON, then scripted actions picked by the scheduler, recorded at 5 steps a second.
// No model calls.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import collectblock from 'mineflayer-collectblock'
import { CHANNELS, Channels } from '../src/behaviors.ts'
import { guardedMovements, installGuards } from '../src/guards.ts'
import { HAND_WRITTEN, SEED_ACTIONS, features, libraryActions, randomInput, startNoise, type Action, type Draw } from './actions.ts'
import { CONTROLS, FAR_EVERY, MID_FLAGS, NOISE, STATE_FLAGS, STEPS_PER_S, VIEWS, classTable } from './format.ts'
import { rconWhenUp } from './rcon.ts'
import { EpisodeRecorder } from './recorder.ts'

const env = process.env
const NAME = env.COLLECT_NAME ?? 'C1_1'
const HOST = env.COLLECT_HOST ?? 'localhost'
const PORT = Number(env.COLLECT_PORT ?? 25565)
const SEED = env.COLLECT_SEED ?? 'unknown'
const SPLIT = env.COLLECT_SPLIT ?? 'train'
const OUT = env.COLLECT_OUT ?? 'episodes'
const RADIUS = Number(env.COLLECT_RADIUS ?? 1000) // episode starts land within this many blocks of 0, 0
const EPISODE_MS = Number(env.COLLECT_EPISODE_S ?? 60) * 1000
const RANDOM_SHARE = 0.15

const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
const int = (lo: number, hi: number) => Math.floor(between(lo, hi + 1))
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]
const log = (...a: unknown[]) => console.log(`[${NAME}]`, ...a)

const r = await rconWhenUp(env.COLLECT_RCON_HOST ?? HOST, Number(env.COLLECT_RCON_PORT ?? 25575), env.COLLECT_RCON_PASSWORD ?? '')
const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, auth: 'offline' })
bot.loadPlugin(pf.pathfinder)
bot.loadPlugin(collectblock.plugin)
bot.on('kicked', reason => log('kicked:', JSON.stringify(reason)))
bot.on('error', err => log('error:', err.message))
bot.on('end', reason => { log('disconnected:', reason); process.exit(1) }) // collect/main.ts starts a new one
await new Promise<void>(resolve => bot.once('spawn', () => resolve()))

// As in src/main.ts: the hitbox fix, the guarded Movements, and the guards, whose vetoes reach the running action.
;(bot.physics as unknown as { playerHalfWidth: number }).playerHalfWidth = Math.fround(0.6) / 2
bot.pathfinder.setMovements(guardedMovements(bot))
bot.collectBlock.movements = undefined
const classes = classTable(bot.registry.blocksArray)
const rec = new EpisodeRecorder(bot, classes)
installGuards(bot, (channel, reason) => { rec.veto(reason); channels.veto(channel, reason) })
rec.wrapControls()

// ---- the scheduler ----
// Only the first terminal end of an action's runs counts; stopping the others afterwards is not an outcome.
let running: { runs: Set<string>, end: (outcome: string) => void } | null = null
const channels = new Channels(bot, {
  event: () => {},
  start: slot => running?.runs.add(slot.runId),
  end: (slot, reason) => { if (running?.runs.has(slot.runId)) running.end(reason) }
})
const ACTIONS: Action[] = [...SEED_ACTIONS, ...libraryActions(env.COLLECT_LIBRARY ?? 'modules/library.json'), ...HAND_WRITTEN]
log(`actions: ${ACTIONS.map(a => a.name).join(', ')}`)

// biome|action|outcome → count: this bot's own, and every bot's as collect/main.ts last sent them.
const counts = new Map<string, number>()
let shared: Record<string, number> = {}
process.on('message', (m: { counts?: Record<string, number> }) => { if (m.counts) shared = m.counts })
const count = (k: string) => Math.max(shared[k] ?? 0, counts.get(k) ?? 0)

// Toward rare biome × action × outcome: an action's weight is the expected rarity, here, of the outcome it will have,
// Σ_o p(o | action) / √(1 + n(biome, action, o)), with p from every biome and one pseudo-count for an outcome not seen yet.
function weight (biome: string, action: string) {
  const byOutcome = new Map<string, number>()
  for (const k of new Set([...Object.keys(shared), ...counts.keys()])) {
    const [, a, o] = k.split('|')
    if (a === action) byOutcome.set(o, (byOutcome.get(o) ?? 0) + count(k))
  }
  const total = [...byOutcome.values()].reduce((a, b) => a + b, 1)
  let w = 1 / total
  for (const [o, n] of byOutcome) w += n / total / Math.sqrt(1 + count(`${biome}|${action}|${o}`))
  return w
}

function choose (biome: string): { name: string, draw: Draw } {
  if (Math.random() < RANDOM_SHARE) return { name: 'random_input', draw: randomInput() }
  const f = features(bot, rec)
  const fit = ACTIONS.filter(a => a.fits(f)).map(a => ({ a, w: weight(biome, a.name) }))
  let x = Math.random() * fit.reduce((s, c) => s + c.w, 0)
  const a = fit.find(c => (x -= c.w) <= 0)?.a ?? fit[0].a
  return { name: a.name, draw: a.draw(bot, f) }
}

let stopping = false
let died = false
let endEpisode: (() => void) | null = null
bot.on('death', () => { died = true; running?.end('died'); endEpisode?.() })
process.on('SIGTERM', () => { stopping = true; running?.end('stopped'); endEpisode?.() })

async function runAction (biome: string, until: number) {
  const { name, draw } = choose(biome)
  const i = rec.startAction(name, draw.params)
  const t0 = Date.now()
  const stopNoise = name === 'random_input' ? () => {} : startNoise(bot, rec)
  const outcome = await new Promise<string>(resolve => {
    const timers = [
      setTimeout(() => end('timeout'), draw.limit_s * 1000),
      setTimeout(() => end('episode_end'), until - Date.now())
    ]
    function end (o: string) { timers.forEach(clearTimeout); running = null; resolve(o) }
    running = { runs: new Set(), end }
    for (const run of draw.runs) channels.set(`${name}:${run.behavior}`, run.behavior, run.target as any, 'collector', { spec: run.spec })
  })
  stopNoise()
  channels.stop(CHANNELS, 'action_end')
  bot.clearControlStates()
  rec.endAction(i, outcome, Date.now() - t0)
  const k = `${biome}|${name}|${outcome.split(' ')[0]}`
  counts.set(k, (counts.get(k) ?? 0) + 1)
}

// ---- episodes ----
const KIT = () => [
  Math.random() < 0.6 && [pick(['cobblestone', 'dirt', 'oak_planks']), int(8, 64)],
  Math.random() < 0.6 && [pick(['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'stone_axe', 'stone_shovel']), 1],
  Math.random() < 0.5 && [pick(['wooden_sword', 'stone_sword', 'iron_sword']), 1],
  Math.random() < 0.6 && [pick(['bread', 'cooked_beef', 'apple', 'baked_potato']), int(1, 8)],
  Math.random() < 0.3 && ['torch', int(1, 16)]
].filter(Boolean).sort(() => Math.random() - 0.5) as Array<[string, number]>

async function start () {
  // spreadplayers lands on the surface, never in a liquid, so over open water it fails: try another spot.
  for (let tries = 1; ; tries++) {
    const reply = await r.command(`spreadplayers ${int(-RADIUS, RADIUS)} ${int(-RADIUS, RADIUS)} 0 24 false ${NAME}`)
    if (/^Spread/.test(reply)) break
    if (tries >= 10) { log('teleport failed 10 times; starting where it stands:', reply); break }
  }
  const kit = KIT()
  const hungry = Math.random() < 0.25 // so `eat` fits in some episodes
  for (const cmd of [`clear ${NAME}`, `effect clear ${NAME}`, `effect give ${NAME} instant_health 1 10 true`, `effect give ${NAME} saturation 1 20 true`,
    ...kit.map(([item, n]) => `give ${NAME} ${item} ${n}`), ...(hungry ? [`effect give ${NAME} hunger 30 40 true`] : [])]) await r.command(cmd)
  bot.setQuickBarSlot(0)
  await bot.waitForChunksToLoad()
  await bot.waitForTicks(30) // land, and let the kit's slot updates arrive
  return { kit: kit.map(([item, count]) => ({ item, count })), hungry }
}

let episodes = 0
let cpu = process.cpuUsage()
while (!stopping) {
  died = false
  const { kit, hungry } = await start()
  if (stopping) break
  const p = bot.entity.position
  const biome = bot.registry.biomes[(bot.world as any).getBiome(p.floored())]?.name ?? 'unknown'
  const header = {
    format: 'jeeve-episode/1', bot: NAME, server: `${HOST}:${PORT}`, seed: SEED, split: SPLIT, mc_version: bot.version,
    start: new Date().toISOString(), start_pos: [p.x, p.y, p.z], biome, scene: 'natural',
    conditions: { time_of_day: bot.time.timeOfDay, raining: bot.isRaining, thunder: bot.thunderState > 0, difficulty: bot.game.difficulty },
    kit, hungry, steps_per_s: STEPS_PER_S, far_every: FAR_EVERY, views: VIEWS,
    controls: CONTROLS, state_flags: STATE_FLAGS, noise: NOISE, mid_flags: MID_FLAGS, classes: classes.names, class_blocks: classes.blocks
  }
  const t0 = Date.now()
  const until = t0 + EPISODE_MS
  rec.begin()
  const over = new Promise<void>(resolve => { endEpisode = resolve })
  while (!stopping && !died && Date.now() < until) await Promise.race([runAction(biome, until), over])
  endEpisode = null
  const wall = Date.now() - t0
  const { gz, steps } = rec.finish({ ...header, end: stopping ? 'stopped' : died ? 'died' : 'time', wall_ms: wall })
  const dir = `${OUT}/${SPLIT}/${SEED}`
  mkdirSync(dir, { recursive: true })
  const file = `${dir}/${NAME}-${header.start.replace(/[:.]/g, '-')}.ep.gz`
  writeFileSync(`${file}.tmp`, gz) // renamed when complete, so a copy to the bucket never takes half a file
  renameSync(`${file}.tmp`, file)
  const used = process.cpuUsage(cpu)
  cpu = process.cpuUsage()
  process.send?.({ steps, wall_ms: wall, cpu_ms: (used.user + used.system) / 1000, bytes: gz.length, capture_ms: rec.stepMs / Math.max(1, steps), counts: Object.fromEntries(counts), biome, episode: ++episodes })
}
r.close()
bot.quit()
process.exit(0)
