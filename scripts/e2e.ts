// End to end on the local server: a scripted player "Josh" whispers the first-milestone instructions
// and checks the outcome. Uses the real Jev. Run: MINECRAFT_EULA=true npm run e2e (EULA only needed once).
import { readFileSync } from 'node:fs'
import mineflayer from 'mineflayer'
import { startAgent } from '../src/main.ts'
import { startServer } from './server.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until (what: string, cond: () => boolean, ms: number) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) { console.log(`PASS ${what} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); return true }
    await sleep(200)
  }
  console.log(`FAIL ${what} (timed out after ${ms / 1000} s)`)
  return false
}

const server = startServer(line => { if (/ERROR|joined the game|left the game|Done \(/.test(line)) console.log('[server]', line) })
await server.ready

const agent = startAgent({ allowed: ['Josh'] })
const josh = mineflayer.createBot({ username: 'Josh', auth: 'offline', host: 'localhost' })
await Promise.all([new Promise<void>(r => agent.bot.once('spawn', () => r())), new Promise<void>(r => josh.once('spawn', () => r()))])
josh.on('whisper', (from, msg) => console.log(`[josh] ${from} whispers: ${msg}`))

const jeeveFromJosh = () => Object.values(josh.entities).find(e => e.username === 'Jeeve')
const gap = () => { const j = jeeveFromJosh(); return j ? j.position.distanceTo(josh.entity.position) : Infinity }

server.command('gamerule doMobSpawning false') // scenario control: only mobs we summon
server.command('kill @e[type=!player]') // the world persists between runs
server.command('time set day')
server.command('gamemode creative Josh') // so mobs go for Jeeve, not the instructor
server.command('give Jeeve diamond_sword')
server.command('tp Jeeve 0 -60 0')
server.command('tp Josh 14 -60 6')
await sleep(2000)

const results: boolean[] = []

josh.whisper('Jeeve', 'come here')
results.push(await until('"come here": Jeeve within 3.5 blocks of Josh', () => gap() < 3.5, 30000))

josh.whisper('Jeeve', 'follow me and defend me')
await sleep(1500)
server.command('tp Josh 34 -60 -4')
await sleep(500)
results.push(await until('"follow me": Jeeve catches up after Josh moves 20 blocks', () => gap() < 4.5, 30000))

server.command('time set midnight')
server.command('summon zombie 38 -60 -4')
await sleep(1000)
const zombieAlive = () => Object.values(josh.entities).some(e => e.name === 'zombie')
results.push(await until('zombie spawned and visible', zombieAlive, 10000))
results.push(await until('"defend me": the zombie is killed', () => !zombieAlive(), 45000))
results.push(agent.bot.health > 0)
console.log(`${agent.bot.health > 0 ? 'PASS' : 'FAIL'} Jeeve survived (health ${agent.bot.health})`)

// Summary from the trace.
const records = readFileSync(agent.traceFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const decisions = records.filter(r => r.kind === 'decide')
const lat = decisions.map(d => d.latency_ms).sort((a, b) => a - b)
const started = decisions.flatMap(d => Object.entries(d.applied ?? {}).filter(([, v]) => v === 'started').map(([c]) => `${c}=${d.answers[c].choice}`))
console.log(`\ndecisions=${decisions.length} errors=${decisions.filter(d => d.error).length} escalations=${decisions.filter(d => d.escalate).length} latency p50=${lat[lat.length >> 1]} ms max=${lat.at(-1)} ms`)
console.log('behaviors started:', started.join(', '))
console.log('trace:', agent.traceFile)

agent.bot.quit(); josh.quit()
await server.stop()
console.log(results.every(Boolean) ? '\nE2E PASS' : '\nE2E FAIL')
process.exit(results.every(Boolean) ? 0 : 1)
