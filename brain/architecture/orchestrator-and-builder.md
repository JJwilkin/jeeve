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
- **AI SDK spans** come from `@ai-sdk/otel`'s `OpenTelemetry` integration on `Tracer.getOTELTracer()`, the path Luna uses. `enrichSpan` adds `judgment.session_id` and `jeeve.request.id` to each one. judgeval's tracer takes a span's parent from its own context, not OTel's global one, so `build()` runs the loop inside `JudgmentTracerProvider.getInstance().withContext(…)`. In e2e run 1, without it, the AI SDK's spans reached Judgment, but outside the builder trace.
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
- **`src/builder.ts`:** `build()`, the request, result and trial-report types, and 2B's prompt, which embeds `API_DOC` from `src/behaviors.ts` (the full player action API, generated from its tables by [[full-player-action-api]]).
- **`src/system2.ts`:** `request_capability` replaces `write_behavior`. 2A's prompt no longer carries the action API, so its cached prefix is smaller.
- **`src/main.ts`:**
  - the request queue (`request`, `cancelRequest`, `dropStaleRequests`, `pumpRequests`);
  - the trial port and the window gate (`trialPort`, `tickTrialWindow`, `TRIAL_WINDOW`);
  - `startTrial` now takes its target and `pass_when` from the request;
  - 2A's context lists the requests in flight and their state.
- **`npm run check`** drives `build()` with the AI SDK's mock model: it trials until one passes, then stops.

## First results (e2e, 2026-10-11)
The e2e's canopy scenario now runs right after "collect 10 logs", so it's the first instruction that needs a new behavior (the scratch library starts empty). A zombie is summoned once 2A has requested a behavior. The craft and chest scenarios from [[full-player-action-api]] also go through 2A → 2B now.

**Run 4 (E2E PASS, all 58 checks; 2B on Opus 5.5 at `high`). Runs 6 and 8 passed again after the fixes below (59 checks in run 8):**
- **Canopy.**
  - 2A first let Jev collect what it could, then requested `need: "break leaf blocks that are too high to reach from the ground … build up a pillar"`, with its own check that no leaves were left near the spot.
  - "working on it" came 71 s after the instruction. The call that made the request took 21 s.
  - While 2B wrote code, Jev killed the zombie in 11 s, and 2A answered two escalations in 3–6 s.
  - No window opened while the zombie lived. The window opened 41 s after it died.
  - `pillar_up_and_clear@1` passed its first trial, 61 s from request to registration.
- **"craft a wooden pickaxe":** `targets: item`, with 2A's check that a wooden pickaxe is in the inventory. `craft_with_table@1` passed its first trial, 53 s.
- **"put your logs in the chest":** `deposit_in_chest@1` passed its first trial, 15 s.
- **In Judgment,** each builder trace links to its request span and holds `invoke_agent`, `step`, `chat claude-opus-5-5`, `execute_tool write_behavior` / `scan`, `perceive` and `trial` spans (6–22 per request, more with more trials).

**Earlier runs found:**
- **Run 1: leftover world state.** An old oak from earlier runs sat in range. Jev walked to it on the raw instruction, and 2A targeted it. The scenario now clears that area too.
- **Run 1: a passing trial was reported as cancelled.** It finished the goal, the goal's completion dropped the request, and the abort cut off the result. Now `build()` waits for a running trial when cancelled.
- **Run 1: the AI SDK spans weren't in the builder trace.** judgeval's tracer uses its own context; fixed with `withContext`.
- **Run 2: a different, valid check.** With a registered behavior that builds with logs, 2A chose a "no logs left in the trunk" check for the next tree over an inventory count. The perception check now accepts either.
- **Run 3: a test race.** The chest check read the action log before the run ended.
- **Run 7: trials use up what they consume.** Opus's first craft attempt turned the test's 4 logs into planks, then got `stuck`. The next two trials had no wood. 2B stopped after 3 trials and said why. 2A failed the goal and asked Josh for logs or a nearby tree. That's the failure path working. The e2e now gives 8 logs, so one bad attempt doesn't end the scenario.
- **Run S3 (Sonnet): a check with nothing to measure.** "2A keeps answering" ran the moment the zombie died, 6 s after the request, before anything had escalated. It now checks every 2A call during the build (all under 30 s, at least one).

**Most trials pass on goal completion.** 2A sets the goal's `done_when` to the same kind of check as `pass_when`. So the goal often completes while the trial runs, and the trial passes as `goal_closed`. The result then never reaches 2A as `capability_result`, because the request closes with its goal. That's fine for M1. A behavior that works only on its trial target is still possible, and the library curation loop should catch it.

**Opus 5.5 vs. Sonnet 5.5 for 2B** (same e2e, parallel runs, `JEEVE_BUILDER_MODEL`):

| Request | Opus 5.5 (runs 3, 4, 6, 7, 8) | Sonnet 5.5 (runs S1, S3) |
|---|---|---|
| Canopy (pillar up and break) | 1 trial in four runs (61–162 s); 3 trials in run 8 (178 s) | 3 trials each: 218 s, 141 s |
| Craft a wooden pickaxe | 1 trial in four runs (47–78 s). Run 7: failed after 3 trials, because the first trial used up the logs (see above) | S1: froze the agent (the sandbox bug below). S3: failed 4 trials, one spent on a `debug_probe` behavior. 2A read the `capability_result`, asked again, and the second request passed on its 4th trial (97 s) |
| Logs into the chest | 1 trial in every run (14–18 s) | 1 trial, 8 s |

**Opus stays the default:** 15 requests, 13 passing on the first trial. Sonnet needs more trials, and more live trials mean more time holding the body (and more materials used up). Sonnet's e2e failures outside 2B are the known defend-me weaknesses (a slime in S1, a death to the zombie in S3), not the builder's doing.

**Two runtime bugs older than the split, found by these runs:**
- **The sandbox could starve the event loop.** Sonnet's craft code recursed through recipes with crafts and walks that failed at once. Each entry into the realm was short, so the 20 ms limit never fired, but settling actions in microtasks never let a timer run, including the run's own time limit. The agent froze at 99% CPU for 20 minutes. Actions now settle with `setImmediate` ([[behaviors-and-guards]] → Sandbox).
- **The bot could spawn unheard.** `startAgent` created the bot, then awaited judgeval's `discoverSchema()`. When staging was slow (runs 5 and S2), the spawn fired during the await, before any handler was registered, and both runs sat idle. Every await now happens before the bot is created.

## Open questions
- **Trials aren't free.** A live trial consumes materials, food and tool durability, and a failed one can leave the next attempt with nothing (run 7). Should the trial gate also check that the inputs are still there, or should 2B be told the inventory each attempt starts with? Today 2B sees it only in the failed trial's evidence.
- **The window gate's thresholds** (8 blocks, 5 s, 3 pre-emptions) are guesses until traces show how often windows are refused or pre-empted.
- **A trial that keeps the body for minutes** (up to its 120 s limit) blocks Jev from the goal meanwhile. Should 2A be able to refuse windows for a goal that's time-critical?
- **Two capabilities for one goal.** One request per goal is the rule. A goal that needs two would chain them: the second request after the first result.
- **Model comparison for 2B:** two models over one run each is a small sample. Compare more runs, and other providers (the AI SDK makes that a config change), once the curation loop gives more requests to build.
- **Results that skip 2A.** When a trial finishes the goal, 2A never sees `capability_result`, so it never writes guidance for the new behavior. That's fine while the goal is done, but the guidance proposal (`usage`) is lost. Keep it in the library entry?
- **The gate's hostile test** uses Mineflayer's entity type. Damage attribution from the defend-me fixes (recent attackers) could replace it.
