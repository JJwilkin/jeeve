---
date: 2026-10-10
tags: [roadmap]
status: active
---
# Roadmap

How we're breaking the problem down. Stages 1–3 and the first milestone are done; stage 4 and the "Next" list under stage 5 are the open work. Each stage ends with notes in the brain.

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

**Implemented 2026-10-11** (`src/trace.ts`). The e2e checks every span kind and the window lineage in Judgment by SQL ([[trace-schema]] → "Implementation").

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

**Reached 2026-10-11.** `npm run e2e` runs the whole stack on a local Paper server:
- System 1 on Jev ([[system-1]] → "First implementation");
- System 2 on Claude, with the goal tree ([[system-2]] → "Implementation");
- traces in Judgment ([[trace-schema]] → "Implementation").

All three instructions pass, and so do a live guard veto and the local API. System 2 sets each goal's check, code reports "done", and the episode is verified in Judgment by SQL.

**Next:**
- System 2 writing encoders and option generators: deferred. Checks, watch conditions and behaviors are done and persist in a module library ([[system-1]] → "Modules System 2 writes", [[behaviors-and-guards]] → "How it's built");
- ~~behaviors System 2 writes at runtime~~ ([[runtime-authored-behaviors]], done 2026-10-11: it wrote, trialled and fixed a pillaring behavior to clear an out-of-reach canopy);
- ~~perception as tools~~: done 2026-10-11. System 2 looks with `scan` and `reachable` ([[perception]]); next is block states and more consistent batching of looks;
- the full player action API, so System 2 can write crafting, container, combat and chat behaviors live ([[full-player-action-api]], task);
- System 2A (orchestrator) / 2B (builder) split ([[system-2a-2b]], task);
- ~~"defend me" fixes~~: done 2026-10-11. Damage is attributed to its source, a fast health drop bypasses the no-repeat window, and the e2e fails on any death and has a slime scenario ([[system-1]] → "Threats", [[system-2]] → Open questions);
- lessons that outlive their goal;
- judges and the outer loop (stage 4);
- the PvP arena and benchmarks ([[benchmarks]]).

## Order after the current work (decided 2026-10-11)
1. ~~**"Defend me" fixes:**~~ done 2026-10-11.
2. **Faster e2e:** split the 20-minute e2e into small independent scenarios that run in parallel (each on its own `JEEVE_PORT` and world), plus a quick smoke subset. Do this after the in-flight sessions ([[full-player-action-api]], [[system-2a-2b]]) land, because both add e2e scenarios.
3. **Online infrastructure:** a hosted server (e.g. GCP), and the ability to spawn one or many agents on running infrastructure somewhere. This comes **before** stage 4's benchmarks, so scenarios and benchmarks run on real infrastructure, not only this laptop.
4. **Stage 4, goals and reward,** plus the first benchmarks (tech-tree ladder, PvP arena), run on that infrastructure. The judge design can be scoped in parallel, as notes only.
5. **The outer loop** on 2B, once there's a signal to climb.
