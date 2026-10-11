// Jeeve client: joins a server like a player, takes instructions (whispers or a local API), keeps the goal
// tree, runs System 1 on Jev under a program System 2 (Claude) shapes, and traces everything to Judgment.
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import collectblock from 'mineflayer-collectblock'
import { Judgeval } from 'judgeval'
import { CHANNELS, Channels } from './behaviors.ts'
import { coalescing, makeDecider, type Ask } from './decide.ts'
import { inventoryCounts, newHandles, rawSnapshot, type Directive } from './encoder.ts'
import { compile, glob, Goals, noteDeath, type CheckSpec, type Goal } from './goals.ts'
import { guardedMovements, installGuards } from './guards.ts'
import { ModuleRegistry, type Snapshot } from './modules.ts'
import { DEFAULT_PROGRAM, ENCODERS, LIMITS, validate, version, type Program } from './program.ts'
import { makeSystem2, type Decision } from './system2.ts'
import { judgmentOrg, Recorder } from './trace.ts'

export type AgentOptions = {
  host?: string
  port?: number
  username?: string
  allowed: string[] // players whose whispers are instructions
  apiPort?: number | null // local instruction API on 127.0.0.1; null turns it off
  project?: string // Judgment project for traces
  system2?: boolean // default: on when ANTHROPIC_API_KEY is set
  ask?: Ask
}

const WINDOW_MS = 60_000
const NO_REPEAT_MS = 30_000
const EVENT_WINDOW_MS = 5_000

export async function startAgent (opts: AgentOptions) {
  const project = opts.project ?? process.env.JEEVE_PROJECT ?? 'jeeve-dev'
  const session = `jeeve-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const recorder = await Recorder.init(project, session)
  const judgeval = recorder.exporting ? await Judgeval.create({ projectName: project, organizationId: judgmentOrg() }).catch(() => null) : null

  const bot = mineflayer.createBot({ host: opts.host ?? 'localhost', port: opts.port ?? 25565, username: opts.username ?? 'Jeeve', auth: 'offline' })
  bot.loadPlugin(pf.pathfinder)
  bot.loadPlugin(collectblock.plugin)

  // ---- live event stream: the last few seconds for Jev, longer for System 2 ----
  const events: Array<{ t: number, text: string }> = []
  const recentFor = (ms: number) => {
    const now = Date.now()
    return events.filter(e => now - e.t <= ms).map(e => `${((e.t - now) / 1000).toFixed(1)}s: ${e.text}`)
  }
  const note = (text: string) => {
    events.push({ t: Date.now(), text })
    while (events.length && Date.now() - events[0].t > 60_000) events.shift()
  }

  let directive: Directive | null = null
  let lastView: unknown = null
  const handles = newHandles()
  let program = DEFAULT_PROGRAM
  let wake = (_reason: string) => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let watchdog = { decides: 0, errors: 0, previous: null as Program | null }
  const fires = (event: string) => program.triggers.events.includes(event.split(' ')[0])
  const failures = new Map<string, number>() // per goal: stuck / none_found count

  // ---- modules System 2 writes: trialled on recent real states, disabled after repeated errors ----
  const recentStates: Snapshot[] = [] // raw snapshots from recent decide calls, for trials
  const modules = new ModuleRegistry((m, reason) => {
    recorder.record('module', { attrs: { 'jeeve.module.id': m.id, 'jeeve.module.kind': m.kind, 'jeeve.module.activation': 'disabled' }, output: { reason, stats: m.stats } })
    note(`module ${m.id} disabled: ${reason}`)
    const leaf = goals.leaf()
    if (leaf) escalate('module_disabled', { module: m.id, reason }, leaf)
  })
  const lookup = (name: string) => modules.get(name)

  const goals = new Goals({
    completed: g => {
      recorder.record('goal', { attrs: { 'jeeve.goal.id': g.id, 'jeeve.goal.path': goals.pathText(), 'jeeve.goal.transition': 'completed' }, output: { summary: g.summary } })
      note(`goal completed: ${g.text} (${g.summary})`)
      if (g.from?.via === 'whisper') bot.whisper(g.from.player, `done: ${g.text}, ${g.summary}`)
      afterGoalChange(g)
    },
    escalate: (reason, g) => escalate(reason, { goal: g.id }, g)
  })

  // A root closing is a goal boundary: cut the window. Programs stack with goals, so re-sync.
  function afterGoalChange (closed: Goal) {
    recorder.goalPath = goals.pathText()
    if (!closed.parent) {
      directive = null
      channels.stop(CHANNELS, 'goal_closed')
      recorder.cut('goal_boundary')
    }
    syncProgram(`goal ${closed.id} ${closed.status}`)
  }

  // ---- channels: behavior runs become behavior spans; events wake Jev or escalate ----
  const channels = new Channels(bot, {
    start: slot => recorder.startBehavior(slot.runId, slot.behavior, {
      'jeeve.behavior.params': slot.key, 'jeeve.behavior.channels': slot.channels.join('+'),
      'jeeve.behavior.decided_by': slot.decidedBy, 'jeeve.behavior.version': 1
    }),
    end: (slot, reason) => recorder.endBehavior(slot.runId, reason),
    event: (slot, event) => {
      note(`${slot.key} ${event}`)
      recorder.behaviorEvent(slot.runId, event)
      const name = event.split(' ')[0]
      if (fires(name)) wake(`${slot.key}:${name}`)
      // A second stuck / none_found under the same goal escalates; the first is Jev's to retry.
      if (name === 'stuck' || name === 'none_found') {
        const leaf = goals.leaf()
        const k = `${leaf?.id}:${name}`
        failures.set(k, (failures.get(k) ?? 0) + 1)
        if (leaf && failures.get(k)! >= 2) escalate(name, { behavior: slot.key, event }, leaf)
      }
    }
  })

  // What's left of the goal's count for a block type. Until System 2 has set a check, the count is the
  // first number in the instruction (Jev acts on the raw text during System 2's few seconds).
  const remaining = (block: string) => {
    const leaf = goals.leaf()
    if (!leaf || !directive) return 0
    const check = leaf.done_when
    if (check?.spec.module === 'inventory_delta') {
      const p = check.progress!(bot)
      return glob(check.spec.match ?? '*').test(block) ? p.want - p.have : 0
    }
    if (check) return 0
    const want = Number(directive.text.match(/\d+/)?.[0] ?? 1)
    return Math.max(0, want - ((inventoryCounts(bot)[block] ?? 0) - (directive.inventory[block] ?? 0)))
  }

  // ---- programs: validate, dry-run the encoder, activate; the watchdog rolls back ----
  function activate (next: Program, because: string, cites: string[] = []): boolean {
    let failed: string | null = null
    try {
      validate(next)
      const t0 = Date.now()
      ENCODERS[next.encoder.module](next.encoder.params)(bot, { handles, directive, channels: channels.describe(), events: [] })
      if (Date.now() - t0 > LIMITS.encodeMs * 5) failed = `encoder took ${Date.now() - t0} ms on a dry run`
    } catch (err) { failed = String(err) }
    const v = version(next)
    recorder.record('program', {
      attrs: {
        'jeeve.program.version': v, 'jeeve.program.parent': next.parent ?? undefined, 'jeeve.program.reason': next.reason,
        'jeeve.program.cites': cites.join(','), 'jeeve.program.activation': failed ? 'failed_check' : 'ok', 'jeeve.program.because': because
      },
      input: { parent: next.parent }, output: { manifest: next, error: failed ?? undefined }
    })
    if (failed) { console.warn(`[program] ${v} failed its check: ${failed}`); return false }
    watchdog = { decides: 0, errors: 0, previous: program }
    program = next
    recorder.program = v
    recorder.stats.programs.add(v)
    wireDecider()
    console.log(`[program] ${v} active: ${because}`)
    return true
  }

  function syncProgram (why: string) {
    const want = goals.program() ?? DEFAULT_PROGRAM
    if (version(want) !== version(program)) activate(want, want === DEFAULT_PROGRAM ? `restore default: ${why}` : why)
  }

  function wireDecider () {
    const decide = makeDecider({
      bot, program, handles, channels, remaining,
      directive: () => directive && { ...directive, goal: goalLine() },
      events: () => recentFor(EVENT_WINDOW_MS),
      record: span => {
        lastView = (span.input as { state: unknown }).state
        recentStates.push(JSON.parse(span.attrs['jeeve.decide.raw_state'] as string))
        if (recentStates.length > 30) recentStates.shift()
        // Watchdog: 3 failed calls in the first 10 after an activation roll back to the previous program.
        watchdog.decides++
        if ((span.output as { error?: string }).error) watchdog.errors++
        if (watchdog.previous && watchdog.decides <= 10 && watchdog.errors >= 3) {
          const back = watchdog.previous
          watchdog.previous = null
          const because = `rolled back from ${version(program)}: ${watchdog.errors} failed calls`
          recorder.record('program', { attrs: { 'jeeve.program.version': version(back), 'jeeve.program.activation': 'rolled_back', 'jeeve.program.because': because } })
          queueMicrotask(() => activate(back, because))
        }
        return recorder.record('decide', { attrs: span.attrs, input: span.input, output: span.output, kind: 'llm', llm: span.llm })
      },
      escalate: (reason, detail) => { const leaf = goals.leaf(); if (leaf) escalate(reason, detail, leaf) },
      ask: opts.ask
    })
    wake = coalescing(decide, LIMITS.minIntervalMs)
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = setInterval(() => wake('heartbeat'), program.triggers.heartbeat_ms)
  }

  const goalLine = () => {
    const leaf = goals.leaf()
    if (!leaf) return null
    const p = goals.progress(bot)
    return `${leaf.text}${leaf.done_when ? `: done when ${leaf.done_when.desc}` : ''}${p ? ` (${p.have}/${p.want})` : ''}`
  }

  // ---- System 2: one call in flight, escalations merged, no repeats within 30 s ----
  const useSystem2 = opts.system2 ?? !!process.env.ANTHROPIC_API_KEY
  const system2 = useSystem2
    ? makeSystem2({
      sql: judgeval ? q => judgeval.sql(q) : undefined,
      schema: judgeval ? await judgeval.discoverSchema().catch(() => undefined) : undefined,
      effort: trigger => trigger.includes('instruction') ? 'medium' : 'low'
    })
    : null
  type Trigger = { reason: string, detail: unknown, goal: string }
  let pending: Trigger[] = []
  const lastSent = new Map<string, number>()

  function escalate (reason: string, detail: unknown, goal: Goal) {
    note(`escalation: ${reason}`)
    recorder.stats.escalations.push(reason)
    const key = `${reason}|${goal.id}|${version(program)}`
    if (reason !== 'instruction' && Date.now() - (lastSent.get(key) ?? 0) < NO_REPEAT_MS) {
      recorder.jsonl({ kind: 'escalation_suppressed', reason, goal: goal.id })
      return
    }
    lastSent.set(key, Date.now())
    if (!system2) { recorder.jsonl({ kind: 'escalation_unhandled', reason, goal: goal.id }); return }
    pending.push({ reason, detail, goal: goal.id })
    wakeSystem2(reason)
  }

  const wakeSystem2 = coalescing(async () => {
    const onPath = new Set(goals.path().map(g => g.id))
    const triggers = pending.filter(t => onPath.has(t.goal)) // escalations for goals that closed meanwhile are moot
    pending = []
    if (!triggers.length || !system2 || stopped) return
    const goal = goals.nodes.find(g => g.id === (triggers.find(t => t.reason === 'instruction') ?? triggers.at(-1)!).goal)!
    const root = goals.path()[0]
    const trigger = triggers.map(t => t.reason === 'instruction' ? 'instruction' : `escalation:${t.reason}`).join(',')
    const context = {
      triggers,
      instruction: triggers.some(t => t.reason === 'instruction') ? { text: root?.text, from: root?.from } : undefined,
      goals: goals.status(bot),
      program: { version: version(program), guidance: program.guidance, allowed_behaviors: program.allowed_behaviors, heartbeat_ms: program.triggers.heartbeat_ms },
      fast_model_view: lastView,
      modules: modules.list(),
      recent_events: recentFor(30_000),
      window: { session_id: session, previous_trace_id: recorder.prevTraceId, summary_so_far: recorder.summary() }
    }
    const t0 = Date.now()
    let result
    try { result = await system2(trigger, context) } catch (err) {
      recorder.record('system2', { attrs: { 'jeeve.system2.trigger': trigger }, input: context, output: { error: String(err) }, kind: 'llm' })
      console.error('[system2]', err)
      return
    }
    if (stopped) return
    const d = result.decision
    const u = result.usage
    const spanId = recorder.record('system2', {
      attrs: { 'jeeve.system2.trigger': trigger, 'jeeve.system2.latency_ms': Date.now() - t0, 'jeeve.system2.turns': result.turns, 'jeeve.system2.refusal': result.refusal },
      input: context, output: { decision: d, sql: result.sql }, kind: 'llm',
      llm: u ? { model: result.model, provider: 'anthropic', non_cached_input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 } : undefined
    })
    recorder.stats.system2.push(`${trigger} → ${d ? d.note : result.refusal ? 'refused' : 'no decision'}`)
    console.log(`[system2] ${trigger} (${Date.now() - t0} ms): ${d?.note ?? 'no decision'}`)
    if (d) applyDecision(d, goal, spanId)
  }, 0)

  function applyDecision (d: Decision, goal: Goal, cite: string) {
    goal.log.push(`system2: ${d.note}`)
    recorder.stats.note = d.note
    const live = goal.status === 'active' || goal.status === 'suspended'
    const root = goals.nodes.find(g => g.id === goals.path()[0]?.id)
    if (d.message && root?.from?.via === 'whisper') bot.whisper(root.from.player, d.message)
    if (!live) return // the goal was closed while System 2 was thinking: keep only the note

    // Modules first, so the rest of the decision can reference them. Each refusal is evidence for the next try.
    const problems: string[] = []
    for (const src of d.new_modules ?? []) {
      const { module, trial } = modules.register(src, [...recentStates, rawSnapshot(bot)])
      recorder.record('module', {
        attrs: { 'jeeve.module.id': module?.id ?? src.name, 'jeeve.module.kind': src.kind, 'jeeve.module.activation': module ? 'ok' : 'failed_trial', 'jeeve.program.cites': cite },
        input: src, output: trial
      })
      goal.log.push(module ? `registered ${module.id} (true on ${trial.trues}/${trial.states} recent states)` : `module ${src.name} refused: ${trial.error}`)
      if (!module) problems.push(`module ${src.name} refused: ${trial.error}`)
    }
    const check = (spec: CheckSpec, g: Goal) => {
      try { return compile(spec, g, lookup) } catch (err) { problems.push(String(err)); return null }
    }

    if (d.goal) {
      const done = d.goal.done_when ? check(d.goal.done_when, goal) : null
      if (!d.goal.done_when || done) goal.done_when = done // keep the old check if the new one can't compile
      goal.escalate_if = d.goal.escalate_if.map((c: CheckSpec) => check(c, goal)).filter(c => c !== null)
      goal.budget_ms = d.goal.budget_s ? d.goal.budget_s * 1000 : null
      goal.review_ms = d.goal.review_s ? d.goal.review_s * 1000 : null
      goal.started = Date.now()
    }
    if (d.goal_action === 'renew') goal.started = Date.now()
    if (d.program) {
      const base = goal.program ?? goals.program() ?? DEFAULT_PROGRAM
      const next: Program = {
        ...base,
        parent: version(base),
        reason: d.note,
        guidance: d.program.guidance ?? base.guidance,
        allowed_behaviors: d.program.allowed_behaviors ?? base.allowed_behaviors,
        triggers: {
          ...base.triggers,
          heartbeat_ms: Math.min(5000, Math.max(LIMITS.minIntervalMs, d.program.heartbeat_ms ?? base.triggers.heartbeat_ms)),
          watch: (d.program.watch ?? base.triggers.watch ?? []).filter(n => {
            const ok = modules.get(n)?.kind === 'watch'
            if (!ok) problems.push(`no registered watch module named ${n}`)
            return ok
          })
        }
      }
      try { validate(next); goal.program = next } catch (err) {
        recorder.record('program', { attrs: { 'jeeve.program.version': version(next), 'jeeve.program.activation': 'failed_check', 'jeeve.program.cites': cite }, output: { error: String(err) } })
      }
    }
    if (d.push_child) {
      const child = goals.create(d.push_child.text, goal.id, null, bot)
      child.done_when = d.push_child.done_when ? check(d.push_child.done_when, child) : null
      child.budget_ms = d.push_child.budget_s ? d.push_child.budget_s * 1000 : null
      recorder.record('goal', { attrs: { 'jeeve.goal.id': child.id, 'jeeve.goal.path': goals.pathText(), 'jeeve.goal.transition': 'pushed' }, input: { text: child.text } })
    }
    if (d.goal_action === 'fail') {
      goals.close(goal, 'failed', d.note)
      recorder.record('goal', { attrs: { 'jeeve.goal.id': goal.id, 'jeeve.goal.path': goals.pathText(), 'jeeve.goal.transition': 'failed' }, output: { summary: d.note } })
      afterGoalChange(goal)
      return
    }
    recorder.goalPath = goals.pathText()
    const want = goals.program() ?? DEFAULT_PROGRAM
    if (version(want) !== version(program)) activate(want, `system2: ${d.note}`, [cite])
    if (problems.length) escalate('module_failed', { problems }, goal)
  }

  // ---- instructions: whispers from allowed players, or the local API ----
  function instruct (text: string, from: { player: string, via: 'whisper' | 'api' }) {
    const { root, abandoned } = goals.instruction(text, from, bot)
    for (const g of abandoned) recorder.record('goal', { attrs: { 'jeeve.goal.id': g.id, 'jeeve.goal.transition': 'abandoned' }, output: { summary: g.summary } })
    recorder.goalPath = goals.pathText()
    recorder.cut('goal_boundary')
    recorder.record('goal', { attrs: { 'jeeve.goal.id': root.id, 'jeeve.goal.path': recorder.goalPath, 'jeeve.goal.transition': 'pushed' }, input: { text, from } })
    directive = { text, from: from.player, at: Date.now(), inventory: inventoryCounts(bot) }
    note(`new directive from ${from.player}: ${text}`)
    if (from.via === 'whisper') bot.whisper(from.player, `on it: ${text}`)
    syncProgram('new instruction')
    if (fires('new_directive')) wake('new_directive')
    escalate('instruction', { text, from }, root)
    return root
  }

  bot.on('whisper', (from, message) => { if (opts.allowed.includes(from)) instruct(message, { player: from, via: 'whisper' }) })

  let api: Server | null = null
  if (opts.apiPort !== null) {
    api = createServer((req, res) => {
      const reply = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (req.method === 'GET' && req.url === '/status') {
        return reply(200, { goals: goals.status(bot), program: version(program), channels: channels.describe(), modules: modules.list(), session, trace_window: recorder.index })
      }
      if (req.method === 'POST' && req.url === '/instructions') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
          try {
            const { from, text } = JSON.parse(body)
            if (typeof text !== 'string' || !text.trim()) return reply(400, { error: 'text is required' })
            const root = instruct(text.trim(), { player: typeof from === 'string' ? from : 'operator', via: 'api' })
            reply(202, { goal: root.id })
          } catch { reply(400, { error: 'body must be JSON {from, text}' }) }
        })
        return
      }
      reply(404, { error: 'POST /instructions or GET /status' })
    })
    // Bound to localhost only: anyone who can reach it is the operator.
    api.listen(opts.apiPort ?? 7777, '127.0.0.1')
  }

  // ---- game events ----
  bot.once('spawn', () => {
    bot.pathfinder.setMovements(guardedMovements(bot, false))
    bot.collectBlock.movements = guardedMovements(bot, true)
    installGuards(bot, (channel, reason) => {
      note(`guard vetoed ${reason}`)
      recorder.windowEvent('vetoed', { channel, reason })
      channels.veto(channel, reason)
    })
    recorder.openWindow({ reason: 'episode_start', bot: bot.username })
    activate(DEFAULT_PROGRAM, 'episode start')
    console.log(`[jeeve] spawned as ${bot.username}; session ${session}; judgment ${recorder.exporting ? `project ${project}` : 'off (JSONL only)'}; system2 ${system2 ? 'on' : 'off'}`)

    let hostileNear = false
    let ticks = 0
    const watching = new Map<string, boolean>()
    bot.on('physicsTick', () => {
      const near = Object.values(bot.entities).some(e => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) <= program.triggers.hostile_within)
      if (near && !hostileNear) { note('hostile mob within range'); if (fires('hostile_near')) wake('hostile_near') }
      hostileNear = near
      if (++ticks % 5 !== 0) return
      goals.tick(bot) // checks every 250 ms
      // Watch modules wake Jev when they turn true (rising edge only).
      const watch = program.triggers.watch ?? []
      if (!watch.length) return
      const snap = rawSnapshot(bot)
      for (const name of watch) {
        const on = modules.get(name)?.run(snap) ?? false
        if (on && !watching.get(name)) { note(`watch ${name} turned true`); wake(`watch:${name}`) }
        watching.set(name, on)
      }
    })
    setInterval(() => { if (recorder.window && Date.now() - recorder.openedAt >= WINDOW_MS) recorder.cut('time') }, 1000)
  })

  bot.on('entityHurt', e => {
    if (e === bot.entity) {
      note('took damage')
      recorder.windowEvent('damage', { health: bot.health })
      if (fires('damage_taken')) wake('damage_taken')
    } else if (e.type === 'player' && e.username === goals.path()[0]?.from?.player) {
      note(`${e.username} took damage`)
      recorder.windowEvent('owner_damage', { player: e.username })
    }
  })
  bot.on('entityDead', e => { if (e.type === 'player' && e.username) noteDeath(e.username) })
  bot.on('chat', (username, message) => { if (username !== bot.username) recorder.windowEvent('chat', { from: username, message }) })
  bot.on('death', () => {
    note('died')
    recorder.windowEvent('death')
    channels.stop(CHANNELS, 'death')
    const leaf = goals.leaf()
    if (leaf) escalate('death', {}, leaf)
  })
  bot.on('kicked', reason => console.error('[jeeve] kicked', reason))
  bot.on('error', err => console.error('[jeeve] error', err))

  let stopped = false
  async function stop () {
    stopped = true
    if (heartbeat) clearInterval(heartbeat)
    api?.close()
    channels.stop(CHANNELS, 'episode_end')
    await recorder.shutdown()
    bot.quit()
  }
  return { bot, channels, goals, recorder, stop, traceFile: recorder.file, session }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const allowed = (process.env.JEEVE_ALLOWED ?? '').split(',').filter(Boolean)
  if (!allowed.length) console.warn('[jeeve] JEEVE_ALLOWED is empty: only the local API can give instructions')
  const agent = await startAgent({ host: process.env.JEEVE_HOST, port: Number(process.env.JEEVE_PORT ?? 25565), allowed, apiPort: Number(process.env.JEEVE_API_PORT ?? 7777) })
  process.on('SIGINT', () => { void agent.stop().then(() => process.exit(0)) })
}
