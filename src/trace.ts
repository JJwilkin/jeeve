// Traces into Judgment (brain/architecture/trace-schema.md): one session per episode, one trace per window.
// Every span is also mirrored to a local JSONL file, which works without Judgment credentials.
import { appendFileSync, mkdirSync } from 'node:fs'
import { context, trace, type Attributes, type Link, type Span } from '@opentelemetry/api'
import { Tracer } from 'judgeval'

type Attrs = Record<string, string | number | boolean | undefined>
type Run = { name: string, attrs: Attrs, span: Span }
type Finish = { attrs?: Attrs, input?: unknown, output?: unknown, kind?: string, llm?: Record<string, unknown> }

// What the code-written window summary counts ([[system-2]] → "Window summaries: written by code").
const emptyStats = () => ({
  behaviors: {} as Record<string, number>, // "<name>:<end_reason>" → count
  events: {} as Record<string, number>, // death, damage, owner_damage, vetoed…
  escalations: [] as string[],
  system2: [] as string[],
  programs: new Set<string>(),
  note: '' as string
})

// judgeval reads JUDGMENT_ORG_ID; also accept JUDGMENT_ORGANIZATION_ID, the name used elsewhere in our env files.
export const judgmentOrg = () => process.env.JUDGMENT_ORG_ID ?? process.env.JUDGMENT_ORGANIZATION_ID

const clean = (a: Attrs): Attributes => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as Attributes
const json = (v: unknown) => typeof v === 'string' ? v : JSON.stringify(v)

export class Recorder {
  session: string
  file: string
  window: Span | null = null
  index = -1
  prevTraceId: string | null = null
  runs = new Map<string, Run>()
  stats = emptyStats()
  program = ''
  goalPath = ''
  exporting = false
  openedAt = 0

  constructor (session: string, file: string) {
    this.session = session
    this.file = file
  }

  // Judgment export is on when JUDGMENT_API_KEY/ORG_ID/API_URL resolve the project; otherwise JSONL only.
  static async init (project: string, session: string, dir = 'traces') {
    mkdirSync(dir, { recursive: true })
    const r = new Recorder(session, `${dir}/${session}.jsonl`)
    if (process.env.JUDGMENT_API_KEY) {
      const tracer = await Tracer.init({ projectName: project, environment: 'dev', organizationId: judgmentOrg() })
      r.exporting = tracer.projectId != null
    }
    return r
  }

  jsonl (record: Record<string, unknown>) { appendFileSync(this.file, JSON.stringify({ t: Date.now(), ...record }) + '\n') }

  private start (name: string, attrs: Attrs, parent: Span | null, links?: Link[]): Span {
    const ctx = parent ? trace.setSpan(context.active(), parent) : context.active()
    return Tracer.getOTELTracer().startSpan(name, { attributes: clean({ ...attrs, 'judgment.session_id': this.session }), root: !parent, links }, ctx)
  }

  ids (span: Span) { const c = span.spanContext(); return { trace_id: c.traceId, span_id: c.spanId } }

  openWindow (carry: Record<string, unknown>) {
    this.index++
    this.openedAt = Date.now()
    const prev = this.window?.spanContext()
    this.window = this.start('window', {
      'jeeve.window_index': this.index,
      'jeeve.prev_trace_id': this.prevTraceId ?? undefined,
      'jeeve.goal.path': this.goalPath
    }, null, prev ? [{ context: prev }] : undefined)
    this.record('carry_over', { attrs: { 'jeeve.prev_trace_id': this.prevTraceId ?? undefined }, input: { ...carry, open_runs: [...this.runs.keys()] } })
    // Behaviors still running continue in the new window under the same run_id.
    for (const [id, run] of this.runs) run.span = this.start(`behavior.${run.name}`, { ...run.attrs, 'jeeve.behavior.continued': true }, this.window)
    this.jsonl({ kind: 'window_open', index: this.index, ...this.ids(this.window), carry })
  }

  // Close the window: end open behavior spans (cut), end the root last, flush so it's queryable in ~1 s.
  closeWindow (reason: string) {
    if (!this.window) return
    for (const run of this.runs.values()) { run.span.setAttribute('jeeve.behavior.end_reason', 'cut'); run.span.end() }
    this.window.setAttribute('jeeve.window.reason', reason)
    this.window.end()
    this.prevTraceId = this.window.spanContext().traceId
    this.jsonl({ kind: 'window_close', index: this.index, reason })
    void Tracer.forceFlush().catch(err => console.error('[trace] flush failed', err))
  }

  // The structured summary handed forward in carry_over. Written by code, never a model.
  summary () {
    const s = this.stats
    return {
      goal_path: this.goalPath, behaviors: s.behaviors, events: s.events, escalations: s.escalations,
      system2: s.system2, programs: [...s.programs], note: s.note || undefined
    }
  }

  cut (reason: string, carry: Record<string, unknown> = {}) {
    const summary = this.summary()
    this.closeWindow(reason)
    const note = this.stats.note
    this.stats = emptyStats()
    this.stats.note = note
    this.stats.programs.add(this.program)
    this.openWindow({ ...carry, goal_path: this.goalPath, program: this.program, previous_window: summary })
  }

  // A span that starts and ends now, a child of the window unless a parent is given. Returns its span id.
  record (name: string, o: Finish & { parent?: Span }): string {
    return this.finish(this.start(name, o.attrs ?? {}, o.parent ?? this.window), name, o)
  }

  // A span left open while work happens under it (a System 2 call); end it with finish().
  open (name: string, attrs: Attrs = {}) { return this.start(name, attrs, this.window) }

  finish (span: Span, name: string, o: Finish): string {
    if (o.attrs) span.setAttributes(clean(o.attrs))
    if (o.kind) Tracer.setSpanKind(o.kind, span)
    if (o.input !== undefined) span.setAttribute('judgment.input', json(o.input))
    if (o.output !== undefined) span.setAttribute('judgment.output', json(o.output))
    if (o.llm) Tracer.recordLLMMetadata(o.llm as any, span)
    span.end()
    const { span_id } = this.ids(span)
    this.jsonl({ kind: name, span_id, attrs: o.attrs, input: o.input, output: o.output })
    return span_id
  }

  windowEvent (name: string, attrs: Attrs = {}) {
    this.stats.events[name] = (this.stats.events[name] ?? 0) + 1
    this.window?.addEvent(name, clean({ ...attrs, program_version: this.program }))
    this.jsonl({ kind: 'event', name, attrs })
  }

  startBehavior (runId: string, name: string, attrs: Attrs) {
    const full = { 'jeeve.behavior.name': name, 'jeeve.behavior.run_id': runId, ...attrs }
    this.runs.set(runId, { name, attrs: full, span: this.start(`behavior.${name}`, full, this.window) })
    this.jsonl({ kind: 'behavior_start', run_id: runId, name, attrs })
  }

  behaviorEvent (runId: string, event: string) {
    this.runs.get(runId)?.span.addEvent(event.split(' ')[0], { detail: event })
    if (event.startsWith('vetoed')) this.stats.events.vetoed = (this.stats.events.vetoed ?? 0) + 1
  }

  endBehavior (runId: string, reason: string) {
    const run = this.runs.get(runId)
    if (!run) return
    run.span.setAttribute('jeeve.behavior.end_reason', reason)
    run.span.end()
    this.runs.delete(runId)
    const k = `${run.name}:${reason}`
    this.stats.behaviors[k] = (this.stats.behaviors[k] ?? 0) + 1
    this.jsonl({ kind: 'behavior_end', run_id: runId, reason })
  }

  async shutdown (reason = 'episode_end') {
    this.closeWindow(reason)
    this.window = null
    await Tracer.forceFlush().catch(() => {})
  }
}
