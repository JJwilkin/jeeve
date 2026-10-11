---
date: 2026-10-10
tags: [architecture, learning, tracing, system-2]
status: active
---
# Learning: context only, live and from traces

**Decision: no model training.** Jeeve improves through **context** (System 2 rewrites Jev's guidance and examples) and **code** (System 2 writes new behaviors, [[behaviors-and-guards]]).

Under the [[bitter-lesson]] this is still learning: it scales with experience, as long as examples are *retrieved from traces*, not hand-picked. The limit is Jev's built-in ability plus what fits in one call. If we hit that, the traces will show it, and we revisit.

## Two loops
| Loop | When | Reads | Example |
|---|---|---|---|
| **Inner** | Live, during the episode | The live event stream (seconds old) | "Steve shields after 2 hits → switch to axe, then sword" |
| **Outer** | Minutes to hours later, across episodes | Past traces, through agentic search | "We died bridging in 8 of 10 Bed Wars runs → start with sneak-bridging" |

Both write the same things: Jev's guidance, its examples, and behaviors.

## Traces are how System 2 reads the past
**One trace per window.** Each episode is one Judgment session. Within it, a new trace is emitted every ~minute (and probably at goal-node boundaries too).
- This keeps traces bounded in size, even over hours of play.
- It also makes recent history queryable within about a minute, not only when the episode ends.

**Traces are linked by lineage.** The first span of each trace is a **carry-over span** that hands context forward:
- the active goal path (root → current node),
- the System 1 program version Jev is running (it includes the guidance; [[system-1]]),
- a summary of the previous window,
- a link to the previous trace (an OpenTelemetry span link, plus `jeeve.prev_trace_id` and `jeeve.window_index` attributes).

Following carry-over spans backwards walks the episode's history, and each one is a natural summary to skim before drilling in.

**What a window trace holds:**
- Jev calls: the state it saw (encoded, plus a compact raw snapshot for replay), its questions, the option order, choices, probabilities, and the program version.
- Behavior runs: start, end, events, vetoes.
- Escalations, and the System 2 calls they triggered.
- Guidance updates: what changed, and the events cited as evidence.

## Agentic search over traces
System 2 doesn't just receive the latest window. It **searches its own history** like any other data, using Judgment's virtual SQL over its own spans and traces ([[trace-schema]]). Semantic search can be added once it's ready.
- "Every window where `navigate` reported stuck near water in the last 2 hours." Pull those traces, find what got it unstuck, and turn that into guidance or an example.
- "The last time we fought Steve." Read that window's choices and outcomes before this fight starts.
- "The guidance version that preceded the most deaths." Diff it against the current one.

This is what turns traces into experience: System 2 picks its own examples by searching for them, not from a fixed set. It's also a strong use of Judgment's own product, where the agent queries its own traces in order to improve.

## Guarding against poisoned beliefs
The long-horizon failure from [[llm-plays-pokemon]]: a wrong belief ("Steve can't shoot") gets baked into guidance and keeps steering badly. So every guidance update must:
- **cite evidence:** the events or trace IDs that motivated it,
- **expire** unless later evidence keeps confirming it,
- **be versioned,** so each decision is traceable to the guidance it ran under, and a bad version can be found and rolled back by searching traces.

## Open questions
- ~~**How fresh the outer loop can be.**~~ Answered in [[trace-schema]]: with a flush at the cut, a window is queryable through virtual SQL 0.7–0.9 s after it closes (measured on staging).
- ~~**What triggers a window.**~~ Answered in [[trace-schema]]: 60 s or a root-goal boundary, whichever comes first. A fight that crosses a cut is stitched back together by `run_id`.
- **Who writes window summaries.** System 2 itself, or a cheap summarizer at the cut?
- **Outcome signals.** How the outer loop knows what "went well" is roadmap stage 4 (goals and reward).
