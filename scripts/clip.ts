// One command per clip (brain/architecture/brain-monitor.md): set up a scene, run the agent on it while OBS
// records, then render the clip at 16:9 and 9:16 with Remotion (viz/). Uses the real Jev, Claude and Judgment.
//   npm run clip canopy                  record and render (JEEVE_CAMERA=<your player> frames your spectator client)
//   npm run clip canopy -- --no-record   run and render the panels without footage
//   npm run clip -- --captions clips/<dir>  rewrite captions.json from the clip's trace
//   npm run clip -- --render clips/<dir>    re-render, e.g. after editing captions.json
// Joshua's client joins localhost:<JEEVE_PORT> as JEEVE_CAMERA; OBS's websocket server: OBS_URL, OBS_PASSWORD.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import mineflayer from 'mineflayer'
import { Vec3 } from 'vec3'
import { startAgent } from '../src/main.ts'
import { MODEL } from '../src/system2.ts'
import { beats, parse, type Beat, type Row } from '../viz/src/timeline.ts'
import { canopy, CANOPY, guard, GUARD, orchard, ORCHARD, workshop, WORKSHOP } from './scenes.ts'
import { PORT, startServer } from './server.ts'

type Xyz = [number, number, number]
type Bot = ReturnType<typeof mineflayer.createBot>
type Ctx = { josh: Bot, agent: Awaited<ReturnType<typeof startAgent>>, command: (c: string) => void, done: () => boolean }
// instructions: given in turn, each once the previous one's goal closes; timeoutMs per instruction (an open-ended
// goal runs until then). during: what the scene does meanwhile (waves, Josh moving). verify: the outcome, judged
// from the world by Josh, never from the agent's own claims. view: the box the world recorder keeps (the camera).
type Scenario = {
  setup: (command: (c: string) => void) => void, camera: { at: Xyz, facing: Xyz }, view: { min: Xyz, max: Xyz },
  instructions: string[], timeoutMs: number, during?: (ctx: Ctx) => Promise<void>, verify: (ctx: Ctx) => Promise<{ pass: boolean, detail: string }>
}
// Blocks matching re in a box, counted by Josh (who sees everything: he's the referee, not the agent).
const countIn = (josh: Bot, re: RegExp, min: Xyz, max: Xyz) => {
  let n = 0
  for (let x = min[0]; x <= max[0]; x++) for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) if (re.test(josh.blockAt(new Vec3(x, y, z))?.name ?? '')) n++
  return n
}
const treeLeft = (josh: Bot, min: Xyz, max: Xyz) => { const n = countIn(josh, /_(log|leaves)$/, min, max); return { pass: n === 0, detail: `${n} logs and leaves left` } }
const SCENARIOS: Record<string, Scenario> = {
  // "It wrote itself a skill": Jeeve can't reach the leaves, 2A asks for a skill, 2B writes and trials a pillaring
  // behavior, and Jeeve climbs and clears them. A wide shot from the south-west takes in Josh, Jeeve and the canopy.
  canopy: {
    setup: command => { canopy(command); command('give Jeeve oak_log 16') },
    camera: { at: [CANOPY.x - 10, -55, CANOPY.z + 10], facing: [CANOPY.x - 1, -56, CANOPY.z] },
    view: { min: [CANOPY.x - 12, -61, CANOPY.z - 8], max: [CANOPY.x + 8, -46, CANOPY.z + 8] },
    instructions: [CANOPY.instruction],
    timeoutMs: 10 * 60_000,
    verify: async ({ josh }) => treeLeft(josh, [CANOPY.x - 2, -61, CANOPY.z - 2], [CANOPY.x + 2, -49, CANOPY.z + 2])
  },
  // "It learns a skill, then uses it": the skill is built on the first tree, then Jev picks it for the other three.
  // The camera stands back south of the row to take in all four.
  orchard: {
    setup: command => { orchard(command); command('give Jeeve oak_log 32') },
    camera: { at: [39, -52, 6], facing: [39, -56, -12] },
    view: { min: [22, -61, -20], max: [56, -46, -4] },
    instructions: ORCHARD.instructions,
    timeoutMs: 10 * 60_000,
    verify: async ({ josh }) => treeLeft(josh, [27, -61, -15], [51, -49, -9])
  },
  // A chain: logs, a crafting table, a pickaxe, the chest. Two small trees in reach.
  workshop: {
    setup: command => workshop(command),
    camera: { at: [22, -54, -1], facing: [31, -58, -12] },
    view: { min: [18, -61, -24], max: [44, -48, 0] },
    instructions: [WORKSHOP.instruction],
    timeoutMs: 10 * 60_000,
    verify: async ({ josh }) => {
      await josh.lookAt(new Vec3(...WORKSHOP.chest).offset(0.5, 0.5, 0.5))
      const chest = await josh.openContainer(josh.blockAt(new Vec3(...WORKSHOP.chest))!)
      const n = chest.containerItems().filter(i => i.name === 'wooden_pickaxe').length
      chest.close()
      return { pass: n > 0, detail: `${n} wooden pickaxe in the chest` }
    }
  },
  // Guard duty: an open-ended goal for a fixed time, zombie waves near Josh while he moves.
  guard: {
    setup: command => guard(command),
    camera: { at: [31, -51, 4], facing: [31, -58, -12] },
    view: { min: [14, -61, -28], max: [48, -50, 4] },
    instructions: [GUARD.instruction],
    timeoutMs: GUARD.waves * GUARD.waveEveryMs + 20_000,
    during: async ({ josh, command, done }) => {
      for (let i = 0; !done(); i++) {
        if (i % 2 === 0 && i / 2 < GUARD.waves) for (const dx of [-6, 6]) command(`execute at Josh run summon zombie ~${dx} ~ ~4`)
        await sleep(GUARD.waveEveryMs / 2)
        command(`tp Josh ${GUARD.spots[(i + 1) % GUARD.spots.length].join(' ')}`)
      }
      void josh
    },
    verify: async ({ josh, agent }) => {
      const zombies = Object.values(josh.entities).filter(e => e.name === 'zombie').length
      const ok = zombies === 0 && josh.health > 0 && agent.bot.health > 0 && !joshDied && !jeeveDied
      return { pass: ok, detail: `${zombies} zombies left, Josh ${josh.health.toFixed(0)} HP (lost ${joshLost.toFixed(0)}), Jeeve ${agent.bot.health.toFixed(0)} HP${joshDied ? ', Josh died' : ''}${jeeveDied ? ', Jeeve died' : ''}` }
    }
  }
}
let joshDied = false
let jeeveDied = false
let joshLost = 0
const LEAD_MS = 1500 // the clip starts this long before the instruction
const TAIL_MS = 3000 // and ends this long after the goal closes

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const args = process.argv.slice(2)

// OBS websocket v5: Hello → Identify (with the password's challenge if set) → requests and output events.
async function obs (url = process.env.OBS_URL ?? 'ws://127.0.0.1:4455', password = process.env.OBS_PASSWORD ?? '') {
  const ws = new WebSocket(url, 'obswebsocket.json')
  const pending = new Map<string, (d: any) => void>()
  const listeners = new Set<(e: any) => void>()
  let id = 0
  await new Promise<void>((resolve, reject) => {
    ws.onerror = () => reject(new Error(`no OBS websocket at ${url}: OBS → Tools → WebSocket Server Settings`))
    ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data))
      if (m.op === 0) {
        const sha = (s: string) => createHash('sha256').update(s).digest('base64')
        const auth = m.d.authentication
        ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 1 << 6, ...(auth ? { authentication: sha(sha(password + auth.salt) + auth.challenge) } : {}) } }))
      } else if (m.op === 2) resolve()
      else if (m.op === 7) pending.get(m.d.requestId)?.(m.d)
      else if (m.op === 5) for (const l of listeners) l(m.d)
    }
  })
  return {
    call: (requestType: string) => new Promise<any>((resolve, reject) => {
      const requestId = String(++id)
      pending.set(requestId, d => d.requestStatus.result ? resolve(d.responseData) : reject(new Error(`OBS ${requestType}: ${d.requestStatus.comment}`)))
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId } }))
    }),
    recordState: (state: string) => new Promise<any>(resolve => {
      const l = (e: any) => { if (e.eventType === 'RecordStateChanged' && e.eventData.outputState === state) { listeners.delete(l); resolve(e.eventData) } }
      listeners.add(l)
    }),
    close: () => ws.close()
  }
}

// Captions: Claude rewrites each beat's template from that beat's facts only; the templates stay if it can't.
async function captions (bs: Beat[]): Promise<Beat[]> {
  if (!process.env.ANTHROPIC_API_KEY || !bs.length) return bs
  try {
    // Structured output (Opus 5.5 refuses a forced tool_choice): { captions: string[] }, one per beat.
    const res = await new Anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['captions'], properties: { captions: { type: 'array', items: { type: 'string' } } } } }
      },
      system: `You write on-screen captions for a short video of Jeeve, a Minecraft bot. Jeeve has three parts a viewer sees as panels: System 1 (a fast model that picks what the body does several times a second), System 2 (a slower planner that reads instructions and sets goals) and the builder (writes new skills as code and tests them on the body).
For each beat, write one plain sentence of at most 14 words for a viewer who has never heard of the system. Use only the facts given for that beat and what came before; never invent detail. No jargon (no "escalation", "trial window", "pass_when"), no emoji, no exclamation marks. Each beat has a template caption: keep its meaning, make it read well in sequence. Return exactly one caption per beat, in order.`,
      messages: [{ role: 'user', content: JSON.stringify(bs.map(b => ({ kind: b.kind, facts: b.facts, template: b.text }))) }]
    } as Anthropic.Beta.MessageCreateParamsNonStreaming)
    if (res.stop_reason === 'refusal') throw new Error('refused')
    const text = res.content.find(b => b.type === 'text')?.text ?? '{}'
    const out = (JSON.parse(text) as { captions?: string[] }).captions ?? []
    return bs.map((b, i) => ({ ...b, text: typeof out[i] === 'string' && out[i].trim() ? out[i].trim() : b.text }))
  } catch (err) {
    console.warn('[clip] captions fell back to templates:', err)
    return bs
  }
}

function render (dir: string) {
  for (const [layout, name] of [['wide', 'clip-16x9.mp4'], ['tall', 'clip-9x16.mp4']]) {
    const r = spawnSync('npx', ['remotion', 'render', 'src/remotion/index.tsx', layout, resolve(dir, name), '--public-dir', resolve(dir)], { cwd: 'viz', stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`remotion render ${layout} failed`)
    console.log(`[clip] ${resolve(dir, name)}`)
  }
}

// claude: rewrite the templates with Claude (skipped for bench runs; npm run clip -- --captions <dir> does it later).
const writeCaptions = async (dir: string, rows: Row[], start: number, end: number, claude = true) => {
  const bs = beats(rows).filter(b => b.t >= start && b.t <= end)
  writeFileSync(`${dir}/captions.json`, JSON.stringify(claude ? await captions(bs) : bs, null, 2))
}

if (args[0] === '--render') {
  render(args[1])
  process.exit(0)
}
if (args[0] === '--captions') {
  const { rows, start, end } = JSON.parse(readFileSync(`${args[1]}/clip.json`, 'utf8'))
  await writeCaptions(args[1], rows, start, end)
  console.log(`[clip] ${args[1]}/captions.json`)
  process.exit(0)
}

const name = args[0]
const scenario = SCENARIOS[name]
if (!scenario) throw new Error(`usage: npm run clip <${Object.keys(SCENARIOS).join('|')}> [-- --no-record | --bench]`)
// --bench: an unattended scored run (scripts/bench.ts): no OBS, no client, no render; one results row.
const bench = args.includes('--bench')
const record = !bench && !args.includes('--no-record')
const CAMERA = bench ? undefined : process.env.JEEVE_CAMERA
const API = 7790 + PORT - 25565
const dir = `clips/${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`
mkdirSync(dir, { recursive: true })
const camera = record ? await obs() : null // fail fast, before the server starts

const server = startServer(line => { if (/ERROR|joined the game|left the game/.test(line)) console.log('[server]', line) })
await server.ready
const LIBRARY = `traces/clip-module-library-${PORT}.json` // empty, so the builder has to write the skill
if (existsSync(LIBRARY)) rmSync(LIBRARY)
const agent = await startAgent({ port: PORT, allowed: ['Josh'], apiPort: API, moduleLibrary: LIBRARY })
const josh = mineflayer.createBot({ username: 'Josh', auth: 'offline', host: 'localhost', port: PORT })
await Promise.all([new Promise<void>(r => agent.bot.once('spawn', () => r())), new Promise<void>(r => josh.once('spawn', () => r()))])
josh.on('death', () => { joshDied = true })
agent.bot.on('death', () => { jeeveDied = true })
let joshHp = 20
josh.on('health', () => { if (josh.health < joshHp) joshLost += joshHp - josh.health; joshHp = josh.health })
console.log(`[clip] monitor: cd viz && npm run monitor, then open http://localhost:5288/?api=http://127.0.0.1:${API}`)
await sleep(2000)
for (const c of ['gamerule spawn_mobs false', 'kill @e[type=!player]', 'time set day', 'gamemode creative Josh', 'clear Jeeve', 'give Jeeve iron_axe']) server.command(c)
scenario.setup(server.command)

if (CAMERA) {
  console.log(`[clip] waiting for ${CAMERA} to join localhost:${PORT}`)
  while (!agent.bot.players[CAMERA]) await sleep(500)
  const { at, facing } = scenario.camera
  server.command(`gamemode spectator ${CAMERA}`)
  server.command(`tp ${CAMERA} ${at.join(' ')} facing ${facing.join(' ')}`)
} else if (record) console.warn('[clip] JEEVE_CAMERA unset: frame the shot yourself')
await sleep(3000) // chunks around the camera load

// The world recorder: what the camera renders without a client (viz/src/World.tsx). Josh sees every block, so the
// view box's blocks once, then each change in it, and every entity near it ten times a second.
const world = createWriteStream(`${dir}/world.jsonl`)
const inView = (p: { x: number, y: number, z: number }) => p.x >= scenario.view.min[0] && p.x <= scenario.view.max[0] && p.y >= scenario.view.min[1] && p.y <= scenario.view.max[1] && p.z >= scenario.view.min[2] && p.z <= scenario.view.max[2]
{
  const { min, max } = scenario.view
  const palette: string[] = []
  const cells: number[] = []
  for (let x = min[0]; x <= max[0]; x++) for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) {
    const n = josh.blockAt(new Vec3(x, y, z))?.name ?? 'air'
    let k = palette.indexOf(n)
    if (k < 0) k = palette.push(n) - 1
    cells.push(k)
  }
  world.write(JSON.stringify({ t: Date.now(), kind: 'blocks', min, max, palette, cells, camera: scenario.camera }) + '\n')
}
josh.on('blockUpdate', (old, now) => {
  if (now && inView(now.position) && old?.name !== now.name) world.write(JSON.stringify({ t: Date.now(), kind: 'block', pos: [now.position.x, now.position.y, now.position.z], name: now.name }) + '\n')
})
const r2 = (v: number) => Math.round(v * 100) / 100
const entityTimer = setInterval(() => {
  const list = Object.values(josh.entities).filter(e => e.position && inView(e.position.floored()) && e.name !== 'item')
    .map(e => ({ id: e.id, name: e.name, username: e.username, pos: [r2(e.position.x), r2(e.position.y), r2(e.position.z)], yaw: r2(e.yaw), pitch: r2(e.pitch), held: e === josh.entity ? undefined : (e as any).heldItem?.name }))
  world.write(JSON.stringify({ t: Date.now(), kind: 'entities', list }) + '\n')
}, 100)
agent.recorder.jsonl({ kind: 'marker', label: 'world_start' })

let recordStart: number | null = null
if (camera) {
  const started = camera.recordState('OBS_WEBSOCKET_OUTPUT_STARTED')
  await camera.call('StartRecord')
  await started
  recordStart = Date.now()
  agent.recorder.jsonl({ kind: 'marker', label: 'record_start' }) // the clock sync: footage time 0 is this row's t
}
await sleep(LEAD_MS)
const asked = Date.now()
let finished = false
const ctx: Ctx = { josh, agent, command: server.command, done: () => finished }
const during = scenario.during?.(ctx)
const outcomes: string[] = []
for (const text of scenario.instructions) {
  const t0 = Date.now()
  josh.whisper('Jeeve', text)
  const goal = () => agent.goals.nodes.find(g => g.text === text && !g.parent)
  while (!['completed', 'failed'].includes(goal()?.status ?? '') && Date.now() - t0 < scenario.timeoutMs && !jeeveDied) await sleep(500)
  const status = goal()?.status ?? 'missing'
  outcomes.push(status)
  console.log(`[clip] "${text}": goal ${status} after ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  if (status !== 'completed') break
  await sleep(1500)
}
finished = true
await during
const end = Date.now() + TAIL_MS
await sleep(TAIL_MS)
const verdict = await scenario.verify(ctx).catch(err => ({ pass: false, detail: `verify failed: ${err}` }))
console.log(`[clip] verify: ${verdict.pass ? 'PASS' : 'FAIL'} (${verdict.detail})`)
clearInterval(entityTimer)
world.end()

let footage: string | null = null
if (camera) {
  const stopped = camera.recordState('OBS_WEBSOCKET_OUTPUT_STOPPED')
  await camera.call('StopRecord')
  const { outputPath } = await stopped
  agent.recorder.jsonl({ kind: 'marker', label: 'record_stop', path: outputPath })
  camera.close()
  // Remuxed to a plain mp4, which Remotion seeks reliably (OBS writes fragmented MP4 or MKV).
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', outputPath, '-c', 'copy', '-an', `${dir}/footage.mp4`], { stdio: 'inherit' })
  if (r.status === 0) footage = 'footage.mp4'
  else console.warn(`[clip] couldn't remux ${outputPath}; rendering without footage`)
}
const traceFile = agent.traceFile
await agent.stop()
josh.quit()
await server.stop()

const rows = parse(readFileSync(traceFile, 'utf8')).filter(r => r.t <= end)
const start = recordStart ? Math.max(recordStart, asked - LEAD_MS) : asked - LEAD_MS
writeFileSync(`${dir}/clip.json`, JSON.stringify({ scenario: name, session: basename(traceFile, '.jsonl'), start, end, recordStart, footage, world: 'world.jsonl', rows }))

// One results row per run, for hill-climbing across runs (scripts/bench.ts, brain/architecture/benchmarks.md).
const of = (k: string) => rows.filter(r => r.kind === k)
const result = {
  t: new Date().toISOString(), scenario: name, pass: verdict.pass, detail: verdict.detail, outcomes,
  s: Math.round((end - TAIL_MS - asked) / 1000),
  system2: { calls: of('system2').length, s: Math.round(of('system2').reduce((n, r) => n + (r.attrs?.['jeeve.system2.latency_ms'] ?? 0), 0) / 1000) },
  builder: of('builder').map(r => ({ status: r.status, behavior: r.behavior, trials: r.attrs?.['jeeve.builder.trials'], s: Math.round((r.attrs?.['jeeve.builder.latency_ms'] ?? 0) / 1000) })),
  plan_steps: rows.filter(r => r.kind === 'goal' && r.attrs?.['jeeve.goal.plan_step']).length,
  confirms: rows.filter(r => r.kind === 'event' && r.name === 'confirm').length,
  deaths: rows.filter(r => r.kind === 'event' && r.name === 'death').length,
  commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  session: basename(traceFile, '.jsonl'), dir
}
mkdirSync('bench', { recursive: true })
appendFileSync('bench/results.jsonl', JSON.stringify(result) + '\n')
console.log(`[bench] ${JSON.stringify(result)}`)

await writeCaptions(dir, rows, start, end, !bench)
console.log(`[clip] ${dir}: captions.json is editable; re-render with npm run clip -- --render ${dir}`)
if (!bench) render(dir)
process.exit(0)
