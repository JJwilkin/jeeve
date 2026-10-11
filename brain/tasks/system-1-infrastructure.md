---
date: 2026-10-10
tags: [task, system-1, architecture, bitter-lesson]
status: active
progress: todo
---
# Task: System 1 as infrastructure, not a fixed design

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/system-1-infrastructure.md`."

## Goal
Decide what the **infrastructure** around System 1 provides, and what is left **for System 2 to decide at runtime**.

The aim is not to design the perfect System 1. We build the runtime, and the agent decides how System 1 works:
- what Jev sees,
- what it's asked,
- when it's called,
- which behaviors it can choose from.

That's the [[bitter-lesson]] applied to our own controller: provide methods, not answers.

## Read first
- [[layers]]: the current split, channels, and why behaviors keep running between calls
- [[behaviors-and-guards]]: the behavior contract, and runtime-authored behaviors (System 2 already writes code)
- [[learning]]: context only, no training; guidance is versioned, cites evidence, and expires
- Evidence: [[decision-models]] (Jev's API: typed questions, up to 255 options per choice, probabilities), [[spatial-models]] and [[perception]] (ways to encode state), [[realtime-game-agents]] (named slow/fast patterns), [[fast-bots]] (physics vs. strategy rules)

## The starting idea, to test or reject
**System 1 is a program that System 2 writes, and the infrastructure is its runtime.** A System 1 "program" could include:

| Part | Who decides today | Proposed |
|---|---|---|
| State encoding: what Jev sees (entity list, maps, ray casts, event window) | Fixed in [[layers]] | System 2 picks or writes an encoder; the infrastructure provides raw state and building blocks |
| Questions and options: what Jev is asked, and how parameterized behaviors become choices | Fixed (one question per channel) | System 2 defines them; the infrastructure enforces limits (255 options, latency) |
| When to call: reactive vs. proactive | Fixed triggers, now loosened | System 2 sets the policy; the infrastructure provides events, state subscriptions, watch conditions, timers |
| Which behaviors are allowed | System 2's guidance | Unchanged |
| Guidance and examples | System 2 | Unchanged |

The infrastructure always provides:
- raw world state,
- the behavior runtime and guards,
- the trigger mechanisms,
- `decide()` (calls Jev, at most one call in flight, latest state wins),
- automatic tracing of everything, including which System 1 program version made each decision.

## Questions to answer
1. **Where's the line?** What must be fixed infrastructure, and what can be System 2-authored? For example, are channels themselves infrastructure, or a default?
2. **Format of a System 1 program:** code (sandboxed, like runtime behaviors), declarative config, or both?
3. **Safety bounds:** what System 2 can't change, e.g. guards, rate limits, the latency budget.
4. **The default program:** the smallest scaffold that works before System 2 has tuned anything. It's the baseline to beat.
5. **How System 2 tells which program is better:** compare versions across trace windows, using what outcome signal? This links to roadmap stage 4.
6. **Jev's limits:** latency per call, how many questions per call, how options are listed. Measure them with our access instead of relying on vendor numbers.

## Done when
- An architecture note (e.g. `brain/architecture/system-1.md`) states the infrastructure/program split, the program format, the fixed bounds, and the default program.
- [[layers]] is updated to point at it, and anything replaced is marked `superseded`.
- Open questions are listed in the note, not left in chat.
