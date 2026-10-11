---
date: 2026-10-10
tags: [roadmap]
status: active
---
# Roadmap

How we're breaking the problem down. Each stage ends with notes in the brain, and later stages build on earlier ones.

## 1. Research: state of the art and benchmarks ✓
Done. Notes are in `brain/research/` (see the index). The main conclusions:
- real-time play is the open problem,
- no single action level wins,
- nobody combines fast, smart and general ([[realtime-landscape]]).

## 2. Architecture ✓
**Decided:**
- [[layers]]: System 2 / Jev / behaviors / guards, channels, what triggers Jev, first milestone.
- [[behaviors-and-guards]]: the deterministic layer.
- [[learning]]: context only, no training.
- [[system-1]]: System 1 is a program System 2 writes; the runtime, its fixed bounds and the default program ([[jev-measurements]] for Jev's real limits).
- [[seed-behaviors]]: `navigate`, `follow`, `collect`, `fight`, `stop`, wrapping mineflayer plugins; the three first-milestone instructions walked through end to end.
- [[system-2]]: the goal tree (System 2 is the only writer; program versions stack with goals), instructions by whisper or a local API, success checks as code modules, escalation handling, and program changes scoped by goal.

## 3. Tracing with Judgment ✓
Done. The design is in [[learning]] and [[trace-schema]]:
- **Sessions and windows:** one session per episode; one trace per window, cut at 60 s or a root-goal boundary. The root span ends last, and behaviors that cross a cut are stitched together by `run_id`.
- **Spans:** seven span kinds with `jeeve.*` attributes. `decide` spans carry the encoded state, the option order and a raw snapshot for replay.
- **Ingest:** judgeval-js, with `forceFlush` at every cut. A window is queryable 0.7–0.9 s after it closes (measured on staging).
- **Read path:** System 2 queries its own traces with virtual SQL. JQL and semantic search aren't used yet.

**Open:** semantic search once it's ready ([[trace-schema]]). The previous-window summary is written by code ([[system-2]]).

Traces feed System 2 as evidence and examples, not as training data.

## 4. Goals and reward (open)
- ~~How an instruction becomes a goal with a success check.~~ Done for the first milestone in [[system-2]]: System 2 picks a check module (`near_entity`, `inventory_delta`, …) and code evaluates it every tick; open-ended goals get `escalate_if` checks and a review interval, where a judge will plug in.
- Programmatic checks vs. judges, scored at each level of the hierarchy.
- The signal the outer loop hill-climbs on.

## 5. First milestone: a client that takes instructions
See [[layers]].
- Join a **local** Minecraft server on this machine as a normal client. A GCP-hosted or other server comes later, with the same agent code.
- Take instructions from outside ("come here", "collect 10 logs", "follow me and defend me").
- Trace everything.
- System 1 runs on Jev (we have access).

Evaluation scenarios, including the PvP arena, run on our own server. Behaving like a legitimate client on public servers (anti-cheat, fairness) comes later.

**Started 2026-10-10:** System 1 runtime slice in `src/` ([[system-1]] → "First implementation"). "Come here" and "follow me and defend me" pass end to end. Still to do: "collect 10 logs" (dig), System 2 (designed in [[system-2]]), Judgment ingest, and a real guard layer.
