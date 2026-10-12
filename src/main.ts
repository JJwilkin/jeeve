// Jeeve client: joins a server like a player, takes instructions (whispers or a local API), keeps the goal
// tree, runs System 1 on Jev under a program System 2A (Claude) shapes, has System 2B build the behaviors 2A
// asks for, and traces everything to Judgment.
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import collectblock from 'mineflayer-collectblock'
import { Judgeval } from 'judgeval'
import type { Span } from '@opentelemetry/api'
import { authoredSpec, BEHAVIORS, CHANNELS, Channels, LOOK_AROUND, type ApiHost, type Spec } from './behaviors.ts'
import { build, BUILDER_MODEL, type BehaviorDraft, type BuildResult, type CapabilityRequest, type TrialReport, type TrialTarget } from './builder.ts'
import { coalescing, makeDecider, optionTarget, type Ask } from './decide.ts'
import { attacking, checkSnapshot, describeEntity, handleFor, inventoryCounts, newHandles, rawSnapshot, type Attackers, type Directive } from './encoder.ts'
import { compile, glob, Goals, noteDeath, type CheckSpec, type Goal, type PlanStep } from './goals.ts'
import { guardedMovements, installGuards } from './guards.ts'
import { compileBehavior, MODULE_LIMITS, ModuleRegistry, type ModuleSource, type Snapshot } from './modules.ts'
import { DEFAULT_PROGRAM, ENCODERS, LIMITS, validate, version, type Program } from './program.ts'
import { makeSystem2, type Decision, type RequestDraft } from './system2.ts'
import { judgmentOrg, Recorder } from './trace.ts'
import { blockAt, explored, frontier, noteDug, observe, placedStanding, reachable, scan, seenMap, seenTypes, type Pos } from './world.ts'

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
// A trial window opens only while nothing threatens the bot: no hostile this close, no damage this recently.
// The same test pre-empts a running trial; past maxPreempts the trial goes back to 2B as pre-empted.
const TRIAL_WINDOW = { hostileWithin: 8, quietMs: 5_000, maxPreempts: 3 }
// A behavior that ended none_found or stuck isn't offered on that target again for this long. Without it Jev restarted
// an authored behavior that ended none_found on its target about 100 times in 20 s (orchard clip, 2026-10-12).
// ponytail: one fixed cooldown; per-behavior backoff if traces show it's too long or too short.
const FAILED_COOLDOWN_MS = 10_000
// A look that ended this recently confirms a check that still passes; an older one, or none, means look first.
const CONFIRM_FRESH_MS = 3_000
// Under a goal with a place, Jev is offered only blocks this close to it (horizontally): a tree's leaves reach 1–2 out.
const PLACE_RADIUS = 3
// While a plan runs, each step is reviewed by 2A this often (review_due), with the seen map and the plan's progress.
const STEP_REVIEW_MS = 30_000
// A goal with nothing running on the body this long escalates as idle (forage: 520 s idle with 2A never called).
const IDLE_MS = 30_000
// A goal whose progress (e.g. logs gathered) hasn't moved this long escalates as stalled, busy or not: a forage run
// followed a scripted player who never moved for 10 min, waiting to be led to trees.
const STALL_MS = 60_000
// Trace rows stay small: long outputs (a scan, an event's data) are cut.
const short = (v: unknown, max = 500) => { const s = JSON.stringify(v); return s && s.length > max ? s.slice(0, max) + '…' : v }

export async function startAgent (opts: AgentOptions) {
  const project = opts.project ?? process.env.JEEVE_PROJECT ?? 'jeeve-dev'
  const session = `jeeve-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const recorder = await Recorder.init(project, session)
  const judgeval = recorder.exporting ? await Judgeval.create({ projectName: project, organizationId: judgmentOrg() }).catch(() => null) : null
  // Every await happens before the bot exists: a spawn during an await would miss its handlers, and the agent would
  // hang unspawned (e2e run 5, when discoverSchema was slow).
  const schema = judgeval ? await judgeval.discoverSchema().catch(() => undefined) : undefined

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
  const ownerAttackers: Attackers = new Map() // who hurt the player the goal serves, and when
  const ownerHits: number[] = []
  let ownerHurtSent = 0
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
  const failedAt = new Map<string, number>() // option target → when a run on it last ended none_found or stuck

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
  // Modules are listed to 2A by id (clear_tall_tree@2); it names them that way, so a version suffix is accepted anywhere.
  const bare = (name: string) => name.replace(/@\d+$/, '')
  const lookup = (name: string) => modules.get(bare(name))
  // The shared block view (src/world.ts), who code may whisper to, and each authored action as a trace row.
  const world: ApiHost = { blockAt, scan, reachable, allowed: opts.allowed, onCall: c => recorder.jsonl({ kind: 'api_call', ...c, out: short(c.out) }) }
  // Behaviors from the library join the seed set; Jev sees them wherever System 2's program allows them.
  for (const m of modules.modules.values()) if (m.kind === 'behavior') BEHAVIORS[m.name] = { ...authoredSpec(m, world), disabled: m.disabled }
  const authoredFailures = new Map<string, number>() // behavior name → failed runs in a row
  let trial: TrialRun | null = null // the one live trial, if any (see startTrial)

  const completed = (g: Goal) => {
    recorder.record('goal', { attrs: { 'jeeve.goal.id': g.id, 'jeeve.goal.path': goals.pathText(), 'jeeve.goal.transition': 'completed' }, output: { summary: g.summary } })
    note(`goal completed: ${g.text} (${g.summary})`)
    if (g.from?.via === 'whisper') bot.whisper(g.from.player, `done: ${g.text}, ${g.summary}`)
    afterGoalChange(g)
    // A plan step done: code starts the next one, no model call in between.
    const parent = g.parent ? goals.nodes.find(n => n.id === g.parent) : null
    if (parent?.plan && parent.status === 'active') startStep(parent)
  }
  const goals = new Goals({
    completed,
    confirm: g => confirm(g),
    escalate: (reason, g) => escalate(reason, { goal: g.id }, g)
  })

  // ---- plans: 2A's steps run one after another as child goals of the instruction's goal (set_plan) ----
  // A step has its own place (so Jev is told about that spot and offered only the blocks there) and check. The goal
  // completes after its last step, unless it has a check of its own.
  function startStep (root: Goal) {
    const plan = root.plan!
    const step = plan.steps[plan.next]
    if (!step) {
      if (!root.done_when && root.status === 'active') { goals.close(root, 'completed', `all ${plan.steps.length} steps done`); completed(root) }
      // Every step done but the goal isn't met (a forage plan's trees gave 10 of 16 logs): 2A plans more, or searches.
      else if (root.status === 'active') escalate('plan_done', { steps: plan.steps.length, progress: root.done_when?.progress?.(bot) ?? null }, root)
      return
    }
    plan.next++
    const child = goals.create(step.text, root.id, null, bot)
    child.place = step.place?.length === 3 && step.place.every(Number.isFinite) ? step.place.map(Math.floor) as Pos : null
    try { child.done_when = step.done_when ? compile(step.done_when, child, lookup) : null } catch (err) { child.log.push(`check refused: ${err}`) }
    child.budget_ms = step.budget_s ? step.budget_s * 1000 : null
    child.review_ms = STEP_REVIEW_MS
    recorder.record('goal', { attrs: { 'jeeve.goal.id': child.id, 'jeeve.goal.path': goals.pathText(), 'jeeve.goal.transition': 'pushed', 'jeeve.goal.plan_step': `${plan.next}/${plan.steps.length}` }, input: { text: step.text, place: child.place, check: step.done_when } })
    recorder.goalPath = goals.pathText()
    channels.stopStalePlace(goals.place())
    note(`plan step ${plan.next} of ${plan.steps.length}: ${step.text}`)
    if (fires('new_directive')) wake('plan_step')
  }

  // A new plan replaces the old one: the step running now is abandoned, and the new plan starts at its first step.
  function setPlan (root: Goal, steps: PlanStep[]) {
    for (const g of goals.path().slice(1).reverse()) {
      goals.close(g, 'abandoned', 're-planned')
      recorder.record('goal', { attrs: { 'jeeve.goal.id': g.id, 'jeeve.goal.transition': 'abandoned' }, output: { summary: 're-planned' } })
    }
    root.plan = { steps, next: 0 }
    startStep(root)
  }

  // ---- survey: 2A's search tool. Jeeve walks a loop around where it stands, looking, and 2A gets the updated map. ----
  // From where it stands a view is occluded (a row of trees hides all but the first, orchard bench); moving is how it
  // finds out what else is there.
  let surveyed: (() => void) | null = null
  const survey = () => new Promise<unknown>(resolve => {
    if (trial || confirming || surveyed) return resolve({ error: 'the body is busy (a trial, a look or another survey)' })
    const me = bot.entity.position.floored()
    surveyed = () => { surveyed = null; resolve({ seen_map: seenMap(bot) }) }
    channels.set('look_around:survey', 'look_around', { place: [me.x, me.y, me.z] as Pos, radius: 6 } as never, 'survey', { spec: LOOK_AROUND, pinned: true })
  })

  // ---- confirm before done: a check that reads the world passed; look around the place, then judge again ----
  // The check re-runs on the next tick over what the look added to the seen memory. A trial holds the body, so the
  // look waits until it ends.
  let confirming: Goal | null = null
  function confirm (g: Goal): boolean {
    if (g.confirmedAt && Date.now() - g.confirmedAt < CONFIRM_FRESH_MS) return false
    if (trial || confirming) return true
    const me = bot.entity.position.floored()
    const place = g.place ?? goals.place() ?? [me.x, me.y, me.z] as Pos
    g.confirming = true
    confirming = g
    recorder.windowEvent('confirm', { goal: g.id, place: place.join(',') })
    note(`looking around before calling goal ${g.id} done`)
    channels.set('look_around:confirm', 'look_around', { place }, 'confirm', { spec: LOOK_AROUND, pinned: true })
    return true
  }
  const endConfirm = () => {
    if (confirming) { confirming.confirming = false; confirming.confirmedAt = Date.now() }
    confirming = null
  }

  // A root closing is a goal boundary: cut the window. Programs stack with goals, so re-sync.
  function afterGoalChange (closed: Goal) {
    recorder.goalPath = goals.pathText()
    channels.stopStalePlace(goals.place())
    dropStaleRequests()
    if (!closed.parent) {
      directive = null
      channels.stop(CHANNELS, 'goal_closed')
      recorder.cut('goal_boundary')
    }
    syncProgram(`goal ${closed.id} ${closed.status}`)
  }

  // ---- channels: behavior runs become behavior spans; events wake Jev or escalate ----
  const channels = new Channels(bot, {
    start: slot => {
      const used = modules.get(slot.behavior) // an authored behavior's run is a use, for curating the library
      if (used) used.usedAt = Date.now()
      recorder.startBehavior(slot.runId, slot.behavior, {
        'jeeve.behavior.params': slot.key, 'jeeve.behavior.channels': slot.channels.join('+'),
        'jeeve.behavior.decided_by': slot.decidedBy, 'jeeve.behavior.version': slot.version
      })
    },
    end: (slot, reason) => {
      recorder.endBehavior(slot.runId, reason, slot.run.detail?.())
      if ((reason === 'none_found' || reason === 'stuck') && !slot.pinned) failedAt.set(optionTarget(slot.key), Date.now())
      if (slot.key === 'look_around:confirm') return endConfirm()
      if (slot.key === 'look_around:survey') return surveyed?.()
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
    // A cleared or authored check (e.g. "no leaves left") has no count: offer only the block types it names (cleared's
    // globs; "oak_leaves", "*_log" in an authored check's code), counted from what the bot has seen near the goal's
    // place, or within the encoder's block radius without one. Otherwise Jev was offered the dirt a pillar left, and
    // the next tree's logs before this one was done (orchard clip, 2026-10-12).
    if (check?.spec.module === 'authored' || check?.spec.module === 'cleared') {
      const code = check.spec.module === 'authored' ? lookup(check.spec.name ?? '')?.code ?? '' : ''
      const at = goals.place()
      // A cleared step also waits on the bot's own scaffolding there, so Jev is offered that too.
      const own = new Set(placedStanding(bot).map(p => p.join(',')))
      const scaffold = check.spec.module === 'cleared' && !!at && (seenTypes(bot, 24).get(block) ?? []).some(p => own.has(p.join(',')) && Math.abs(p[0] - at[0]) <= PLACE_RADIUS && Math.abs(p[2] - at[2]) <= PLACE_RADIUS)
      const named = check.spec.module === 'cleared'
        ? (check.spec.match ?? '*').split(',').some(m => glob(m.trim()).test(block))
        : code.includes(block) || code.includes(`_${block.split('_').at(-1)}`)
      if (!named && !scaffold) return 0
      const me = bot.entity.position
      const r = program.encoder.params.block_radius
      return (seenTypes(bot, 24).get(block) ?? []).filter(p => at
        ? Math.abs(p[0] - at[0]) <= PLACE_RADIUS && Math.abs(p[2] - at[2]) <= PLACE_RADIUS
        : Math.max(Math.abs(p[0] - me.x), Math.abs(p[1] - me.y), Math.abs(p[2] - me.z)) <= r).length
    }
    if (check) return 0
    const want = Number(directive.text.match(/\d+/)?.[0] ?? 1)
    return Math.max(0, want - ((inventoryCounts(bot)[block] ?? 0) - (directive.inventory[block] ?? 0)))
  }

  // What an inventory_delta check naming one item still needs: the target for item behaviors (e.g. a craft).
  const wanted = () => {
    const check = goals.leaf()?.done_when
    if (check?.spec.module !== 'inventory_delta' || !bot.registry.itemsByName[check.spec.match ?? '']) return []
    const p = check.progress!(bot)
    return p.want > p.have ? [{ name: check.spec.match!, count: p.want - p.have }] : []
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
      bot, program, handles, channels, remaining, wanted, attackers,
      guarding: () => { const p = goals.path()[0]?.from?.player; return p ? { name: p, attackers: ownerAttackers } : undefined },
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
      cooling: option => Date.now() - (failedAt.get(option) ?? 0) < FAILED_COOLDOWN_MS,
      threatened: () => threatened(),
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
  const perceive = async (tool: string, input: Record<string, unknown>, parent: Span | undefined = system2Span) => {
    const t0 = performance.now()
    let out: unknown
    try {
      out = tool === 'scan' ? scan(bot, input as Parameters<typeof scan>[1])
        : tool === 'reachable' ? await reachable(bot, input.position as Pos)
          : tool === 'survey' ? await survey()
            : { error: `unknown tool ${tool}` }
    } catch (err) { out = { error: String(err) } }
    recorder.record('perceive', {
      parent,
      attrs: {
        'jeeve.perceive.tool': tool, 'jeeve.perceive.query': JSON.stringify(input), 'jeeve.perceive.mode': tool === 'scan' ? 'los' : undefined,
        'jeeve.perceive.latency_ms': +(performance.now() - t0).toFixed(1), 'jeeve.perceive.result_bytes': JSON.stringify(out).length
      },
      input, output: out
    })
    return out
  }
  const useSystem2 = opts.system2 ?? !!process.env.ANTHROPIC_API_KEY
  const system2 = useSystem2
    ? makeSystem2({
      perceive: (tool, input) => perceive(tool, input),
      sql: judgeval ? q => judgeval.sql(q) : undefined,
      schema,
      // JEEVE_SYSTEM2_EFFORT sets every call's effort (e.g. low, to make 2A answer instructions faster).
      // Instructions at high: that's when 2A plans. Escalations stay at low, for responsiveness mid-task.
      effort: trigger => (process.env.JEEVE_SYSTEM2_EFFORT as 'low' | 'medium' | 'high' | undefined) ?? (trigger.includes('instruction') ? 'high' : 'low')
    })
    : null
  type Trigger = { reason: string, detail: unknown, goal: string }
  let pending: Trigger[] = []
  const lastSent = new Map<string, number>()
  // Learning from 2A's answers: an escalation it answered with no change backs off for that goal, doubling each time
  // (30 s to 4 min); one it acted on resets. About half of 2A's calls were Jev's doubts answered "carry on" (bench).
  const quiet = new Map<string, { until: number, ms: number }>()
  const changedNothing = (d: Decision) => !d.goal && !d.program && !d.push_child && d.goal_action === 'none' && !d.new_modules?.length && !d.requests?.length && !d.plan?.length && !d.message
  function learnFrom (d: Decision, triggers: Trigger[]) {
    for (const t of triggers) {
      if (t.reason === 'instruction' || t.reason === 'capability_result') continue
      const k = `${t.reason}|${t.goal}`
      if (!changedNothing(d)) { quiet.delete(k); continue }
      const ms = Math.min(240_000, (quiet.get(k)?.ms ?? NO_REPEAT_MS / 2) * 2)
      quiet.set(k, { until: Date.now() + ms, ms })
    }
  }

  // During a trial Jev can't act on the pinned channels, so its doubts are expected; the trial's result is what counts.
  const jevDoubtDuringTrial = (reason: string) => !!trial && (reason === 'low_confidence' || reason === 'jev_escalate')

  function escalate (reason: string, detail: unknown, goal: Goal) {
    note(`escalation: ${reason}`)
    recorder.stats.escalations.push(reason)
    const key = `${reason}|${goal.id}|${version(program)}`
    // A fast health drop bypasses the window: in run jeeve-2026-10-11T16-36-51-167Z it suppressed every jev_escalate
    // while slimes took health from 11 to 1.
    const bypass = reason === 'instruction' || reason === 'capability_result' || reason === 'owner_hurt' || fallingFast()
    // 2A answered this kind of escalation for this goal with "no change" lately: it's quiet for a while (see below).
    const hushed = (quiet.get(`${reason}|${goal.id}`)?.until ?? 0) > Date.now()
    if (jevDoubtDuringTrial(reason) || (!bypass && (hushed || Date.now() - (lastSent.get(key) ?? 0) < NO_REPEAT_MS))) {
      recorder.jsonl({ kind: 'escalation_suppressed', reason, goal: goal.id })
      return
    }
    lastSent.set(key, Date.now())
    if (!system2) { recorder.jsonl({ kind: 'escalation_unhandled', reason, goal: goal.id }); return }
    recorder.jsonl({ kind: 'escalation_sent', reason, goal: goal.id, detail })
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
      seen_map: seenMap(bot), // everything the bot has seen around it, so the scene doesn't hinge on this turn's scans
      // Where it has looked, and where not yet: the frontier widens from where the instruction came.
      explored: { cell: 16, bot_at: [Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.z)], origin: root?.origin ? [root.origin[0], root.origin[2]] : null, frontier: frontier(bot, root?.origin ? { x: root.origin[0], z: root.origin[2] } : undefined), centers: explored(bot) },
      modules: modules.list(),
      requests: requests.map(r => ({ id: r.id, goal: r.goal.id, need: r.need, status: windowAsk?.req === r ? 'waiting_for_trial_window' : trial?.ask?.req === r ? 'trialling' : r.status })),
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
    if (d) { learnFrom(d, triggers); applyDecision(d, goal, spanId) }
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
    // After modules, so a request's pass_when can name a check registered in this decision.
    // Requests belong to the instruction's goal, not a plan step: a skill outlives the step that asked for it.
    const top = goals.path()[0] ?? goal
    for (const r of d.requests ?? []) {
      const problem = request(r, top, cite)
      goal.log.push(problem ?? `capability requested: ${r.need}`)
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
      // While a plan runs, the program belongs to the instruction's goal, so it carries across steps (each step
      // started back on the default program, and 2A set the same one again per tree).
      const owner = goal !== top && top.plan ? top : goal
      const base = owner.program ?? goals.program() ?? DEFAULT_PROGRAM
      const next: Program = {
        ...base,
        parent: version(base),
        reason: d.note,
        guidance: d.program.guidance ?? base.guidance,
        allowed_behaviors: d.program.allowed_behaviors?.map(bare) ?? base.allowed_behaviors,
        triggers: {
          ...base.triggers,
          heartbeat_ms: Math.min(5000, Math.max(LIMITS.minIntervalMs, d.program.heartbeat_ms ?? base.triggers.heartbeat_ms)),
          watch: (d.program.watch?.map(bare) ?? base.triggers.watch ?? []).filter(n => {
            const ok = modules.get(n)?.kind === 'watch'
            if (!ok) problems.push(`no registered watch module named ${n}`)
            return ok
          })
        }
      }
      try { validate(next); owner.program = next } catch (err) {
        recorder.record('program', { attrs: { 'jeeve.program.version': version(next), 'jeeve.program.activation': 'failed_check', 'jeeve.program.cites': cite }, output: { error: String(err) } })
        problems.push(`program refused: ${String(err)}`) // told at once, not found out a minute later
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
    if (d.plan?.length && (top.status === 'active' || top.status === 'suspended')) {
      setPlan(top, d.plan)
      goal.log.push(`plan: ${d.plan.map(s => s.text).join(' → ')}`)
    }
    recorder.goalPath = goals.pathText()
    const want = goals.program() ?? DEFAULT_PROGRAM
    if (version(want) !== version(program)) activate(want, `system2: ${d.note}`, [cite])
    if (problems.length) escalate('module_failed', { problems }, goal)
  }

  // ---- capability requests: 2A asks, 2B builds (src/builder.ts), one build at a time, in this process ----
  // A request lives as long as its goal is on the active path; one per goal, a newer one replaces it.
  type Req = CapabilityRequest & { goal: Goal, status: 'queued' | 'building', abort: AbortController, span: { trace_id: string, span_id: string } }
  let requests: Req[] = []
  let requestCount = 0

  function request (r: RequestDraft, goal: Goal, cite: string): string | null {
    r = { ...r, pass_when: bare(r.pass_when ?? '') }
    const t = r.trial ?? {}
    if (modules.get(r.pass_when)?.kind !== 'check') return `request refused: pass_when names no registered check module (${r.pass_when})`
    if (r.targets === 'entity' ? !findEntity(t.entity ?? null) : !t[r.targets]) return `request refused: trial target not found (${JSON.stringify(t)})`
    for (const old of requests.filter(q => q.goal === goal)) cancelRequest(old, 'replaced by a newer request')
    const req: Req = { id: `c-${++requestCount}`, need: r.need, constraints: r.constraints ?? [], targets: r.targets, trial: t, pass_when: r.pass_when, goal, status: 'queued', abort: new AbortController(), span: { trace_id: '', span_id: '' } }
    const span_id = recorder.record('request', {
      attrs: { 'jeeve.request.id': req.id, 'jeeve.goal.id': goal.id, 'jeeve.program.cites': cite },
      input: { need: req.need, constraints: req.constraints, targets: req.targets, trial: t, pass_when: req.pass_when }
    })
    req.span = { trace_id: recorder.window ? recorder.ids(recorder.window).trace_id : '', span_id }
    requests.push(req)
    note(`capability request ${req.id}: ${req.need}`)
    const root = goals.path()[0]
    if (root?.from?.via === 'whisper') bot.whisper(root.from.player, `working on it: learning a new behavior for "${root.text}"`)
    pumpRequests()
    return null
  }

  function cancelRequest (req: Req, why: string) {
    requests = requests.filter(r => r !== req)
    note(`capability request ${req.id} cancelled: ${why}`)
    req.abort.abort(why) // the builder's loop and a waiting trial stop; a running trial is stopped below
    // A trial still passes if the goal it serves completed while it ran.
    if (trial?.ask?.req === req) channels.stop(trial.spec.channels, req.goal.status === 'completed' ? 'goal_closed' : 'cancelled')
  }

  const dropStaleRequests = () => {
    for (const r of requests) if (r.goal.status !== 'active' && r.goal.status !== 'suspended') cancelRequest(r, `goal ${r.goal.status}`)
  }

  function pumpRequests () {
    const req = requests.find(r => r.status === 'queued')
    if (stopped || !req || requests.some(r => r.status === 'building')) return
    req.status = 'building'
    const t0 = Date.now()
    const span = recorder.openTrace('builder', {
      'jeeve.request.id': req.id, 'jeeve.request.span_id': req.span.span_id, 'jeeve.request.trace_id': req.span.trace_id,
      'jeeve.goal.id': req.goal.id, 'jeeve.builder.model': BUILDER_MODEL
    }, req.span.trace_id ? [{ context: { traceId: req.span.trace_id, spanId: req.span.span_id, traceFlags: 1 } }] : [])
    const check = modules.get(req.pass_when)!
    // Only 2A's structured words reach 2B, never the instruction's text (brain/architecture/system-2.md → "2A and 2B").
    const snap = rawSnapshot(bot)
    const brief = {
      request: { id: req.id, need: req.need, constraints: req.constraints, targets: req.targets, trial: req.trial },
      pass_when: { id: check.id, description: check.description, code: check.code },
      library: [...modules.modules.values()].filter(m => m.kind === 'behavior').map(m => ({ id: m.id, description: m.description, channels: m.channels, targets: m.targets, disabled: m.disabled ?? null, code: m.code })),
      // The scene, so the build doesn't hinge on how 2A worded the request: what the bot carries, notable blocks and
      // entities near it, and the trial target's clusters (exact counts, bounds, heights).
      self: snap.self, inventory: snap.inventory, blocks: snap.blocks, entities: snap.entities,
      trial_target: req.targets === 'block' && req.trial.block ? scan(bot, { match: req.trial.block }) : undefined
    }
    console.log(`[builder] ${req.id} started: ${req.need}`)
    build(req, brief, { trial: (d, _r, signal) => trialPort(d, req, signal, span), perceive: (tool, input) => perceive(tool, input, span), log: row => recorder.jsonl({ request: req.id, ...row }) }, req.abort.signal, span, session)
      .catch((err): BuildResult => ({ request: req.id, status: 'failed', reason: req.abort.signal.aborted ? `cancelled: ${req.abort.signal.reason}` : String(err), attempts: [] }))
      .then(result => {
        const cancelled = req.abort.signal.aborted
        recorder.finish(span, 'builder', {
          attrs: { 'jeeve.builder.status': cancelled && result.status !== 'registered' ? 'cancelled' : result.status, 'jeeve.builder.trials': result.attempts.length, 'jeeve.builder.latency_ms': Date.now() - t0 },
          input: brief, output: result
        })
        requests = requests.filter(r => r !== req)
        console.log(`[builder] ${req.id} ${result.status}${cancelled ? ` (request dropped: ${req.abort.signal.reason})` : ''} after ${((Date.now() - t0) / 1000).toFixed(0)} s, ${result.attempts.length} trials${result.status === 'registered' ? `: ${result.behavior}` : ''}`)
        req.goal.log.push(`builder ${req.id}: ${result.status === 'registered' ? `registered ${result.behavior}` : `failed: ${result.reason}`}`)
        if (!cancelled) escalate('capability_result', result, req.goal)
        pumpRequests()
      })
  }

  // ---- trials: one live run at a time, under guards, pinned against Jev, in a window code grants ----
  // Pass: the run returns "done" and its pass_when check holds a few ticks later, or the goal it serves completes
  // while it runs. The result, with the error and the last actions, goes back to whoever asked (2B's trial tool).
  type RunDetail = { error?: string, actions: unknown[] }
  type WindowAsk = { draft: BehaviorDraft, req: Req, parent: Span, preempted: number, resolve: (r: TrialReport) => void }
  type TrialRun = { src: ModuleSource, spec: Spec, passWhen: string | null, version: number, goal: Goal | null, target: unknown, t0: number, runId?: string, ask?: WindowAsk, done?: (r: TrialReport) => void }
  let windowAsk: WindowAsk | null = null // a draft waiting for a trial window
  let lastDamage = 0
  const findEntity = (name: string | null) => {
    if (!name) return null
    const e = bot.players[name]?.entity ?? Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.name === name)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    return e ?? null
  }
  // ponytail: "hostile" is Mineflayer's entity type (slimes are "mob"); recent damage catches what it misses.
  const threatened = () => Date.now() - lastDamage < TRIAL_WINDOW.quietMs ||
    Object.values(bot.entities).some(e => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) <= TRIAL_WINDOW.hostileWithin)

  // 2B's trial tool. Shape problems come back at once; otherwise the draft waits for a window.
  function trialPort (draft: BehaviorDraft, req: Req, signal: AbortSignal, parent: Span) {
    return new Promise<TrialReport>((resolve, reject) => {
      const refuse = (error: string) => resolve({ behavior: draft.name, passed: false, end: 'refused', ms: 0, error, preempted: 0 })
      if (draft.targets !== req.targets) return refuse(`targets must be "${req.targets}", as the request says`)
      try { compileBehavior({ kind: 'behavior', ...draft }) } catch (err) { return refuse(String(err)) }
      windowAsk = { draft, req, parent, preempted: 0, resolve }
      note(`trial window requested for ${draft.name}`)
      signal.addEventListener('abort', () => { if (windowAsk?.req === req) { windowAsk = null; reject(new Error('cancelled')) } }, { once: true })
    })
  }

  // Every 250 ms: pre-empt a running trial if something threatens the bot, or open a window if nothing does.
  function tickTrialWindow () {
    if (trial?.ask && threatened()) {
      trial.ask.preempted++
      recorder.windowEvent('trial_preempted', { request: trial.ask.req.id, behavior: trial.src.name })
      note(`trial of ${trial.src.name} pre-empted: the bot is threatened`)
      return channels.stop(trial.spec.channels, 'preempted')
    }
    const ask = windowAsk
    if (!ask || trial || threatened()) return
    windowAsk = null
    recorder.windowEvent('trial_window', { request: ask.req.id, behavior: ask.draft.name })
    note(`trial window granted to ${ask.draft.name}`)
    const problem = startTrial(ask.draft, {
      target: ask.req.trial, passWhen: ask.req.pass_when, goal: ask.req.goal, decidedBy: `builder:${ask.req.id}`, ask,
      done: r => {
        if (r.end === 'preempted' && ask.preempted < TRIAL_WINDOW.maxPreempts && !ask.req.abort.signal.aborted) { windowAsk = ask; return } // back in line
        recorder.record('trial', {
          parent: ask.parent,
          attrs: {
            'jeeve.request.id': ask.req.id, 'jeeve.module.id': r.behavior, 'jeeve.behavior.run_id': r.run_id,
            'jeeve.trial.end': r.end, 'jeeve.trial.passed': r.passed, 'jeeve.trial.preempted': ask.preempted
          },
          input: ask.draft, output: r
        })
        ask.resolve({ ...r, preempted: ask.preempted })
      }
    })
    if (problem) ask.resolve({ behavior: ask.draft.name, passed: false, end: 'refused', ms: 0, error: problem, preempted: ask.preempted })
  }

  function startTrial (n: BehaviorDraft, o: { target: TrialTarget | null, passWhen: string | null, goal: Goal | null, decidedBy: string, ask?: WindowAsk, done?: TrialRun['done'] }): string | null {
    const src: ModuleSource = { kind: 'behavior', name: n.name, description: n.description, code: n.code, channels: n.channels, targets: n.targets, timeout_s: n.timeout_s }
    let problem: string | null = null
    try { compileBehavior(src) } catch (err) { problem = `behavior ${n.name} refused: ${String(err)}` }
    const t = o.target
    const thing = src.targets === 'block' ? t?.block : t?.item
    const target = !t ? null : src.targets === 'entity' ? findEntity(t.entity ?? null) : thing ? { name: thing, count: t.count ?? 1 } : null
    if (!problem && trial) problem = `behavior ${n.name}: the trial of ${trial.src.name} is still running`
    if (!problem && !target) problem = `behavior ${n.name}: trial target not found (${JSON.stringify(t)})`
    if (!problem && o.passWhen && modules.get(o.passWhen)?.kind !== 'check') problem = `behavior ${n.name}: pass_when names no registered check module (${o.passWhen})`
    const version = modules.nextVersion(n.name)
    recorder.record('module', {
      attrs: { 'jeeve.module.id': `${n.name}@${version}`, 'jeeve.module.kind': 'behavior', 'jeeve.module.activation': problem ? 'failed_trial' : 'trial_started', 'jeeve.program.cites': o.decidedBy },
      input: src, output: problem ? { error: problem } : { target: t }
    })
    if (problem) return problem
    const spec = authoredSpec({ ...src, version }, world)
    trial = { src, spec, passWhen: o.passWhen, version, goal: o.goal, target: t, t0: Date.now(), ask: o.ask, done: o.done }
    note(`trial of ${n.name}@${version} started`)
    channels.set(`${n.name}:trial`, n.name, target as never, o.decidedBy, { spec, pinned: true })
    if (trial) trial.runId = channels.slots[spec.channels[0] as keyof typeof channels.slots]?.runId
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
    const judged = checkSnapshot(bot)
    const claimFails = end === 'done' && t.passWhen && !modules.get(t.passWhen)?.run(judged)
    if (claimFails) detail = { ...detail, actions: detail?.actions ?? [], error: `returned done, but pass_when ${t.passWhen} is false on ${JSON.stringify({ self: judged.self, blocks: judged.blocks })}` }
    const passed = (end === 'done' && !claimFails) || (end === 'goal_closed' && t.goal?.status === 'completed')
    const result = { target: t.target, end, ms: Date.now() - t.t0, ...(detail?.error ? { error: detail.error } : {}) }
    const id = `${t.src.name}@${t.version}`
    if (passed) {
      modules.addBehavior(t.src, t.version, result, { session, goal: t.goal ? `${t.goal.id}: ${t.goal.text}` : 'operator', created_at: new Date().toISOString() })
      BEHAVIORS[t.src.name] = t.spec
      authoredFailures.delete(t.src.name)
    }
    recorder.record('module', {
      attrs: { 'jeeve.module.id': id, 'jeeve.module.kind': 'behavior', 'jeeve.module.activation': passed ? 'ok' : end === 'preempted' ? 'preempted' : 'failed_trial' },
      input: t.src, output: { trial: result, actions: detail?.actions }
    })
    note(`trial of ${id} ${passed ? 'passed' : `failed: ${end}`}`)
    console.log(`[behavior] trial of ${id} ${passed ? 'passed' : end === 'preempted' ? 'pre-empted' : 'failed'}: ${end}${detail?.error ? ` (${detail.error})` : ''}`)
    t.goal?.log.push(`trial of ${id} ${passed ? 'passed: registered' : `failed: ${end}`}`)
    t.done?.({ behavior: id, run_id: t.runId, passed, end, ms: result.ms, error: detail?.error, actions: detail?.actions, self: judged.self, preempted: 0 })
  }

  // ---- instructions: whispers from allowed players, or the local API ----
  function instruct (text: string, from: { player: string, via: 'whisper' | 'api' }) {
    const { root, abandoned } = goals.instruction(text, from, bot)
    const at = bot.entity.position.floored()
    root.origin = [at.x, at.y, at.z]
    if (confirming) channels.stop(LOOK_AROUND.channels, 'cancelled')
    dropStaleRequests()
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
      // The trace as server-sent events: the session's rows so far, then each new one (the monitor, viz/).
      if (req.method === 'GET' && req.url === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' })
        const send = (line: string) => res.write(`data: ${line}\n\n`)
        // The file appears with the first row; a monitor can connect before that (it reconnects as the agent starts).
        if (existsSync(recorder.file)) for (const line of readFileSync(recorder.file, 'utf8').split('\n')) if (line) send(line)
        recorder.listeners.add(send)
        req.on('close', () => recorder.listeners.delete(send))
        return
      }
      const body = (then: (b: Record<string, unknown>) => void) => {
        let s = ''
        req.on('data', c => { s += c })
        req.on('end', () => { try { then(JSON.parse(s)) } catch { reply(400, { error: 'body must be JSON' }) } })
      }
      if (req.method === 'POST' && req.url === '/instructions') {
        return body(({ from, text }) => {
          if (typeof text !== 'string' || !text.trim()) return reply(400, { error: 'text is required' })
          const root = instruct(text.trim(), { player: typeof from === 'string' ? from : 'operator', via: 'api' })
          reply(202, { goal: root.id })
        })
      }
      // A clock-sync row, e.g. when a recording starts (scripts/clip.ts), so footage lines up with the trace.
      if (req.method === 'POST' && req.url === '/marker') {
        return body(b => { recorder.jsonl({ ...b, kind: 'marker' }); reply(202, {}) })
      }
      reply(404, { error: 'POST /instructions, POST /marker, GET /status or GET /events' })
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
    let lastBusy = Date.now()
    let progressSeen = ''
    let progressAt = Date.now()
    const watching = new Map<string, boolean>()
    bot.on('physicsTick', () => {
      const near = Object.values(bot.entities).some(e => (e.type === 'hostile' || attacking(attackers, e.id) || attacking(ownerAttackers, e.id)) && e.position.distanceTo(bot.entity.position) <= program.triggers.hostile_within)
      if (near && !hostileNear) { note('hostile mob within range'); if (fires('hostile_near')) wake('hostile_near') }
      hostileNear = near
      if (++ticks % 5 !== 0) return
      observe(bot, ticks % 40 === 0) // the seen memory first, so checks judge what's in sight now; a far look every 2 s
      if (CHANNELS.some(c => channels.slots[c]?.status === 'running') || system2Span) lastBusy = Date.now()
      const idleLeaf = goals.leaf()
      if (idleLeaf && Date.now() - lastBusy > IDLE_MS) { lastBusy = Date.now(); escalate('idle', { idle_s: IDLE_MS / 1000 }, idleLeaf) }
      // Progress is the root's own measure when it has one (inventory_delta), else which step is running.
      const root = goals.path()[0]
      const now = root ? JSON.stringify([root.id, root.done_when?.progress?.(bot) ?? null, idleLeaf?.id]) : ''
      if (now !== progressSeen) { progressSeen = now; progressAt = Date.now() }
      else if (root && Date.now() - progressAt > STALL_MS) { progressAt = Date.now(); escalate('stalled', { stalled_s: STALL_MS / 1000, progress: root.done_when?.progress?.(bot) ?? null }, idleLeaf ?? root) }
      goals.tick(bot) // checks every 250 ms
      tickTrialWindow()
      // Watch modules wake Jev when they turn true (rising edge only).
      const watch = program.triggers.watch ?? []
      if (!watch.length) return
      const snap = checkSnapshot(bot)
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
      lastDamage = Date.now()
      if (source) attackers.set(source.id, Date.now())
      const from = source ? `${handleFor(handles, source.id)} (${describeEntity(source)})` : undefined
      note(from ? `took damage from ${from}` : 'took damage')
      recorder.windowEvent('damage', { health: bot.health, source: from })
      if (fires('damage_taken')) wake('damage_taken')
    } else if (e.type === 'player' && e.username === goals.path()[0]?.from?.player) {
      // The player the goal serves is treated like the bot: who hit them is marked for Jev, and repeated hits escalate.
      if (source) ownerAttackers.set(source.id, Date.now())
      const from = source ? `${handleFor(handles, source.id)} (${describeEntity(source)})` : undefined
      note(from ? `${e.username} took damage from ${from}` : `${e.username} took damage`)
      recorder.windowEvent('owner_damage', { player: e.username, source: from })
      ownerHits.push(Date.now())
      while (ownerHits.length && Date.now() - ownerHits[0] > 5000) ownerHits.shift()
      if (fires('damage_taken')) wake('owner_damage')
      const leaf = goals.leaf()
      if (leaf && ownerHits.length >= 3 && Date.now() - ownerHurtSent > 10_000) { ownerHurtSent = Date.now(); escalate('owner_hurt', { player: e.username, hits_in_5s: ownerHits.length, from }, leaf) }
    }
  })
  bot.on('entityDead', e => { if (e.type === 'player' && e.username) noteDeath(e.username) })
  bot.on('diggingCompleted', b => noteDug(bot, [b.position.x, b.position.y, b.position.z]))
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
    for (const r of requests) r.abort.abort('episode_end')
    if (heartbeat) clearInterval(heartbeat)
    api?.close()
    channels.stop(CHANNELS, 'episode_end')
    modules.save() // with when each module was last used
    await recorder.shutdown()
    bot.quit()
  }
  // Trial a behavior outside any goal (the e2e's guard fixture uses the same pipeline System 2 does).
  const trialBehavior = (n: BehaviorDraft) => new Promise<TrialReport>((resolve, reject) => {
    const problem = startTrial(n, { target: n.trial ?? null, passWhen: n.trial?.pass_when ?? null, goal: null, decidedBy: 'operator', done: resolve })
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
