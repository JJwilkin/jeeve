---
date: 2026-10-10
tags: [task, behaviors, tracing, judgment]
status: active
progress: done
---
# Task: seed behaviors, and the trace schema and ingest

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/seed-behaviors-and-traces.md`."

## Goal
Pin down what the first milestone ([[layers]]: a local server, instructions from outside) needs in two areas:
1. **Seed behaviors:** the smallest behavior set that makes these instructions work:
   - "come here",
   - "collect 10 logs",
   - "follow me and defend me".
2. **Traces:** the span and trace schema, and how traces get into Judgment and become searchable again by System 2.

## Read first
- [[behaviors-and-guards]]: the behavior contract (channel, parameters, lifecycle, events, ending), guards, runtime-authored behaviors
- [[layers]]: channels, and System 2 vs. Jev vs. code
- [[learning]]: one trace per window, carry-over spans, `jeeve.prev_trace_id` / `jeeve.window_index`, agentic search over traces
- Evidence: [[fast-bots]] (what mineflayer-pathfinder and mineflayer-pvp already do), [[mindcraft-and-voyager]] (Mindcraft's skills library as a reference for primitives)
- If [[system-1-infrastructure]] has landed, read it too. It may change what counts as a seed behavior versus something System 2 writes.

## Part 1: seed behaviors
- **For each of the three instructions:** which behaviors on which channels, and what is System 2's or Jev's job rather than a behavior's.
- **Reuse what exists.** Wrap `mineflayer-pathfinder`, `mineflayer-pvp` and `mineflayer-collectblock` before writing anything new.
- **For each behavior:** its contract, the events it emits, how it ends, and which guards apply.
- **Keep it small.** Every seed behavior is scaffolding under the [[bitter-lesson]]. Note which ones System 2 should eventually be able to write itself.

## Part 2: trace schema and ingest
- **Span tree for one window:** carry-over span → System 2 calls, guidance updates, Jev `decide()` calls → behavior runs → events and vetoes.
- **Attributes:**
  - for each span kind, what's recorded (state as Jev saw it, questions, choices, probabilities, guidance version, behavior version, System 1 program version);
  - naming (`jeeve.*`);
  - which fields need to be searchable;
  - a compact raw state snapshot on each `decide()` span, plus the option order shown, so programs can be replayed ([[system-1]]).
- **Sessions and windows:** one session per episode, one trace per window. Decide what triggers a window: time, goal-node boundaries, or both.
- **Ingest:**
  - judgeval-js setup in a Node process;
  - how Jev, Claude and behavior spans get created (the judgeval-js Tracer, OpenTelemetry);
  - flush timing;
  - how quickly a window is queryable after it closes, measured on staging.
- **Read path:** the queries System 2 will run over its own traces (JQL and semantic search), and the fields and summaries those queries need.
- **Volume:** spans per minute at the expected call rates, and what to sample or aggregate.

## Done when
- `brain/architecture/` has a note for the seed behaviors and one for the trace schema and ingest (or one combined note, if small).
- The first milestone's three instructions are walked through end to end against both notes.
- [[roadmap]] stage 3 is updated.
