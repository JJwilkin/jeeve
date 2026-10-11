---
date: 2026-10-11
tags: [architecture, perception, system-2, tools, bitter-lesson]
status: active
---
# Perception as tools

Most of what Jeeve sees, he has to ask for. System 2 gets a coarse block summary for free, and looks for detail with two read-only tools when a goal needs it. Every look is traced. This note is the outcome of [[perception-tools]]. It follows [[perception]] ("perception as tools") and the [[bitter-lesson]]: we don't decide what Jeeve should always see; we give him a way to look.

**Why:** in a live session on 2026-10-11, System 2 only had count buckets with no height. It guessed that a tree had 3 logs, which left one log standing. It also found out that the leaves were out of reach only after `collect` got `stuck` three times.

## The tool set: `scan` and `reachable`
Two tools cover "how many, where, how high, can I reach it". Both are general; neither knows about trees.

| Tool | Answers | How |
|---|---|---|
| `scan(match, radius ≤ 32, los?)` | how many, where, how high | Mineflayer's `findBlocks` with the block ids that match a glob. It skips chunk sections whose palette lacks those ids, so it isn't a 65³ loop. Matches are grouped into 26-connected clusters, nearest first. |
| `reachable(position)` | can I get within arm's reach | The pathfinder's A* with the one guarded `Movements` ([[seed-behaviors]]) toward `GoalLookAtBlock`. That's the goal `collect` uses. It yields between A* chunks and is bounded at 1 s. **The search stays inside the box around the bot and the block, padded by 16** (a neighbor filter on a per-call view of the shared `Movements`). On open ground an unbounded A* never runs out of nodes, so before this "no" could only be `timeout`. (A 32-block `searchRadius` was tried and reverted: it's a cost margin, not a distance, and A* pruned the path to a ground-level log 6 blocks away, which `collect` then reached.) **It judges the world as it is now:** a log behind other logs is unreachable until they're broken, though `collect` gets there by digging in order. `noPath` means no path inside the box; `timeout` means the box wasn't exhausted in time, i.e. unknown. |

**Not built:**
- **`look`, GITM-style ray casts.** The fairness use of ray casts is covered by `scan`'s `los` flag, and no goal yet needs "what's in front of me".
- **`surroundings`, a height map.** `navigate` handles terrain, and [[system-1]] deliberately gives Jev no terrain map.

Add either one when a goal shows it's needed.

**Reachability is code, not System 2's estimate.** It has one right answer given the movement rules, which is the dividing rule in [[layers]]. System 2 still reads heights from `scan`, and can reason "+5 is above reach" without a call.

## Output format
`scan` returns JSON. Exact numbers are fine here: System 2 is Claude, not Jev ([[jev-measurements]]).
```json
{ "match": "*_log", "radius": 16, "los": false, "total": 6, "truncated": false,
  "clusters": [{ "count": 5, "names": { "oak_log": 5 }, "nearest": [10, -60, 12], "dist": 4.1,
                 "rel": [3, 0, 2], "y_rel": [0, 4], "min": [10, -60, 12], "max": [10, -56, 12],
                 "positions": [[10, -60, 12], "…"] }] }
```
- **Absolute and relative coordinates both.** Absolute coordinates let System 2 write checks and behaviors against them. `rel` and `y_rel` are measured from the block at the bot's feet, which answers "how high" directly.
- **Bounded:** radius ≤ 32, at most 512 blocks scanned (`truncated` says if that limit was hit), at most 8 clusters, and up to 32 positions per cluster, nearest first. A typical tree answer is ~1–3 KB.
- `reachable` returns `{ reachable, status: success | noPath | timeout, steps? }`.

## Turns and latency
- **Several tool calls run in one turn.** The API already allows parallel tool calls, and the loop runs them together (`Promise.all`). The prompt says to make every look in the same turn. A turn costs seconds; a look costs milliseconds.
- **`MAX_TURNS` stays 4,** and the last turn still offers only `submit_decision`, so a call always ends in a decision.
- **No default scan in the context.** The improved always-on summary (below) plays that role. Raise the turn cap for instructions only if traces show calls running out of turns.

Measured: see "Implementation".

## One query layer
`src/world.ts` is the only block view. It's read-only and returns plain JSON, with no Vec3 or Block objects, so it can cross a sandbox boundary.
- `blockAt(pos)`, `scan(…)`, `reachable(pos)`, `notableBlocks(…)`.
- **System 2's tools** call `scan` and `reachable`.
- **The encoder and the raw snapshot** use `notableBlocks`.
- **Behaviors System 2 writes** ([[runtime-authored-behaviors]]) get `blockAt` and `scan` as synchronous reads and `reachable` as an async call, unchanged, through their action API. That task builds its API on this layer; it doesn't add block queries of its own.
- **Modules** (checks and watch conditions) stay pure over the snapshot. Their block view is the snapshot's `blocks`. They don't call `scan`.

## The always-on summary
- **For Jev**, notable blocks keep named buckets but add an exact count up to 9 ("a few (4)", "many (7)"), and a vertical tag on the nearest one when it's more than a block up or down ("close, right, ~3 up"). Notable means a type that's rare in the 17³ cube (≤ 64), so terrain drops out without a hand-written list.
- **In the raw snapshot** (the module API and replay record), `blocks: { name: [[x, y, z], …nearest 8] }` for up to 12 notable types. It's the same scan, memoized until the bot moves to another block or any block changes (`blockUpdate`), so one `decide` scans the cube once and a check never reads a block that's already gone.
- **A missing name doesn't mean none.** The view is the cube within 8 blocks of the bot's feet, and a type with more than 64 blocks in it isn't notable. In the [[runtime-authored-behaviors]] e2e, a check `!s.blocks.oak_log && !s.blocks.oak_leaves` passed falsely when `collect` walked Jeeve 6 blocks off and the canopy fell outside the cube. So the System 2 prompt says a "none left" check must also require the bot to be near the place. System 2 can ask `scan` for "none left"; modules can't.
- This replaces the 16³ block cube that [[system-1]] and [[trace-schema]] planned for the snapshot. A full cube is ~5k blocks, while notable blocks with positions are ~1 KB. Add the cube when an encoder that's being replayed needs terrain.

## Fairness
`scan` sees through walls by default (x-ray). `los: true` keeps only blocks the bot can see (`bot.canSeeBlock`, a ray cast per block). The mode is recorded on every call as `jeeve.perceive.mode` (`xray` | `los`). It's a parameter, not a fixed bound, for the local milestone. On public servers it becomes an operator setting ([[layers]], [[fast-bots]]).

## Tracing
Each call is a `perceive` span, **a child of the `system2` span** that made it. The `system2` span now opens when the call starts and ends when the decision is applied.
- Input and output: the query and the full result.
- Attributes: `jeeve.perceive.tool`, `.query`, `.mode`, `.latency_ms`, `.result_bytes`.

Details are in [[trace-schema]].

## Implementation (2026-10-11)
Built in `src/world.ts`, `src/system2.ts` (the tools and parallel dispatch), `src/main.ts` (the `perceive` callback and the early `system2` span) and `src/trace.ts` (`open`/`finish`, `record(…, { parent })`). The e2e places an oak with `/place feature minecraft:oak` after "collect 10 logs":
- random ticks are off, so the leaves don't decay;
- the area is cleared first;
- both players are teleported outside the canopy (in one run the tree grew into Jeeve and he suffocated).

**"break this tree":** System 2 scans `*_log` and sets `inventory_delta("*_log", N)` with N equal to the real count (4 in one run, 6 in another). Every log is collected.
- **It looked on its own,** with no prompt about trees.
- **In the first run it wrote a better-grounded check:** "no `oak_log` left in column x=10, z=12". It found the trunk's absolute coordinates with `scan`.
- **That check exposed a coupling System 2 couldn't see.** `collect` is offered only from an `inventory_delta` check's remaining count, so under an authored check Jev had no collect option. System 2 spent three escalations rewriting guidance for an option that didn't exist.
  - The stopgap is a prompt sentence: gathering goals use `inventory_delta`.
  - [[runtime-authored-behaviors]] fixes it at the root: under an authored check, the count offered is the number of blocks of that type within 32.

**"break the leaves too":** the brief assumed the leaves were out of reach. For an oak, they mostly aren't: they sit at +1 to +4, and once the trunk is gone Jeeve can stand under them.
- **The real gap is that `collect` measures progress by items, and leaves drop nothing without shears.**
- System 2 worked this out from its scans. It ran `collect` against an `inventory_delta` it knew wouldn't move, and on callback rescanned to measure progress (51 → 41 leaves) and renewed the goal.
- So the e2e step is outcome-based: System 2 looks, then either reports a limit before any `stuck`, or the leaf count drops.
- A behavior that breaks blocks without collecting them is [[runtime-authored-behaviors]]'s territory.

**Latency** (e2e runs on 2026-10-11):

| | Turns | Time |
|---|---|---|
| Calls without looks | 1 | 4–9 s |
| Instructions with looks | 2–3 | 12–22 s |
| Worst case (looks mostly one at a time, up to 7 looks) | 4 | 32–33 s |

- One scan costs 6–40 ms, and the results are 0.3–0.8 KB.
- **`reachable` answers both ways.** Before the box bound, a block that wasn't reachable (a top log behind other logs, the canopy) ran to the 1 s timeout: "unknown", not "no". With the box (e2e on 2026-10-11): `noPath` in 85–108 ms for the top log and a canopy leaf, and `success` in 0.2 ms for a low leaf. Offline (the selfcheck world), exhausting the box takes 150–330 ms depending on its size.
- **Batching is inconsistent.** System 2 sometimes looks in parallel (logs and leaves together; scan and `reachable` together), and sometimes one tool per turn.
- No encode ran over budget with notable positions in the snapshot.
- The bot keeps acting meanwhile, so the cost is when the goal's check lands, not reaction time.

**A bug in `applyDecision` that predates this work (fixed).** A System 2 call that finished after its goal had closed still whispered its message. In one run, a late escalation for "collect 10 logs" told Josh it got only 9 of 10, after the goal had already completed. A late one for "break this tree" told him the logs were gone, because a scan correctly found no logs left. Decisions on closed goals now keep only their note. That covers the message too.

**Judgment:** every `perceive` span lands with its query and result, under its `system2` span (checked by SQL in the e2e).

## Open questions
- **A window cut during a System 2 call.** The `system2` span can end after its window root, because a 60 s cut doesn't wait for the call. Its spans still export, but the trace was finalized without them. Seen in traces? Then end and reopen the span at the cut, as behaviors do.
- **Block states.** `blockAt` and `scan` return names only. System 2 rightly expected a logless canopy to decay, but player-placed leaves are `persistent` ([[runtime-authored-behaviors]] e2e). Expose a few states (e.g. `persistent`, `axis`) if more cases like this show up.
- **The `reachable` box.** A path that only exists by leaving the box (a detour of more than 16 blocks) reads as `noPath`. Pad 8 already pruned a 12-block detour round a wall in the selfcheck. If traces show `noPath` for a block `collect` then reaches, widen the pad.
- **Batching.** If traces keep showing one look per turn, try a stronger prompt, or put the first scan's result into the instruction context.
- **Clusters merge neighbors.** Two touching trees are one cluster. `names` and bounds usually show it. Split by type, or by trunk, only if traces show System 2 misreading clusters.
