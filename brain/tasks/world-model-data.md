---
date: 2026-11-02
tags: [task, world-models, data, infrastructure, perception]
status: active
progress: todo
---
# Task: collect state data for a small world model

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/world-model-data.md`."

## Why
2A got stuck at a river because nothing tells it how terrain behaves ([[3d-world-representation]]). The plan there is a region graph built by code. This task tests the other half of the idea: a **small model trained on game state, not pixels** ("Tier 1"), which learns from scripted bots when each action works. Scripted actions are the vocabulary; the model learns when each one succeeds, so it can rank options in places no script was written for ("bridge 3 here: 0.9, swim: 0.2, walk upstream: 0.6").

This task only collects the data. Training is a separate decision, and reopens "context only, no training" ([[learning]]).

## Decisions (Joshua, 2026-11-02)
- **Tier 1 first:** a 5–20M-parameter encoder with task heads.
- **Not on the Mac.** Collection runs on a separate GCP VM, so it doesn't depend on the laptop being on.
- **Scaled out to finish in ~4–5 hours** on one big VM, at about $15–17 in total ("that pricing works").

## What one recorded step holds (5 per second)
| Part | Contents |
|---|---|
| Self | position, velocity, yaw/pitch, on_ground, in_water, health, food, held item |
| Block crop | 16 × 16 × 16 around the feet (x ±8, y −6…+9, z ±8), each block mapped to ~64 classes (air, walkable solid, water, lava, leaves, log, ores…) |
| Entities | the 8 nearest: type, position relative to the bot, velocity |
| Low-level action | the step's controls (forward/back/left/right/jump/sprint/sneak), yaw/pitch change, dig or place target, and any guard veto. Captured where `installGuards` (`src/guards.ts`) already wraps `setControlState`, `dig` and `place` |
| Scripted action | which one is running, its parameters, and how and when it ended (done, stuck, vetoed, died, timeout) |

- **The crop is the server's true state.** Read it with `bot.world.getBlockStateId`, not `blockAt`, which builds an object per block.
- **The "seen" bit is computed offline,** from the recorded eye position and crop, with the same rule as `src/world.ts` (a ray from the eyes reaches a face with an empty neighbour). Running the seen memory live costs ~80–450 ms a pass, which is most of an asleep Jeeve's CPU ([[deployment]]); collection would pay it 20 times over.
- **`raw_state` isn't reused:** it keeps only the 12 most notable block types.
- **Format:** one file per 60-second episode: a JSON header (seed, start, biome, server conditions, the block-class table) and fixed-size binary records, gzipped. A ~20-line Python reader goes in the repo next to it.

## Variety
**Worlds**
- Real terrain, not the dev server's superflat. **60 seeds: 50 for training, 10 held out** (never trained on; the test set).
- **Biome quotas** for start points: plains, forest, river, ocean shore, mountains, desert, swamp, snowy, jungle, badlands, and underground starts below y 50. Found once per seed with `/locate biome` over RCON and saved to the bucket.
- **Terrain generated up front** around each start with the Chunky plugin, so bots never wait for chunks.
- **Conditions:** day and night (night brings mobs), clear and rain. Time and weather are per server, so each server rotates them every 10 minutes.

**Episodes**
- 60 s each. The bot is teleported to a fresh start point with a random kit (`/give`: blocks for bridging and pillars, food, a tool), in survival.
- Bots on one server start at least 200 blocks apart. A death ends the episode with outcome "died"; the bot respawns and the next episode starts.

**Scripted actions** (random parameters each time; each lasts at most 20 s)
| Group | Actions |
|---|---|
| Movement | `navigate` and `wander` (from `src/behaviors.ts`), sprint-jump, swim across water, climb up, step down, walk straight on raw controls (produces falls and vetoes) |
| Terrain | dig down by stairs, tunnel, fell a tree (`collect`), collect a resource |
| Building | bridge a gap or water N blocks, pillar up, a wall, a small shelter from a template |
| Interaction | chest, crafting, `eat` |
| Mobs | `track`, flee, `attack_when_ready` (night) |
| Feature-seeking | cross the nearest water, get down this cliff, get to that ledge: find the feature, then try a random suitable method |
| Random input | short bursts of random raw controls, so failures and odd states are covered too |

- **The collection-only actions live in `collect/`**, not in `src/behaviors.ts`. Ones that prove useful can move to Jeeve later.
- **A scheduler** picks the next action, weighted toward biome × action × outcome combinations that are still rare.
- **Vetoes and failures are kept on purpose:** they're the "this won't work here" labels.
- **The guards run as they do in Jeeve,** so the labels match Jeeve's rules. That includes fixing the water-drop mismatch first (below).

## Infrastructure
| | |
|---|---|
| **Smoke-run VM** | `jeeve-collect-smoke`: e2-standard-8, us-west1, ~1 hour, then deleted |
| **Big-run VM** | `jeeve-collect`: **c2d-standard-56** (56 vCPU, 224 GB), us-west1, standard (not spot), 100 GB disk |
| **Quota needed** | "CPUs (all regions)" from 32 to 96. C2D's regional limit (100) already allows it |
| **What runs** | Docker Compose, generated by a script: 14–16 Paper servers (itzg image as on the Jeeve VM, each with its own `SEED`, Chunky, RCON inside the Compose network) + one collector container (the `jeeve` image, a different command) running the bots, the scheduler and the recorder |
| **Seeds per server** | each works through a queue of ~4 seeds: start the world, generate terrain, run ~1 hour of bot time, next seed |
| **No public access** | no open ports, SSH over IAP only, no Tailscale, no API keys (no model calls). Only `MINECRAFT_EULA=true` |
| **Data** | episodes written to the VM disk, copied every 10 minutes to the private bucket **`gs://jeeve-worlddata/v1/{train,heldout}/{seed}/`**, plus a coverage report (counts by biome × action × outcome). Nothing goes to the laptop |
| **Stopping** | the collector stops at the step target, copies the last data, and shuts the VM down. Backstop: the VM is created with an 8-hour maximum run time and stops itself either way |

## Size and cost
- **Target:** ~5M steps ≈ 280 bot-hours (Chinchilla's ~20 tokens per parameter for 20M parameters, at ~75 tokens a step; a rule of thumb, not a law).
- **Storage:** ~21 GB raw, ~2–4 GB compressed.
- **Cost:**
  - big run ~$15 (c2d-standard-56 at ~$2.54/h × ~6 h, including terrain generation);
  - smoke run ~$0.30;
  - disk ~$0.10;
  - bucket ~$0.06 a month;
  - $0 in model calls.
  - Worst case ~$20 (the 8-hour cap).

## Phases
0. **Prerequisite:** land the water-drop fix (`moves.infiniteLiquidDropdownDistance = false` in `guardedMovements`), so the route-finder never plans a drop the guards veto. Otherwise every water label would teach the bug.
1. **Recorder, format and a first scripted bot:** written and unit-tested in the repo. Then the smoke run: one server, 4 then 8 bots, ~1 hour. It measures:
   - steps per second per bot (target ≥ 4.5);
   - CPU per bot and per server;
   - MB per step;
   - Chunky's chunks per second.

   Check: replay one episode in the monitor and read it back with the Python reader. **Go/no-go for the big run, and the final VM size, come from these numbers.**
2. **Variety:** seed and biome sampler, terrain pre-generation, the remaining scripted actions, the scheduler, the coverage report, a second smoke run.
3. **The big run,** after the quota increase.
4. **Training** (separate decision): a no-neural-net baseline first (decision trees on hand-built features), then Tier 1, tested on the held-out seeds and on the river scene against the code-only baseline.
5. **Joshua's play** (later): an observer bot in spectator mode on the Jeeve server records his sessions in the same format, for demonstrations and fine-tuning ([[3d-world-representation]]).

## Safety (outward-facing, so confirm first)
Creating the VMs and the bucket, the quota request, and each run need Joshua's yes, with this plan as the brief. Creating them: Claude, with gcloud from Joshua's account. All of it is in project `jeeve-513410`; teardown is `gcloud compute instances delete` and `gcloud storage rm -r`.

## Done when
- 5M steps across the 60 seeds are in the bucket, held-out seeds kept apart, with a coverage report showing every biome × action group represented, and the Python reader loading them.
- The smoke-run measurements and the big run's actual cost are recorded here, and the VMs are gone.
