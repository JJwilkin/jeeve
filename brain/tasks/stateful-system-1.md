---
date: 2026-10-13
tags: [task, system-1, memory, escalation]
status: active
progress: doing
---
# Task: a stateful System 1

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/stateful-system-1.md`."

## Why
System 1 (Jev) is stateless. Each call sees one encoded state and answers from scratch, so anything that has to last longer than one call lives in code patches or in 2A's guidance. The bench shows the cost ([[architecture/stateful-system-1|stateful-system-1]] → "What the traces say today"):
- 57% of 2A's calls are Jev's one-off doubts;
- most of those doubts are "keep or switch?";
- 2A answers them by restating state Jev can't keep ("keep walking until at the place, then clear the tree").

The goal: System 1 carries a small working memory, and takes on keeping commitments, local recovery and judging when to escalate. 2A stays the only writer of commitments.

## Constraints
- No model training ([[learning]]).
- Jev's measured limits ([[jev-measurements]]): ~160–300 ms; questions nearly free; ≤255 options; position bias on close calls; weak with numbers and with generating text.
- 2A stays the only writer of goals and commitments ([[system-2]]).
- [[bitter-lesson]]: provide mechanisms, and let 2A or the traces decide the content.

## Read first
- [[architecture/stateful-system-1|stateful-system-1]]: the proposal (design, mechanisms compared, risks, first experiment)
- [[system-1]], [[layers]], [[overview]] → "Time in decisions"; [[system-2]] → Plans and Escalations; [[bench-hill-climb]] (fixes #6, #8, #11, #20, #29 are System 1 state added one patch at a time)
- Evidence: [[realtime-game-agents]], [[project-sid]], [[fast-slow-agents]], [[decision-models]], [[spatial-models]]
- Code: `src/decide.ts`, `src/program.ts`, `src/encoder.ts`, `src/main.ts` (`escalate`, `learnFrom`, `startStep`, the channel `end`/`event` handlers)

## Plan
1. ~~**Design**~~: written in [[architecture/stateful-system-1|stateful-system-1]] (2026-10-13). **Waiting for Joshua's review** of its open questions before any code.
2. ~~**Replay experiment**~~: done 2026-10-13 (`scripts/replay-memory.ts`; results in [[architecture/stateful-system-1|stateful-system-1]] → "Replay results"):
   - persistent doubt is rejected;
   - the moot-answer filter is the clean win;
   - memory (`plan` + `doing`) cuts doubt about 13 points, with slightly better agreement.
3. **Build pieces 0 and 1:**
   - piece 0: don't escalate doubt about answers that were overridden, pinned, held or in the dwell;
   - piece 1: the memory block (`plan` + `doing`) as an encoder param, so on vs. off is a program diff.
3b. ~~**Needs and objects replays**~~: done 2026-10-14 (`scripts/replay-world.ts`, shared code in `scripts/replay-lib.ts`):
   - **needs defaults work** once the idle directive and the hands wording stop contradicting them: eat when hungry 100%, escalate when starving with no food 100%, gather when fed;
   - **objects in place of the block list** cut doubt ~9 points and help the single-channel questions, but hurt the body question until its options name objects too;
   - remembered far objects changed nothing on these labels.
3c. ~~**Build the needs defaults**~~: shipped 2026-10-14 ([[system-1]] → Needs):
   - the needs line, the idle directive and the hands wording;
   - `eat` (always offered when hungry), and the idle-only `wander` and `glance`;
   - an e2e scenario: idle, Jeeve walks or looks around; made hungry with bread, it eats with no 2A call.
   
   Gathering when idle is held back (it breaks blocks unprompted).
4. **Bench A/B:** 3 rounds × orchard, forage, guard and workshop, memory on vs. off. Maybe add an "interrupted orchard" scene.
5. **Stages** (piece 3), only if traces still show doubt about sub-steps.

## Done when
- The replay report and the bench A/B are recorded in [[architecture/stateful-system-1|stateful-system-1]] (or its successor). Doubt-driven 2A calls per run are down, with pass rate, deaths and reaction no worse. Or the note says why not.
- [[system-1]] is updated with what shipped, and the proposal's `status` is `active` or `superseded`.
- `npm run check`, `npm run typecheck` and `npm run e2e` pass.
- [[roadmap]] and the index are updated, and this task's `progress` is `done`.
