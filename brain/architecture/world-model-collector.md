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
| `collect/bot.ts` | One bot per process: teleport + kit over RCON, the scheduler, one file per episode |
| `collect/main.ts` | Starts the bot processes, rotates each server's time and weather every 10 min, starts Chunky, stops at the step target |
| `collect/compose.ts`, `deploy/collect/run.sh` | The Compose file for N Paper servers + the collector, and the VM-side run (copy to the bucket every 10 min, power off at the end) |
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
- **The scheduler:** 15% random input (2–10 s, an Ornstein–Uhlenbeck look drift and random key holds; a vetoed key doesn't end it). Otherwise it picks among actions that fit, weighted by the expected rarity of the outcome each will have here: Σ_o p(o | action) / √(1 + n(biome, action, o)). Counts are shared across all bots through `collect/main.ts` and saved to `coverage.json`.
- **Noise while an action runs:** yaw wobbles, an extra jump, a brief forward release, a pause. Each step records which kinds were injected (`noise`).
- **Outcomes:** the first terminal end of the action's runs (done, stuck, none_found, vetoed, target_dead, target_lost…), or `timeout` (its own limit, ≤20 s), `episode_end`, `died`, `stopped`.
- **Episode start:** `spreadplayers` (surface only, never in a liquid; retried up to 10 times), clear, heal, feed, then a random kit (blocks, a tool, a sword, food, torches).

## Hand-written actions (phase 2)
- **One file each in `collect/actions/`,** each exporting an `Authored`: its source, `fits` (from the features) and `target` (its random parameters). The code is a string run in the behavior sandbox, on all three channels (the only layout with legs and aim together).
  - **Shared helpers** (`collect/actions/common.ts`: passable blocks, `walkTo` a column's centre on raw controls, a stall check, the best tool) are **inlined as source into each action**, so each stays self-contained and could go into Jeeve's library unchanged.
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
| `cross_water` | a method: `jump_gap` (≤ 3 wide), `navigate` | `waters` | that method's done |
| `get_down_cliff` | a method: `navigate`, `climb_down_safely` | `drops` | that method's done |
| `reach_ledge` | a method: `navigate`, `pillar_up` (then a step onto it) | `ledges` | that method's done |

- **How they move:**
  - **Raw-control actions press their keys again each tick on the ground,** as a player holds them, so the noise's key releases get corrected.
  - **Every press is checked by the guards,** so these actions are vetoed where Jeeve would be: a step down of 4, a gap deeper than 3 (vetoed at its edge), sprinting off a cliff.
  - **`climb_down_safely`:** the route-finder first, then digging straight down. The guards allow a dig under the feet only while there's a floor within 3 below it. A veto of the route-finder at the edge counts as "no route", not as the outcome.
- **Feature-seeking actions** (`seeker` in `common.ts`) pick a feature and a method that fits it. Their code walks to the block before the feature (`near`), then runs the method's code (another action's source, inlined) on a target made from the feature.
  - Not `step_down` for cliffs: walking off 4+ is always vetoed.
  - **2B's bridge and swim across join `cross_water`'s method list** once they're in `collect/actions/` (the slot is marked in `cross_water.ts`).
- **The terrain queries** (`terrain()` in `collect/actions.ts`) run once per action choice on the recorder's view (`rec.at`, a block's class).
  - **The walk:** up to 12 blocks out in each of 8 directions. Each column's ground is the first block that isn't open, from 4 above the feet down to 16 below. A walk stops at its first feature, at a wall (a rise of 5+), at lava or at an unloaded chunk. That's ≤ 2,000 lookups.
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
    - cross_water: route-finder done; jumping 3 with no run-up stuck.
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
