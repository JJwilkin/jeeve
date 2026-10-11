---
date: 2026-10-10
tags: [architecture, tracing, judgment]
status: active
---
# Trace schema and ingest

How Jeeve's experience gets into Judgment and how System 2 reads it back. This implements the window and lineage decisions in [[learning]], for the seed behaviors in [[seed-behaviors]].

## Sessions and windows
- **One episode is one session.** `judgment.session_id` is set on each window root and propagates to all its children through baggage.
- **One window is one trace.** A window closes on whichever comes first:
  - 60 s, or
  - a root-goal boundary: a new instruction, or the goal completed or failed.
- **Interrupts don't cut windows.** A fight (behavior runs under a goal) stays in the current window.

**The root span must end last.** Judgment treats a trace as finalized when its root span ends (judgeval-server `modules/otel/client.ts`), and post-processing runs once per finalized trace. So closing a window means:
1. End every open behavior span with `end_reason = cut`.
2. End the `window` root.
3. Call `Tracer.forceFlush()`.
4. Reopen the still-running behaviors in the new window with the same `jeeve.behavior.run_id` and `jeeve.behavior.continued = true`.

A fight that crosses a cut is stitched back together by `run_id`.

## Span tree for one window
`behavior` spans are siblings of `decide`, not children, because a behavior outlives the call that chose it.
```
window                   root
├─ carry_over            first child: hands context forward
├─ system2               Claude call (instruction or escalation)
├─ program               one per new System 1 program version (includes guidance)
├─ decide                one per Jev call (most of the spans)
├─ behavior.<name>       one per behavior run within this window
└─ goal                  one per goal-tree transition
```

## What each span records
All custom attributes use the `jeeve.*` prefix.

| Span | Input / output | Attributes | Events |
|---|---|---|---|
| `window` | none | `jeeve.window_index`, `jeeve.prev_trace_id`, `jeeve.window.reason` (`time`, `goal_boundary`, `episode_end`), `jeeve.goal.path` (`g-4:collect 10 logs > g-5:…`, at window open) | game events that aren't behavior events: `death`, `damage`, `owner_damage` (the player an open-ended goal protects, [[system-2]]), `chat`. Each carries the program version in effect. |
| `carry_over` | in: goal path, program version, previous window's summary, open behavior runs | `jeeve.prev_trace_id` | none |
| `system2` | in: instruction text and sender, or the escalation · out: goal, check, program changes | `jeeve.system2.trigger` (`instruction`, `escalation:<reason>`), plus model and tokens via `recordLLMMetadata` | none |
| `program` | in: manifest diff from the parent · out: full manifest | `jeeve.program.version`, `.parent`, `.reason`, `.cites` (trace and span ids), `.activation` (`ok`, `failed_check`, `rolled_back`) | none |
| `decide` | in: the encoded state as Jev saw it, plus the questions with options **in the order shown** · out: choices, probabilities, confidence | `jeeve.program.version`, `jeeve.decide.trigger` (merged triggers), `.changed`, `.latency_ms`, `.state_age_ms` (how stale the state was when the answer arrived), `.deadline_missed`, `.escalate`, `.raw_state` (compact raw snapshot for replay) | none |
| `behavior.<name>` | none | `jeeve.behavior.name`, `.version`, `.params`, `.run_id`, `.channels`, `.decided_by` (the `decide` span id), `.end_reason`, `.continued` | `progress`, `vetoed` (guard and reason), and the other behavior events |
| `goal` | in: the node · out: the check result and one-line summary | `jeeve.goal.id`, `.path`, `.transition` (`pushed`, `completed`, `failed`, `abandoned`; ~~`popped`~~ dropped by [[system-2]]: a pop is the child closing) | none |

**Every `decide` call keeps its full state.** The many `keep_current` calls are the evidence for telling a bad choice from a broken behavior ([[behaviors-and-guards]]). `jeeve.decide.changed` lets queries skip them.

**The raw snapshot is for replay** ([[system-1]]):
- **What's in it:** entities, inventory, the bot's own status, the event window, and a 16³ block cube, as JSON in `jeeve.decide.raw_state`.
- **The block cube is logged only when it changes.** The first `decide` of every window always logs it, so replay never needs to look across traces.
- **Option order is part of the input,** because order changes Jev's answers ([[jev-measurements]]).

## Ingest
- **Tracer:** `Tracer.init({ projectName })` from judgeval-js runs in the bot's Node process.
- **`system2` and `decide` spans are made by hand** with `Tracer.observe({ spanType: "llm" })` plus `recordLLMMetadata`. judgeval-js only auto-instruments OpenAI clients.
- **`window`, `carry_over`, `behavior` and `goal` spans** use `Tracer.startSpan` and `span.addEvent`.
- **Flush:** call `Tracer.forceFlush()` at every window close. Otherwise the batch processor's 5 s delay applies.

**Freshness, measured on staging 2026-10-10:**
- Setup: project `jeeve-dev`, judgeval-js 1.3.5, 10 synthetic windows of 23 spans each.
- With `forceFlush`: a window's root and all its spans are queryable through virtual SQL **0.7–0.9 s** after the root ends.
- Without it: 4.4–5.1 s.

The inner loop doesn't depend on any of this; it reads the live event stream in-process ([[learning]]). The outer loop can query a window about a second after it closes.

## Read path: virtual SQL
System 2 queries its own project through `client.sql()` (judgeval-js `Judgeval`) against `telemetry.traces` and `telemetry.spans`. JQL and semantic search aren't used for now. Text questions ("stuck near water") become `ILIKE` over `decide` inputs.

```sql
-- navigate runs that got stuck in the last 2 h
SELECT trace_id, span_id, started_at, attributes['jeeve.behavior.params'] AS params
FROM telemetry.spans
WHERE span_name = 'behavior.navigate' AND attributes['jeeve.behavior.end_reason'] = 'stuck'
  AND started_at > now() - INTERVAL 2 HOUR
ORDER BY started_at DESC LIMIT 50
```
```sql
-- the last fight with Steve; then read the decide spans in that trace where jeeve.decide.changed = 'true'
SELECT trace_id, started_at, ended_at FROM telemetry.spans
WHERE span_name = 'behavior.attack_when_ready' AND attributes['jeeve.behavior.params'] ILIKE '%Steve%'
ORDER BY started_at DESC LIMIT 1
```
```sql
-- walk an episode through its carry-over spans
SELECT t.trace_id, t.attributes['jeeve.window_index'] AS idx, substringUTF8(s.input, 1, 2000) AS carry_over
FROM telemetry.traces t JOIN telemetry.spans s ON s.trace_id = t.trace_id AND s.span_name = 'carry_over'
WHERE t.session_id = '<episode>' ORDER BY toUInt32OrZero(idx)
```
```sql
-- deaths per program version
SELECT JSONExtractString(e, 'Attributes', 'program_version') AS v, count() AS deaths
FROM telemetry.spans ARRAY JOIN JSONExtractArrayRaw(events_json) AS e
WHERE span_name = 'window' AND JSONExtractString(e, 'Name') = 'death'
GROUP BY v ORDER BY deaths DESC
```
```sql
-- live comparison of program versions (tier 3 in system-1): choice changes, escalations, late answers
SELECT attributes['jeeve.program.version'] AS v, count() AS decides,
       countIf(attributes['jeeve.decide.changed'] = 'true') AS changes,
       countIf(attributes['jeeve.decide.escalate'] = 'true') AS escalations,
       quantile(0.9)(toFloat64OrZero(attributes['jeeve.decide.state_age_ms'])) AS p90_state_age_ms
FROM telemetry.spans
WHERE span_name = 'decide' AND started_at > now() - INTERVAL 1 DAY
GROUP BY v ORDER BY decides DESC LIMIT 20
```

**Which fields are cheap to search:**
- Filter on `span_name`, `session_id` and `trace_id` first. These are real columns.
- `jeeve.*` values sit in the `attributes` map, and reading one key scans the whole map. That's acceptable for one agent's project; narrow the time range first.
- The staging test checked that session propagation, the `jeeve.*` attributes, `prev_trace_id` lineage and `events_json` all come through.

## Volume
| Span | Per minute |
|---|---|
| `decide` | 60–180 at the default 1 s heartbeat plus triggers; up to 300 at the 5/s cap |
| `behavior` | about 10 |
| `system2` | 1–3 |
| `program` | about 1 |

- **About 5–20k spans per hour.** Each `decide` carries ~2–8 KB of encoded state plus ~15 KB of raw snapshot (~2–4 KB compressed, per [[system-1]]).
- **Reading snapshots back:** virtual SQL caps a result at 5 MiB, so read raw snapshots a few spans at a time, or in `substringUTF8` windows.
- **Cost:** Jev input costs under $1 per hour at $0.042 per million tokens ([[decision-models]]).
- **No sampling for M1.** If it's needed later, the first knobs are dropping the encoded state from `keep_current` calls (keeping a hash), then logging the raw snapshot less often.

## Implementation (2026-10-11)
Built in `src/trace.ts`, exporting to staging project `jeeve-dev` via judgeval-js 1.3.5. Every span is also mirrored to `traces/<session>.jsonl`, which works without credentials.
- **One session per agent run.** The episode is the process.
- **Windows cut** at 60 s, on a new instruction, and when a root goal completes or fails.
- **Carry-over span:** carries the code-written summary of the previous window: goal path, behavior runs by how they ended, events, escalations, System 2 notes and program versions ([[system-2]]).
- **Lineage:** each window links to the previous one with an OTel span link and `jeeve.prev_trace_id`.
- **Spans are made with the OTel tracer judgeval registers,** with the window span as their parent. `judgment.session_id` is set on every span directly rather than through baggage, which gives the same result.
- **Verified by `npm run e2e`.** A SQL query by `session_id` finds `window`, `carry_over`, `decide`, `system2`, `program`, `goal` and `behavior.*` spans, and every window after the first has a `prev_trace_id`.

**Attributes added beyond the table above:**
- `jeeve.decide.encode_ms`;
- `jeeve.program.because`: why a version was activated. Keeping the cause out of the manifest keeps versions stable: the default is always the same hash;
- `jeeve.system2.latency_ms`, `.turns` and `.refusal`;
- `jeeve.behavior.decided_by`, as specified.

**Not yet:**
- **The raw snapshot has no block cube.** The default encoder doesn't need terrain yet.
- **Semantic search isn't used.** System 2 has SQL only (`run_sql`).

## Open questions
- ~~**Who writes the previous-window summary** in `carry_over`: System 2, or a cheap summarizer at the cut?~~ Answered in [[system-2]]: code, as a structured summary at the cut.
- **Semantic search.** When it's ready, thousands of near-identical `keep_current` states could drown it. The likely fix is indexing only `changed = true`.
- **Session length.** Is one session per multi-hour episode fine for session-level queries in the UI?
