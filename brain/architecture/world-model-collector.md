---
date: 2026-11-02
tags: [architecture, world-models, data, infrastructure]
status: active
---
# World-model collector

What [[world-model-data]] phases 1 and 2 built in `collect/`, and what the first local run measured. The plan stays in the task note; this is how it works now.

## Pieces
| File | What |
|---|---|
| `collect/format.ts` | The episode format, the record layout and the block-class table |
| `collect/recorder.ts` | The step recorder: 5 steps a second, far view once a second |
| `collect/actions.ts` | Scripted actions, DART-style noise, random input, the slot for phase-2 actions |
| `collect/bot.ts` | One bot per process: teleport to a start or into a built scene + kit over RCON, the scheduler, one file per episode |
| `collect/main.ts` | One server, one seed: locates the starts, pre-generates around them, starts the bot processes, rotates time and weather every 10 min, stops at the seed's step budget |
| `collect/worlds.ts`, `collect/scenes.ts` | Start points by biome quota (`/locate biome`) and Chunky per start; the built stress scenes |
| `collect/compose.ts`, `deploy/collect/run.sh` | The Compose file for one round of seeds (a Paper server and a collector per seed), and the VM-side run (the seed queue in rounds, copy to the bucket every 10 min, power off at the end) |
| `collect/author.ts`, `collect/author-stub.ts`, `deploy/collect/author.sh` | 2B's authoring harness for bridge, swim across and shelter (below) |
| `collect/read_episode.py`, `collect/check.ts` | The numpy reader, and checks (`npm run collect:check [file]`) that compare it with the TypeScript decoder |

## Format
- **One gzipped file per 60 s episode:** `u32 header length | header JSON | steps | far views`. The header is written when the episode ends, so it also carries the episode's tables (actions with parameters and outcomes, veto reasons, held items, entity types) that records index into.
- **The header lists every field** with its numpy dtype and shape, so the reader builds its dtype from the file: a new field needs no reader change.
- **A step is 12,590 bytes raw:** self state, controls, noise, dig/place targets, veto, action index, 8 entities, near view (16³ classes), mid view (16³ cells: main class + water/lava/air flags). **A far view is 12,292 bytes** (64×64 height, top class, water depth). About 15 KB per step raw, as planned.
- **63 block classes**, generated from the registry: named classes first (fluids, ores, logs, leaves, terrain, shapes like slab or stairs, hazards), then a fallback by collision box and mining tool, so an unnamed block still lands somewhere physical. The table and its members go in every header; 255 means "chunk not loaded".
- **Far view:** per column, the first non-air block scanning from feet+48 down to feet−48 (height −128: none in that window). So underground it maps the cave's ceiling, not the surface.

## Recorder
- **Blocks are read from the chunk columns** (`column.getBlockStateId`, the same call `bot.world.getBlockStateId` makes, without its per-call Vec3 and key string), with columns cached for one step.
- **Controls and vetoes:** the collector passes its own veto callback to `installGuards` and wraps `setControlState`, `dig` and `placeBlock` on top of the guards. A control counts if it was held at the step or pressed since the last one and not vetoed; dig and place targets count even when vetoed. `src/guards.ts` is unchanged.

## Actions and scheduler
- **Every action runs through `Channels`** (`src/behaviors.ts`) under the same guards as Jeeve: `navigate` (5–40 blocks), `wander`, `collect` (logs and leaves: the only blocks the guarded Movements may break), `track`, `fight` (follow + track + `attack_when_ready` on one mob), `eat` (only when the food bar isn't full; a quarter of episodes start with a hunger effect so it can fit).
- **Authored-format actions** (`async (api, target) => …`) run through `authoredSpec`, unchanged: library ones by name (`FROM_LIBRARY` in `collect/actions.ts`, empty for now) and the hand-written and 2B-written ones (`WRITTEN`, one file each in `collect/actions/`). See "Hand-written actions" below.
- **The scheduler:** 15% random input (2–10 s, an Ornstein–Uhlenbeck look drift and random key holds; a vetoed key doesn't end it). Otherwise it picks among actions that fit, weighted by the expected rarity of the outcome each will have here: Σ_o p(o | action) / √(1 + n(biome, action, o)). Counts are shared among one server's bots through `collect/main.ts` and saved to the seed's `coverage.json`, so each seed is balanced on its own. Since v4, the actions the first Tier 1 model was weakest or thinnest on (bridge, swim_across, jump_gap, cross_water, climb_down_safely, reach_ledge) get ×3 (`FOCUS` in `collect/bot.ts`); they fit only near their feature, so this raises how often they run there.
- **Noise while an action runs:** yaw wobbles, an extra jump, a brief forward release, a pause. Each step records which kinds were injected (`noise`).
- **Outcomes:** the first terminal end of the action's runs (done, stuck, none_found, vetoed, target_dead, target_lost…), or `timeout` (its own limit, ≤20 s), `episode_end`, `died`, `stopped`.
- **Episode start:** `spreadplayers` around a start point (below), clear, heal, feed, then a random kit (blocks, a tool, a sword, food, torches).

## 2B's actions: the authoring harness (phase 2)
`collect/author.ts` (`npm run author -- [bridge,swim_across,shelter] [--stub]`) has 2B write bridge, swim across and shelter by calling `build()` (`src/builder.ts`) with a capability request and a pass check, as 2A would. It drives its own bot (named Jeeve, since `scripts/scenes.ts` addresses it by name) on one superflat Paper server, through RCON, and runs drafts through `Channels` + `authoredSpec` under the guards, like the collector.
- **Scenes:** bridge alternates river and ravine (`crossingScene(kind, false, seed)`: no way round, 32 cobblestone); swim across uses rivers; shelter is open superflat with 0–2 trees, a random wall or hut template, size 3–5 and building block. Validation seeds are 1–20; practice seeds (one per trial) are `1000 + 10·round + trial`, so trials never see a validation scene.
- **Targets** (passed as-is to the code): bridge `{ name, count, dir: [dx, dz] }` (count = the gap's width in validation), swim `{ at: [x, y, z] }` (the far-bank goal block), shelter `{ name, size, template }`. `timeout_s` ≤ 20, the collector's per-action limit.
- **Pass checks** are TypeScript functions in `author.ts`; their source goes into 2B's brief as `pass_when.code`, so 2B reads exactly what judges it. Bridge: every gap column has a block at bank level and the bot stands dry on the far side. Swim: the bot was in water and ends dry on the aim block's level within 2.5 blocks. Shelter: a wall run of `size` columns 2 high, or (hut) a 4-way flood fill from the feet can't get further than `size` or reach a block it could jump onto and out, and every reachable cell has a roof 2 above the feet. As in live trials, only a run that returns `done` is judged.
- **The loop:** a round is one `build()`; the first trial that passes ends it, and that draft runs on all 20 validation scenes. At ≥ 50% the action is written to `collect/actions/<name>.ts` (the module only, with the pass rate in a header; the collector's `fits`/`target` wrapper is separate). Below it, the next round's brief carries the last draft (as a library entry) and the evidence: the passing scenes, up to 6 failing ones with their end, error, state and last 15 API calls, and the rest in one line each. If no trial passed, it carries each trial's end, error, state and last 15 calls instead. Up to 3 rounds (`AUTHOR_ROUNDS`), and a dollar cap (`AUTHOR_MAX_USD`, default 25) that aborts the build.
- **Output:** `authoring/<session>.json` (per round: trials, per-scene pass/fail with the failures' last calls, cost) and the builder's trace, to Judgment when keys are set (project `JEEVE_PROJECT`, default `jeeve-test`) and to `traces/<session>.jsonl` always.
- **On the VM:** `deploy/collect/author.sh` starts a superflat Paper container and runs `author.ts` in the `jeeve` image. The keys come down ssh's stdin ahead of the script and reach Node through a pipe (`--env-file=/dev/stdin`), so they're never in a file, a command line or the container config.
- **`--stub`** swaps the model for `MockLanguageModelV4` replaying canned drafts (`collect/author-stub.ts`), so the whole loop runs without model calls. Its accepted drafts go to `authoring/actions/`, never where the collector reads.
- **Stubbed run (local dev Paper, 2026-11-02, ~35 min):**
  - Bridge round 1: a draft capped at 3 blocks passed a trial, then 9 of 20 validation scenes (45%). Round 2's brief carried those failures (~8 KB): a draft that claims done without bridging failed its trial on the pass check, and the full bridge passed 20 of 20 and was written.
  - Swim: a plain `goto` to the aim point failed every trial in 3 rounds. **The guarded pathfinder scaffolds with kit blocks** (its Movements can place), so it crossed dry, and the "was in water" check caught it. Banks of 4+ were vetoed as drops.
  - Shelter: 15 of 20 (75%); all 5 failures were huts of size 4–5 that ran past the 20 s limit.
  - About 10 s a scene, so a 20-scene validation takes 3–4 min.

## Hand-written and 2B's actions (phase 2)
- **One file each in `collect/actions/`,** each exporting an `Authored`: its source, `fits` (from the features) and `target` (its random parameters). The code is a string run in the behavior sandbox, on all three channels (the only layout with legs and aim together).
  - **Shared helpers** (`collect/actions/common.ts`: passable blocks, `walkTo` a column's centre on raw controls, a stall check, the best tool) are **inlined as source into each action** (and into each seeker method's own source), so each stays self-contained and could go into Jeeve's library unchanged.
  - `collect/check.ts` compiles every one as an authored behavior.
- **The actions** (outcomes `done`/`stuck`/`none_found` from the code, `vetoed` when a veto goes uncaught, `timeout` at 20 s):

| Action | Parameters | Fits | Done when |
|---|---|---|---|
| `sprint_jump` | 2–10 jumps, yaw | always | that many landings |
| `walk_raw` | 1–5 s, yaw, key (forward ×2, back, left, right), sneak 30% | always | it covered ¼ of what the key covers on open ground |
| `step_down` | an edge: direction, distance, depth 1–4 | `edges` | standing `depth` lower |
| `climb_down_safely` | a drop: its floor | `drops` | at the floor's height |
| `pillar_up` | 2–8 blocks, which block | blocks in the kit | `n` up |
| `dig_stairs_down` | 3–12 steps, cardinal direction | always | every step dug and taken |
| `tunnel` | 3–15 blocks, cardinal direction | always | every block dug and walked |
| `jump_gap` | a gap: direction, distance, width 1–3 | `gaps` | landed past it, at most a block lower |
| `flee` | a mob, distance 8–20 | mobs | that far from it, or it's gone |
| `cross_water` | a method: `jump_gap` (≤ 3 wide and ≤ 3 away, run-up from where it stands, far bank ≤ 1 up), `navigate`, 2B's `bridge` (straight, ≤ 8 wide), 2B's `swim_across` | `waters` | that method's done |
| `get_down_cliff` | a method: `navigate`, `climb_down_safely` | `drops` | that method's done |
| `reach_ledge` | a method: `navigate`, `pillar_up` (then a step onto it) | `ledges` | that method's done |

- **How they move:**
  - **Raw-control actions press their keys again each tick on the ground,** as a player holds them, so the noise's key releases get corrected.
  - **Every movement-key press is checked by the guards** (0.8 blocks ahead, at the press), so these actions are vetoed where Jeeve would be: a step down of 4, a gap deeper than 3 (vetoed at its edge). Jump and sprint aren't checked, and keys held in the air aren't pressed again, so a sprint-jump can still clear an edge mid-air.
  - **`climb_down_safely`:** the route-finder first, then digging straight down. The guards allow a dig under the feet only while there's a floor within 3 below it. A veto of the route-finder at the edge counts as "no route", not as the outcome.
- **Feature-seeking actions** (`seeker` in `common.ts`) pick a feature and a method that fits it. Their code walks to the block before the feature (`near`), unless the method makes its own run-up, then runs the method's code (another action's source, inlined) on a target made from the feature.
  - Not `step_down` for cliffs: walking off 4+ is always vetoed.
  - **Each method gets its own source** (helpers, the walk to `near`, and that method only), and the target picks it. So 2B's long code (swim_across is 5.8k characters) stays under the library's 8,000 limit.
- **2B's actions** (`collect/author.ts`, smoke VM, 2026-11-02, $0.92; one round each) are committed unchanged as `bridge.ts`, `swim_across.ts` and `shelter.ts`, each exporting its `source`. `from_2b.ts` gives them `fits` and targets in the shapes their trials used:
  - `bridge` `{ name, count, dir }`: a straight gap or water ≤ 8 wide, blocks in the kit. Validation: 100%.
  - `swim_across` `{ at }`: the far bank's ground block. Validation: 60%; the fails are wide, deep rivers with a high far bank.
  - `shelter` `{ name, size 3–5, template wall or hut }`: blocks in the kit. Validation: 100%.
  - **bridge walks to the block before water first** (`near`, through the same approach as the seekers), alone and as `cross_water`'s method. Its code finds the edge only along level ground at the bot's own height, so from where the bot stood it ended `none_found` for half of v3's bridges (766 of 1,543), mostly water up to 12 blocks out over uneven ground. Gaps are on level ground within 3, so a bridge over one still starts where the bot stands.
  - swim_across starts from where the bot stands (it threw from the bank's edge in its trials).
  - **swim_across's `stuck: …` throw returns `stuck`** (a wrapper in `from_2b.ts`; 2B's file is unchanged). In v3 it recorded 15% of swims (295 of 2,030) as `error`, which training drops. Its log in the message (up to 1,500 characters) goes with it: a `stuck` carries no message.
  - **An `error` outcome carries its message** (`error` on the action in the header, ≤ 500 characters). v3 recorded only "error", so the cause couldn't be read back from the data or the logs.
- **The terrain queries** (`terrain()` in `collect/actions.ts`) run once per action choice on the recorder's view (`rec.at`, a block's class).
  - **The walk:** up to 12 blocks out in each of 8 directions, from the bot's own ground (so mid-jump doesn't read as a step down). Each column's ground is read at the walk's current level: below the feet if the feet and head blocks there are open (a canopy overhead isn't a ledge), else the first block up to 4 higher with two open blocks above it. A walk stops at its first feature, at a wall (a rise of 5+), at lava, at an unloaded chunk, or at a diagonal step between two blocked corners. Water more than a block down is a drop, not a crossing. That's ≤ 2,000 lookups.
  - **What it reports:**
    - `edges`: a step down of 1–4 within 4 blocks, on level ground;
    - `drops`: 4+ down, to a floor within 16;
    - `ledges`: 2–4 up;
    - `gaps`: 1–3 wide and 2+ deep, within 3 blocks, on level ground;
    - `waters`: water with land on the far bank within 12 blocks.

    Each comes with where to stand before it and at its far end.
  - **`placeable`:** the kit's full blocks.
- **The kit already covers what the actions need** (blocks 60% of episodes, a pickaxe, axe or shovel 60%), so `collect/bot.ts` is unchanged.
- **Tested locally (2026-11-02, Paper 26.1.2):**
  - **Built scenes on a sky platform:** every action ran.
    - step_down of 2: done; of 4: vetoed.
    - jump_gap 1–3 wide: done; a deep gap: vetoed.
    - climb_down_safely: dug down to the floor.
    - reach_ledge: pillar done; route-finder vetoed (it tried to place a block in the bot).
    - cross_water: route-finder done; jumping 3 with no run-up stuck. With a run-up from where the bot stands (after the review fixes), done.
  - **A 16-minute natural run, 2 bots:** 9.2k steps at 5.0 steps/s. Every action fit at least once except jump_gap: natural gaps on level ground are rare.
  - **Fixed bug:** tunnel and dig_stairs_down sometimes ended in `error` ("nothing to dig at": a passable block that the helpers' `open` list doesn't name). They now dig through the helpers' `clear`, which treats "nothing to dig" as open.

## Measured (local, 2026-11-02, Apple-silicon Mac; one Paper 26.1.2 server, normal terrain, no Chunky)
Two bots for 8 episodes, then one bot for 2 (2 × 4 min + 2 min):
- **Steps per second per bot: 5.00** (median step interval 203 ms, p99 209 ms). Target was ≥ 4.5.
- **CPU per bot: ~7.5% of a core** on average (5–21% per episode); capturing a step takes 2.2–3.2 ms. Bot memory ~190 MB.
- **Paper: ~50% of a core** with 2 bots teleporting into fresh terrain every minute (world generation), 1.7 GB resident.
- **Bytes per step: ~0.67 KB gzipped** (0.48–0.86), against ~15 KB raw. 5M steps ≈ **3.4 GB** compressed, below the plan's 6–10 GB.
- No unloaded chunks in any view; 0.7% of steps had a veto.

The bots are cheap; the servers (terrain generation) are what the VM size depends on. The GCP smoke run measures them on the real machine type, with Chunky.

## Worlds (phase 2)
- **The seed queue runs in rounds** (`deploy/collect/run.sh`): 60 seeds (or `SEEDS`), every sixth held out unless `COLLECT_HELDOUT` names them, kept in `episodes/seeds.txt`. Each round is `SERVERS` seeds (default 8 servers × 8 bots): the Compose file is regenerated with a Paper server and a collector per seed, and the run waits for every collector. A collector stops when its seed has `COLLECT_TARGET_STEPS / seeds` steps (5M / 60 ≈ 83k, ~35 min at 8 bots), so rounds end together and the total is the target.
  - **Switching worlds** restarts the Paper container with the next `SEED` and `LEVEL` (a new world dir in the same volume): no multiworld plugin to keep working on 26.1.2, and every command (`locate`, `fill`, `spreadplayers`) runs in the default world.
  - **Resume:** `<split>/<seed>/coverage.json` holds the steps so far; a seed is done once it has its budget. A second pass reruns the seeds a crashed collector left short, from their saved starts and steps, as does a re-run of the script (on the kept world when the seed gets the same server).
  - **Unattended:** a round that hangs is stopped after `ROUND_TIMEOUT` (2 h; its seeds keep their steps), a round whose servers fail to start is skipped, and any exit copies the data, uploads the log and powers off.
  - **One collector per server:** 60 bots in one Node process would need ~12 GB (smoke run).
- **Start points** (`collect/worlds.ts`): `/locate biome` for 10 kinds (plains, forest, river, ocean shore, mountains, desert, swamp, snowy, jungle, badlands; ids or `#minecraft:is_*` tags), asked from 4 points ~2000 blocks apart: ~36–40 starts in ~15 s, saved to `starts.json` with the seed's episodes. Each kind, plus underground, gets an equal share of natural episodes; a start lands within 24 blocks by `spreadplayers` (underground: `under 50`, the highest floor below y 50, e.g. y −7 in a cave). The header has `start_kind` next to the measured `biome`.
- **Chunky per start**, radius 128 (view distance 96 plus wandering), one task after another: ~40 × 289 chunks ≈ 11.5k, against ~20k for the old 1128-radius square, which also missed starts thousands of blocks out. Scene spots (64 out) see past it, so the edge of their view generates as they arrive. A kept world first gets `chunky continue` (`chunky start` there only asks to confirm); Chunky passes over chunks already generated.
- **Built scenes** (`collect/scenes.ts`, `COLLECT_SCENE_SHARE`, default 20%): river, ravine/cliff, ledge, lava pool, canopy, cave mouth with the plan's ranges. Built **per episode, where the bot lands** (64 blocks from a surface start, on a ring that gives each bot its own spot): the chunks are loaded there, the ground height is read from the bot's own world (below any tree), and the last episode's digging never carries over. A pad (x −6…24, z −12…12) is levelled at that height, topped with the ground's own block (sand in a desert), the obstacle cut ~3–5 blocks ahead, and the bot set facing it (+x). The header's `scene` names it and `scene_params` holds its parameters. Since v4 the scenes are drawn river 3 : ravine 3 : ledge 2 : lava pool, canopy, cave mouth 1 each (v3: uniform).

Local dev run (2026-11-02, one native Paper server, 2 bots, 20 s episodes, a 2-seed queue with one held out): the world switch, 40 and 36 starts located, every kind found on both seeds, 10 of 16 episodes in scenes (all six kinds, every fill accepted), the re-run of a kept world resuming from its starts and step count. Chunky isn't installed locally: its path is untested until the next GCP smoke run.
