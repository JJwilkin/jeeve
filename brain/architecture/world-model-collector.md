---
date: 2026-11-02
tags: [architecture, world-models, data, infrastructure]
status: active
---
# World-model collector

What [[world-model-data]] phase 1 built in `collect/`, and what the first local run measured. The plan stays in the task note; this is how it works now.

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
- **Authored-format actions** (`async (api, target) => …`) run through `authoredSpec`, unchanged: library ones by name (`FROM_LIBRARY` in `collect/actions.ts`) and phase-2 hand-written or 2B-written ones (`HAND_WRITTEN`, one file each in `collect/actions/`).
- **`climb_down_safely` is not in `modules/library.json`** (the library on main is empty, and no branch has it). The collector runs it if it appears; until then it's phase-2 work like the other hand-written actions.
- **The scheduler:** 15% random input (2–10 s, an Ornstein–Uhlenbeck look drift and random key holds; a vetoed key doesn't end it). Otherwise it picks among actions that fit, weighted by the expected rarity of the outcome each will have here: Σ_o p(o | action) / √(1 + n(biome, action, o)). Counts are shared among one server's bots through `collect/main.ts` and saved to the seed's `coverage.json`, so each seed is balanced on its own.
- **Noise while an action runs:** yaw wobbles, an extra jump, a brief forward release, a pause. Each step records which kinds were injected (`noise`).
- **Outcomes:** the first terminal end of the action's runs (done, stuck, none_found, vetoed, target_dead, target_lost…), or `timeout` (its own limit, ≤20 s), `episode_end`, `died`, `stopped`.
- **Episode start:** `spreadplayers` around a start point (below), clear, heal, feed, then a random kit (blocks, a tool, a sword, food, torches).

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
- **Built scenes** (`collect/scenes.ts`, `COLLECT_SCENE_SHARE`, default 20%): river, ravine/cliff, ledge, lava pool, canopy, cave mouth with the plan's ranges. Built **per episode, where the bot lands** (64 blocks from a surface start, on a ring that gives each bot its own spot): the chunks are loaded there, the ground height is read from the bot's own world (below any tree), and the last episode's digging never carries over. A pad (x −6…24, z −12…12) is levelled at that height, topped with the ground's own block (sand in a desert), the obstacle cut ~3–5 blocks ahead, and the bot set facing it (+x). The header's `scene` names it and `scene_params` holds its parameters.

Local dev run (2026-11-02, one native Paper server, 2 bots, 20 s episodes, a 2-seed queue with one held out): the world switch, 40 and 36 starts located, every kind found on both seeds, 10 of 16 episodes in scenes (all six kinds, every fill accepted), the re-run of a kept world resuming from its starts and step count. Chunky isn't installed locally: its path is untested until the next GCP smoke run.
