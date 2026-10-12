// System 2B between episodes (brain/architecture/orchestrator-and-builder.md → "The between-episode loop"): a
// builder run with no request and no body. It reads the module library and what recent sessions did with each
// behavior (virtual SQL), and proposes keep / retire / merge plus lessons with cited trace ids. Nothing is
// applied: the output is a library diff and a lessons file for a person to review (scripts/curate.ts).
import { OpenTelemetry } from '@ai-sdk/otel'
import { generateText, jsonSchema, stepCountIs, tool, type LanguageModel } from 'ai'
import { trace, type Span } from '@opentelemetry/api'
import { JudgmentTracerProvider, Tracer } from 'judgeval'
import { API_DOC } from './behaviors.ts'
import { BUILDER_EFFORT } from './builder.ts'
import { compileBehavior, type Stored } from './modules.ts'
import { TRACES } from './system2.ts'

type Row = Record<string, string>
export type Sql = (q: string) => Promise<{ rows: Row[] }>
type Count = Record<string, number>
// What the traces say about one library behavior, only from sessions where this version was in use (loaded at
// startup, or born there): e2e runs start from scratch libraries, so a name@version can mean other code elsewhere.
export type Facts = {
  id: string, sessions: string[],
  picked: Count, // runs the fast model chose, by end_reason
  trial_runs: Count, // runs that were trials (decided_by builder:<request>)
  failures: { session: string, trace_id: string, span_id: string, run_id: string, end: string, detail: string }[], // the last 10
  builds: { session: string, request: string, need: string, status: string, trials: string, latency_ms: string, trace_id: string }[],
  trials: { session: string, request: string, end: string, passed: string, preempted: string, trace_id: string, span_id: string }[],
  disabled: { session: string, reason: string, trace_id: string, span_id: string }[],
  goals: { session: string, goal: string, text: string, outcome: string, summary: string, allowed: boolean, ran: number, trace_id: string, span_id: string }[]
}

const quote = (xs: Iterable<string>) => [...xs].map(x => `'${x.replace(/['\\]/g, '')}'`).join(',') || "''"
const OK_ENDS = new Set(['done', 'goal_closed', 'replaced', 'stopped', 'place_changed', 'target_dead'])
const ENDED = new Set(['completed', 'failed', 'abandoned'])

// Every id in a result row: what a cited lesson or decision can be checked against.
function remember (seen: Set<string>, rows: Row[]) {
  for (const r of rows) for (const v of Object.values(r)) if (typeof v === 'string' && /^(r-\d+|[0-9a-f]{16}|[0-9a-f]{32})$/.test(v)) seen.add(v)
  return rows
}

export async function gather (sql: Sql, library: Stored[], days: number, seen: Set<string>): Promise<Facts[]> {
  const behaviors = library.filter(m => m.kind === 'behavior')
  if (!behaviors.length) return []
  const q = async (s: string) => remember(seen, (await sql(s)).rows)
  const since = `started_at > now() - INTERVAL ${Math.floor(days)} DAY`
  const ids = behaviors.map(m => `${m.name}@${m.version}`)
  const loaded = await q(`SELECT session_id AS session, attributes['jeeve.module.id'] AS id FROM telemetry.spans WHERE span_name = 'module' AND attributes['jeeve.module.activation'] = 'loaded' AND attributes['jeeve.module.id'] IN (${quote(ids)}) AND ${since} GROUP BY session, id`)
  const inUse = new Map(behaviors.map(m => [`${m.name}@${m.version}`, new Set([...(m.origin ? [m.origin.session] : []), ...loaded.filter(r => r.id === `${m.name}@${m.version}`).map(r => r.session)])]))
  const scope = `session_id IN (${quote(new Set([...inUse.values()].flatMap(s => [...s])))}) AND ${since}`
  const [runs, trials, builds, requests, disabled, goals, programs] = await Promise.all([
    q(`SELECT session_id AS session, trace_id, span_id, started_at, attributes['jeeve.behavior.name'] AS name, attributes['jeeve.behavior.version'] AS version, attributes['jeeve.behavior.run_id'] AS run_id, attributes['jeeve.behavior.end_reason'] AS end_reason, attributes['jeeve.behavior.decided_by'] AS decided_by, substring(attributes['jeeve.behavior.detail'], 1, 400) AS detail FROM telemetry.spans WHERE startsWith(span_name, 'behavior.') AND attributes['jeeve.behavior.name'] IN (${quote(behaviors.map(m => m.name))}) AND attributes['jeeve.behavior.end_reason'] != 'cut' AND ${scope} ORDER BY started_at LIMIT 5000`),
    q(`SELECT session_id AS session, trace_id, span_id, attributes['jeeve.request.id'] AS request, attributes['jeeve.module.id'] AS id, attributes['jeeve.trial.end'] AS end_reason, attributes['jeeve.trial.passed'] AS passed, attributes['jeeve.trial.preempted'] AS preempted FROM telemetry.spans WHERE span_name = 'trial' AND attributes['jeeve.module.id'] IN (${quote(ids)}) AND ${scope}`),
    q(`SELECT session_id AS session, trace_id, attributes['jeeve.request.id'] AS request, attributes['jeeve.builder.status'] AS status, attributes['jeeve.builder.trials'] AS trials, attributes['jeeve.builder.latency_ms'] AS latency_ms FROM telemetry.spans WHERE span_name = 'builder' AND ${scope}`),
    q(`SELECT session_id AS session, attributes['jeeve.request.id'] AS request, input FROM telemetry.spans WHERE span_name = 'request' AND ${scope}`),
    q(`SELECT session_id AS session, trace_id, span_id, attributes['jeeve.module.id'] AS id, substring(output, 1, 400) AS reason FROM telemetry.spans WHERE span_name = 'module' AND attributes['jeeve.module.activation'] = 'disabled' AND attributes['jeeve.module.id'] IN (${quote(ids)}) AND ${scope}`),
    q(`SELECT session_id AS session, trace_id, span_id, started_at, attributes['jeeve.goal.id'] AS goal, attributes['jeeve.goal.transition'] AS transition, input, output FROM telemetry.spans WHERE span_name = 'goal' AND ${scope} ORDER BY started_at`),
    // Programs that allowed a library behavior (the name appears in the manifest; parsed below, not matched).
    q(`SELECT session_id AS session, started_at, output FROM telemetry.spans WHERE span_name = 'program' AND attributes['jeeve.program.activation'] = 'ok' AND (${behaviors.map(m => `output LIKE '%"${m.name}"%'`).join(' OR ')}) AND ${scope}`)
  ])
  const json = (s: string) => { try { return JSON.parse(s) } catch { return {} } }
  const allowedAt = programs.map(p => ({ session: p.session, started_at: p.started_at, allowed: (json(p.output).manifest?.allowed_behaviors ?? []) as string[] }))
  const needs = new Map(requests.map(r => [`${r.session}|${r.request}`, String(json(r.input).need ?? '')]))
  // Goal lifetimes: pushed → completed, failed or abandoned, per session.
  const spans: { session: string, goal: string, text: string, from: string, to?: Row }[] = []
  for (const g of goals) {
    if (g.transition === 'pushed') spans.push({ session: g.session, goal: g.goal, text: String(json(g.input).text ?? ''), from: g.started_at })
    else if (ENDED.has(g.transition)) { const s = spans.findLast(s => s.session === g.session && s.goal === g.goal && !s.to); if (s) s.to = g }
  }
  const tally = (rs: Row[]) => rs.reduce<Count>((c, r) => ({ ...c, [r.end_reason]: (c[r.end_reason] ?? 0) + 1 }), {})
  return behaviors.map(m => {
    const id = `${m.name}@${m.version}`
    const used = inUse.get(id)!
    const mine = runs.filter(r => r.name === m.name && Number(r.version) === m.version && used.has(r.session))
    const picked = mine.filter(r => !r.decided_by?.startsWith('builder:'))
    const myTrials = trials.filter(t => t.id === id && used.has(t.session))
    const requested = new Set(myTrials.map(t => `${t.session}|${t.request}`))
    return {
      id, sessions: [...used],
      picked: tally(picked),
      trial_runs: tally(mine.filter(r => r.decided_by?.startsWith('builder:'))),
      failures: picked.filter(r => !OK_ENDS.has(r.end_reason)).slice(-10).map(r => ({ session: r.session, trace_id: r.trace_id, span_id: r.span_id, run_id: r.run_id, end: r.end_reason, detail: r.detail })),
      builds: builds.filter(b => requested.has(`${b.session}|${b.request}`)).map(b => ({ session: b.session, request: b.request, need: needs.get(`${b.session}|${b.request}`) ?? '', status: b.status, trials: b.trials, latency_ms: b.latency_ms, trace_id: b.trace_id })),
      trials: myTrials.map(t => ({ session: t.session, request: t.request, end: t.end_reason, passed: t.passed, preempted: t.preempted, trace_id: t.trace_id, span_id: t.span_id })),
      disabled: disabled.filter(d => d.id === id && used.has(d.session)).map(d => ({ session: d.session, reason: d.reason, trace_id: d.trace_id, span_id: d.span_id })),
      goals: spans.filter(s => s.to && s.to.transition !== 'abandoned' && used.has(s.session)).map(s => {
        const during = (t: string) => t >= s.from && t <= s.to!.started_at
        return {
          session: s.session, goal: s.goal, text: s.text, outcome: s.to!.transition, summary: String(json(s.to!.output).summary ?? ''),
          allowed: allowedAt.some(p => p.session === s.session && during(p.started_at) && p.allowed.includes(m.name)),
          ran: picked.filter(r => r.session === s.session && during(r.started_at)).length,
          trace_id: s.to!.trace_id, span_id: s.to!.span_id
        }
      }).filter(g => g.allowed || g.ran)
    }
  })
}

export type Decision = { behavior: string, action: 'keep' | 'retire' | 'merge', reason: string, evidence: string[] }
export type Merge = { name: string, description: string, code: string, channels: string[], targets: 'block' | 'entity' | 'item', timeout_s: number, usage: string, replaces: string[], reason: string, evidence: string[] }
export type Lesson = { lesson: string, evidence: string[], expires: string }
export type Proposal = { decisions: Decision[], merges: Merge[], lessons: Lesson[], summary: string }

const ids = { type: 'array', items: { type: 'string' }, description: 'Trace, span or run ids from the evidence' }
const SUBMIT = {
  type: 'object', additionalProperties: false, required: ['decisions', 'merges', 'lessons', 'summary'],
  properties: {
    decisions: {
      type: 'array', description: 'One per library behavior.',
      items: {
        type: 'object', additionalProperties: false, required: ['behavior', 'action', 'reason', 'evidence'],
        properties: { behavior: { type: 'string', description: 'Its name' }, action: { type: 'string', enum: ['keep', 'retire', 'merge'] }, reason: { type: 'string' }, evidence: ids }
      }
    },
    merges: {
      type: 'array', description: 'New general behaviors, each replacing the behaviors marked merge.',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'description', 'code', 'channels', 'targets', 'timeout_s', 'usage', 'replaces', 'reason', 'evidence'],
        properties: {
          name: { type: 'string' }, description: { type: 'string' }, code: { type: 'string' },
          channels: { type: 'array', items: { type: 'string', enum: ['legs', 'aim', 'hands'] } },
          targets: { type: 'string', enum: ['block', 'entity', 'item'] }, timeout_s: { type: 'integer' }, usage: { type: 'string' },
          replaces: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' }, evidence: ids
        }
      }
    },
    lessons: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['lesson', 'evidence', 'expires'],
        properties: { lesson: { type: 'string' }, evidence: ids, expires: { type: 'string', description: 'A date (YYYY-MM-DD) after which it needs fresh evidence' } }
      }
    },
    summary: { type: 'string', description: 'Two or three sentences for the reviewer.' }
  }
}

const SYSTEM = `You are System 2B, the builder of Jeeve, a Minecraft bot, working between episodes: there is no request and no body. You curate the library of behaviors you wrote during earlier episodes. Each came from a capability request and passed one live trial. You get each library behavior with its code, and what the traces say about it, from the sessions where that version was in use: runs the fast model picked, by end reason; its trials and builds; disable events; and the goals that completed or failed while it was allowed or ran. Failed picked runs come with the start of their detail (error and last actions).

Decide for every behavior:
- keep: it works, or the evidence is too thin to judge (one session is thin; a behavior loaded but never picked across several sessions is not).
- retire: it keeps failing, was disabled, or is never picked across several sessions.
- merge: it nearly duplicates another library behavior; write one general version that replaces them (in merges). Only merge when the merged code is clearly at least as good as each one it replaces: it can't be trialled now, so it is trialled in the next episode.
A trial that passed as goal_closed means the goal completed while it ran, not that the behavior did the work; a behavior that only ever passed that way is less proven.

Then lessons: what these traces teach that should outlive the goal that produced them (about behaviors, the api, trials, or the world), each citing the trace, span or run ids that show it, with an expiry date. Few and specific beats many and vague. No lessons is fine.

Nothing you propose is applied: a person reviews it as a git diff. Use run_sql to read more (a failed run's full jeeve.behavior.detail, a trial span's output) when the facts aren't enough, then call submit_curation once.

Behaviors are code: \`async (api, target) => ...\` returning "done", "stuck" or "none_found", claiming one of legs, aim, hands or all three.
${API_DOC}`

// One 2B run over the facts. parent: the `curate` span; the AI SDK's spans go under it, as in build().
export async function curate (library: Stored[], facts: Facts[], sql: Sql, seen: Set<string>, parent: Span, session: string, model: LanguageModel): Promise<Proposal | null> {
  let proposal: Proposal | null = null
  const tools = {
    run_sql: tool({
      description: "Run one read-only SELECT over the traces (telemetry.spans; span attributes are in attributes['jeeve.*']).",
      inputSchema: jsonSchema<{ query: string }>({ type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string' } } }),
      execute: async ({ query }) => {
        try { return JSON.stringify(remember(seen, (await sql(query)).rows)).slice(0, 20_000) } catch (err) { return `error: ${(err as Error).message}` }
      }
    }),
    submit_curation: tool({
      description: 'Submit the proposal: a decision per behavior, merges, lessons.',
      inputSchema: jsonSchema<Proposal>(SUBMIT),
      execute: async p => { proposal = p; return 'submitted' }
    })
  }
  const brief = {
    library: library.filter(m => m.kind === 'behavior').map(m => ({ id: `${m.name}@${m.version}`, description: m.description, usage: m.usage ?? null, channels: m.channels, targets: m.targets, timeout_s: m.timeout_s, origin: m.origin, trial: m.trial, code: m.code })),
    facts
  }
  const judgment = JudgmentTracerProvider.getInstance()
  await judgment.withContext(trace.setSpan(judgment.getCurrentContext(), parent), () => generateText({
    model,
    system: `${SYSTEM}\n\n${TRACES}`,
    prompt: JSON.stringify(brief),
    tools,
    stopWhen: [stepCountIs(16), () => !!proposal],
    providerOptions: { anthropic: { effort: BUILDER_EFFORT } },
    telemetry: {
      functionId: 'curate',
      integrations: [new OpenTelemetry({ tracer: Tracer.getOTELTracer(), enrichSpan: () => ({ 'judgment.session_id': session }) })]
    }
  }))
  return proposal
}

// The proposal as files for review. Retired and merged-away behaviors leave the library; a merge adds a new
// version with no trial result. A merge whose code doesn't compile is dropped, and what it replaces stays.
export function propose (library: Stored[], proposal: Proposal, o: { session: string, seen: Set<string>, facts: Facts[], now: string }) {
  // The brief lists behaviors as name@version; decisions and merges may name them either way.
  const bare = (n: string) => n.split('@')[0]
  const p = { ...proposal, decisions: proposal.decisions.map(d => ({ ...d, behavior: bare(d.behavior) })), merges: proposal.merges.map(mg => ({ ...mg, replaces: mg.replaces.map(bare) })) }
  const names = new Set(library.filter(m => m.kind === 'behavior').map(m => m.name))
  const rejected: string[] = []
  const merges = p.merges.filter(mg => {
    const unknown = mg.replaces.filter(n => !names.has(n))
    try {
      if (unknown.length) throw new Error(`replaces behaviors not in the library: ${unknown.join(', ')}`)
      compileBehavior({ kind: 'behavior', ...mg })
      return true
    } catch (err) { rejected.push(`${mg.name}: ${(err as Error).message}`); return false }
  })
  const leaving = new Set([...p.decisions.filter(d => d.action === 'retire' && names.has(d.behavior)).map(d => d.behavior), ...merges.flatMap(mg => mg.replaces)])
  const modules: Stored[] = library.filter(m => m.kind !== 'behavior' || !leaving.has(m.name))
  for (const mg of merges) {
    const { replaces, reason, evidence, ...src } = mg
    const version = Math.max(0, ...library.filter(m => m.name === mg.name).map(m => m.version)) + 1
    modules.push({ kind: 'behavior', ...src, version, origin: { session: o.session, goal: `curate: merge of ${replaces.join(', ')}`, created_at: o.now } })
  }
  modules.sort((a, b) => a.name.localeCompare(b.name))

  const cite = (xs: string[]) => xs.length ? xs.map(x => o.seen.has(x) ? `\`${x}\`` : `\`${x}\` (not in the queried traces)`).join(', ') : '(none)'
  const counts = (c: Count) => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
  const decided = new Map(p.decisions.map(d => [d.behavior, d]))
  const review = [
    `# Library curation ${o.now}`, '', `Session \`${o.session}\`. Proposed only: nothing was applied. Apply with \`git apply\` on library.diff, or copy library.json over the library.`, '', p.summary, '',
    '| Behavior | Decision | Picked runs | Goals (allowed or ran) | Why | Evidence |', '|---|---|---|---|---|---|',
    ...o.facts.map(f => {
      const name = f.id.split('@')[0]
      const d = decided.get(name)
      const into = merges.find(mg => mg.replaces.includes(name))
      const action = into ? `merge → ${into.name}` : leaving.has(name) ? 'retire' : 'keep'
      const goals = f.goals.map(g => `${g.goal} ${g.outcome}`).join(', ') || 'none'
      return `| ${f.id} (${f.sessions.length} session${f.sessions.length === 1 ? '' : 's'}) | ${action}${d && !action.startsWith(d.action) ? ` (proposed ${d.action})` : ''} | ${counts(f.picked)} | ${goals} | ${(d?.reason ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${cite(d?.evidence ?? [])} |`
    }),
    ...merges.flatMap(mg => ['', `## Merge: ${mg.name} (untrialled; replaces ${mg.replaces.join(', ')})`, '', mg.reason, '', `Evidence: ${cite(mg.evidence)}`, '', `Usage: ${mg.usage}`, '', '```js', mg.code, '```']),
    ...(rejected.length ? ['', '## Merges dropped', '', ...rejected.map(r => `- ${r}`)] : [])
  ].join('\n') + '\n'
  const lessons = [
    `# Lessons ${o.now}`, '', `From curation session \`${o.session}\`. Proposed: each cites its evidence and expires ([[system-2]] → "Lessons kept past their goal").`, '',
    ...(p.lessons.length ? p.lessons.map(l => `- ${l.lesson}\n  - evidence: ${cite(l.evidence)}\n  - expires: ${l.expires}`) : ['(none)'])
  ].join('\n') + '\n'
  return { library: JSON.stringify({ modules }, null, 2) + '\n', review, lessons }
}
