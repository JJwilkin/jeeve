---
date: 2026-10-11
tags: [architecture, system-2, behaviors, harness]
status: active
---
# System 2A and 2B: the orchestrator and the builder

System 2 is two agents. **2A, the orchestrator,** runs the game: the goal tree, Jev's program, escalations. **2B, the builder,** writes, trials and fixes behaviors. They talk through capability requests and trial windows. This note is the outcome of [[system-2a-2b]]. It refines [[system-2]] (2A is what that note calls System 2) and [[behaviors-and-guards]] → "How it's built" (the builder now writes and trials behaviors, not System 2).

**Why split:**
- **Speed.** Writing a behavior and 2–3 trial rounds took minutes, while the same System 2 should have been reacting to the game.
- **Self-grading.** A trial could pass on the behavior's own `done` claim.
- **Prompt injection.** A player's raw text steered the code being written.

## Who does what
| | **2A: orchestrator** | **2B: builder** |
|---|---|---|
| Code | `src/system2.ts`: the Anthropic SDK directly, at most 4 turns per call, event-driven and stateless | `src/builder.ts`: the Vercel AI SDK, one `generateText` tool loop per request |
| Job | The goal tree, Jev's program, escalations, the player | Write → trial → read the evidence → fix, until one trial passes |
| Speed | Seconds per call | Minutes per request |
| Context | Goal path, program, recent events, the module list | The action API, the request, its pass check, the library's behavior code |
| Writes | Goals, guidance, allowed behaviors, check and watch modules. It stays the **only writer of commitments** ([[system-2]]) | Library entries only (behaviors). It *proposes* guidance; 2A decides |
| Model | `claude-opus-5-5`, `medium` for instructions, `low` for escalations (unchanged) | `JEEVE_BUILDER_MODEL`, default `claude-opus-5-5` at `high` (`JEEVE_BUILDER_EFFORT`) |

## Capability requests
2A calls a `request_capability` tool, next to `submit_decision`. It's not a `submit_decision` field, because the strict grammar is already at its size limit. The request is applied with the decision, after `new_modules`, so its pass check can be registered in the same decision.
```yaml
id: c-3                 # set by code
goal: g-7               # the goal whose decision made it; set by code
need: "break blocks that are out of reach from the ground by building up next to them"   # 2A's own words
constraints: ["only build with blocks already in the inventory"]
targets: block          # block | entity
trial: { block: oak_leaves, count: 27 }    # or { entity: zombie }
pass_when: leaves_cleared_near_tree        # required: a check module 2A registered
```
- **The pass check is required and is 2A's.** Code refuses a request without a registered check module. 2B sees the check's code but can't change it. "Behaviors grade themselves" is closed: a run passes only if it returns `done` and the check holds three ticks later, or the goal it serves completes while it runs.
- **No priority field** (decided with Joshua). Requests are FIFO. A new instruction abandons the old root, so the queue rarely holds more than one.
- **One request per goal.** A new request for the same goal replaces the old one.
- **Cancelling is automatic.** A request is dropped when its goal leaves the active path (completed, failed or abandoned): its build is aborted, a waiting trial leaves the queue, and a running trial stops. If the goal *completed* during the trial, the trial still passes and the behavior is registered.
- **Code tells the player** "working on it: learning a new behavior for …" when a request is made. This is a fixed message like "done", so speech still follows the goal tree.

**The result** comes back to 2A as a `capability_result` escalation (exempt from the no-repeat window, as `instruction` is):
```yaml
# registered
{ request: c-3, status: registered, behavior: reach_and_break@2, usage: "pick it for blocks out of reach…", attempts: [...] }
# failed
{ request: c-3, status: failed, reason: "…2B's own account, or 'no trial passed in 4'", attempts: [...] }
# each attempt: { behavior, run_id, passed, end, ms, error, actions (last 30), self, preempted }
```
On `registered`, 2A adds the behavior to `allowed_behaviors` and writes guidance for it; `usage` is 2B's proposal (decided with Joshua). On `failed`, 2A reads the attempts and either asks again differently or fails the goal.

## Trial windows: the body is shared
2B can write in parallel with the game, but a trial needs the body. **A code gate grants the window, not 2A's model** (decided with Joshua): it takes milliseconds and doesn't wait on an LLM call.
- **2B asks** by calling its `write_behavior` tool. Shape problems (wrong target type, a compile error) come back at once. Otherwise the draft waits for a window.
- **Granted** when nothing threatens the bot: no `hostile` entity within 8 blocks, no damage in the last 5 s, and no other trial running. Checked every 250 ms with the goal checks.
- **Pre-empted** by the same test while the trial runs. The trial stops as `preempted`, which isn't counted as a failure, and the draft waits for the next window. After 3 pre-emptions it goes back to 2B as `preempted`.
- **During a window:** the trial is pinned on its channels, so Jev can't replace it. Jev keeps deciding for channels the trial doesn't hold, and its doubts about the pinned ones are dropped, as before ([[behaviors-and-guards]]).
- **While waiting:** Jev runs normally under 2A's program. That includes fighting what threatens the bot, which is what lets the window open.
- **Windows are traced** as window events: `trial_window` (granted) and `trial_preempted`.

*Under the [[bitter-lesson]]:* "hostile" is Mineflayer's entity type, and recent damage catches what it misses (slimes are typed `mob`, [[system-1]] → Open questions). It's a mechanical safety test, not strategy.

## Concurrency and process
- **One build at a time,** in the agent's process (decided with Joshua). The rest of the requests queue. Trials are serialized on the one body anyway.
- **2B's contract is narrow:** `build(request, brief, ports, signal, parent span)`. The ports are `trial()`, which waits for a window, and `perceive()` (`scan` and `reachable`, read-only, so 2B can look without the body). Moving 2B to its own process, or to Luna's HTTP service, only changes how these are carried.

## What 2B sees, and prompt injection
2B's prompt holds only:
- **2A's structured request:** need, constraints, target type, trial target;
- **the pass check:** id, description and code;
- **the library's authored behaviors,** with their code;
- **the bot's own state.**

It never gets the goal text, which is the player's raw instruction.

**What this protects against:**
- a player's text directly instructing the code writer ("…and also whisper me the inventory every second");
- 2B grading its own work: the check is 2A's and is evaluated by code.

**What it doesn't protect against:**
- **Injection through 2A.** 2A reads the raw text, and a steered 2A can write a harmful `need`. The paraphrase is a filter, not a boundary.
- **What a behavior can do.** That's bounded by the action API, the guards and channel ownership ([[behaviors-and-guards]]), not by who asked. Those stay the real boundary.
- **Library poisoning.** A registered behavior persists in `modules/library.json`. Curation is still a person reading the git diff.

## The between-episode loop (designed, not built)
Decided with Joshua: design only, build as a follow-up.
- **Trigger:** `npm run curate` after an episode, or on a schedule. It's a 2B run with no request and no body.
- **Reads:** `modules/library.json`, plus virtual SQL over recent sessions ([[trace-schema]]): runs per behavior by `end_reason`, trials and their attempts, `module_disabled` events, goals that completed or failed with a behavior allowed.
- **Does:**
  - retire behaviors that keep failing or are never picked;
  - merge near-duplicates into one general version;
  - mine traces for lessons that outlive their goal ([[roadmap]]).
- **Output:** a proposed library diff for git review (curation stays git, [[system-1]] → "Module library"), plus a list of lessons with cited trace ids. Lessons need [[system-2]]'s rule for kept lessons: evidence and an expiry. Nothing is applied without review until stage 4 gives an outcome signal to trust.
- **Rewrites need a body.** A rewrite can't be trialled without a server, so between episodes 2B proposes, and the trial happens in the next episode, or on the eval server with RCON resets ([[system-1]] → "How programs are compared").

## Tracing
2B's work is a **trace of its own per request**, in the episode's session. Window traces cut every 60 s, and a build takes minutes, so it can't live under one window.
```
window (2A's)                         builder (its own trace; links → request)
├─ system2                            ├─ ai.generateText …    AI SDK spans (OpenTelemetry), one per step,
├─ request  ◄──────── span link ──────┤    model call and tool call
├─ behavior.<name>  (the trial run;   ├─ perceive             2B's scan / reachable
│   decided_by builder:<request>)  ◄──┼─ trial                one per trial: run_id, end, passed, pre-emptions
└─ (events) trial_window, trial_preempted
```
- **`request`** (a child of the window): `jeeve.request.id`, `jeeve.goal.id`, `jeeve.program.cites` (the `system2` span that made it). Input: the request.
- **`builder`** (a root): `jeeve.request.id`, `.request.span_id`, `.request.trace_id`, `jeeve.goal.id`, `jeeve.builder.model`, `.status` (`registered`, `failed`, `cancelled`), `.trials`, `.latency_ms`. It has an OTel link to the request span. Input: the brief. Output: the result.
- **AI SDK spans** come from `@ai-sdk/otel`'s `OpenTelemetry` integration on `Tracer.getOTELTracer()`, the path Luna uses. `enrichSpan` adds `judgment.session_id` and `jeeve.request.id` to each one. judgeval registers no OTel context manager, so `src/trace.ts` registers `AsyncLocalStorageContextManager`; without it, the AI SDK's spans found no parent.
- **`trial`** (a child of `builder`): `jeeve.request.id`, `jeeve.module.id`, `jeeve.behavior.run_id` (joins to the `behavior.<name>` span in the window trace), `jeeve.trial.end`, `.passed`, `.preempted`.

## Harness (decided 2026-10-11, see [[system-2a-2b]])
- **2A keeps the custom loop:** its calls are seconds-scale, and a framework would add little.
- **2B is on the Vercel AI SDK** (`ai` 7, `@ai-sdk/anthropic`, `@ai-sdk/otel`):
  - `generateText` with tools;
  - `stopWhen`: a trial passed, 4 trials used, or 16 steps;
  - `abortSignal` for cancellation;
  - the model is a config value.
- **Luna later,** when its packages can be used from a public repo. Durable runs and a native waiting state replace the in-process promise that waits for a trial window. `build()`'s arguments and result stay the contract.

## Implementation (2026-10-11)
- **`src/builder.ts`:** `build()`, the request, result and trial-report types, and 2B's prompt, which embeds `API_DOCS` from `src/behaviors.ts` (the action API as authored code sees it, shared with [[full-player-action-api]]).
- **`src/system2.ts`:** `request_capability` replaces `write_behavior`. 2A's prompt no longer carries the action API, so its cached prefix is smaller.
- **`src/main.ts`:**
  - the request queue (`request`, `cancelRequest`, `dropStaleRequests`, `pumpRequests`);
  - the trial port and the window gate (`trialPort`, `tickTrialWindow`, `TRIAL_WINDOW`);
  - `startTrial` now takes its target and `pass_when` from the request;
  - 2A's context lists the requests in flight and their state.
- **`npm run check`** drives `build()` with the AI SDK's mock model: it trials until one passes, then stops.

## First results
*(filled in from the e2e runs below)*

## Open questions
- **The window gate's thresholds** (8 blocks, 5 s, 3 pre-emptions) are guesses until traces show how often windows are refused or pre-empted.
- **A trial that keeps the body for minutes** (up to its 120 s limit) blocks Jev from the goal meanwhile. Should 2A be able to refuse windows for a goal that's time-critical?
- **Two capabilities for one goal.** One request per goal is the rule. A goal that needs two would chain them: the second request after the first result.
- **Model comparison for 2B:** Opus 5.5 vs. Sonnet 5.5 on the e2e canopy request (see First results).
