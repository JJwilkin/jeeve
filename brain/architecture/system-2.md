---
date: 2026-10-10
tags: [architecture, system-2, goals, first-milestone]
status: active
---
# System 2 and goals

How System 2 owns the goal tree, how an instruction from outside becomes a goal with a success check, how System 2 changes System 1's program, and how escalations reach it. Scoped to the first milestone ([[layers]]): a local server, instructions given from outside. This note is the outcome of [[system-2-and-goals]]. It makes the goal hierarchy in [[overview]] concrete, and it settles a contradiction between [[learning]] and [[system-1]] ([Program changes](#program-changes-scoped-by-goal)).

Judges and the outer loop's reward signal are still roadmap stage 4 ([[roadmap]]).

## The goal tree
```yaml
id: g-4                  # per episode, counts up
parent: null             # null = root = the latest instruction
text: "collect 10 logs"
from: { player: Josh, via: whisper }      # roots only
status: active           # active | suspended | completed | failed | abandoned
done_when: { module: inventory_delta@1, params: { match: "*_log", count: 10 } }   # null = open-ended
escalate_if: [{ module: entity_alive@1, params: { player: Josh }, negate: true }]
budget_ms: 300000        # open-ended goals: a review interval instead
program: v-9f2c          # the System 1 program pushed with this node
log: [...]               # kept while active
summary: "..."           # one line, written on close
```
- **The root is the latest instruction** ([[layers]]). A new instruction marks the old root and everything under it `abandoned`.
- **Only System 2 writes nodes.** It's the single writer of commitments, PIANO's bottleneck ([[project-sid]]). Code changes a node's status only for mechanical reasons:
  - the check passed → `completed`,
  - a new instruction arrived → `abandoned`.
  
  A budget running out or an `escalate_if` firing doesn't change status: it escalates, and System 2 decides.
- **Expansion is lazy** ([[overview]]). System 2 adds children when it reaches a node, not all at the start. The three M1 instructions are one-node trees: `collect`, `navigate` and `follow` cover them without breaking them down.
- **Interrupts push and pop.** System 2 pushes a child, and the parent becomes `suspended`. When the child closes, the parent resumes. **Program versions stack with the goals:** each node carries the program pushed with it, and closing a node restores its parent's program.
- **When Jev picks a fight (`track` + `attack_when_ready`, [[seed-behaviors]]), that's behavior runs, not a node.** They show up as `behavior.*` spans under the active goal. Interrupt nodes are for what needs its own check or plan, e.g. "get away from the creeper" or "eat". Those come from System 2 when it handles an escalation. This refines [[overview]]'s "⚡ fight" example.
- **Summaries roll up.** When a node closes, its one-line summary goes into its parent's log. A closed root's summary goes into the episode's list of past instructions. System 2's context is the active path with its logs, plus that list, plus the latest window summaries. That keeps it far below the ~100k tokens where long-context agents start looping ([[llm-plays-pokemon]]).

## Success checks are code; choosing them is System 2's job
- **A check is a module** of the same kind as System 1's watch conditions ([[system-1]]): a predicate over raw state. A check can also report progress `{ have, want }`, which is shown to Jev and in status replies. Values like a starting inventory count are captured when the node is pushed.
- **Built-in checks:**
  - `near_entity(target, r)`
  - `inventory_delta(match, count)`
  - `entity_alive(target)`

  System 2 picks a check and fills in its values, and can write new ones through the module pipeline (write → sandbox → trial → register → version, [[behaviors-and-guards]]).
- **The runtime evaluates checks every tick,** so neither model is called to ask "am I done?". This is Lyfe's cheap termination ([[realtime-game-agents]]).
- **Under the [[bitter-lesson]]:** the checks are generic predicates. The Minecraft knowledge lives in the values System 2 fills in, e.g. "logs" means `*_log`. [[gitm]]'s typed goals `(object, count)` are one case of this.
- **Every goal can be falsified** ([[llm-plays-pokemon]]): either a `done_when` plus a budget, or, for an open-ended goal, a review interval.

**Open-ended goals** such as "follow me and defend me" have no `done_when`. They end only when a new instruction arrives. Instead they have:
- **`escalate_if` predicates** that call System 2 when something's measurably wrong, e.g. the player is more than 12 blocks away for 10 s, or the player died;
- **a review interval** in place of a budget. System 2 reads the node's log and renews or changes it: a critic on a timer ([[llm-plays-pokemon]]). This is where a stage 4 judge will score the goal.
- **Measurable side signals in the trace,** for stage 4 later: the protected player's damage (window event `owner_damage`), fights, and time out of range.

## Taking instructions
Two channels, handled the same way:
- **In-game whispers** from allowlisted players. The allowlist check is code.
- **A local API** bound to `127.0.0.1` (`node:http`):
  - `POST /instructions {from, text}`: operator access, so there's no auth beyond being local;
  - `GET /status`: the active goal path, progress, and the last few closed instructions.

**When an instruction arrives, code does this right away:**
1. Abandons the old root.
2. Creates the new root with `text` and `from`, and no check yet.
3. Cuts the window (a root-goal boundary, [[trace-schema]]).
4. Hands Jev the raw text as its directive, so the bot starts moving within about a second.
5. Acknowledges receipt ("on it").

**Then System 2 is called** and fills in `done_when`, `escalate_if`, the budget and a program, which takes 2–5 s. Jev acting on the raw text in the meantime is accepted. If traces show Jev misreading instructions in that gap, the fix is to idle until System 2 lands.

**Reporting back.** All speech follows the goal tree, so the bot can't say one thing and do another ([[project-sid]]).
- **On completion,** code whispers a fixed message ("done: collect 10 logs, 10/10"), with no model call.
- **For failures, refusals and clarifying questions,** System 2 writes the message.
- **Jev never speaks.**

## Escalations
**Where escalations come from:**

| Source | Escalations |
|---|---|
| Jev | Low confidence; yes to the `escalate` question ([[system-1]]) |
| Behaviors | `stuck`, `none_found`, `inventory_full` ([[seed-behaviors]]) |
| The goal | `budget_exceeded`, `review_due`, `escalate_if:<module>` |
| The game | `death` |

**How System 2 is called:**
- **One call in flight,** with escalations that arrive during a call merged into the next one, as in `decide()`.
- **No repeats:** an escalation with the same reason under the same program version is traced but not sent again, until the program changes or 30 s pass. Otherwise a low-confidence Jev means a Claude call per heartbeat.
- **The bot never waits.** The current program keeps running. If System 2 is down, the current program keeps running; the pinned fallback is only for programs that fail their check or trip the watchdog ([[system-1]]).

**What System 2 gets:**
- the escalation and the spans behind it,
- the goal path with its logs,
- the current program manifest,
- the last few window summaries,
- virtual SQL over its own traces ([[trace-schema]]).

**What it returns,** any of:
- a program change,
- a goal edit: push, fail, change a check, renew a budget,
- a message to the player,
- "carry on", with a reason.

## Program changes: scoped by goal
**The contradiction:** [[learning]] says every guidance update must cite evidence and expire. [[system-1]] says evidence is recorded, not required. Resolved as follows (decision below, for Joshua's review):
- **Citing is automatic.** System 2 only changes a program inside a `system2` span, and every such span is triggered by an instruction or an escalation. So every change cites at least that span (`jeeve.program.cites`), plus any trace and event IDs System 2 adds.
- **Expiry comes from the tree.** A change belongs to the goal node that made it, and reverts when that node closes. Guidance like "don't chase beyond 12 from Josh" lives exactly as long as "follow me and defend me".
- **Lessons kept past their goal need more.** For example, "Steve shields after 2 hits", carried into the next instruction:
  - they must cite trace or event IDs,
  - they carry an expiry (default: end of episode),
  - they're renewed only by citing evidence newer than the last citation.
  
  This is [[learning]]'s rule, applied where poisoning actually happens: beliefs that outlive the situation that produced them.
- **Structural changes keep [[system-1]]'s rule.** New encoders, question layouts and modules carry a recorded reason, the mechanical checks and the watchdog. They don't expire, because "expiring an encoder" has no clear meaning. They're versioned and can be rolled back.

## Window summaries: written by code
The previous-window summary in `carry_over` ([[trace-schema]]) is a **structured summary written by code at the cut**:
- the goal path, and the goal status changes in the window,
- behavior runs counted by how they ended,
- deaths, damage, `owner_damage` and vetoes,
- escalations and what System 2 returned,
- the program versions in effect,
- System 2's latest note on the active goal, if any.

It's factual, needs no model call at the cut, and can't be poisoned. In the Pokémon runs, harness-written facts were the most reliable memory ([[llm-plays-pokemon]]). System 2 writes prose only where it already reasons: goal summaries and notes in the goal log.

## Traces
- **`jeeve.goal.path`:** `g-4:collect 10 logs > g-5:…`, set when the window opens.
- **`goal` spans:** one per status change. `jeeve.goal.transition` is one of `pushed | completed | failed | abandoned`. `popped` is gone, because a pop is just the child closing.
  - At intake, `pushed` carries the raw instruction. The check System 2 fills in is in that `system2` span's output.
  - A closing span's output is the check result and the one-line summary.
- **New window event:** `owner_damage`, for the player an open-ended goal protects.

## The three instructions end to end
**"come here" (from Josh)**
1. Josh whispers, and the allowlist passes. Code creates root `g-1`, cuts the window, hands Jev the raw text, and replies "on it".
2. Under the default program, Jev already picks `navigate:Josh`.
3. System 2 sets:
   - `done_when: near_entity(Josh, 3)`, a 60 s budget,
   - `escalate_if: Josh not alive`,
   - a program allowing `navigate` and `stop`.
4. Josh is within 3 → code marks `completed` → the window is cut → Josh hears "done: come here" → the program reverts.
5. **On failure:** after `stuck`, Jev retries. A second `stuck`, or the budget, escalates. System 2 reads the `stuck` spans and either changes the program or fails the goal ("can't reach you: no path across the river").

**"collect 10 logs"**
1. Same intake, creating root `g-2`.
2. System 2 sets:
   - `done_when: inventory_delta(*_log, 10)`, counted from what's held now,
   - a 5 min budget,
   - a program allowing `collect`, `navigate`, `track`, `attack_when_ready` and `stop`, with guidance "fight only what threatens you".
3. Jev's state shows the goal at 6/10. The option generator offers `collect:oak_log(4)` from the check's progress.
4. A zombie comes within 6 blocks, so Jev picks `attack_when_ready` and `track` on it. Those are behavior runs under `g-2`. On `target_dead`, Jev picks `collect:oak_log(4)` again.
5. The check reaches 10 → `completed` → Josh hears "done: 10/10".
6. **If no logs are found:** two `none_found` events escalate. System 2 rewrites the guidance for this goal, e.g. "head north; window X saw a forest there", or fails the goal.

**"follow me and defend me"**
1. Root `g-3`, with `done_when: null`.
2. `escalate_if`: Josh more than 12 blocks away for 10 s; Josh not alive.
3. A 5 min review interval.
4. The loop runs as in [[seed-behaviors]]: follow, with `attack_when_ready:E7` + `track:E7` → `target_dead` → `track:Josh`. Here fighting is the task itself, and it's still a behavior run.
5. **At review,** System 2 reads `g-3`'s log (fights, `owner_damage`, time out of range) and renews the goal or tightens the program, e.g. adds a watch condition for chasing.
6. The goal crosses 60 s cuts. Each `carry_over` carries `g-3`'s path and the code-written summary. A new instruction marks it `abandoned`.

## Decisions to review
Taken on Joshua's "go with the recommendations" (2026-10-10). Each one can be revisited:
1. **Program changes are scoped by goal.** Only lessons kept past their goal need cited evidence and an expiry.
2. **Code writes the window summary,** not a model.
3. **Only System 2 pushes goal nodes.** Jev's fights are behavior runs.
4. **Jev acts on the raw instruction** during System 2's 2–5 s.
5. *(Made while writing this note.)* **Code changes status only for `completed` and `abandoned`.** A budget or `escalate_if` escalates rather than failing the goal directly, so failing is always System 2's call.
6. *(Made while writing this note.)* **Lessons kept past their goal expire at episode end by default.** Cross-episode lessons wait for the outer loop (stage 4).
7. *(Made while writing this note.)* **The local API has no auth beyond binding to 127.0.0.1.** Revisit before the agent runs anywhere but this machine.
8. *(Made while implementing, 2026-10-11.)* **Model and effort.** `claude-opus-5-5`: `medium` for instructions, `low` for escalations. Override with `JEEVE_SYSTEM2_MODEL`. **Reviewed 2026-10-11: accepted.** Speed matters little here, because System 1 handles reacting to the world, so System 2 can take longer to think.
9. *(Implementing.)* **Low-confidence escalations reach System 2,** deduplicated at 30 s per goal and program version. That's about 2–3 extra calls per instruction (each ~5 s, ~3k cached input tokens). Raise the threshold or the no-repeat window if that's too chatty.
10. *(Implementing.)* **A second `stuck` / `none_found` under the same goal escalates;** the first is left to Jev.
11. *(Implementing.)* **When a root goal closes,** its channels stop and the bot idles until the next instruction.
12. *(Implementing.)* **`owner_damage`** is damage to the player who gave the active root instruction.

## Implementation (2026-10-11)
Built in `src/goals.ts`, `src/system2.ts` and `src/main.ts`, and exercised by `npm run e2e` (two passing runs in a row).

**System 2 is Claude Opus 5.5 in a short tool loop:**
- `run_sql` over its own traces through judgeval's `client.sql()`;
- `scan` and `reachable`, read-only world queries, traced as `perceive` spans ([[perception]]). Tool calls in one turn run in parallel;
- a strict `submit_decision` tool that returns goal check, `escalate_if`, budget or review interval, the goal's place ([[behaviors-and-guards]] → "Going back to a place"), a program patch, a goal action (`none` | `fail` | `renew`), an optional sub-goal and an optional message;
- effort `medium` for instructions and `low` for escalations;
- server-side `fallbacks: "default"`, and the stable system prompt is cached.

**Measured latency:** instructions take 5–9 s; escalations usually 4–7 s, with one at 22 s. That's slower than the 2–5 s assumed above, but the bot acts on the raw instruction meanwhile.

**What it decided:**

| Instruction | Check | Other |
|---|---|---|
| "come here" | `near_entity(Josh, 3)` | 60 s budget |
| "collect 10 logs" | `inventory_delta("*_log", 10)` | 300 s budget |
| "follow me and defend me" | none: open-ended | `escalate_if`: Josh farther than 16–24 blocks for 10–15 s, or Josh dead; a 120–180 s review |

All three are sensible with no prompt tuning.

**The inner loop works.** Low-confidence escalations (30 s no-repeat per goal and program version) reach System 2 two or three times per instruction. It reads the fast model's view and tightens the guidance ("S1 was torn between collect and following Josh, so guidance now says stay on collect"). Confidence then recovers.

**Reading its own traces works.**
- Without the schema, System 2 spent its 4 turns discovering column names and never decided.
- Now the system prompt carries the virtual SQL schema (`discoverSchema()`, fetched once per run, so it stays cached) plus Jeeve's span names and `jeeve.*` keys. The last turn offers only `submit_decision`.
- Asked about a past session, it answered correctly in one query.

**Writing behaviors:** a third tool, `write_behavior`, not strict. It's queued and applied with the decision, and the trial result comes back as a `behavior_trial` escalation ([[behaviors-and-guards]] → "How it's built"). Adding behaviors to `new_modules` instead hit the grammar limit again.

**Strict-schema limit:** a strict `submit_decision` plus any second tool failed with "compiled grammar is too large". Defining the check object once (`$defs` / `$ref`) instead of three times fixed it, and `run_sql` (one string argument) isn't strict.

**Implemented as designed:**
- intake by whisper and by `127.0.0.1` API;
- code-written "done" whispers;
- only System 2 fails goals;
- programs stack with goals and revert on close;
- merged triggers, with escalations for goals that have closed dropped;
- no repeats;
- window summaries written by code.

**Not built:**
- **Lessons kept past their goal.** Only the code-written summary and System 2's last note carry forward.
- ~~**Modules written by System 2.**~~ Checks and watch conditions are built ([[system-1]] → "Modules System 2 writes"). Encoders aren't yet.
- **Several players.** The latest instruction wins.

## Open questions
- **The no-repeat window.** Is 30 s right? It's a guess until traces show escalation rates.
  - **Evidence it can be fatal (2026-10-11, run `jeeve-2026-10-11T16-36-51-167Z`):** five slimes hit Jeeve for ~2 HP every 0.5 s. After the first escalation on the new goal, every later `jev_escalate` was suppressed while health fell from 11 to 1, and he died. System 2's fix arrived after the death.
  - ~~**Proposed:** a fast health drop bypasses the window~~ Built 2026-10-11: while the bot has lost 4 HP or more in the last 5 s, every escalation bypasses the window, the same way `instruction` and `behavior_trial` always do. Both numbers are guesses. The coalescing still holds: one System 2 call in flight, with the triggers merged. System 2 takes 5–15 s, so this doesn't save a fight by itself; Jev fighting back does ([[system-1]] → "Threats").
- **Clarifying questions.** If System 2 asks "which logs?", does the root stay active with Jev running on the raw text, or wait?
- **Several players.** Two allowlisted players give conflicting instructions. For now the latest wins, whoever sent it.
- **Which Claude model and effort per trigger.** Instructions may deserve more reasoning than a repeated `stuck`.
- **Stall detection from progress.** Behaviors emit `stuck`, but a goal whose progress hasn't moved for N minutes without any `stuck` isn't caught before its budget runs out. Add it if traces show silent stalls.
