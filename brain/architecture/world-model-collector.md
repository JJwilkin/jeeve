---
date: 2026-11-02
tags: [architecture, world-models, data, infrastructure]
status: active
---
# World-model collector (phase 1)

What [[world-model-data]] phase 1 built in `collect/`, and what the first local run measured. The plan stays in the task note; this is how it works now.

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
- **Authored-format actions** (`async (api, target) => …`) run through `authoredSpec`, unchanged: library ones by name (`FROM_LIBRARY` in `collect/actions.ts`) and phase-2 hand-written or 2B-written ones (`HAND_WRITTEN`, one file each in `collect/actions/`).
- **`climb_down_safely` is not in `modules/library.json`** (the library on main is empty, and no branch has it). The collector runs it if it appears; until then it's phase-2 work like the other hand-written actions.
- **The scheduler:** 15% random input (2–10 s, an Ornstein–Uhlenbeck look drift and random key holds; a vetoed key doesn't end it). Otherwise it picks among actions that fit, weighted by the expected rarity of the outcome each will have here: Σ_o p(o | action) / √(1 + n(biome, action, o)). Counts are shared across all bots through `collect/main.ts` and saved to `coverage.json`.
- **Noise while an action runs:** yaw wobbles, an extra jump, a brief forward release, a pause. Each step records which kinds were injected (`noise`).
- **Outcomes:** the first terminal end of the action's runs (done, stuck, none_found, vetoed, target_dead, target_lost…), or `timeout` (its own limit, ≤20 s), `episode_end`, `died`, `stopped`.
- **Episode start:** `spreadplayers` (surface only, never in a liquid; retried up to 10 times), clear, heal, feed, then a random kit (blocks, a tool, a sword, food, torches).

## Measured (local, 2026-11-02, Apple-silicon Mac; one Paper 26.1.2 server, normal terrain, no Chunky)
Two bots for 8 episodes, then one bot for 2 (2 × 4 min + 2 min):
- **Steps per second per bot: 5.00** (median step interval 203 ms, p99 209 ms). Target was ≥ 4.5.
- **CPU per bot: ~7.5% of a core** on average (5–21% per episode); capturing a step takes 2.2–3.2 ms. Bot memory ~190 MB.
- **Paper: ~50% of a core** with 2 bots teleporting into fresh terrain every minute (world generation), 1.7 GB resident.
- **Bytes per step: ~0.67 KB gzipped** (0.48–0.86), against ~15 KB raw. 5M steps ≈ **3.4 GB** compressed, below the plan's 6–10 GB.
- No unloaded chunks in any view; 0.7% of steps had a veto.

The bots are cheap; the servers (terrain generation) are what the VM size depends on. The GCP smoke run measures them on the real machine type, with Chunky.
