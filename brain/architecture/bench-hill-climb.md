---
date: 2026-10-12
tags: [architecture, benchmarks, evaluation, search, learning]
status: active
---
# Bench and the overnight hill-climb

Three scored scenes, run unattended, and what each round changed. Started with Joshua, 2026-10-12. The rule he set: **don't tune to the scenes.** Each failure points to a gap in Jeeve's **search** (finding out what the world holds that matters for the goal) or **learning** (keeping what worked as skills). The fix goes in the harness, per the [[bitter-lesson]].

## The night of 2026-10-12, in short
- **138 scored runs, 125 passed.** Over the last 59 (random layouts, four scenes including a search scene), 58 passed. `node scripts/bench-report.ts` has the per-commit table.
- **30 gaps found and fixed in the harness**, below. None is tuned to a scene:
  - **perception:** line of sight, a far look, a memory of what was seen, ground told by shape;
  - **search:** `survey`, frontier exploration widening from the task's origin, explored coverage, `plan_done`, `idle` and `stalled`;
  - **learning:** a shared library across runs, curation, general item skills, escalation backoff learned from 2A's answers;
  - **control:** no restart thrash, a target-switch dwell, the whole-body hold, the protected player treated like the bot;
  - **correctness:** crafting settles the inventory, the bot's own scaffolding and digs, versioned module names, a plan's program carries across steps.
- **Medians on random layouts by the end:** orchard (3–5 canopy trees) ~160–200 s; workshop (a different tool each run) ~45 s; guard always passes; forage (trees beyond sight) ~200 s with 18–23 logs.
- `npm run e2e` passes (62 checks) after the night's changes.
- Clips, start to end: `clips/reel-16x9.mp4` and `clips/reel-9x16.mp4` (`scripts/reel.ts`), from the notable runs' own clips.

## The bench
- `npm run bench -- <rounds> [scenarios] [--fresh]` (`scripts/bench.ts`). Each scenario in `scripts/clip.ts` runs with `--bench`: no OBS, no client, no render. Runs go in parallel on ports 25571+, each with its own world. One row per run goes to `bench/results.jsonl`: pass, time, 2A calls and seconds, builds and trials, the library it started with, plan steps, look-arounds, deaths, commit.
- **Scored by Josh, not by Jeeve.** The scripted player sees every block, so verification is ground truth:
  - **orchard:** four canopy trees, "break the tree closest to you", then "the other three the same way". Pass: no logs or leaves left in the row.
  - **workshop:** two small trees and a chest, "make a wooden pickaxe and put it in the chest". Pass: a pickaxe in the chest (Josh opens it).
  - **guard:** at night, "follow me and keep me safe", while Josh moves between four spots and four zombie waves come. Pass: no zombies left, and Josh and Jeeve both alive.
- **Learning across runs.** Every run starts from `bench/library.json`: the skills and checks learned so far, across all scenes. After each round, `bench` merges what each run learned back in. `--fresh` starts empty.
- **The camera without a client.** Josh records the world (`<dir>/world.jsonl`: the view box's blocks, each change, entities at 10 Hz). Clips draw it with real Minecraft textures via prismarine-viewer (`viz/src/world-video.ts` → `world.mp4`), or with flat three.js (`viz/src/WorldScene.tsx`) as a fallback, when there's no OBS footage ([[brain-monitor]]).
- **The all-seeing eye.** `node scripts/gaps.ts <dir>` (run after every bench run, written to `<dir>/gaps.md`):
  - at each 2A call, 2A's `seen_map` vs the truth: trees unseen, stale blocks, counts off;
  - goals whose check said a spot was clear but it wasn't;
  - time: body idle, per behavior, 2A thinking, building; behavior endings.

## Rounds
| Round | Commit | orchard | workshop | guard | What changed before it |
|---|---|---|---|---|---|
| 1 | 6825298 | PASS 422 s (built `clear_tree_pillar`, 3 trials, 246 s) | FAIL 238 s: crafts turned planks into buttons and hung 20 s; trials used up the wood | PASS 125 s | Baseline: plans, seen memory, look-to-confirm, empty library |
| 2 | 27be657 | PASS 246 s (reused the skill) | PASS 173 s (built craft and deposit skills) | PASS 125 s | Crafting settles the inventory; shared library seeded from round 1 |
| 3 | 4c91e84 | PASS 313 s, body idle 145 s, 3 of 4 trees unseen when planning | **PASS 69 s** (both skills reused) | PASS 125 s, Jeeve 10 HP | Face-ray visibility, far look, ground by shape |
| 4 | 33511ad | **PASS 142 s** | PASS 47 s | **FAIL**: Jeeve died (started at 10 HP; target flip-flop) | No restart thrash |
| 5 | c5369e7 | PASS 147 s, idle 26 s | PASS 65 s | PASS (Josh lost 13) | Target-switch dwell; runs start at full health; 2A's `survey` |
| 6 | c5369e7 | PASS 133 s, idle 17 s | PASS 66 s | PASS | — |

From round 7 the scenes are randomized per run (seeded: 3–5 trees of oak or birch, trunks 5–7, at random spots; workshop trees and chest at random spots; 3–5 guard waves; no free building blocks), and the library starts fresh, so what's measured is generalization, not one layout. `bench/library-fixed-scenes.json` keeps what rounds 1–6 learned.

| Random round | Commit | orchard | workshop | guard |
|---|---|---|---|---|
| 1 (empty library) | 8c4235f | PASS 330 s, 5 trees; built `clear_tall_tree` in 2 trials, 123 s, with no free blocks | unscored: Jeeve finished, but the referee couldn't reach the chest (fixed) | PASS |
| 2 | d445ae0 | PASS 164 s | PASS 106 s | PASS |
| 3 | 3fc49d3 | PASS 159 s | **PASS 34 s** | PASS |

On layouts it hadn't seen, Jeeve learned in the first round and reused after. 2A's map had all five orchard trees at the first instruction, from one spot (the far look and face-ray visibility).

## Gaps found, and the harness fix for each
1. **Crafting corrupted the inventory** (round 1). `bot.craft` resolves before the server's slot updates arrive, so back-to-back crafts laid out grids from stale slots: buttons instead of sticks, and 20 s hangs. Reproduced against the server in isolation. **Fix:** every item-moving action waits for the inventory to settle (`settle()`, `src/behaviors.ts`).
2. **Every run relearned everything** (round 1). **Fix:** the shared library (learning across episodes). The workshop went 238 s (fail) → 173 s → 69 s.
3. **Half-blind visibility** (found with `gaps.ts`). Mineflayer's `canSeeBlock` casts one ray at the block's centre with a range measured to its corner, so blocks below eye level or half hidden read as unseen: 3 of a tree's 27 leaves. **Fix:** `visible()`, a block is seen if a ray reaches one of its exposed faces that point at the eyes. `scan` and the seen memory both use it.
4. **Jeeve only saw 8 blocks out.** **Fix:** a far look every 2 s (24 out, 16 up, ~50 ms), skipping types that are everywhere there (ground, air).
5. **2A's map merged the ground into the trees.** The partly seen grass floor came under the 512-block terrain cutoff and swallowed every tree touching it. **Fix:** ground is told by shape (most of a type on one height level, over a wide area), not by count.
6. **Option thrash** (round 2). An option's count is part of its key (`clear_tree_pillar:oak_log(5)`). When the count dropped, Jev saw a "new" option and restarted the running skill: 18 restarts on one tree. **Fix:** the running option under any count stays `keep_current`.
7. **Occluded search** (round 3). From the start spot, the first tree hides the other three, so 2A planned for one tree. Seeing farther can't fix that; moving can. **Fix:** a `survey` tool for 2A: Jeeve walks a loop 6 blocks around where it stands, looking, and 2A gets the updated map. Search is 2A's choice, like `scan`.

8. **Target flip-flop** (round 4). With two zombies close, Jev switched attack targets every 0.5 s for 7 s, so no swing landed, and Jeeve died. 2A's guidance ("keep the current target") didn't hold. **Fix:** a behavior just started can't be swapped for the same behavior on another target within 1.5 s (`LIMITS.switchDwellMs`), unless it ended: hysteresis in the control loop, not a strategy rule.
9. **Bench hygiene** (round 4). A bench port's world persists between rounds, and with it the players' health and hunger: Jeeve started guard at 10 HP. **Fix:** every run heals and feeds both players first.
10. **2A didn't need `survey` on the fixed orchard** (rounds 5–6: 0 calls). The first instruction needs only the nearest tree, and by the second the far look had found the rest. It stays a tool 2A picks when a goal is out of view.

11. **Half of 2A's calls changed nothing** (random rounds 1–2: 13 of 25 and 7 of 15). Nearly all were Jev's doubts (`low_confidence`, `jev_escalate`) that 2A answered "carry on". **Fix, learning from 2A's own answers:** an escalation 2A answered with no change backs off for that goal, doubling from 30 s to 4 min. Acting on one resets it. A fast health drop still bypasses.
12. **Search beyond sight:** a fourth scene, forage ("get me 16 logs", every tree 28–45 blocks out, beyond the far look). It tests whether 2A explores with what it has (step places, `survey`, the seen map).

13. **Scaffolding left standing** (orchard, two runs). The pillaring skill left the bottom two blocks of its pillar: birch logs carried from an earlier tree, on an oak's trunk spot. 2A's oak-only `cleared` check passed. **Fix:** the runtime remembers the blocks Jeeve placed (`notePlaced`, `src/world.ts`). A `cleared` step stays open while any of them stand near its place, whatever they're made of, and Jev is offered them to break. 2A is also told to match every wood.
14. **A plan ran out before its goal** (forage, trees beyond sight). Two trees gave 10 of 16 logs, and 2A wasn't called for 520 s: no steps left, Jev's doubts backed off, no review timer. **Fix:** `plan_done` (all steps done, goal not met) and `idle` (nothing on the body for 30 s) escalations. A built-in `at_place` check makes exploration steps possible ("walk to an unexplored spot 20–30 out"), and 2A is told how search works here (it sees about 24 blocks).
15. **2A forgot a tree it had passed.** Jeeve walked within 11 blocks of a tree, but by the next 2A call it was more than 32 blocks off, out of the map, and 2A searched the far west. **Fix:** the map covers 64 blocks (20 clusters), and the memory keeps blocks out to 96.
16. **Busy isn't progress.** 2A asked the (scripted, silent) player to lead it to trees, and Jeeve followed him in place for 10 minutes. `idle` never fired, because following counts as busy. **Fix:** `stalled`, a goal whose progress (the root's measure, or which step runs) hasn't moved for 60 s escalates. 2A is told players may not answer or lead.
17. **No eating** (guard deaths). Health came back between waves only if Jeeve ate, and it had no food and no way to eat. The guard scene now gives it bread, and nothing tells it to eat: a learning test.

18. **The library filled with one-off checks** tied to one layout (`birch_tree_43_cleared`, `tree_at_35_cleared`). They're useless elsewhere and crowd 2A's context. **Fix, curation (the between-episode loop, minimal):** modules record when they were last used (a check evaluated, a behavior run, `used_at`). After each round, `bench` retires checks and watches unused for 2 rounds in a row. Skills stay.
19. **A false done from a canopy-height place.** 2A put a step's place at the leaves, and `cleared` only counted blocks at or above the place, so the trunk below was missed. **Fix:** `cleared` checks the whole column (12 up and down).
20. **A whole-body skill cut off by one channel** (9 times in one run). Jev's legs question chose "walk to the place", which stole the legs from the running tree skill. **Fix:** a running whole-body behavior is only the body question's to change; a channel's own answer is held. Orchard on random layouts went to 118–128 s.
21. **Skills have to generalize.** The workshop asks for a different wooden tool each run (pickaxe, axe, sword, shovel), so a `craft_wooden_pickaxe` skill isn't enough.
22. **2A didn't know where it had looked** (forage). It searched west, north and south, then said it had covered the east, where every unseen tree was. **Fix:** `explored`, the centres of the 16-block cells the far look has swept, in 2A's context. 2A is told to aim searches at cells not in it.

23. **Item skills didn't generalize.** For a shovel, the builder wrote `craft_and_deposit_wooden_shovel` instead of extending `craft_wooden_pickaxe`. **Fix:** the builder is told an item behavior must make whatever its target names, and 2A to try an item behavior on a new item before asking for another. A sword, never made before, then passed on its first try.
24. **2A couldn't pick search directions from a list of cells** (forage: west four times; the trees it never saw were north and south). **Fix, frontier exploration:** the runtime computes `explored.frontier`, the nearest unexplored spot in each of 8 directions, and 2A plans steps to it.
25. **A frontier ranked from the bot drifts.** Each step pushed the frontier outward, and a search went 300 blocks east while every tree was within 60 of the start (the recorder lost Jeeve past its box). **Fix:** the frontier is ranked from the task's origin (where the instruction came), so the search widens in rings around the start.

26. **2A named skills by id** (`clear_tall_tree@2`, as the module list shows them), and program validation knows only bare names. Every program it set was refused, silently: one orchard run made 36 2A calls re-setting it. **Fix:** a version suffix is accepted anywhere a module is named, and a refused program goes back to 2A at once.
27. **Each plan step started on the default program.** 2A set guidance on the step it was answering, and the next step didn't inherit it. **Fix:** while a plan runs, a program 2A sets belongs to the instruction's goal and carries across steps.
28. **The player Jeeve guards was invisible as a victim** (guard: Josh hit every second for 30 s while Jev stayed on a zombie walking away). **Fix:** the protected player is treated like the bot. Their attackers are marked for Jev ("zombie (attacking Josh)"), count as threats for `hostile_near`, and wake Jev. Three hits in 5 s escalate `owner_hurt`, past the backoff.

Also: e2e expectations updated for the new design: the built-in `cleared` check counts as "tests that none are left", and "hears done" waits for the look before done. 2A matches logs only unless leaves are asked for ("break this tree": natural leaves decay).

29. **A regression from #20, caught by the e2e.** Collect holds the whole body, so while a zombie hit Jeeve, the hands' answer "attack it" was held, and Jeeve kept collecting until it died. **Fix:** the hold doesn't apply while the bot is under threat (damage in the last 5 s, or a hostile within 8 blocks).
30. **Jeeve's own digging left stale memory.** Collect broke a log inside a canopy. Its empty spot was hidden by leaves, so the memory never saw it gone, and "break this tree" couldn't close: 2A eventually gave up on a finished tree. **Fix:** blocks the bot digs itself are forgotten at once (`noteDug`, on `diggingCompleted`), as placed ones are remembered.

## Open
- **Trials still consume materials** ([[orchestrator-and-builder]] → Open questions). Workshop round 1 burned its wood on failed trials.
- **Idle time** is still large while the builder works or 2A thinks. Jev could do the parts of a plan it can already do meanwhile.
