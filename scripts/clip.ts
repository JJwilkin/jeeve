// One command per clip (brain/architecture/brain-monitor.md): set up a scene, run the agent on it while OBS
// records, then render the clip at 16:9 and 9:16 with Remotion (viz/). Uses the real Jev, Claude and Judgment.
//   npm run clip canopy                  record and render (JEEVE_CAMERA=<your player> frames your spectator client)
//   npm run clip canopy -- --no-record   run and render the panels without footage
//   npm run clip -- --captions clips/<dir>  rewrite captions.json from the clip's trace
//   npm run clip -- --render clips/<dir>    re-render, e.g. after editing captions.json
// Joshua's client joins localhost:<JEEVE_PORT> as JEEVE_CAMERA; OBS's websocket server: OBS_URL, OBS_PASSWORD.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import mineflayer from 'mineflayer'
import { startAgent } from '../src/main.ts'
import { MODEL } from '../src/system2.ts'
import { beats, parse, type Beat, type Row } from '../viz/src/timeline.ts'
import { canopy, CANOPY } from './scenes.ts'
import { PORT, startServer } from './server.ts'

type Xyz = [number, number, number]
type Scenario = { setup: (command: (c: string) => void) => void, camera: { at: Xyz, facing: Xyz }, instruction: string, timeoutMs: number }
const SCENARIOS: Record<string, Scenario> = {
  // "It wrote itself a skill": Jeeve can't reach the leaves, 2A asks for a skill, 2B writes and trials a pillaring
  // behavior, and Jeeve climbs and clears them. A wide shot from the south-west takes in Josh, Jeeve and the canopy.
  canopy: {
    setup: command => { canopy(command); command('give Jeeve oak_log 16') },
    camera: { at: [CANOPY.x - 10, -55, CANOPY.z + 10], facing: [CANOPY.x - 1, -56, CANOPY.z] },
    instruction: CANOPY.instruction,
    timeoutMs: 10 * 60_000
  }
}
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

const writeCaptions = async (dir: string, rows: Row[], start: number, end: number) =>
  writeFileSync(`${dir}/captions.json`, JSON.stringify(await captions(beats(rows).filter(b => b.t >= start && b.t <= end)), null, 2))

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
if (!scenario) throw new Error(`usage: npm run clip <${Object.keys(SCENARIOS).join('|')}> [-- --no-record]`)
const record = !args.includes('--no-record')
const CAMERA = process.env.JEEVE_CAMERA
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

let recordStart: number | null = null
if (camera) {
  const started = camera.recordState('OBS_WEBSOCKET_OUTPUT_STARTED')
  await camera.call('StartRecord')
  await started
  recordStart = Date.now()
  agent.recorder.jsonl({ kind: 'marker', label: 'record_start' }) // the clock sync: footage time 0 is this row's t
  await sleep(LEAD_MS)
}
const asked = Date.now()
josh.whisper('Jeeve', scenario.instruction)
const goal = () => agent.goals.nodes.find(g => g.text === scenario.instruction && !g.parent)
while (!['completed', 'failed'].includes(goal()?.status ?? '') && Date.now() - asked < scenario.timeoutMs) await sleep(500)
console.log(`[clip] goal ${goal()?.status ?? 'missing'} after ${((Date.now() - asked) / 1000).toFixed(0)} s`)
const end = Date.now() + TAIL_MS
await sleep(TAIL_MS)

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
writeFileSync(`${dir}/clip.json`, JSON.stringify({ scenario: name, session: basename(traceFile, '.jsonl'), start, end, recordStart, footage, rows }))
await writeCaptions(dir, rows, start, end)
console.log(`[clip] ${dir}: captions.json is editable; re-render with npm run clip -- --render ${dir}`)
render(dir)
process.exit(0)
