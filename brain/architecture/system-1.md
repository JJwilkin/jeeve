---
date: 2026-10-10
tags: [architecture, system-1, system-2, bitter-lesson]
status: active
---
# System 1: a program System 2 writes, on a runtime we build

How System 1 works is not designed here. **System 2 writes it, as a program, and we build the runtime that program runs on.** This is the [[bitter-lesson]] applied to our own controller: provide methods, not answers. This note is the outcome of [[system-1-infrastructure]], and it refines the System 1 section of [[layers]].

## The idea, and the two amendments
The starting idea held: **System 1 is a program System 2 writes, and the infrastructure is its runtime.** Two amendments:

1. **A program is a small declarative manifest that points to code modules.** It isn't free-form code.
   - The manifest says *what*: the encoder, the questions, where each question's options come from, the triggers, the guidance, the examples, and the allowed behaviors.
   - Anything that needs real logic is a **module**: encoders, option generators and watch conditions.
   - A manifest can be checked against the bounds before it goes live, diffed, swapped mid-episode at no cost, and named by one version.
2. **The two loops get different jobs, but neither loop is gated.**
   - **Inner loop (live):** System 2 edits settings: guidance, examples, allowed behaviors, trigger settings. It switches between encoders and question sets that already exist.
   - **Outer loop:** this is where new encoders and question sets usually come from, because comparing them needs traces ([How programs are compared](#how-programs-are-compared)).
   - **Evidence is recorded, not required.** Every program change is versioned and carries its reasoning and any events it cites, the same rule [[learning]] sets for guidance. System 2 may write a module and activate it straight away. The only checks are the mechanical ones in [Fixed bounds](#fixed-bounds).
   - *Refined by [[system-2]]:* this holds for structural changes (encoders, question layouts, modules). Guidance changes are scoped to the goal node that made them and revert when it closes; lessons kept past their goal must cite trace or event IDs and expire.

## Where the line is
The infrastructure owns anything that does one of four things:
- enforces safety or game rules,
- owns time and concurrency,
- is needed to measure programs,
- has one right answer.

Everything else is program.

| Infrastructure (fixed) | Program (System 2) |
|---|---|
| **Channels as ownership of the bot's controls:** one owner per channel, plus the rules that couple channels ([[layers]]) | **How questions map to channels.** One choice per channel is just the default program. A program can ask one joint question, leave a channel's behavior running without asking about it, or ask questions that aren't about a channel (a threat score, a target pick). |
| **Stable handles** for entities, blocks and waypoints, so an option like `track(E3)` binds to a real object | Which entities and areas are encoded, and how |
| **A check when the answer arrives:** is the target still there? The runtime also records how stale the state was. Jev answers ~150–300 ms after the state it saw. | How options are listed and ordered, and whether to debias them ([[jev-measurements]]) |
| Raw world state, after the **fairness filter** | Encoder choice and encoder settings |
| **`decide()`:** one call in flight per bot; the latest state wins; triggers that fire during a call merge into the next one | **Trigger policy:** event subscriptions, watch conditions, timers |
| The **module pipeline:** write → sandbox → trial → register → version, shared with behaviors ([[behaviors-and-guards]]) | The modules themselves, whether built in or authored |
| **Tracing, versioning, rollback** | Guidance, examples, allowed behaviors |

**Built-in modules are just modules registered in advance.** The runtime doesn't distinguish them from authored ones.

**Channels:** fixed as actuators, a default as a question layout.

## Program format
```yaml
program: v-9f2c            # content hash of everything below
parent: v-71ab
reason: "Bridging failed 3× with no terrain in view; add a 9×9 height map."
cites: [trace:…, event:…]
encoder: { module: egocentric@3, params: { entity_cap: 8, radius: 16, heightmap: 9 } }
questions:
  legs:  { type: choice, instructions: "...", options: { module: behaviors_x_targets@1, channel: legs }, debias: reverse }
  aim:   { type: choice, options: { module: behaviors_x_targets@1, channel: aim } }
  hands: { type: choice, options: { module: behaviors_x_targets@1, channel: hands } }
  escalate: { type: noul, instructions: "..." }
triggers:
  events: [done, stuck, blocked, vetoed, target_lost, damage_taken, new_directive]
  watch:  [{ module: entity_within@1, params: { radius: 6, hostile: true } }]
  heartbeat_ms: 1000
escalate_when: { confidence_below: 0.5, noul_above: 0.5 }
allowed_behaviors: [navigate, follow, track, attack_when_ready, eat, keep_current]
guidance: "..."
examples: [trace:…/span:…]
```
- **Module kinds:** an *encoder* turns raw state into Jev's `state`; an *option generator* turns a channel, the allowed behaviors and the encoded entities into a Choice's options; a *watch condition* is a predicate over raw state that wakes Jev.
- **One version:** the program version includes the guidance. It replaces a separate "guidance version" ([[learning]]).
- **Writing modules is allowed from the first milestone.** System 2 can author encoders, option generators and watch conditions, not only pick and tune built-ins.

## Fixed bounds
System 2 can't change these.

- **Guards.** A guard can still be lifted for a specific purpose and a limited time ([[behaviors-and-guards]]); guard code can't be removed.
- **The fairness filter and server privileges.** The operator sets them per scenario. Otherwise System 2 would simply turn x-ray on.
- **`decide()` limits.** The caps come from [[jev-measurements]], not vendor numbers:

  | Bound | Starting value | Why |
  |---|---|---|
  | Calls in flight per bot | 1 | One decision-maker keeps speech and action consistent ([[project-sid]]) |
  | Max call rate per bot | 5/s | p50 ~160 ms at a ~2k-token state; also keeps under the account's 80 req/s |
  | Questions per call | 32 | Measured flat latency from 1 to 32 |
  | Options per Choice | 255 (API cap) | Latency is fine at 255. The real limit is position bias, which programs handle by filtering and debiasing. |
  | Input tokens per call | 8k | ~200 ms p50. At 22k it's ~300 ms, and the vendor warns accuracy drops with irrelevant state. |
  | Call deadline | 1 s | Behaviors keep running, so a late answer only delays a change. Past the deadline, the answer is dropped and traced. |
- **A CPU budget for modules.** Encoders and watch conditions run on the hot path, so a slow encoder is as bad as a slow model. The runtime measures each run and traces it. A module over budget is disabled and the program falls back.
- **Tracing can't be turned off.** Every decision carries its program version and the order its options were shown in.
- **A check before activation.** Mechanical only: the program's modules run on the last N recorded raw states, within budget and caps, and produce valid options.
- **A watchdog.** It rolls back to the previous program when errors, timeouts or blown budgets spike after an activation. It watches only mechanical signals; outcomes are System 2's call.
- **A pinned fallback program.** It's the default program below. It runs when a program fails its check, when the watchdog trips, or when System 2 is unavailable. Changing it takes a reviewed commit, never an in-episode edit. This replaces [[layers]]'s "small fixed base context".

## The default program
The smallest scaffold that should work before System 2 tunes anything. It's the baseline every program has to beat.

- **Encoder (`egocentric`):**
  - the bot's own status: health, food, held item;
  - up to 8 entities within 16 blocks, as stable handle, type, *named* distance and direction ("close, ahead-left"), closing speed, and held item;
  - each channel's current behavior and its status;
  - a ~5 s event window;
  - the directive.

  Distances and directions are named buckets computed in code. Jev's vendor lists numbers as a weak spot ([[jev-measurements]]). **There's deliberately no terrain map:** `navigate` handles terrain, and whether System 2 adds a map when bridging fails is a direct test of this design.
- **Questions:**
  - one Choice per channel for single-channel behaviors, plus one joint `body` Choice for whole-body ones (`collect`), with options = allowed behaviors × encoded targets, plus `keep_current` to stop churn. Body answers are applied first, and a body start wins its channels for that call ([[seed-behaviors]]). Option order is shuffled per call, and the order is traced, because the order changes answers ([[jev-measurements]]);
  - one `escalate` Noul.
- **Triggers:** behavior events (`done`, `stuck`, `blocked`, `vetoed`, `target_lost`), damage taken, a hostile entity within 6 blocks, a new directive, and a 1 s heartbeat.
- **Escalation:** confidence below 0.5 on any question, `escalate` above 0.5, or a typed escalation event from code.

## How programs are compared
From cheapest to most realistic:
1. **Replay.** Run a program's encoder and questions on recorded raw states, and score how often Jev agrees with System 2's own careful choice on the same state. Those labels come from a paused world on the eval server. This is search labelling the fast policy, as in AlphaZero, done through context instead of weights ([[fast-slow-agents]]).
2. **Scenario A/B on the eval server.** RCON resets, the same scenario, N runs per program.
3. **Live windows by program version,** with virtual SQL grouped by `jeeve.program.version` and directive type ([[trace-schema]]). Signals:
   - directive completed, and how fast,
   - deaths and damage taken,
   - vetoes, `stuck` events, escalation rate,
   - churn: a choice reversed within a second,
   - cost, and how stale the state was when the answer arrived.

   This tier is noisy and confounded. It's a guardrail, not a judge.

These are tools System 2 can use and a record to search later, not gates. Outcome signals for open-ended objectives are still roadmap stage 4.

**Replay needs raw state in the trace.** Each `decide()` span logs a compact raw snapshot (entities, inventory, the bot's own status, events, a 16³ block cube) besides the encoded text. The estimate is ~15 KB raw, or ~2–4 KB compressed, per decision. That's ~10–25 MB/h compressed per bot at 1–3 decisions/s, about 1–5× the encoded text we log anyway. To save more, log the block cube only when it changes. The span schema is in [[trace-schema]].

## First implementation (2026-10-10)
A first slice runs in `src/`. It has:
- the default program, and `decide()` against Jev;
- three channels (legs, aim, hands), with the merged seed set from [[seed-behaviors]]: `navigate`, `follow`, `track`, `attack_when_ready`, and whole-body `collect`;
- both guard layers;
- whispers as the instruction channel;
- JSONL traces with raw snapshots.

`npm run e2e` starts a local Paper 1.21.4 server, the agent and a scripted player. All three milestone instructions pass, and two runs in a row gave the same results:

| Instruction | Time |
|---|---|
| "come here" | ~3 s |
| "collect 10 logs" | ~18–20 s |
| "follow me" | ~3 s |
| "defend me", against a summoned zombie | ~4–5 s, no damage taken |

Per decision: p50 ~110 ms, ~1.1k input tokens, ≤10 ms to encode (the budget is 20 ms), and ~3 KB of trace.

What it taught us:
- **Options must not overlap.** On an idle channel, `keep_current` and `stop` mean the same thing, and Jev split ~50/50 between them. A running `navigate:E0` offered beside `keep_current` split 0.56/0.44. Confidence is spread across options, so duplicates faked low confidence and caused 9 false escalations in 13 decisions. With duplicates removed by the option generator (`stop` only while something runs; the running option only as `keep_current`), that fell to 2 in 19. This is now a rule for every option generator, authored or built in.
- **Channels are coupled through the view.** The pathfinder steers by looking, so `track` yields to the legs while they move. That's the first concrete cross-channel rule from [[layers]].
- **Wrapped plugins have hidden state.**
  - `pathfinder.stop()` takes effect later, and the next `setGoal()` runs it immediately, wiping the new goal. collectblock's cancel leaves exactly such a stop behind, so a `follow` started right after `collect` silently never moved. Behaviors now flush a pending stop before setting a goal.
  - collectblock also skips any target the pathfinder's `Movements` says can't be broken, so with digging off it "succeeded" without collecting anything. Only its copy of the guarded config may dig, and a collect pass that collects nothing now reports `stuck` instead of looping.
- **Escalations on close calls.** About 17% of calls still escalate, mostly `keep_current` against a close alternative on aim. Whether 0.5 is the right threshold is a calibration question (Open questions).

Not yet built, and deliberately so:
- ~~**System 2**, activation checks and the watchdog.~~ Built 2026-10-11 ([[system-2]] → "Implementation"):
  - **Activation check:** `validate()`, plus an encoder dry run against 5× the encode budget.
  - **Watchdog:** 3 failed Jev calls among the first 10 after an activation roll the program back.
  - **Program versions:** the activation cause goes on the `program` span, so the default program has a stable hash.
- **Module authoring.** System 2 changes settings (guidance, allowed behaviors, heartbeat) but can't write encoders, checks or watch conditions yet. That needs a sandbox decision first.
- **The goal count in the gap.** System 2 sets the real check in ~5–9 s. Until it lands, `collect` counts the first number in the instruction. This is a marked stand-in.
- ~~**Guard vetoes in a live run.**~~ The e2e now makes one fire: a raw `forward` off a 5-block pillar is vetoed and the bot stays put.
- **The stance channel.**
- ~~**Judgment ingest.**~~ Built ([[trace-schema]] → "Implementation").

## Open questions
- **Order bias.** Is reversed-order averaging enough, or do programs need a full shuffle-and-average? It costs nothing in latency, since extra questions are free ([[jev-measurements]]).
- **Numbers vs. buckets.** Raw coordinates did as well as buckets on an easy near/far case. Harder spatial judgments haven't been tested.
- **Tail latency under load.** A 1.2 s outlier showed up with 16 calls in parallel. We still need p99 at real multi-bot load, measured from where the bots will actually run.
- **Calibration.** Jev's confidence hasn't been checked against System 2 labels, so the 0.5 escalation threshold is a guess.
- **One call in flight per bot or per decider.** Per bot until the numbers say aim needs a faster cadence than legs.
- **Module sandbox.** Is it the same restricted environment as behaviors? What CPU budget per tick is realistic in Node?
- **Rate limits.** TypeSafe says its limits "can change without notice". Multi-bot plans need a fallback model ([[decision-models]]).
