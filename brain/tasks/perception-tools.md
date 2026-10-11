---
date: 2026-10-11
tags: [task, perception, system-2, tools, bitter-lesson]
status: active
progress: done
---
# Task: perception as tools

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/perception-tools.md`."

## Why
In a live session on 2026-10-11, the only block information Jeeve had about a tree right next to him was the encoder's summary:
```
oak_log    — "a few", nearest "very close, behind-right"
oak_leaves — "many",  nearest "very close, left"
```
- **Counts are buckets** (`one`, `a few` = 2–5, `many`). For "break this tree", System 2 guessed 3 logs, set the done check to 3, and left a log standing.
- **No height.** Directions are horizontal only, so nothing said the leaves were ~5 blocks up. Jeeve found out only after `collect` got `stuck` 3 times.
- **No shape.** He can't tell one tree from another, or a tree from a pile of logs.
- **System 2 can't look for itself.** Its only tool besides `submit_decision` is `run_sql` over its own traces. The snapshot that modules read has no blocks at all, only the block underfoot (`rawSnapshot`, `src/encoder.ts`, marked `ponytail: no block cube yet`).

The fix follows [[perception]] ("perception as tools") and the [[bitter-lesson]]. Instead of us deciding what Jeeve should always see, give System 2 calls to **ask for detail when a goal needs it**: how many logs, how high are the leaves, can I reach them. Every look gets traced.

## Goal
1. **System 2 can query the world** through a few general perception tools, called in its decision loop next to `run_sql`. Each call is traced.
2. **The always-on summary gets a little better** for everyone: exact counts and height relative to the bot for notable blocks, and notable blocks with positions in the raw snapshot, so modules can use them.

## Read first
- [[perception]]: data vs. pixels, where the view narrows, perception as tools, x-ray
- [[spatial-models]]: ways to encode space (entity lists, maps, ray casts, GITM's "LiDAR")
- [[gitm]]: ray casts every 5° and a voxel radius, used by its scripts
- [[system-1]]: the default `egocentric` encoder, the raw snapshot as the module API, replay
- [[system-2]]: the decision loop, tools, `MAX_TURNS`, latency
- [[trace-schema]]: span kinds and `jeeve.*` attributes (add one for perception calls)
- [[fast-bots]]: "fairness is a setting" (x-ray vs. line of sight)
- Code: `src/encoder.ts` (`notableBlocks`, `rawSnapshot`), `src/system2.ts` (`TOOLS`, `run_sql`, `MAX_TURNS = 4`), `src/trace.ts`

## Questions to answer
1. **The smallest general tool set.** Candidates:
   - `scan(block, radius)`: block name or glob → matching blocks grouped into connected clusters, with count, position relative to the bot, and height range per cluster (so "one tree, 5 logs, leaves +3 to +6").
   - `look(direction | target)`: ray casts → first hit per ray, with distance (GITM-style).
   - `reachable(position)`: can the pathfinder get within arm's reach without building or digging forbidden blocks?
   - `surroundings(radius)`: a coarse top-down height map.

   Pick the fewest that cover "how many, where, how high, can I reach it". Keep them general: no tree- or Minecraft-recipe-specific tools.
2. **Output format.** Exact numbers are fine for System 2 (Claude), unlike Jev ([[jev-measurements]]: Jev is weak with numbers). Include both coordinates relative to the bot and absolute ones, so System 2 can write checks and modules against them. Bound the output size.
3. **Turns and latency.** System 2 has `MAX_TURNS = 4`, and calls already take ~4–11 s. Every tool call costs a turn. Options:
   - include a cheap default scan in the context,
   - allow several tool calls in parallel in one turn,
   - raise the turn cap for instructions only.

   Measure the effect on latency.
4. **Who else uses it.** The same read-only query functions should serve modules System 2 writes and, later, behaviors it writes ([[runtime-authored-behaviors]], whose question 5 needs a block view). Build one query layer, not three.
5. **The always-on summary.** For Jev, keep named buckets but add a vertical tag (e.g. "above, ~5 up") and an exact count where it's small. In the raw snapshot, add notable blocks with positions, bounded (e.g. nearest N per type). Check that encode time stays within the budget in [[system-1]].
6. **Fairness.** `scan` sees through walls (x-ray). Make line of sight a parameter, and record which mode was used. Defaults can stay as they are for the local milestone; [[layers]] defers fairness on public servers.
7. **Tracing.** Each perception call is a span (e.g. kind `perceive`) with the query, result size and latency, under the System 2 span. Update [[trace-schema]].

## Coordination
- [[runtime-authored-behaviors]] is in progress in another chat and touches `src/system2.ts`, `src/main.ts`, `src/modules.ts` and the e2e. **This task owns the block view** (that brief's question 5). Agree the shared query layer with that chat, or land this first and let it build on top.
- Work in a separate git worktree or branch if both are active. **Only one e2e can run at a time** (port 25565), so check that no server is running before starting one.

## Done when
- An architecture note (a new `brain/architecture/perception.md`, or updates to [[system-1]] and [[system-2]]) records the tool set, output format, turn and latency trade-off, the shared query layer, the summary changes and fairness.
- An e2e scenario: place an oak with `/place feature minecraft:oak`, then
  - "break this tree": System 2 scans, sets the check to the real log count, and every log is collected;
  - "break the leaves too": System 2 sees the leaves' height and either reports up front that they're out of reach, or (if [[runtime-authored-behaviors]] has landed) builds up to reach them.
- Perception spans appear in Judgment with their query and result.
- `npm run check`, `npm run typecheck` and `npm run e2e` pass.
- [[roadmap]] and the index are updated, and this task's `progress` is `done`.
