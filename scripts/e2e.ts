// End to end on the local server: a scripted player "Josh" gives the three first-milestone instructions and
// checks the outcomes, a live guard veto, the local API, and that the episode landed in Judgment.
// Uses the real Jev, Claude (System 2) and Judgment staging. Run: MINECRAFT_EULA=true npm run e2e (EULA once).
import { existsSync, readFileSync, rmSync } from 'node:fs'
import mineflayer from 'mineflayer'
import { Judgeval } from 'judgeval'
import { startAgent } from '../src/main.ts'
import { ModuleRegistry } from '../src/modules.ts'
import { judgmentOrg } from '../src/trace.ts'
import { startServer } from './server.ts'

const API = 7790
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const results: Array<[string, boolean]> = []
async function until (what: string, cond: () => boolean, ms: number) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) { console.log(`PASS ${what} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); results.push([what, true]); return true }
    await sleep(200)
  }
  console.log(`FAIL ${what} (timed out after ${ms / 1000} s)`)
  results.push([what, false])
  return false
}
const check = (what: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`); results.push([what, ok]) }

const server = startServer(line => { if (/ERROR|joined the game|left the game|Done \(|[Gg]ame ?rule|feature|Unknown|Incorrect/.test(line) && !/No key layers/.test(line)) console.log('[server]', line) })
await server.ready

const LIBRARY = 'traces/e2e-module-library.json' // a scratch library, so test runs don't rewrite modules/library.json
if (existsSync(LIBRARY)) rmSync(LIBRARY)
const agent = await startAgent({ allowed: ['Josh'], apiPort: API, moduleLibrary: LIBRARY })
const josh = mineflayer.createBot({ username: 'Josh', auth: 'offline', host: 'localhost' })
await Promise.all([new Promise<void>(r => agent.bot.once('spawn', () => r())), new Promise<void>(r => josh.once('spawn', () => r()))])
const whispers: string[] = []
josh.on('whisper', (from, msg) => { console.log(`[josh] ${from} whispers: ${msg}`); whispers.push(msg) })

const jeeveFromJosh = () => Object.values(josh.entities).find(e => e.username === 'Jeeve')
const gap = () => { const j = jeeveFromJosh(); return j ? j.position.distanceTo(josh.entity.position) : Infinity }
const leaf = () => agent.goals.leaf()

await sleep(2000) // let chunks around the players load: since 1.21.9 there are no always-loaded spawn chunks
server.command('gamerule spawn_mobs false') // scenario control: only mobs we summon (doMobSpawning before 1.21.11)
server.command('kill @e[type=!player]') // the world persists between runs
server.command('time set day')
server.command('gamemode creative Josh') // so mobs go for Jeeve, not the instructor
server.command('clear Jeeve')
server.command('give Jeeve diamond_sword')
server.command('give Jeeve iron_axe')

// Guard, live: Jeeve on a 5-high pillar facing east over the edge; a raw "forward" must be vetoed.
server.command('fill 50 -60 0 50 -56 0 stone')
server.command('tp Jeeve 50.5 -55 0.5 -90 0')
await sleep(1500)
const y0 = agent.bot.entity.position.y
agent.bot.setControlState('forward', true)
await sleep(1500)
agent.bot.setControlState('forward', false)
check('guard: raw forward off a 5-block drop is vetoed', agent.bot.entity.position.y >= y0 - 0.1 && (agent.recorder.stats.events.vetoed ?? 0) > 0,
  `y ${y0} → ${agent.bot.entity.position.y.toFixed(2)}, vetoes ${agent.recorder.stats.events.vetoed ?? 0}`)
server.command('fill 50 -60 0 50 -56 0 air')

server.command('tp Jeeve 0 -60 0')
server.command('tp Josh 14 -60 6')
await sleep(2000)

josh.whisper('Jeeve', 'come here')
await until('"come here": Jeeve within 3.5 blocks of Josh', () => gap() < 3.5, 30000)
await until('"come here": System 2 set a check and Josh hears "done"', () => whispers.some(w => w.startsWith('done: come here')), 30000)

// Three 4-high oak log columns near Josh: 12 logs.
for (const [x, z] of [[17, 10], [19, 10], [17, 12]]) server.command(`fill ${x} -60 ${z} ${x} -57 ${z} oak_log`)
await sleep(1000)
const logs = () => agent.bot.inventory.items().filter(i => i.name.endsWith('_log')).reduce((n, i) => n + i.count, 0)
josh.whisper('Jeeve', 'collect 10 logs')
await until('"collect 10 logs": System 2 sets inventory_delta(*_log, 10)', () => leaf()?.done_when?.spec.module === 'inventory_delta' || whispers.some(w => w.startsWith('done: collect')), 30000)
await until('"collect 10 logs": 10 logs in inventory', () => logs() >= 10, 120000)
await until('"collect 10 logs": Josh hears "done"', () => whispers.some(w => w.startsWith('done: collect 10 logs')), 20000)

// Perception: a real oak. System 2 has to look (scan) to set the true log count, and to see the leaves are
// out of reach before trying. Leaves don't decay during the test (random ticks off), and the area is cleared
// first, so nothing from earlier runs or the log columns is counted.
const traceRecords = () => readFileSync(agent.traceFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const looksSince = (n: number) => traceRecords().filter(r => r.kind === 'perceive').slice(n)
const treeBlocks = (re: RegExp) => josh.findBlocks({ matching: b => re.test(b.name), maxDistance: 16, count: 500 }).length
server.command('gamerule random_tick_speed 0')
server.command('fill 4 -60 6 20 -50 20 air')
server.command('tp Jeeve 15 -60 9') // outside the canopy (x 8–12, z 10–14), or the tree grows into him
server.command('tp Josh 15 -60 7')
server.command('place feature minecraft:oak 10 -60 12')
await sleep(1500)
const treeLogs = treeBlocks(/_log$/)
check('an oak is placed', treeLogs >= 4, `${treeLogs} logs, ${treeBlocks(/_leaves$/)} leaves`)
let looked = looksSince(0).length
josh.whisper('Jeeve', 'break this tree')
const tree = () => agent.goals.nodes.find(g => g.text === 'break this tree')
await until('"break this tree": System 2 sets a check', () => !!tree()?.done_when, 45000)
check('"break this tree": the check counts the real logs', tree()?.done_when?.spec.module === 'inventory_delta' && tree()?.done_when?.spec.count === treeLogs,
  `${tree()?.done_when?.desc}, tree has ${treeLogs}`)
const treeLooks = looksSince(looked)
check('"break this tree": System 2 looked first', treeLooks.some(r => r.attrs['jeeve.perceive.tool'] === 'scan'), treeLooks.map(r => `${r.attrs['jeeve.perceive.tool']} ${r.attrs['jeeve.perceive.query']}`).join('; '))
await until('"break this tree": every log is collected', () => treeBlocks(/_log$/) === 0, 120000)
await until('"break this tree": Josh hears "done"', () => whispers.some(w => w.startsWith('done: break this tree')), 20000)

// Outcome-based: an oak's leaves are mostly within reach once the trunk is gone, but collect measures
// progress by items and leaves drop none. Pass if System 2 looks, then reports a limit up front or breaks leaves.
looked = looksSince(0).length
const heard = whispers.length
const asked = Date.now()
const leavesBefore = treeBlocks(/_leaves$/)
let reportedAt = 0
const reported = () => reportedAt > 0 || (whispers.slice(heard).some(w => !/^(on it|done):/.test(w)) && (reportedAt = Date.now()) > 0)
josh.whisper('Jeeve', 'break the leaves too')
await until('"break the leaves too": Jeeve reports a limit up front or breaks leaves', () => reported() || treeBlocks(/_leaves$/) < leavesBefore - 5, 60000)
const leafLooks = looksSince(looked)
check('"break the leaves too": System 2 looked at the leaves', leafLooks.some(r => /leaves/.test(r.attrs['jeeve.perceive.query']) || r.attrs['jeeve.perceive.tool'] === 'reachable'),
  leafLooks.map(r => `${r.attrs['jeeve.perceive.tool']} ${r.attrs['jeeve.perceive.query']}`).join('; '))
if (reported()) check('"break the leaves too": the report came before any stuck', !traceRecords().some(r => r.kind === 'behavior_end' && r.reason === 'stuck' && r.t > asked && r.t < reportedAt))
else console.log(`INFO "break the leaves too": leaves ${leavesBefore} → ${treeBlocks(/_leaves$/)}`)
server.command('gamerule random_tick_speed 3')

// A goal no built-in check covers: System 2 has to write a check module, which code then evaluates.
josh.whisper('Jeeve', 'wait here until it gets dark')
await until('"until dark": System 2 writes and registers a check module', () => !!leaf()?.text.startsWith('wait here') && leaf()?.done_when?.spec.module === 'authored', 45000)
const authored = agent.goals.leaf()?.done_when?.desc ?? ''
check('"until dark": the authored check is false in daylight', !whispers.some(w => w.startsWith('done: wait here')), authored)
server.command('time set 14000')
await until('"until dark": night falls and Josh hears "done"', () => whispers.some(w => w.startsWith('done: wait here until it gets dark')), 15000)
server.command('time set day')
{
  const reloaded = new ModuleRegistry(() => {}, LIBRARY)
  const { loaded } = reloaded.load()
  check('modules persist: a fresh registry reloads the authored check from the library', loaded.includes(agent.goals.nodes.find(g => g.text.startsWith('wait here'))?.done_when?.desc.split(':')[0] ?? '?'), loaded.join(', '))
}

josh.whisper('Jeeve', 'follow me and defend me')
await sleep(1500)
server.command('tp Josh 34 -60 -4')
await sleep(500)
await until('"follow me": Jeeve catches up after Josh moves 20 blocks', () => gap() < 4.5, 30000)
await until('"follow me": System 2 makes it open-ended with escalate_if', () => !!leaf() && leaf()!.done_when === null && leaf()!.escalate_if.length > 0, 30000)

server.command('time set midnight')
server.command('summon zombie 38 -60 -4')
await sleep(1000)
const zombieAlive = () => Object.values(josh.entities).some(e => e.name === 'zombie')
await until('zombie spawned and visible', zombieAlive, 10000)
await until('"defend me": the zombie is killed', () => !zombieAlive(), 45000)
check('Jeeve survived', agent.bot.health > 0, `health ${agent.bot.health}`)

// The local API: an instruction from the operator replaces the root goal; /status shows it.
const post = await fetch(`http://127.0.0.1:${API}/instructions`, { method: 'POST', body: JSON.stringify({ from: 'operator', text: 'stand still and wait' }) })
const status = await (await fetch(`http://127.0.0.1:${API}/status`)).json() as any
check('local API: POST /instructions replaces the root goal', post.status === 202 && status.goals.path[0]?.text === 'stand still and wait')
check('"follow me and defend me" was abandoned, not failed', status.goals.past.some((l: string) => l.includes('abandoned: follow me and defend me')))
await sleep(12000) // let System 2 answer the last instruction before the episode ends

// Summary from the local mirror.
const records = traceRecords()
const decisions = records.filter(r => r.kind === 'decide')
const lat = decisions.map(d => d.attrs['jeeve.decide.latency_ms']).sort((a, b) => a - b)
const s2 = records.filter(r => r.kind === 'system2')
console.log(`\ndecisions=${decisions.length} escalating=${decisions.filter(d => d.attrs['jeeve.decide.escalate']).length} jev p50=${lat[lat.length >> 1]} ms`)
console.log(`system2 calls=${s2.length}: ${s2.map(r => `${r.attrs['jeeve.system2.trigger']} ${r.attrs['jeeve.system2.latency_ms']} ms/${r.attrs['jeeve.system2.turns']} turns`).join('; ')}`)
const looks = records.filter(r => r.kind === 'perceive')
console.log(`perceive calls=${looks.length}: ${looks.map(r => `${r.attrs['jeeve.perceive.tool']} ${r.attrs['jeeve.perceive.latency_ms']} ms ${r.attrs['jeeve.perceive.result_bytes']} B`).join('; ')}`)
console.log(`suppressed escalations=${records.filter(r => r.kind === 'escalation_suppressed').length}, windows=${records.filter(r => r.kind === 'window_open').length}`)

const session = agent.session
await agent.stop()
josh.quit()
await server.stop()

// The episode in Judgment: one session, windows with carry-over lineage, every span kind.
if (agent.recorder.exporting) {
  try {
    const client = await Judgeval.create({ projectName: process.env.JEEVE_PROJECT ?? 'jeeve-dev', organizationId: judgmentOrg() })
    const q = `SELECT span_name, count() AS n FROM telemetry.spans WHERE session_id = '${session}' AND started_at > now() - INTERVAL 1 HOUR GROUP BY span_name ORDER BY n DESC`
    let names: Record<string, number> = {}
    for (let i = 0; i < 10 && !names.system2; i++) {
      await sleep(2000)
      const res = await client.sql(q)
      names = Object.fromEntries(res.rows.map((r: any) => [r.span_name, Number(r.n)]))
    }
    console.log('judgment spans by name:', JSON.stringify(names))
    const want = ['window', 'carry_over', 'decide', 'system2', 'perceive', 'program', 'goal', 'module', 'behavior.collect', 'behavior.follow', 'behavior.attack_when_ready']
    check('Judgment has every span kind for this session', want.every(n => (names[n] ?? 0) > 0), want.filter(n => !names[n]).join(', ') || 'all present')
    const looks = await client.sql(`SELECT count() AS n, countIf(p.span_name = 'system2') AS under FROM telemetry.spans s LEFT JOIN telemetry.spans p ON p.span_id = s.parent_span_id AND p.trace_id = s.trace_id WHERE s.session_id = '${session}' AND s.span_name = 'perceive' AND s.input != '' AND s.output != ''`)
    const lk = looks.rows[0] as any
    check('perceive spans in Judgment carry query and result, under system2', Number(lk.n) > 0 && Number(lk.under) === Number(lk.n), `${lk.under}/${lk.n} under system2`)
    const lineage = await client.sql(`SELECT count() AS n FROM telemetry.spans WHERE session_id = '${session}' AND span_name = 'window' AND attributes['jeeve.prev_trace_id'] != ''`)
    check('windows are linked by prev_trace_id', Number((lineage.rows[0] as any).n) > 0, `${(lineage.rows[0] as any).n} linked windows`)
  } catch (err) {
    check('Judgment read-back by SQL', false, String((err as Error).message ?? err))
  }
} else console.log('SKIP Judgment checks: export is off (no credentials or project)')

const failed = results.filter(([, ok]) => !ok).map(([w]) => w)
console.log(failed.length ? `\nE2E FAIL: ${failed.join('; ')}` : '\nE2E PASS')
process.exit(failed.length ? 1 : 0)
