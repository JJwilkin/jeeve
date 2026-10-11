// End to end on the local server: a scripted player "Josh" gives the three first-milestone instructions and
// checks the outcomes, a live guard veto, the local API, and that the episode landed in Judgment.
// Uses the real Jev, Claude (System 2) and Judgment staging. Run: MINECRAFT_EULA=true npm run e2e (EULA once).
import { readFileSync } from 'node:fs'
import mineflayer from 'mineflayer'
import { Judgeval } from 'judgeval'
import { startAgent } from '../src/main.ts'
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

const server = startServer(line => { if (/ERROR|joined the game|left the game|Done \(/.test(line) && !/No key layers/.test(line)) console.log('[server]', line) })
await server.ready

const agent = await startAgent({ allowed: ['Josh'], apiPort: API })
const josh = mineflayer.createBot({ username: 'Josh', auth: 'offline', host: 'localhost' })
await Promise.all([new Promise<void>(r => agent.bot.once('spawn', () => r())), new Promise<void>(r => josh.once('spawn', () => r()))])
const whispers: string[] = []
josh.on('whisper', (from, msg) => { console.log(`[josh] ${from} whispers: ${msg}`); whispers.push(msg) })

const jeeveFromJosh = () => Object.values(josh.entities).find(e => e.username === 'Jeeve')
const gap = () => { const j = jeeveFromJosh(); return j ? j.position.distanceTo(josh.entity.position) : Infinity }
const leaf = () => agent.goals.leaf()

server.command('gamerule doMobSpawning false') // scenario control: only mobs we summon
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
const records = readFileSync(agent.traceFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const decisions = records.filter(r => r.kind === 'decide')
const lat = decisions.map(d => d.attrs['jeeve.decide.latency_ms']).sort((a, b) => a - b)
const s2 = records.filter(r => r.kind === 'system2')
console.log(`\ndecisions=${decisions.length} escalating=${decisions.filter(d => d.attrs['jeeve.decide.escalate']).length} jev p50=${lat[lat.length >> 1]} ms`)
console.log(`system2 calls=${s2.length}: ${s2.map(r => `${r.attrs['jeeve.system2.trigger']} ${r.attrs['jeeve.system2.latency_ms']} ms`).join('; ')}`)
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
    const want = ['window', 'carry_over', 'decide', 'system2', 'program', 'goal', 'behavior.collect', 'behavior.follow', 'behavior.attack_when_ready']
    check('Judgment has every span kind for this session', want.every(n => (names[n] ?? 0) > 0), want.filter(n => !names[n]).join(', ') || 'all present')
    const lineage = await client.sql(`SELECT count() AS n FROM telemetry.spans WHERE session_id = '${session}' AND span_name = 'window' AND attributes['jeeve.prev_trace_id'] != ''`)
    check('windows are linked by prev_trace_id', Number((lineage.rows[0] as any).n) > 0, `${(lineage.rows[0] as any).n} linked windows`)
  } catch (err) {
    check('Judgment read-back by SQL', false, String((err as Error).message ?? err))
  }
} else console.log('SKIP Judgment checks: export is off (no credentials or project)')

const failed = results.filter(([, ok]) => !ok).map(([w]) => w)
console.log(failed.length ? `\nE2E FAIL: ${failed.join('; ')}` : '\nE2E PASS')
process.exit(failed.length ? 1 : 0)
