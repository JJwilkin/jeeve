// Timeline core (brain/architecture/brain-monitor.md): trace rows (traces/<session>.jsonl) → the state of every
// panel at time t, the messages passing around t, the beats captions are written for, and the speed-up map for
// clips. Pure: the live monitor, replay and the Remotion composition all call the same functions.

export type Row = { t: number, kind: string, [k: string]: any }
export type Node = 'player' | 's2' | 'builder' | 's1'
export type Message = { t: number, from: Node, to: Node, label: string }
export type Answer = { q: string, choice: string, confidence: number, top: Array<[string, number]> }
export type BuilderStatus = 'idle' | 'queued' | 'thinking' | 'waiting' | 'trialling' | 'registered' | 'failed' | 'cancelled'

export type Panels = {
  t: number
  goalPath: string
  self: { health?: number, food?: number, pos?: number[] }
  system2: { thinking: boolean, since?: number, trigger?: string, note?: string, latencyMs?: number, guidance?: string, guidanceAt?: number }
  builder: {
    status: BuilderStatus, since?: number, request?: { id: string, need: string, passWhen: string }
    trial: number, maxTrials: number, step?: string, result?: string
  }
  code?: { name: string, code: string, live: boolean, running?: { line?: number, call: string }, marks: Record<number, boolean> }
  system1: { at?: number, latencyMs?: number, trigger?: string, answers: Answer[], escalate?: number, channels: Record<string, string | null> }
  messages: Message[] // sent in the last MESSAGE_MS
  log: Message[] // the last few, for a running log
  veto?: { reason: string, t: number }
}

export const MESSAGE_MS = 2000
export const MAX_TRIALS = 4 // src/builder.ts BUILDER_LIMITS.trials

const clip = (s: unknown, n: number) => { const v = typeof s === 'string' ? s : JSON.stringify(s) ?? ''; return v.length > n ? v.slice(0, n - 1) + '…' : v }
const json = (s: unknown) => { try { return typeof s === 'string' ? JSON.parse(s) : s } catch { return undefined } }

// Keep only what the panels need: a session's JSONL is megabytes, mostly decide states.
export function slim (r: Row): Row {
  const { t, kind } = r
  switch (kind) {
    case 'decide': {
      const raw = json(r.attrs?.['jeeve.decide.raw_state'])
      const { 'jeeve.decide.raw_state': _, ...attrs } = r.attrs ?? {}
      return { t, kind, attrs, self: raw?.self, answers: r.output?.answers, applied: r.output?.applied }
    }
    case 'system2': {
      const d = r.output?.decision
      return { t, kind, span_id: r.span_id, attrs: r.attrs, note: d?.note ?? r.output?.error, message: d?.message, requests: d?.requests?.length ?? 0 }
    }
    case 'program': return { t, kind, attrs: r.attrs, guidance: r.output?.manifest?.guidance, allowed: r.output?.manifest?.allowed_behaviors }
    case 'builder': return { t, kind, span_id: r.span_id, attrs: r.attrs, status: r.output?.status, behavior: r.output?.behavior, reason: r.output?.reason, request: r.input?.request?.id }
    case 'builder_tool': return { t, kind, request: r.request, tool: r.tool, phase: r.phase, input: r.tool === 'write_behavior' ? r.input : clip(r.input, 200), output: clip(r.output, 300) }
    case 'builder_step': return { t, kind, request: r.request, text: clip(r.text ?? '', 600), reasoning: clip(r.reasoning ?? '', 600), tools: r.tools }
    case 'trial': return { t, kind, attrs: r.attrs, error: r.output?.error }
    case 'module': return { t, kind, attrs: r.attrs, name: r.input?.name, code: r.input?.code }
    case 'behavior_end': return { t, kind, run_id: r.run_id, reason: r.reason, error: r.detail?.error }
    case 'escalation_sent': return { t, kind, reason: r.reason, goal: r.goal, status: r.detail?.status, behavior: r.detail?.behavior }
    case 'window_open': return { t, kind, index: r.index }
    case 'carry_over': case 'perceive': case 'escalation_suppressed': return { t, kind }
    default: return r
  }
}

export const parse = (text: string): Row[] => text.split('\n').filter(Boolean).map(l => slim(JSON.parse(l))).sort((a, b) => a.t - b.t)

const goalText = (r: Row) => r.input?.text as string | undefined
const reqId = (r: Row) => r.attrs?.['jeeve.request.id'] ?? r.attrs?.request ?? r.request // spans, window events, builder rows

// The messages between the systems, with when each was sent.
export function messages (rows: Row[]): Message[] {
  const out: Message[] = []
  const m = (t: number, from: Node, to: Node, label: string) => out.push({ t, from, to, label })
  for (const r of rows) {
    if (r.kind === 'goal' && r.attrs?.['jeeve.goal.transition'] === 'pushed' && r.input?.from) m(r.t, 'player', 's2', `"${clip(goalText(r), 60)}"`)
    else if (r.kind === 'escalation_sent' && r.reason === 'capability_result') m(r.t, 'builder', 's2', `result: ${r.status}`)
    else if (r.kind === 'escalation_sent' && r.reason !== 'instruction') m(r.t, 's1', 's2', `escalation: ${r.reason}`)
    else if (r.kind === 'program' && String(r.attrs?.['jeeve.program.because']).startsWith('system2')) m(r.t, 's2', 's1', 'new guidance')
    else if (r.kind === 'request') m(r.t, 's2', 'builder', `request ${r.attrs?.['jeeve.request.id']}: ${clip(r.input?.need, 50)}`)
    else if (r.kind === 'event' && r.name === 'trial_window') m(r.t, 'builder', 's1', `trial window: ${r.attrs?.behavior}`)
    else if (r.kind === 'event' && r.name === 'trial_preempted') m(r.t, 's1', 'builder', 'trial pre-empted')
    else if (r.kind === 'system2' && r.message) m(r.t, 's2', 'player', `"${clip(r.message, 60)}"`)
  }
  return out
}

// Behavior code by name: drafts the builder wrote, and modules registered or trialled.
function codeByName (rows: Row[]) {
  const code = new Map<string, string>()
  for (const r of rows) {
    if (r.kind === 'module' && r.code) code.set(r.name, r.code)
    if (r.kind === 'builder_tool' && r.tool === 'write_behavior' && r.phase === 'start' && r.input?.code) code.set(r.input.name, r.input.code)
  }
  return code
}

export function stateAt (all: Row[], t: number): Panels {
  const rows = all.filter(r => r.t <= t)
  const last = (pred: (r: Row) => boolean) => rows.findLast(pred)
  const sent = messages(rows)
  const p: Panels = {
    t, goalPath: '', self: {}, messages: sent.filter(m => t - m.t <= MESSAGE_MS), log: sent.slice(-6),
    system2: { thinking: false }, builder: { status: 'idle', trial: 0, maxTrials: MAX_TRIALS }, system1: { answers: [], channels: { legs: null, aim: null, hands: null } }
  }
  p.goalPath = last(r => r.kind === 'goal')?.attrs?.['jeeve.goal.path'] ?? ''

  // System 2 (2A): thinking from its start row to its own row; the latest note; guidance from programs it caused.
  const done = new Set(rows.filter(r => r.span_id).map(r => `${r.kind}:${r.span_id}`))
  const s2Start = last(r => r.kind === 'start' && r.name === 'system2')
  if (s2Start && !done.has(`system2:${s2Start.span_id}`)) Object.assign(p.system2, { thinking: true, since: s2Start.t, trigger: s2Start.attrs?.['jeeve.system2.trigger'] })
  const s2 = last(r => r.kind === 'system2')
  if (s2) Object.assign(p.system2, { note: s2.note, latencyMs: s2.attrs?.['jeeve.system2.latency_ms'], ...(p.system2.thinking ? {} : { trigger: s2.attrs?.['jeeve.system2.trigger'] }) })
  const prog = last(r => r.kind === 'program' && r.attrs?.['jeeve.program.activation'] === 'ok')
  if (prog) Object.assign(p.system2, { guidance: prog.guidance, guidanceAt: prog.t })

  // The builder (2B), for the latest request.
  const req = last(r => r.kind === 'request')
  if (req) {
    const id = req.attrs['jeeve.request.id']
    const mine = rows.filter(r => reqId(r) === id)
    const b = p.builder
    b.request = { id, need: req.input?.need, passWhen: req.input?.pass_when }
    b.status = 'queued'
    b.since = req.t
    const at = (status: BuilderStatus, r: Row) => { b.status = status; b.since = r.t }
    for (const r of mine) {
      if (r.kind === 'start') at('thinking', r)
      else if (r.kind === 'builder_step') b.step = r.text || b.step
      else if (r.kind === 'builder_tool' && r.tool !== 'write_behavior' && r.phase === 'start') b.step = `looks: ${r.tool} ${r.input}`
      else if (r.kind === 'builder_tool' && r.tool === 'write_behavior') {
        if (r.phase === 'start') { at('waiting', r); b.trial++ } else at('thinking', r)
      } else if (r.kind === 'event' && r.name === 'trial_window') at('trialling', r)
      else if (r.kind === 'event' && r.name === 'trial_preempted') at('waiting', r)
      else if (r.kind === 'trial') b.result = r.attrs['jeeve.trial.passed'] ? `trial ${b.trial} passed (${r.attrs['jeeve.trial.end']})` : `trial ${b.trial} failed: ${r.attrs['jeeve.trial.end']}${r.error ? `, ${clip(r.error, 80)}` : ''}`
      else if (r.kind === 'builder') { at(r.attrs?.['jeeve.builder.status'] ?? r.status, r); if (r.behavior) b.result = `registered ${r.behavior}` }
    }
  }

  // Behavior runs on the body now, and the authored code running (or the latest draft, if none runs).
  const runs = new Map<string, Row>()
  for (const r of rows) {
    if (r.kind === 'behavior_start') runs.set(r.run_id, r)
    else if (r.kind === 'behavior_end') runs.delete(r.run_id)
  }
  for (const r of runs.values()) for (const c of String(r.attrs?.['jeeve.behavior.channels'] ?? '').split('+')) if (c) p.system1.channels[c] = r.attrs?.['jeeve.behavior.params'] ?? r.name
  // The code box: an authored run on the body now, else the builder's latest draft with how its last run went.
  const code = codeByName(rows)
  const live = [...runs.values()].reverse().find(r => code.has(r.name))
  const draft = last(r => r.kind === 'builder_tool' && r.tool === 'write_behavior' && r.phase === 'start')
  const shown = live ?? (draft && last(r => r.kind === 'behavior_start' && r.name === draft.input.name && r.t >= draft.t))
  const name = live?.name ?? draft?.input.name
  if (name) {
    const calls = shown ? rows.filter(r => r.kind === 'api_call' && r.run_id === shown.run_id) : []
    const marks: Record<number, boolean> = {}
    for (const c of calls) if (c.phase === 'end' && c.line) marks[c.line] = c.ok
    const lastCall = calls.at(-1)
    p.code = { name, code: live ? code.get(name)! : draft!.input.code, live: !!live, marks, running: live && lastCall?.phase === 'start' ? { line: lastCall.line, call: lastCall.call } : undefined }
  }

  // System 1 (Jev): the latest decide call.
  const d = last(r => r.kind === 'decide')
  if (d) {
    p.self = { health: d.self?.health, food: d.self?.food, pos: d.self?.pos }
    p.system1 = {
      ...p.system1, at: d.t, latencyMs: d.attrs?.['jeeve.decide.latency_ms'], trigger: d.attrs?.['jeeve.decide.trigger'],
      escalate: d.answers?.escalate?.noul,
      answers: Object.entries(d.answers ?? {}).filter(([, a]: [string, any]) => a?.type === 'choice').map(([q, a]: [string, any]) => ({
        q, choice: a.choice, confidence: a.confidence,
        top: Object.entries(a.probabilities ?? {}).sort((x, y) => (y[1] as number) - (x[1] as number)).slice(0, 3) as Array<[string, number]>
      }))
    }
  }
  const veto = last(r => r.kind === 'event' && r.name === 'vetoed')
  if (veto && t - veto.t <= 1500) p.veto = { reason: veto.attrs?.reason, t: veto.t }
  return p
}

// Root goals a player gave (instructions), newest first, with how each ended ('open' while it runs).
export type RecentGoal = { t: number, id: string, text: string, from: string, outcome: string }
export function recentGoals (rows: Row[], n = 5): RecentGoal[] {
  const goals = new Map<string, RecentGoal>()
  for (const r of rows) {
    if (r.kind !== 'goal') continue
    const id = r.attrs?.['jeeve.goal.id'], tr = r.attrs?.['jeeve.goal.transition']
    if (tr === 'pushed' && r.input?.from) goals.set(id, { t: r.t, id, text: goalText(r) ?? '', from: r.input.from.player, outcome: 'open' })
    else if (tr !== 'pushed' && goals.has(id)) goals.get(id)!.outcome = tr
  }
  return [...goals.values()].slice(-n).reverse()
}

// ---- beats: the moments a caption is written for, with the facts a caption may use ----
export type Beat = { t: number, kind: string, facts: Record<string, unknown>, text: string }

export function beats (rows: Row[]): Beat[] {
  const out: Beat[] = []
  const b = (r: Row, kind: string, facts: Record<string, unknown>, text: string) => out.push({ t: r.t, kind, facts, text })
  let trial = 0
  for (const r of rows) {
    const tr = r.attrs?.['jeeve.goal.transition']
    if (r.kind === 'goal' && tr === 'pushed' && r.attrs?.['jeeve.goal.plan_step']) {
      const [n, of] = String(r.attrs['jeeve.goal.plan_step']).split('/')
      b(r, 'step', { step: n, of, text: r.input?.text }, `Step ${n} of ${of}: ${clip(r.input?.text, 60)}.`)
    } else if (r.kind === 'goal' && tr === 'pushed' && r.input?.from) b(r, 'instruction', { from: r.input.from.player, text: goalText(r) }, `${r.input.from.player} asks Jeeve: "${clip(goalText(r), 70)}"`)
    else if (r.kind === 'goal' && (tr === 'completed' || tr === 'failed') && !String(r.attrs?.['jeeve.goal.path'] ?? '').includes('>')) b(r, `goal_${tr}`, { summary: r.output?.summary }, tr === 'completed' ? 'Done.' : 'Jeeve gives up on this one.')
    else if (r.kind === 'request') b(r, 'request', { need: r.input?.need, pass_when: r.input?.pass_when }, "Jeeve can't do this yet. System 2 asks the builder for a new skill.")
    else if (r.kind === 'builder_tool' && r.tool === 'write_behavior' && r.phase === 'start') { trial++; b(r, 'draft', { name: r.input?.name, trial }, trial === 1 ? `The builder writes code for it: ${r.input?.name}.` : `The builder fixes the code (attempt ${trial}).`) }
    else if (r.kind === 'event' && r.name === 'trial_window') b(r, 'trial_window', { behavior: r.attrs?.behavior }, 'Nothing threatens Jeeve, so the builder gets the body to test its code.')
    else if (r.kind === 'trial') b(r, r.attrs?.['jeeve.trial.passed'] ? 'trial_passed' : 'trial_failed', { behavior: r.attrs?.['jeeve.module.id'], end: r.attrs?.['jeeve.trial.end'], error: r.error }, r.attrs?.['jeeve.trial.passed'] ? 'The trial passes. Jeeve has a new skill.' : 'The trial fails. The builder reads what went wrong.')
    else if (r.kind === 'event' && r.name === 'trial_preempted') b(r, 'preempted', {}, 'A threat: the trial stops, and Jeeve deals with it first.')
    else if (r.kind === 'event' && r.name === 'confirm') b(r, 'confirm', {}, 'Jeeve looks around to make sure it got everything.')
    // Jev's own doubts (low_confidence, jev_escalate) come every few seconds: not worth a caption.
    else if (r.kind === 'escalation_sent' && ['stuck', 'none_found'].includes(r.reason)) b(r, 'escalation', { reason: r.reason }, 'Jeeve is stuck, so the fast model asks System 2.')
  }
  // A trial that finishes the goal is logged just after the goal: say what passed, then "done".
  const key = (b: Beat) => b.t + (b.kind.startsWith('goal_') ? 1000 : 0)
  out.sort((a, b) => key(a) - key(b))
  // Each caption stays up long enough to read: one that comes too soon waits for the one before.
  for (let i = 1; i < out.length; i++) out[i].t = Math.max(out[i].t, out[i - 1].t + CAPTION_MIN_MS)
  return out
}
export const CAPTION_MIN_MS = 2500

export const captionAt = (bs: Beat[], t: number) => bs.findLast(b => b.t <= t)?.text ?? ''

// ---- speed-ups: stretches where nothing visible changes play squashed ----
export type Segment = { t0: number, t1: number, rate: number }
export const SPEEDUP = { marginMs: 1000, squashToMs: 2000, minRate: 2 }

// When something visible changes: any row but heartbeat decides that changed nothing and left the bot in place.
export function activity (rows: Row[]): number[] {
  const out: number[] = []
  let pos: number[] | undefined
  for (const r of rows) {
    if (r.kind === 'decide') {
      const p = r.self?.pos as number[] | undefined
      const moved = p && pos && Math.hypot(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]) > 0.3
      if (p) pos = p
      if (!moved && !r.attrs?.['jeeve.decide.changed']) continue
    } else if (['carry_over', 'window_open', 'window_close', 'perceive', 'escalation_suppressed', 'marker'].includes(r.kind)) continue
    out.push(r.t)
  }
  return out
}

// Cover [t0, t1] with segments: 1× by default; a gap between activity, less a margin on each side, plays in
// squashToMs when that is at least minRate× (so stretches of 6 s or more, with the defaults).
export function speedups (times: number[], t0: number, t1: number, o = SPEEDUP): Segment[] {
  const segs: Segment[] = []
  let at = t0
  const marks = [t0, ...times.filter(t => t > t0 && t < t1), t1]
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1] + o.marginMs, z = marks[i] - o.marginMs
    if ((z - a) / o.squashToMs < o.minRate) continue
    if (a > at) segs.push({ t0: at, t1: a, rate: 1 })
    segs.push({ t0: a, t1: z, rate: (z - a) / o.squashToMs })
    at = z
  }
  if (t1 > at) segs.push({ t0: at, t1, rate: 1 })
  return segs
}

export const duration = (segs: Segment[]) => segs.reduce((n, s) => n + (s.t1 - s.t0) / s.rate, 0)

// Output time (ms from the clip's start) → trace time, and the rate there.
export function traceTime (segs: Segment[], ms: number): { t: number, rate: number } {
  for (const s of segs) {
    const len = (s.t1 - s.t0) / s.rate
    if (ms < len) return { t: s.t0 + ms * s.rate, rate: s.rate }
    ms -= len
  }
  const s = segs.at(-1)!
  return { t: s.t1, rate: s.rate }
}
