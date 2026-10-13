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
Three pieces, each measured before the next.

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
- `tried` comes from the behavior `end` handler that already feeds `failedAt`.
- It's an encoder param (`memory: true`), so a program turns it on and off, and A/B is a program diff ([[system-1]] → "How programs are compared").

**2. Escalate on persistent doubt** (a code rule in `decide.ts`).
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

## Open questions for Joshua
1. **Order:** memory → persistent doubt → stages (only if needed), with the replay first. Agree?
2. **Should Jev write any state beyond its applied choices in v1?** Proposed: no. The stage pick comes in piece 3, and beliefs later.
3. **Headline metric:** fewer doubt-driven 2A calls, with pass, deaths and reaction as guardrails? Or is reaction quality the headline?
4. **How long outcomes live:** per instruction (proposed: a tree that failed in step 1 matters in step 3), or per step?
5. **Escalation thresholds** in the program (2A tunes them per goal), or fixed bounds like `switchDwellMs`?
