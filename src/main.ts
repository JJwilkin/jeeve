// Jeeve client: joins a server like a player, takes instructions (whispers or a local API), keeps the goal
// tree, runs System 1 on Jev under a program System 2 (Claude) shapes, and traces everything to Judgment.
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import collectblock from 'mineflayer-collectblock'
import { Judgeval } from 'judgeval'
import { authoredSpec, BEHAVIORS, CHANNELS, Channels, type Spec, type WorldReads } from './behaviors.ts'
import { coalescing, makeDecider, type Ask } from './decide.ts'
import { attacking, describeEntity, handleFor, inventoryCounts, newHandles, rawSnapshot, type Attackers, type Directive } from './encoder.ts'
import { compile, glob, Goals, noteDeath, type CheckSpec, type Goal } from './goals.ts'
import { guardedMovements, installGuards } from './guards.ts'
import { compileBehavior, MODULE_LIMITS, ModuleRegistry, type BehaviorTrial, type ModuleSource, type Snapshot } from './modules.ts'
import { DEFAULT_PROGRAM, ENCODERS, LIMITS, validate, version, type Program } from './program.ts'
import { makeSystem2, type BehaviorDraft, type Decision, type Perceive } from './system2.ts'
import { judgmentOrg, Recorder } from './trace.ts'
import { blockAt, reachable, scan, type Pos } from './world.ts'

export type AgentOptions = {
  host?: string
  port?: number
  username?: string
  allowed: string[] // players whose whispers are instructions
  apiPort?: number | null // local instruction API on 127.0.0.1; null turns it off
  project?: string // Judgment project for traces
  system2?: boolean // default: on when ANTHROPIC_API_KEY is set
  moduleLibrary?: string // where modules System 2 writes persist across runs
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
  const attackers: Attackers = new Map()
  // Health over the last 5 s, so a fast drop can bypass the no-repeat window (see escalate()).
  const healthLog: Array<{ t: number, hp: number }> = []
  // ponytail: 4 HP in 5 s is a guess (run jeeve-2026-10-11T16-36-51-167Z lost 2 HP every 0.5 s); tune from traces.
  const fallingFast = () => healthLog.some(h => Date.now() - h.t <= 5000 && h.hp - bot.health >= 4)
  let program = DEFAULT_PROGRAM
  let wake = (_reason: string) => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let watchdog = { decides: 0, errors: 0, previous: null as Program | null }
  const fires = (event: string) => program.triggers.events.includes(event.split(' ')[0])
  const failures = new Map<string, number>() // per goal: stuck / none_found count

  // ---- modules System 2 writes: trialled on recent real states, disabled after repeated errors ----
  const recentStates: Snapshot[] = [] // raw snapshots from recent decide calls, for trials
  const library = opts.moduleLibrary ?? process.env.JEEVE_MODULE_LIBRARY ?? 'modules/library.json'
  const modules = new ModuleRegistry((m, reason) => {
    recorder.record('module', { attrs: { 'jeeve.module.id': m.id, 'jeeve.module.kind': m.kind, 'jeeve.module.activation': 'disabled' }, output: { reason, stats: m.stats } })
    note(`module ${m.id} disabled: ${reason}`)
    const leaf = goals.leaf()
    if (leaf) escalate('module_disabled', { module: m.id, reason }, leaf)
  }, library)
  const libraryLoad = modules.load()
  const lookup = (name: string) => modules.get(name)
  const world: WorldReads = { blockAt, scan, reachable } // the shared block view (src/world.ts), as authored code sees it
  // Behaviors from the library join the seed set; Jev sees them wherever System 2's program allows them.
  for (const m of modules.modules.values()) if (m.kind === 'behavior') BEHAVIORS[m.name] = { ...authoredSpec(m, world), disabled: m.disabled }
  const authoredFailures = new Map<string, number>() // behavior name → failed runs in a row
  let trial: TrialRun | null = null // the one live trial, if any (see startTrial)

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
    channels.stopStalePlace(goals.place())
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
      'jeeve.behavior.decided_by': slot.decidedBy, 'jeeve.behavior.version': slot.version
    }),
    end: (slot, reason) => {
      recorder.endBehavior(slot.runId, reason, slot.run.detail?.())
      if (slot.pinned) return finishTrial(reason, slot.run.detail?.() as RunDetail | undefined) // only trials are pinned
      // An authored behavior that keeps failing (its own error or time limit) is disabled, as checks are.
      const m = modules.get(slot.behavior)
      if (m?.kind !== 'behavior') return
      const n = reason === 'error' || reason === 'timeout' ? (authoredFailures.get(m.name) ?? 0) + 1 : reason === 'done' ? 0 : authoredFailures.get(m.name) ?? 0
      authoredFailures.set(m.name, n)
      if (n >= MODULE_LIMITS.maxErrors && !m.disabled) {
        const why = `${n} failed runs in a row; last: ${(slot.run.detail?.() as RunDetail | undefined)?.error ?? reason}`
        if (BEHAVIORS[m.name]) BEHAVIORS[m.name].disabled = why
        modules.disable(m, why)
      }
    },
    event: (slot, event) => {
      note(`${slot.key} ${event}`)
      recorder.behaviorEvent(slot.runId, event)
      const name = event.split(' ')[0]
      if (fires(name)) wake(`${slot.key}:${name}`)
      // A second stuck / none_found under the same goal escalates; the first is Jev's to retry.
      if ((name === 'stuck' || name === 'none_found') && !slot.pinned) { // a trial's result goes to System 2 anyway
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
    // An authored check (e.g. "no leaves left") has no count: offer what's in view (the encoder's block radius).
    // A wider count sends collect after far blocks and away from the goal's place.
    if (check?.spec.module === 'authored') return bot.findBlocks({ matching: bot.registry.blocksByName[block]?.id, maxDistance: program.encoder.params.block_radius, count: 64 }).length
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
      bot, program, handles, channels, remaining, attackers,
      directive: () => directive && { ...directive, goal: goalLine(), place: goals.place() },
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

  // ---- System 2: one call in flight, escalations merged, no repeats within 30 s unless health is falling fast ----
  // Its perception calls are traced as `perceive` spans under the open system2 span.
  let system2Span: ReturnType<Recorder['open']> | undefined
  const perceive: Perceive = async (tool, input) => {
    const t0 = performance.now()
    let out: unknown
    try {
      out = tool === 'scan' ? scan(bot, input as Parameters<typeof scan>[1]) : tool === 'reachable' ? await reachable(bot, input.position as Pos) : { error: `unknown tool ${tool}` }
    } catch (err) { out = { error: String(err) } }
    recorder.record('perceive', {
      parent: system2Span,
      attrs: {
        'jeeve.perceive.tool': tool, 'jeeve.perceive.query': JSON.stringify(input), 'jeeve.perceive.mode': tool === 'scan' ? (input.los ? 'los' : 'xray') : undefined,
        'jeeve.perceive.latency_ms': +(performance.now() - t0).toFixed(1), 'jeeve.perceive.result_bytes': JSON.stringify(out).length
      },
      input, output: out
    })
    return out
  }
  const useSystem2 = opts.system2 ?? !!process.env.ANTHROPIC_API_KEY
  const system2 = useSystem2
    ? makeSystem2({
      perceive,
      sql: judgeval ? q => judgeval.sql(q) : undefined,
      schema: judgeval ? await judgeval.discoverSchema().catch(() => undefined) : undefined,
      effort: trigger => trigger.includes('instruction') ? 'medium' : 'low'
    })
    : null
  type Trigger = { reason: string, detail: unknown, goal: string }
  let pending: Trigger[] = []
  const lastSent = new Map<string, number>()

  // During a trial Jev can't act on the pinned channels, so its doubts are expected; the trial's result is what counts.
  const jevDoubtDuringTrial = (reason: string) => !!trial && (reason === 'low_confidence' || reason === 'jev_escalate')

  function escalate (reason: string, detail: unknown, goal: Goal) {
    note(`escalation: ${reason}`)
    recorder.stats.escalations.push(reason)
    const key = `${reason}|${goal.id}|${version(program)}`
    // A fast health drop bypasses the window: in run jeeve-2026-10-11T16-36-51-167Z it suppressed every jev_escalate
    // while slimes took health from 11 to 1.
    const bypass = reason === 'instruction' || reason === 'behavior_trial' || fallingFast()
    if (jevDoubtDuringTrial(reason) || (!bypass && Date.now() - (lastSent.get(key) ?? 0) < NO_REPEAT_MS)) {
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
    // Escalations for goals that closed meanwhile are moot, and so are Jev's doubts queued just before a trial began.
    const triggers = pending.filter(t => onPath.has(t.goal) && !jevDoubtDuringTrial(t.reason))
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
    const span = system2Span = recorder.open('system2', { 'jeeve.system2.trigger': trigger })
    let result
    try { result = await system2(trigger, context) } catch (err) {
      recorder.finish(span, 'system2', { input: context, output: { error: String(err) }, kind: 'llm' })
      console.error('[system2]', err)
      return
    } finally { system2Span = undefined }
    const d = result.decision
    const u = result.usage
    const spanId = recorder.finish(span, 'system2', {
      attrs: { 'jeeve.system2.trigger': trigger, 'jeeve.system2.latency_ms': Date.now() - t0, 'jeeve.system2.turns': result.turns, 'jeeve.system2.refusal': result.refusal },
      input: context, output: { decision: d, sql: result.sql }, kind: 'llm',
      llm: u ? { model: result.model, provider: 'anthropic', non_cached_input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 } : undefined
    })
    if (stopped) return
    recorder.stats.system2.push(`${trigger} → ${d ? d.note : result.refusal ? 'refused' : 'no decision'}`)
    console.log(`[system2] ${trigger} (${Date.now() - t0} ms): ${d?.note ?? 'no decision'}`)
    if (d) applyDecision(d, goal, spanId)
  }, 0)

  function applyDecision (d: Decision, goal: Goal, cite: string) {
    goal.log.push(`system2: ${d.note}`)
    recorder.stats.note = d.note
    const live = goal.status === 'active' || goal.status === 'suspended'
    if (!live) return // the goal was closed while System 2 was thinking: keep only the note (a message would be stale)
    const root = goals.nodes.find(g => g.id === goals.path()[0]?.id)
    if (d.message && root?.from?.via === 'whisper') bot.whisper(root.from.player, d.message)

    // Modules first, so the rest of the decision can reference them. Each refusal is evidence for the next try.
    const problems: string[] = []
    for (const src of d.new_modules ?? []) {
      const { module, trial } = modules.register(src, [...recentStates, rawSnapshot(bot)], { session, goal: `${goal.id}: ${goal.text}`, created_at: new Date().toISOString() })
      recorder.record('module', {
        attrs: { 'jeeve.module.id': module?.id ?? src.name, 'jeeve.module.kind': src.kind, 'jeeve.module.activation': module ? 'ok' : 'failed_trial', 'jeeve.program.cites': cite },
        input: src, output: trial
      })
      goal.log.push(module ? `registered ${module.id} (true on ${trial.trues}/${trial.states} recent states)` : `module ${src.name} refused: ${trial.error}`)
      if (!module) problems.push(`module ${src.name} refused: ${trial.error}`)
    }
    // After modules, so a trial's pass_when can name a check registered in this decision.
    for (const b of d.new_behaviors ?? []) {
      const problem = startTrial(b, goal, cite)
      goal.log.push(problem ?? `trial started: ${b.name}`)
      if (problem) problems.push(problem)
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
      const at = d.goal.place
      const ok = at?.length === 3 && at.every(Number.isFinite)
      if (at && !ok) problems.push(`place must be [x, y, z], got ${JSON.stringify(at)}`)
      goal.place = ok ? at!.map(Math.floor) as Pos : null
      channels.stopStalePlace(goals.place())
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

  // ---- behaviors System 2 writes: one live trial at a time, under guards, pinned against Jev ----
  // Pass: the run returns "done", or the goal it was written for completes while it runs. Either way the
  // result, with the error and the last actions, goes back to System 2 as a behavior_trial escalation.
  type RunDetail = { error?: string, actions: unknown[] }
  type TrialRun = { src: ModuleSource, spec: Spec, passWhen: string | null, version: number, goal: Goal | null, target: unknown, t0: number, done?: (r: BehaviorTrial & { passed: boolean }) => void }
  const findEntity = (name: string | null) => {
    if (!name) return null
    const e = bot.players[name]?.entity ?? Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.name === name)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    return e ?? null
  }

  function startTrial (n: BehaviorDraft, goal: Goal | null, cite: string, done?: TrialRun['done']): string | null {
    const src: ModuleSource = { kind: 'behavior', name: n.name, description: n.description, code: n.code, channels: n.channels, targets: n.targets, timeout_s: n.timeout_s }
    let problem: string | null = null
    try { compileBehavior(src) } catch (err) { problem = `behavior ${n.name} refused: ${String(err)}` }
    const t = n.trial
    const target = !t ? null : src.targets === 'block' ? (t.block ? { name: t.block, count: t.count ?? 1 } : null) : findEntity(t.entity ?? null)
    if (!problem && trial) problem = `behavior ${n.name}: the trial of ${trial.src.name} is still running`
    if (!problem && !target) problem = `behavior ${n.name}: trial target not found (${JSON.stringify(t)})`
    const passWhen = t?.pass_when || null
    if (!problem && passWhen && modules.get(passWhen)?.kind !== 'check') problem = `behavior ${n.name}: pass_when names no registered check module (${passWhen})`
    const version = modules.nextVersion(n.name)
    recorder.record('module', {
      attrs: { 'jeeve.module.id': `${n.name}@${version}`, 'jeeve.module.kind': 'behavior', 'jeeve.module.activation': problem ? 'failed_trial' : 'trial_started', 'jeeve.program.cites': cite },
      input: src, output: problem ? { error: problem } : { target: t }
    })
    if (problem) return problem
    const spec = authoredSpec({ ...src, version }, world)
    trial = { src, spec, passWhen, version, goal, target: t, t0: Date.now(), done }
    note(`trial of ${n.name}@${version} started`)
    channels.set(`${n.name}:trial`, n.name, target as never, `system2:${cite}`, { spec, pinned: true })
    return null
  }

  function finishTrial (end: string, detail?: RunDetail) {
    const t = trial
    if (!t) return
    trial = null
    // "done" is the code's own claim; a pass_when check tests it in the world, a few ticks later so the view has
    // caught up (world.ts caches block views for 50 ms, and e2e run 8 judged a leaf it had just broken).
    if (end === 'done' && t.passWhen) void bot.waitForTicks(3).then(() => settleTrial(t, end, detail))
    else settleTrial(t, end, detail)
  }

  function settleTrial (t: TrialRun, end: string, detail?: RunDetail) {
    const judged = rawSnapshot(bot)
    const claimFails = end === 'done' && t.passWhen && !modules.get(t.passWhen)?.run(judged)
    if (claimFails) detail = { ...detail, actions: detail?.actions ?? [], error: `returned done, but pass_when ${t.passWhen} is false on ${JSON.stringify({ self: judged.self, blocks: judged.blocks })}` }
    const passed = (end === 'done' && !claimFails) || (end === 'goal_closed' && t.goal?.status === 'completed')
    const result: BehaviorTrial = { target: t.target, end, ms: Date.now() - t.t0, ...(detail?.error ? { error: detail.error } : {}) }
    const id = `${t.src.name}@${t.version}`
    if (passed) {
      modules.addBehavior(t.src, t.version, result, { session, goal: t.goal ? `${t.goal.id}: ${t.goal.text}` : 'operator', created_at: new Date().toISOString() })
      BEHAVIORS[t.src.name] = t.spec
      authoredFailures.delete(t.src.name)
    }
    recorder.record('module', {
      attrs: { 'jeeve.module.id': id, 'jeeve.module.kind': 'behavior', 'jeeve.module.activation': passed ? 'ok' : 'failed_trial' },
      input: t.src, output: { trial: result, actions: detail?.actions }
    })
    note(`trial of ${id} ${passed ? 'passed' : `failed: ${end}`}`)
    console.log(`[behavior] trial of ${id} ${passed ? 'passed' : 'failed'}: ${end}${detail?.error ? ` (${detail.error})` : ''}`)
    t.goal?.log.push(`trial of ${id} ${passed ? 'passed: registered' : `failed: ${end}`}`)
    t.done?.({ ...result, passed })
    if (t.goal) escalate('behavior_trial', { behavior: id, passed, ...result, actions: detail?.actions, self: rawSnapshot(bot).self }, t.goal)
  }

  // ---- instructions: whispers from allowed players, or the local API ----
  function instruct (text: string, from: { player: string, via: 'whisper' | 'api' }) {
    const { root, abandoned } = goals.instruction(text, from, bot)
    channels.stopStalePlace(null) // other behaviors keep running while System 2 reads the instruction
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
    // 1.21.11+ servers reject moves from flush against a block unless the hitbox matches the game's float
    // 0.6F / 2; unreleased fix from https://github.com/PrismarineJS/mineflayer/issues/3911
    ;(bot.physics as unknown as { playerHalfWidth: number }).playerHalfWidth = Math.fround(0.6) / 2
    bot.pathfinder.setMovements(guardedMovements(bot))
    // Unset, collectblock installs its own Movements on each collect (with dontCreateFlow off) and leaves it there.
    bot.collectBlock.movements = undefined
    installGuards(bot, (channel, reason) => {
      note(`guard vetoed ${reason}`)
      recorder.windowEvent('vetoed', { channel, reason })
      channels.veto(channel, reason)
    })
    recorder.openWindow({ reason: 'episode_start', bot: bot.username, modules: libraryLoad })
    for (const id of libraryLoad.loaded) recorder.record('module', { attrs: { 'jeeve.module.id': id, 'jeeve.module.activation': 'loaded' } })
    activate(DEFAULT_PROGRAM, 'episode start')
    console.log(`[jeeve] module library ${library}: ${libraryLoad.loaded.length} loaded${libraryLoad.skipped.length ? `, skipped ${libraryLoad.skipped.join('; ')}` : ''}`)
    console.log(`[jeeve] spawned as ${bot.username}; session ${session}; judgment ${recorder.exporting ? `project ${project}` : 'off (JSONL only)'}; system2 ${system2 ? 'on' : 'off'}`)

    let hostileNear = false
    let ticks = 0
    const watching = new Map<string, boolean>()
    bot.on('physicsTick', () => {
      const near = Object.values(bot.entities).some(e => (e.type === 'hostile' || attacking(attackers, e.id)) && e.position.distanceTo(bot.entity.position) <= program.triggers.hostile_within)
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

  bot.on('health', () => {
    healthLog.push({ t: Date.now(), hp: bot.health })
    while (Date.now() - healthLog[0].t > 5000) healthLog.shift()
  })
  // Damage is attributed to its source (Mineflayer reads it from the 1.20+ damage_event), so being hit makes
  // anything a threat: the encoder marks it as attacking, and hostile_near counts it.
  bot.on('entityHurt', (e, source?: typeof e) => {
    if (e === bot.entity) {
      if (source) attackers.set(source.id, Date.now())
      const from = source ? `${handleFor(handles, source.id)} (${describeEntity(source)})` : undefined
      note(from ? `took damage from ${from}` : 'took damage')
      recorder.windowEvent('damage', { health: bot.health, source: from })
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
  // Trial a behavior outside any goal (the e2e's guard fixture uses the same pipeline System 2 does).
  const trialBehavior = (n: BehaviorDraft) => new Promise<BehaviorTrial & { passed: boolean }>((resolve, reject) => {
    const problem = startTrial(n, null, 'operator', resolve)
    if (problem) reject(new Error(problem))
  })
  return { bot, channels, goals, modules, recorder, stop, trialBehavior, traceFile: recorder.file, session }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const allowed = (process.env.JEEVE_ALLOWED ?? '').split(',').filter(Boolean)
  if (!allowed.length) console.warn('[jeeve] JEEVE_ALLOWED is empty: only the local API can give instructions')
  const agent = await startAgent({ host: process.env.JEEVE_HOST, port: Number(process.env.JEEVE_PORT ?? 25565), allowed, apiPort: Number(process.env.JEEVE_API_PORT ?? 7777) })
  process.on('SIGINT', () => { void agent.stop().then(() => process.exit(0)) })
}
