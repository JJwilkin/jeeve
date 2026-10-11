// Jeeve client: joins a server like a player, takes instructions by whisper, runs System 1 on Jev.
import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import collectblock from 'mineflayer-collectblock'
import { CHANNELS, Channels } from './behaviors.ts'
import { coalescing, makeDecider, type Ask } from './decide.ts'
import { inventoryCounts, newHandles, type Directive } from './encoder.ts'
import { guardedMovements, installGuards } from './guards.ts'
import { DEFAULT_PROGRAM, LIMITS, validate, version, type Program } from './program.ts'

export type AgentOptions = {
  host?: string
  port?: number
  username?: string
  allowed: string[] // players whose whispers are instructions
  program?: Program
  ask?: Ask
}

export function startAgent (opts: AgentOptions) {
  const program = opts.program ?? DEFAULT_PROGRAM
  validate(program)
  const bot = mineflayer.createBot({ host: opts.host ?? 'localhost', port: opts.port ?? 25565, username: opts.username ?? 'Jeeve', auth: 'offline' })
  bot.loadPlugin(pf.pathfinder)
  bot.loadPlugin(collectblock.plugin)

  mkdirSync('traces', { recursive: true })
  const traceFile = `traces/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  const trace = (r: Record<string, unknown>) => appendFileSync(traceFile, JSON.stringify(r) + '\n')

  let directive: Directive | null = null
  const events: Array<{ t: number, text: string }> = []
  const recent = () => {
    const now = Date.now()
    while (events.length && now - events[0].t > 5000) events.shift()
    return events.map(e => `${((e.t - now) / 1000).toFixed(1)}s: ${e.text}`)
  }
  const note = (text: string) => { events.push({ t: Date.now(), text }); trace({ kind: 'event', t: Date.now(), text }) }

  const handles = newHandles()
  let wake = (_reason: string) => {}
  const fires = (event: string) => program.triggers.events.includes(event.split(' ')[0])

  const channels = new Channels(bot, (key, event) => {
    note(`${key} ${event}`)
    if (fires(event)) wake(`${key}:${event.split(' ')[0]}`)
  })

  // ponytail: stand-in for System 2's goal. The count is the first number in the directive (default 1),
  // counted from the moment it was given. System 2 replaces this with a real goal and success check.
  const remaining = (block: string) => {
    if (!directive) return 0
    const want = Number(directive.text.match(/\d+/)?.[0] ?? 1)
    return Math.max(0, want - ((inventoryCounts(bot)[block] ?? 0) - (directive.inventory[block] ?? 0)))
  }

  bot.once('spawn', () => {
    bot.pathfinder.setMovements(guardedMovements(bot, false))
    bot.collectBlock.movements = guardedMovements(bot, true)
    installGuards(bot, (channel, reason) => channels.veto(channel, reason))

    const decide = makeDecider({ bot, program, handles, channels, directive: () => directive, events: recent, remaining, trace, ask: opts.ask })
    wake = coalescing(decide, LIMITS.minIntervalMs)
    trace({ kind: 'program', t: Date.now(), program: version(program), manifest: program })
    console.log(`[jeeve] spawned as ${bot.username}; program ${version(program)}; trace ${traceFile}`)

    setInterval(() => wake('heartbeat'), program.triggers.heartbeat_ms)

    // Watch condition: a hostile mob comes within range (fires on the transition, not every tick).
    let hostileNear = false
    bot.on('physicsTick', () => {
      const near = Object.values(bot.entities).some(e => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) <= program.triggers.hostile_within)
      if (near && !hostileNear) { note('hostile mob within range'); if (fires('hostile_near')) wake('hostile_near') }
      hostileNear = near
    })
  })

  bot.on('entityHurt', e => {
    if (e !== bot.entity) return
    note('took damage')
    if (fires('damage_taken')) wake('damage_taken')
  })

  // Instruction channel: whispers from allowed players set the directive.
  bot.on('whisper', (from, message) => {
    if (!opts.allowed.includes(from)) return
    directive = { text: message, from, at: Date.now(), inventory: inventoryCounts(bot) }
    note(`new directive from ${from}: ${message}`)
    trace({ kind: 'directive', t: Date.now(), from, text: message })
    bot.whisper(from, `on it: ${message}`)
    if (fires('new_directive')) wake('new_directive')
  })

  bot.on('death', () => { note('died'); channels.stop(CHANNELS) })
  bot.on('kicked', reason => console.error('[jeeve] kicked', reason))
  bot.on('error', err => console.error('[jeeve] error', err))
  return { bot, channels, traceFile }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const allowed = (process.env.JEEVE_ALLOWED ?? '').split(',').filter(Boolean)
  if (!allowed.length) console.warn('[jeeve] JEEVE_ALLOWED is empty: no one can give instructions')
  startAgent({ host: process.env.JEEVE_HOST, port: Number(process.env.JEEVE_PORT ?? 25565), allowed })
}
