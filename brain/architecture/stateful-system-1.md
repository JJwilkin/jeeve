---
date: 2026-10-13
tags: [architecture, system-1, system-2, memory, escalation]
status: proposal
---
# Stateful System 1 (proposal)

**Status: proposal, for discussion with Joshua before any code.** Outcome of the design pass in [[tasks/stateful-system-1|stateful-system-1 task]]. It would refine [[system-1]] (the runtime and the default program), the "Time in decisions" section of [[overview]], and Jev's escalation rule in [[layers]].

Today System 1 is stateless: each Jev call sees one encoded state (status, entities, blocks, the channels, a 5 s event window, the directive and the current step's check) and answers again from scratch. Everything that has to outlive one call lives somewhere else: in code (the dwell, the whole-body hold, cooling targets, the plan walker) or in System 2's guidance. The proposal: give System 1 a small **working memory** rendered into every call, with one writer per slot. Then move three jobs down to it: **keeping a commitment, recovering locally, and deciding when doubt is worth escalating.**

## What the traces say today
Taken from the last 59 bench runs (random layouts, 2026-10-12, [[bench-hill-climb]]): 12,944 Jev calls and 725 2A calls.
- **2A is acting as Jev's working memory.** 410 of 725 2A calls (57%) were set off by `low_confidence` alone. In 271 of them 2A rewrote the program, nearly always the guidance, and in 129 it changed nothing. The notes read like reminders of state Jev can't keep:
  - "keep walking until at the place, then use clear_tall_tree on birch_log";
  - "keep_current while it runs";
  - "the legs question is ambiguous only because navigate is still running".
- **Jev's doubt is mostly "keep or switch?".** 21% of calls had a question under 0.5 confidence (legs 316 escalations, body 135, aim 120, hands 45). Among the doubtful answers, `keep_current` was the top pick 71% of the time.
- **Most doubt is one-off.** Of the 2,753 doubtful calls, 1,507 had the same question doubtful in at least 3 of its last 5 calls. Only 712 of those also changed their top pick (real dithering). 1,935 `low_confidence` escalations were already dropped by the no-repeat window and backoff.
- **2A time is a large share of a run.** Median 2A seconds per run against run time: orchard 83 of 184 s, forage 120 of 227 s, guard 61 of 125 s, workshop 55 of 75 s. 2A runs alongside the body, but the bench's "Open" list names the idle time while 2A thinks.
- **Code already holds most of System 1's state, one patch at a time:** the target-switch dwell (#8), "the running option stays `keep_current`" (#6), the whole-body hold (#20) and its exception under threat (#29), cooling for failed targets, the escalation backoff (#11), and the plan walker. Each fix was right on its own. Together they're an unnamed working memory that Jev can't see.

## What "stateful" means here
Jev stays a stateless model. "Stateful" means the **runtime** carries a small memory between calls and renders it into each state as plain sentences. Each slot has exactly one writer:

| Slot | Writer | Holds | Lives until |
|---|---|---|---|
| **Commitment** | 2A (exists today) | The goal and its check, **the plan's position (step k of n, this step, the next step)**, the step's place, guidance | Its goal node closes ([[system-2]] → "Program changes: scoped by goal") |
| **Intent** | Jev, only through its applied choices; code records them | Per channel: what's running, which decision started it and on what trigger, how long ago, and its progress trend. Later, the stage of the step (below). | The behavior ends, or the stage or goal changes |
| **Outcomes** | Code | This instruction's attempts: behavior × target → how each ended (`done`, `stuck`, `none_found`, `vetoed`, `target_dead`), how many times, how long ago; targets now cooling | The instruction's root goal closes |
| **Beliefs** (later) | Jev's Score/Noul answers, smoothed by code | E.g. per-entity threat. The output of a question, not text. | They decay (TTL), and close with the goal |

**Rules for the memory:**
- **Jev never writes text.** It writes only by choosing among options code listed. Free text is a weak spot ([[jev-measurements]]) and the poisoning path ([[llm-plays-pokemon]]).
- **Say facts as sentences, and ages and counts as words:** "started a few seconds ago", "failed twice on this tree". Rendering facts as sentences moved P(walk back) from 0.25 to 0.98 ([[jev-measurements]]).
- **Describe, don't instruct.** Write "you are clearing this tree with clear_tall_tree; it is making progress", not "keep doing it". The choice stays Jev's.
- **Small:** at most about 8 lines (~300 tokens) on top of today's ~1.1k. Context rot is a known Jev weakness.
- **Nothing in it outlives the instruction.** System 1 memory never crosses instructions or episodes. Lessons that do are 2A's, under [[system-2]]'s rule (evidence and an expiry).
- **It's traced.** The memory is part of the `decide` span's encoded state, so it can be replayed.

## Who does what
| Job | Today | Proposed |
|---|---|---|
| Keep a commitment across calls | 2A guidance; code's dwell and hold | **System 1:** the intent slot in view, plus a hysteresis rule kept in code |
| Order the work within one plan step (walk there, act, finish what's left) | 2A guidance, rewritten on escalations | **System 1:** the plan position and outcomes in view. Optionally, stages 2A writes and Jev moves through (piece 3) |
| Recover locally after `stuck` / `none_found` | Cooling, then the 2nd failure escalates | **System 1** picks the next alternative with the outcomes in view. **Code** escalates `options_exhausted` as soon as every offered target has failed, without waiting for `stalled` |
| Decide when doubt is worth a 2A call | Any question under 0.5 confidence, cut down afterwards by no-repeat and backoff | **System 1:** escalate on *persistent* doubt (piece 2), on Jev's `escalate` Noul with the commitment in view, or on typed events |
| Resume the task after a fight | Jev, from the event window and the directive | **System 1:** the intent slot keeps the interrupted behavior and target ("interrupted 4 s ago by E9") |
| Goals, plans, checks, allowed behaviors, guidance, speech, capability requests, failing a goal, lessons | 2A | **Stays with 2A.** It's still the only writer of commitments ([[project-sid]]'s bottleneck) |
| Advance plan steps | Code, on each step's check | Stays code. Jev never skips or reorders 2A's steps: that's a commitment change, so it escalates |

## Mechanisms considered
| Mechanism | Prior art | Verdict |
|---|---|---|
| **A. A rendered memory block** (commitment, intent, outcomes) | SIMA 2's Pro summary used as recurrent memory; Lumine's latest thought; Lyfe's 4–5-item working memory ([[realtime-game-agents]], [[project-sid]]) | **Recommended, first.** No new questions and no extra latency. It only changes the state. Code writes it, so it can't be poisoned. |
| **B. Escalate on persistent doubt** | Game-TARS adds reasoning only where the fast policy alone gets it wrong; the Pokémon harness ([[llm-plays-pokemon]]) found models don't notice they're stuck, so code has to | **Recommended, second.** A code rule over the decide stream, replayable on old traces at zero Jev cost |
| **C. Stages that 2A writes and Jev moves through** (an option graph per plan step) | DPT-Agent's FSM, which System 2 rewrites; PORTAL's behavior trees; Lyfe's options with cheap termination | **Third, only if A and B leave doubt about "which part of the step am I on?"** It's the FSM DPT-Agent found beats LLM controllers, with Jev deciding only at the judgment edges |
| **D. Beliefs from Score/Noul questions** (threat per entity, "is this step still possible here?") | PIANO's action awareness (expected vs. observed) | **Later.** Questions are free ([[jev-measurements]]), but damage attribution already covers threats. Add it when a trace shows a belief that's missing. |
| **E. Hysteresis and commitment rules** | Today's dwell (#8) and hold (#20, #29) | **Keep them, and show them.** Rules stay in code (physics-like, one right answer). The memory makes them visible to Jev, so it stops "fighting" a held option with low confidence. |
| F. A free-text scratchpad Jev writes | VideoGameBench's scratchpad (notes got overwritten) | **Rejected.** Jev can't generate text, and it's the poisoning path. |
| G. Jev reads 2A's partial reasoning | AgileThinker | **Deferred.** 2A's calls are short and event-driven, and its notes reach Jev as guidance anyway |

## Recommended design
*Measured live (see [Bench A/B](#bench-ab-2026-10-14)):* the moot filter ships; the memory didn't move doubt or 2A calls live, so it's opt-in. Three pieces, each measured before the next. *Revised by the replay (see [Replay results](#replay-results-2026-10-13)):* piece 0, ignoring doubt about moot answers, goes first. The memory keeps only `plan` and `doing`. Piece 2 was rejected.

**0. Don't escalate doubt about an answer that couldn't apply** (added by the replay; one line in `decide.ts`).
- Today `unsure` counts every Choice under the threshold, even one whose answer was `overridden` (a body start won its channels), `pinned` (a confirm look or a trial holds the channel), `held` or `dwell`. In the replay, 27% of doubtful calls were doubtful only about such answers.
- Count only questions whose answer could have been applied.

**1. The memory block** (encoder plus a small runtime store; no new questions).
```yaml
memory:
  plan: "step 2 of 4: clear the birch at the goal's place; next: the oak to the north"
  doing:
    body: "clear_tall_tree on birch_log, started a few seconds ago when you reached the place; logs left there: going down (5 → 3)"
    aim: "nothing (the body task holds it)"
  interrupted: "collect on oak_log, by a zombie (E9) 6 s ago; the zombie is dead now"   # only after an interruption
  tried: ["collect on oak_log at the first tree: stuck twice, the last a while ago (cooling)"]
  held: "the body task can't be swapped by one channel unless you are under threat"   # only while a rule applies
```
- The plan line comes from `root.plan` and `goals.status()`, which already exist.
- `doing` and `interrupted` come from the channel slots (`decidedBy`, `startedAt`) and the check's progress, sampled at each call.
- `tried` comes from the behavior `end` handler that already feeds `failedAt`. *Dropped by the replay:* the `tried` lines lowered agreement with 2A's labels, and `plan` + `doing` carried all of the gain.
- It's an encoder param (`memory: true`), so a program turns it on and off, and A/B is a program diff ([[system-1]] → "How programs are compared").

**2. ~~Escalate on persistent doubt~~** *Rejected by the replay:* it drops escalations 2A acted on at almost the same rate as ones it ignored, and 28 near damage. Kept below for the record.
- Today: any Choice under `confidence_below` escalates.
- Proposed: a question escalates `low_confidence` only when it was doubtful in **k of its last n calls** (start at 3 of 5), *or* when its top pick changed back and forth among those doubtful calls (dithering), *or* when Jev's `escalate` Noul is above threshold.
- All bypasses stay: `fallingFast`, `owner_hurt`, the 2nd `stuck`/`none_found`, `stalled`, `idle`, `plan_done`.
- `k`, `n` and the dithering rule go in the program's `escalate_when`, so 2A can tighten them per goal. Code doesn't decide what a close call means.
- **Order debias for free:** a doubtful Choice is asked again, forward and reversed, in the same call (questions cost no extra latency). The two are averaged before the rule is applied. Debiasing is already an open question in [[system-1]].

**3. Stages (only if 1 and 2 leave doubt about sub-steps).**
- A `set_plan` step can carry `stages: [{ name, text, offer, exit }]`.
  - `offer` is a subset of the allowed behaviors.
  - `exit` is a check module, or `null` (Jev's call).
- Code shows the current stage in `memory.plan` and offers only that stage's behaviors, plus `keep_current`/`stop`.
- Exits:
  - with a check, code advances the stage;
  - with no check, a `stage` Choice over the next stages decides, with hysteresis: the same answer on 2 calls in a row, or confidence ≥ 0.7.
- Stages go through `set_plan`, which is its own tool, so the strict `submit_decision` grammar doesn't grow ([[orchestrator-and-builder]]).
- Steps without stages behave as today.

**Bitter-lesson check.**
- Every piece is a mechanism: a store, a renderer, a rule with program-set thresholds, and a stage container.
- No Minecraft knowledge goes in. What a stage is, what counts as "tried", and when to doubt are written by 2A or measured from outcomes.
- The one hand-made part is *which* facts the memory shows. That's encoder design, which [[system-1]] already makes swappable and comparable by replay.

## How to measure it
**Bench scenes** ([[bench-hill-climb]]), random layouts, memory on vs. off as two program versions (an env flag for the default program):
- **orchard:** sequencing inside steps. The bulk of the low-confidence calls were here.
- **forage:** search and local recovery (`plan_done`, `stalled`, `none_found`).
- **guard:** commitment against reaction. It must not get slower to react, and target persistence matters.
- **workshop:** a control. It has little System 1 judgment and should be unchanged.
- **Candidate new scene, "interrupted orchard":** a zombie wave mid-plan. It measures resuming after a fight without 2A.

**Metrics** (baselines from the 59 runs above):

| | Metric | Baseline |
|---|---|---|
| Primary | 2A calls per run set off only by Jev's doubt (`low_confidence`, `jev_escalate`) | ~8.4 per run (496 of 725 calls) |
| Primary | Share of Jev calls with a doubtful question | 21% |
| Guardrail | Pass rate | 58 of 59 |
| Guardrail | Median time to pass | orchard ~184 s, forage ~227 s, guard 125 s, workshop ~75 s |
| Guardrail | Deaths; Josh's damage in guard | Jeeve 0 deaths; Josh died in 1 of 12 guard runs |
| Guardrail | Reaction: first damage → attack started (guard, slime case) | measure (the [[system-1]] → Threats table is the prior) |
| Guardrail | Churn: a choice reversed within 1 s | measure |
| Cost | Jev input tokens per call; 2A seconds per run | ~1.1k tokens; 2A seconds as above |

A stateful System 1 is better if doubt-driven 2A calls fall by about half, with pass rate, deaths and reaction no worse. A faster orchard or forage time is the bonus.

## Risks
| Risk | Mitigation |
|---|---|
| **Stale memory.** The world changed, but the memory says "keep". | Every line carries its age. Intent ends with its behavior, and the plan line with its step. "Under threat" overrides the hold, as in #29. `interrupted` is shown as a fact, never as an order. |
| **Poisoned memory** | Code writes facts; Jev writes only applied choices; nothing outlives the instruction; 2A's commitments keep their goal scope |
| **Self-reinforcement.** Seeing "you chose X" makes Jev keep X forever. | Phrase it as a fact; `tried` shows the failures; watch churn *and* reaction time, since a sticky System 1 shows up as slower reactions in guard |
| **Fewer escalations hide real trouble** (the slime death) | Every bypass stays. Replay the new rule over old traces first: list every escalation it would drop that came within 10 s of a death, `owner_hurt` or `stalled`. |
| Position bias on a stage pick | ≤5 stage options, shuffled, forward and reversed in one call |
| Weak with numbers | Ages and counts as words; the progress trend said as "going down", not a series |
| Context rot | ≤8 lines; current instruction only |
| Trace volume | The memory is inside the encoded state already logged (+0.3–1 KB on ~3 KB per decision); stage changes are window events |
| 2A has more to write | Stages are optional; pieces 1 and 2 need nothing from 2A |

## First experiment: a replay, before any live code
Cheap and offline. It uses only recorded traces and Jev calls (~$0.05).
1. **Persistent-doubt counterfactual** (no Jev calls).
   - Run the 3-of-5 rule and the dithering variant over the 12,944 recorded decide spans.
   - Report how many `low_confidence` escalations would still go out, and list every one dropped within 10 s of a death, `owner_hurt` or `stalled`.
   - *First cut, already computed:* 1,507 of 2,753 doubtful calls are persistent, and 712 are persistent and dithering.
2. **Memory A/B on doubtful states** (Jev calls).
   - Sample ~200 doubtful decide spans, stratified by scene and question.
   - Rebuild the memory block from each trace's prefix: goal and plan spans, behavior spans and their ends, events.
   - Ask Jev each state twice (A: as recorded; B: plus the memory), each forward and reversed.
   - **Label:** the choice applied on that question at the first decide after 2A answered. If 2A changed nothing, Jev's original top pick is the label.
   - **Measure:** the share still under 0.5, agreement with the label, and flips under reversal.
3. **Go / no-go:** B cuts doubt by ≥40% at agreement no lower than A, and the counterfactual drops no escalation near a death. Then build pieces 1 and 2 behind a program flag, and run the bench, 3 rounds × 4 scenes, memory on vs. off.

Lives as `scripts/replay-memory.ts`. It reads `traces/*.jsonl` and `bench/results.jsonl`, and writes a short report.

## Replay results (2026-10-13)
`node --env-file=../judgment/.env.jeeve scripts/replay-memory.ts`, run over the 59 random-layout bench runs (traces in the `jeeve-monitor` worktree). It finishes in about 5 s, for under $0.05 of Jev calls. One run's samples and answers are in `bench/replay-memory-run1.json`. Flags: `--no-jev` (counterfactual only), `--conf`, `--keys` (memory ablation), `--n`, `--out`.

**1. Escalation counterfactual (no Jev calls).**
- Each rule is replayed over all 12,944 decide spans.
- A `low_confidence` escalation that was sent counts as kept if the rule fires in that run within 5 s of it, because a rule that waits for persistence raises the same doubt a call or two later.
- "2A acted" means 2A's answer changed anything.
- Baseline: 514 sent, 2A acted on 342 (67%). A rule is useful if what it drops is mostly escalations 2A didn't act on.

| Rule | Doubtful calls | Sent kept | Dropped: 2A acted / didn't | Dropped within 10 s of damage or `stalled` |
|---|---|---|---|---|
| Today (any question < 0.5) | 2,753 | 514 | — | — |
| **Ignore moot answers** (overridden, pinned, held, dwell) | 2,009 | 417 | **22 / 70** | 1 |
| Moot filter + threshold 0.4 | 1,248 | 337 | 73 / 95 | 9 |
| Moot filter + only doubt whose top pick is a change | 552 | 273 | 119 / 105 | 14 |
| Persistent: doubtful in 3 of the last 5 calls (p50 delay 1.0 s) | 975 | 212 | 166 / 111 | 28 |
| Persistent and dithering (p50 delay 1.1 s) | 341 | 140 | 221 / 125 | 38 |

- **The moot filter is the clean win.** What it drops is 76% "carry on" (base rate 33%), and only one drop is near damage.
- **Persistence doesn't separate useful escalations from the rest.** It drops what 2A acts on at nearly the base rate, and it delays the rest by about a second. Rejected.

**2. Memory A/B (Jev).**
- **Sample:** 200 doubtful questions from escalations 2A answered, stratified by scene and question. Moot ones were left out.
- **Arms:** A = the state as recorded. B = the state plus the memory rebuilt from the trace.
- **Calls:** each arm asked forward and reversed.
- **Label:** Jev's pick after 2A's answer. **181 of the 200 labels are `keep_current`.**

| | Doubtful (< 0.5) | Agrees with label | Flips under reversal |
|---|---|---|---|
| A (run 1 / run 2) | 79% / 78% | 69% / 68% | 21% / 22% |
| B: full memory (run 1 / run 2) | 66% / 65% | 72.5% / 71% | 18% / 15% |
| B: `plan` + `doing` only | 66% | 74% | 14% |
| B: `tried` + `interrupted` + `held` only | 72% | 65% | 22% |

- **Paired bootstrap (95% CI), full memory:**
  - doubt −13 points (−7 to −19);
  - confidence +0.05 (+0.03 to +0.08);
  - agreement +3 points (−0.5 to +7).
- `plan` + `doing`: doubt −14 points, agreement **+4 (+0.5 to +8)**.
- `tried` alone: agreement **−4.5 (−1 to −8)**. Listing failures pushes Jev away from carrying on.
- **By scene:**
  - guard improved most: agreement 65% → 80%, doubt 73% → 57%;
  - orchard: doubt 79% → 66% at equal agreement;
  - with a plan line: doubt 78% → 59%.
- **Go / no-go: no-go on the 40% bar.** Doubt fell about 16% relative, not 40%. Still, the gain is real, reproducible, free in latency, and comes with better agreement. So memory (`plan` + `doing`) goes in behind the moot filter. It isn't the fix by itself.

**3. What else the replay showed.**
- **Jev's confidence is informative.** It tracks agreement with 2A's label: 61% below 0.4, 74% at 0.4–0.5, 79% at 0.5–0.6, 85% at 0.6–0.8, 100% above 0.8. So the 0.5 threshold isn't arbitrary. The top probability tracks agreement the same way.
- **2A's answer to Jev's doubt is almost always "keep going"** (91% of the labels). What's left after the moot filter and the memory is mostly a real close call between carrying on and a near-duplicate option. One example: a running `clear_tall_tree:oak_log` against `clear_tall_tree:oak_leaves` on the same tree, which is the same tree-clearing run. That's the "options must not overlap" rule from [[system-1]], applied across targets. It's a lead for the option generator, not tested here.
- **Estimated effect of pieces 0 + 1:** doubt-driven escalations sent fall about 19% from the moot filter, then about 16% of the rest from the memory. That's roughly a third overall, not the hoped-for half. The bench A/B would measure the real number.

## Needs: what System 1 does when 2A hasn't asked for anything (2026-10-14)
Joshua's direction: the standing objective should be immediate, like a person meeting basic needs, not a distant root goal like "beat the game". Today, when a goal closes, code stops the channels. Jev's state then says "none yet: stay safe and wait", and it stands still (~5% of bench calls).

**Design.**
- **Code measures the needs** and states them as facts in a `needs` line. Hunger with whether there's food to eat, health, and threats now; night coming and missing tools later. It's measurement, like the other buckets: no strategy.
- **Jev meets a need when one behavior does it.** Eat what's in the inventory, fight or flee, gather what's in view. With no instruction, the directive says so ("no instruction: look after your needs") instead of "wait".
- **A need that takes a plan is a typed escalation.** "Starving and no food" needs finding, hunting or farming, which is 2A's job under the dividing rule in [[layers]].
- **Needs can interrupt a task,** with hysteresis: during a task, only a critical need does.
- **This is scaffolding** under [[overview]]'s rule. The needs guidance lives in the pinned default program, and it has a baseline to beat (today's idle bot). 2A can rewrite it per goal.
- **What it changes:** the guard scene stops being a test of learning to eat (bench gap #17, [[bench-hill-climb]]). There's no `eat` behavior yet either; only authored skills eat today.

**Replay** (`scripts/replay-world.ts --exp needs`, 2026-10-14):
- **States:** 40 idle and 40 mid-task recorded states, edited to be hungry, starving or fed. Bench runs nearly always have food and health "full", so the states had to be edited.
- **The `eat:bread` option** is offered on the hands question whenever there's bread.
- **Arms:**
  - A: today;
  - B: plus the `needs` line;
  - C: plus a needs line in the guidance;
  - D: C, plus the idle directive "no instruction: look after your needs" (not "stay safe and wait"), the hands question worded "(attacking, eating)" (not "(attacking)"), and "with every need met and no instruction, gather resources in view".

| Case (want) | A: today | B: + needs facts | C: + needs guidance | D: + wording fixed, gather |
|---|---|---|---|---|
| Idle, hungry, has bread (eat) | eats 0% | 33% (doubt 93%) | 50% (doubt 99%) | **100% (doubt 0%)** |
| Idle, fed, has bread (don't eat; gather) | no eat; gathers 0% | no eat | no eat | no eat; **gathers in 100% of the states where gathering was offered** |
| Idle, starving, no food (escalate) | 0% | 28% | **100%** | **100%** |
| Busy, starving, has bread (eat) | 1% | 40% | 58% | **76%** |
| Busy, hungry, has bread (open; the guidance says only when starving) | 0% | 3% | 6% | 28% |

- **Today Jev never acts on "food: low" in its self fields.** It has to be told the fact the decision turns on, which matches [[jev-measurements]].
- **The two wording conflicts mattered as much as the needs themselves.** "Stay safe and wait" and "hands (attacking)" pulled against eating. The default program's wording is part of the design.
- **With all four pieces, the defaults behave:**
  - it eats when it should, with no doubt;
  - it doesn't eat when fed;
  - it gathers when there's nothing to do;
  - it hands 2A what it can't fix.

**Shipped 2026-10-14** (Joshua: "ship the needs defaults and add an eat behavior", plus a walk-around behavior so an idle bot doesn't just stand there). See [[system-1]] → Needs. Arm E of the replay is the shipped wording, with `wander` and `glance` offered:
- idle and fed: walks and looks around 100%;
- idle and hungry: eats 100% and doesn't wander;
- mid-task: never wanders.

Gathering when idle was held back: it breaks blocks unprompted.

## Space and time: objects, not voxels or frames (2026-10-14)
Joshua asked for object permanence (several seconds of what Jev has seen) and how to represent 3D space plus time efficiently.

**Design.** Code does the geometry, and Jev gets the conclusions: a short list of **objects** (AlphaStar's entity tokens, [[spatial-models]]), not a voxel grid or stacked frames.
- **Stable IDs for block clusters,** like entity handles ("T2"). The clusters are 2A's `seen_map` clusters (a tree is one cluster). The same thing keeps its ID across calls, so permanence is built in.
- **Relations instead of coordinates:** distance bucket, direction, height span, in view or remembered.
- **Time as change, not frames.** Each object carries:
  - its age ("last looked a few seconds ago");
  - its trend ("closing", "going down");
  - its events (appeared, gone, hit you).
- **A budget.** About 10–15 objects ranked by goal relevance, threat and novelty, at ~25 tokens each.
- **Entities already have permanence.** The server sends them through walls, so a mob left Jev's list and came back within 15 s only 3 times in 12,944 calls. If a line-of-sight filter is added for fairness, a "last seen" entry is needed.

**Replay** (`--exp objects`, 2026-10-14, two runs):
- **Sample:** 200 doubtful orchard, forage and workshop questions 2A answered, with the same labels as the memory replay.
- **Arms:**
  - A: today's block list (types within 8 blocks);
  - B: objects in its place;
  - C: B with compass directions for anything 16 or more blocks away;
  - D: today's list, plus only the remembered objects beyond it.

| Arm (Δ vs A, paired, 95% CI) | Doubt | Agreement: body | Agreement: legs, aim, hands |
|---|---|---|---|
| B: objects | **−8.5 to −10.5 points** (CI within −3 to −16) | **−7.6 to −8.3** (CI excludes 0) | +3 to **+7** (run 2 CI +2.7 to +11) |
| C: objects, compass when far | −9 | −8 to −10 | +2 to +5 |
| D: today's list + remembered far objects | −1 (n.s.) | −2 (n.s.) | +2 (n.s.) |

The state grows from ~310 to ~390 tokens.

- **The object form helps, but distant memory doesn't** (in these labels). Clusters with heights and IDs cut doubt, and they help the single-channel questions. Adding what's remembered beyond 8 blocks changed nothing. The labels are 90% "keep going", which doesn't depend on far things. A search scene (forage before it finds trees) would be the test for that.
- **The body question gets worse because the options and the state now use different words.** The state names objects (T2), but the body's options still name block types ("clear_tall_tree:birch_log(6)"). [[jev-measurements]] already found Jev needs the options in the state's words.
  - The fix is options per object ("clear_tall_tree:T2"), which changes block behaviors to take a cluster instead of a type.
  - That's a design change to the option generator and the behavior targets, so it needs its own replay before building.
- **Compass directions don't help** at this distance.

**Where this leaves the design:** objects in place of the block list, but only together with per-object options for the body question. Distant memory waits for a search-scene test.

## Bench A/B (2026-10-14)
Pieces 0 and 1 were built (commit `5bac02c`): the moot-answer filter (`escalate_when.ignore_moot`), and the memory (`plan` + `doing`, an encoder param, rendered by `describeMemory`).
- **Arms:** one switch turned both off.
- **Layouts:** both arms ran side by side on the same layouts (`JEEVE_BENCH_SEED`), 3 rounds × orchard, workshop, guard and forage.
- **Library:** each arm started from its own copy of the same library snapshot.
- **Report:** `node scripts/ab-report.ts 5bac02c`.

| Paired, 12 pairs | Off | On | On better / worse |
|---|---|---|---|
| Pass | 12/12 | 12/12 | 0 / 0 |
| 2A calls set off only by Jev's doubt, per run | 7.2 | 6.8 | 4 / 4 |
| Jev calls with a doubtful answer | 34.5% | 31.5% | 8 / 4 |
| Time to pass | 140 s | 146 s | 4 / 5 (workshop −26 s in 3/3; orchard +27, forage +19) |
| Deaths; reaction from a hit to attacking | 0; ~same | 0; ~same | — |

**What it says:**
- **The moot filter works as designed.** Low-confidence escalations sent fell 81 → 68, and suppressed ones fell 309 → 155. It costs nothing, and it stays on.
- **The memory has no measurable live effect.**
  - Calls with a doubtful answer: 26.2% → 25.2% during plan steps, 22.4% → 19.5% under an instruction with no plan.
  - The replay's −13 points held on the hard states it sampled (doubtful, escalated, answered by 2A), not across all states.
  - So the memory is now **opt-in** (`JEEVE_MEMORY=1`). It stays as the substrate for the next memory layer (objects); delete it if that doesn't earn its place either.
- **A suspect, cleared.** During plan steps, the escalate Noul went over 0.5 in 9.8% of calls with memory, against 2.9% without. Replaying 150 of the "on" arm's own plan-step states with the memory removed gave 8.0% without and 6.0% with (`scripts/replay-noul.ts`). The live gap came from the two arms visiting different states, not from the memory's words.
- **Why 2A calls barely move: they're capped by the gate, not the doubt rate.** Raised doubt escalations outnumber the ones sent 4–5× (off: 81 + 25 sent, 541 suppressed). The no-repeat window and the backoff let roughly one through per reason, goal and window. Cutting the doubt rate by 10–20% doesn't change that. Fewer 2A calls needs either:
  - doubt that disappears entirely for a goal, or
  - a different gate: e.g. escalate low confidence only when the top pick would *change* what's running, or let the backoff learn faster.

  That's the next experiment, and the counterfactual harness (`scripts/replay-memory.ts`) can score a new gate on old traces first.
- **n = 3 pairs per scene.** The time differences are within run-to-run noise. Pass rate, deaths and reaction are the guardrails, and none moved.

## Open questions for Joshua
1. ~~**Order:** memory → persistent doubt → stages~~ After the replay: moot filter → memory (`plan` + `doing`) → bench A/B. Persistent doubt is dropped. Stages wait until the bench shows doubt about sub-steps. Agree?
2. **Should Jev write any state beyond its applied choices in v1?** Proposed: no. The stage pick comes in piece 3, and beliefs later.
3. **Headline metric:** fewer doubt-driven 2A calls, with pass, deaths and reaction as guardrails? Or is reaction quality the headline?
4. ~~**How long outcomes live**~~ Moot for now: the `tried` lines hurt in the replay, so outcomes stay in code (cooling, the 2nd-failure escalation) and out of Jev's view.
5. **Escalation thresholds** in the program (2A tunes them per goal), or fixed bounds like `switchDwellMs`?
6. **Near-duplicate options across targets** (the same whole-body skill on logs vs. leaves of one tree): worth a replay of its own?
7. ~~**Needs:** ship the needs defaults?~~ Shipped 2026-10-14, except gathering when idle: it breaks blocks unprompted (the e2e's and bench's trees before their instruction; griefing on a shared server). Ship it anyway, behind a per-context setting, or leave it to 2A?
8. **Objects:** worth the per-object option change (block behaviors target a cluster, not a type)? It's the condition for objects not hurting the body question.
