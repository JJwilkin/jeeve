---
date: 2026-11-02
tags: [task, world-models, data, infrastructure, perception]
status: active
progress: doing
---
# Task: collect state data for a small world model

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/world-model-data.md`."

## Why
2A got stuck at a river because nothing tells it how terrain behaves ([[3d-world-representation]]). The plan there is a region graph built by code. This task tests the other half of the idea: a **small model trained on game state, not pixels** ("Tier 1"), which learns from scripted bots when each action works. Scripted actions are the vocabulary; the model learns when each one succeeds, so it can rank options in places no script was written for ("bridge 3 here: 0.9, swim: 0.2, walk upstream: 0.6").

This task only collects the data. Training is a separate decision, and reopens "context only, no training" ([[learning]]).

## Decisions (Joshua, 2026-11-02)
- **Tier 1 first:** a 5–20M-parameter encoder with task heads.
- **Not on the Mac.** Collection runs on a separate GCP VM, so it doesn't depend on the laptop being on.
- **Scaled out to finish in ~4–5 hours** on one big VM, at about $15–17 for compute ("that pricing works").
- **A 64-block view, in layers** (fine near, coarse far), not a 16-block cube.
- **Worlds: ~80% natural seeds, ~20% built stress scenes.**
- **All four action groups in v1:** movement and terrain, crossing, building and resources, mobs and random input.
- **2B writes the hard actions now** (bridge, swim across, shelter); the rest are hand-written or reused.

## What one recorded step holds
| Part | Contents | Rate |
|---|---|---|
| Self | position, velocity, yaw/pitch, on_ground, in_water, health, food, held item | 5/s |
| Near view | 16³ around the feet (x ±8, y −6…+9, z ±8), every block, ~64 block classes (air, walkable solid, water, lava, leaves, log, ores…) | 5/s |
| Mid view | 32³ around the feet in 2×2×2 cells (each cell: its main class, plus whether it holds water, lava or air) | 5/s |
| Far view | 64 × 64 columns top-down (a height map): ground height relative to the feet, top block class (water, lava, leaves, solid…), water depth | 1/s |
| Entities | the 8 nearest within 32 blocks: type, position relative to the bot, velocity | 5/s |
| Low-level action | the step's controls (forward/back/left/right/jump/sprint/sneak), yaw/pitch change, dig or place target, and any guard veto. Captured where `installGuards` (`src/guards.ts`) already wraps `setControlState`, `dig` and `place` | 5/s |
| Scripted action | which one is running, its parameters, and how and when it ended (done, stuck, vetoed, died, timeout) | per action |

- **About 200 model tokens a step** (64 near + 64 mid + 64 far, plus entities and self), and ~16 KB raw.
- **The views are the server's true state.** The server sends terrain out to ~96 blocks (view distance 6 chunks), so 64 blocks are available. Read with `bot.world.getBlockStateId`, not `blockAt`, which builds an object per block.
- **The "seen" bit is computed offline,** from the recorded eye positions and views, with the same rule as `src/world.ts` (a ray from the eyes reaches a face with an empty neighbour). Running the seen memory live costs ~80–450 ms a pass, which is most of an asleep Jeeve's CPU ([[deployment]]). It matters most for the far view: Jeeve's own far observation reaches only 24 blocks.
- **Long routes stay with the region graph** ([[3d-world-representation]]). The 64-block view gives the model local context ("where the river goes, where the bank drops"), not routes across hundreds of blocks.
- **`raw_state` isn't reused:** it keeps only the 12 most notable block types.
- **Format:** one file per 60-second episode: a JSON header (seed, start, biome, scene, server conditions, the block-class table) and fixed-size binary records, gzipped. A ~20-line Python reader goes in the repo next to it.

## Worlds
**Natural (~80% of episodes)**
- Real terrain, not the dev server's superflat. **60 seeds: 50 for training, 10 held out** (never trained on; the test set).
- **Biome quotas** for start points: plains, forest, river, ocean shore, mountains, desert, swamp, snowy, jungle, badlands, and underground starts below y 50. Found once per seed with `/locate biome` over RCON and saved to the bucket.
- **Terrain generated up front** around each start with the Chunky plugin, so bots never wait for chunks.
- **Conditions:** day and night (night brings mobs), clear and rain. Time and weather are per server, so each server rotates them every 10 minutes.

**Built stress scenes (~20%)**

These are dropped into natural worlds with `/fill`, the same way `scripts/scenes.ts` builds bench scenes from a seed. Natural rivers and cliffs come in too few shapes, and the river that stuck Jeeve_1 is the kind of case that needs many variations.

| Scene | Varies |
|---|---|
| River | width 1–8, depth 1–6, bank height 0–5, straight or bent |
| Ravine / cliff | drop 3–20, width 2–10, with or without a slope down |
| Ledge | rise +2 to +6, overhang or not |
| Lava pool | size 2–6, next to the path or across it |
| Dense canopy | height 4–10, leaves thick enough to walk on |
| Cave mouth | opening 1–3 wide, sloping down 5–15 |

Held-out seeds hold out their built scenes too.

## Scripted actions
| # | Action | Random parameters | Needs nearby | Made by |
|---|---|---|---|---|
| 1 | `navigate` to a point | distance 5–40, direction | – | reuse (`src/behaviors.ts`) |
| 2 | `wander` | – | – | reuse |
| 3 | sprint-jump | 2–10 jumps, direction | – | hand |
| 4 | walk on raw controls | 1–5 s, direction, sneak or not | – | hand |
| 5 | step down | 1–4 blocks | a ledge | hand |
| 6 | `climb_down_safely` | – | being up high (a drop of 4+) | hand (not in the library after all) |
| 7 | pillar up | 2–8 blocks | blocks in kit | hand |
| 8 | dig stairs down | 3–12 steps | – | hand |
| 9 | tunnel | 3–15 blocks, direction | – | hand |
| 10 | **swim across** | aim point on the far bank | water | **2B** (60%) |
| 11 | **bridge** | 1–8 blocks, direction | a gap or water | **2B** (100%) |
| 12 | jump a gap | width 1–3 | a gap | hand |
| 13 | fell a tree (`collect`) | which tree | trees | reuse |
| 14 | collect a resource | block type | that block | reuse |
| 15 | **wall / small shelter** | size 3–5, template | blocks in kit | **2B** (100%) |
| 16 | `track` / flee / `attack_when_ready` | which mob (flee: how far, 8–20) | mobs (night) | reuse; flee by hand |
| 17 | feature-seeking: cross water, get down a cliff, reach a ledge | a method drawn from those that fit: water 12 or 1 (10, 11 when 2B's land), cliff 6 or 1, ledge 7 or 1 | that feature | hand (picks among the others) |
| 18 | random input | 2–10 s | – | generated |

Chests, crafting and eating are out of v1: they teach little about space, and eating happens anyway when the kit's food is used.

### How they're made
- **One format for all.** Every action is a behavior in the format 2B writes: `async (api, target) => 'done' | 'stuck' | 'none_found'`, on the same `api` (`api.control`, `api.goto`, `api.look`, `api.place`, `api.dig`, `api.blockAt`…). This gives three things for free:
  - **logging:** the runner for authored behaviors already logs each API call with its result and timing;
  - **the same rules:** the same guards and channel limits as Jeeve;
  - **promotion:** any that prove useful can go into Jeeve's library unchanged.
- **Hand-written ones** live in `collect/actions/`, ~20–40 lines each ([[world-model-collector]] → "Hand-written actions"). Step down isn't a cliff method: walking off 4+ is always vetoed by the guards.
- **2B's three** (bridge, swim across, shelter) are written by calling `build()` (`src/builder.ts`) from a small script (`collect/author.ts`). The script hands 2B a capability request and a pass check, as 2A would, and runs the trials on built scenes. Done 2026-11-02 in one round each ($0.92); they're in `collect/actions/` and the collector runs them ([[world-model-collector]]).
  - **The bar:** each must pass on at least half of a validation set of 20 built scenes (rivers and gaps of varied width, depth and bank height). Below that, 2B gets the failing scenes as evidence and another round.
  - **Imperfect is fine:** a 70% bridge gives the model the failures it needs to learn when bridging won't work.
- **Feature-seeking actions find their target with small code queries on the views:** the nearest water with land on both sides, the nearest drop of 4+, a ledge 2–4 up.
- **Noise injected into running actions:** small yaw wobbles, an occasional extra jump or brief key release, an occasional forced pause. This gives "slightly off, then recovered" data (DART-style noise injection).
- **Random input** is 2–10 s of random key holds with random durations, and a smoothly drifting look direction (correlated noise, not jitter).

### The scheduler
For each bot, it repeats:
1. Read the views and note the nearby features (water, a drop, trees, a ledge, mobs).
2. Pick an action that fits, weighted toward biome × action × outcome combinations that are still rare.
3. Draw its parameters, run it for up to 20 s with noise on, and record the outcome.
4. About 15% of the time, run random input instead.

Vetoes, failures and deaths are kept on purpose: they're the "this won't work here" labels.

**Why scripted data doesn't make a scripted model:** the model is given which action ran and learns what happened, so who chose the action doesn't matter. What matters is how varied the starting states are, which is what the seeds, built scenes, noise and random input are for.

## How the model would fit into Jeeve
- **It doesn't need intent.** It answers: "if I run action A with parameters P here, what happens, how long does it take, and where do I end up?" Intent stays in 2A's goal tree ([[system-2]]): the goal says which outcome is wanted; the model says which action gets there.
- **Where it plugs in:**
  1. **Jev's options** (`src/decide.ts`). Each option gets a predicted outcome. One predicted to be vetoed is marked "likely blocked" or not offered. At the river, `navigate:place` would have shown as failing and "bridge 3" as likely to work.
  2. **A tool for 2A**, like `reachable`: `predict(action, params, at)`, or "ways to reach X", ranked.
  3. **Link costs in the region graph:** crossing links get their success odds and time from the model, not hand-set numbers.
  4. **2B's trials:** predict whether a new behavior will pass before spending one of its 4 live trials.
- **Where it runs:** inside the Jeeve container, on CPU, via onnxruntime; a batch of options scores in milliseconds.
- **Learned intent comes later.** A goal-conditioned head ("to get there, which action next?") is trained with hindsight relabelling, then post-trained on Joshua's recorded play.

## Infrastructure
| | |
|---|---|
| **Authoring + smoke VM** | `jeeve-collect-smoke`: e2-standard-8, us-west1, a few hours across phases 1–2, deleted after each use |
| **Big-run VM** | `jeeve-collect`: **c2d-standard-56** (56 vCPU, 224 GB), us-west1, standard (not spot), 200 GB disk |
| **Quota needed** | "CPUs (all regions)" from 32 to 96. C2D's regional limit (100) already allows it |
| **What runs** | Docker Compose, generated by a script per round of seeds: 8 Paper servers (itzg image as on the Jeeve VM, each with its own `SEED`, Chunky, RCON inside the Compose network), each with its own collector container (the `jeeve` image, a different command) running its bots, the scheduler and the recorder |
| **Seeds per server** | each works through a queue of ~7–8 seeds: start the world, generate terrain, run ~35 min of bot time (5M steps / 60 seeds), next seed; stress scenes are built per episode ([[world-model-collector]] → "Worlds") |
| **No public access** | no open ports, SSH over IAP only, no Tailscale. Only `MINECRAFT_EULA=true` |
| **API keys** | only for 2B's authoring, on the smoke VM: an Anthropic key and the Judgment keys (2B's work is traced to `jeeve-test` like live builds), sent over stdin as on the Jeeve VM, gone when the VM is deleted. The big run has no keys and makes no model calls |
| **Data** | episodes written to the VM disk, copied every 10 minutes to the private bucket **`gs://jeeve-worlddata/v1/{train,heldout}/{seed}/`**, plus a coverage report (counts by biome × scene × action × outcome). Nothing goes to the laptop |
| **Stopping** | the collector stops at the step target, copies the last data, and shuts the VM down. Backstop: the VM is created with an 8-hour maximum run time and stops itself either way |

## Size and cost
- **Target:** ~5M steps ≈ 280 bot-hours. That's for 20M parameters at Chinchilla's ~20 tokens per parameter: 400M tokens at ~200 tokens a step needs only ~2M steps. 5M gives headroom, and costs little more on one VM. A rule of thumb, not a law.
- **Storage:** ~45 GB raw (~16 KB a step, with the far view once a second), ~6–10 GB compressed.
- **Cost:**
  - big run ~$15 (c2d-standard-56 at ~$2.54/h × ~6 h, including terrain generation);
  - 2B authoring ~$5–15 in Opus calls (about $0.11 a builder call in the live run; each action takes ~10–30 calls over its trials and retries);
  - smoke VM ~$1 (a few hours of e2-standard-8);
  - disks ~$0.20;
  - bucket ~$0.20 a month.
  - Total ≈ **$20–30**, worst case ~$35 (the 8-hour cap plus a costly authoring round).

## Phases
*Phase 1 is done ([[world-model-collector]]). `climb_down_safely` turned out not to be in the library, so action 6 is phase-2 work.*

**Smoke run (2026-11-02, `jeeve-collect-smoke`, one server, one seed, 4 then 8 bots, ~95 min):**
- **Rate:** 5.01 steps/s per bot in both phases (target ≥ 4.5); 0 crashes, 0 throttled logins; 571 episodes, 107,515 steps.
- **CPU:** the collector ~13–15% of a core per bot. Per server at 8 bots: collector 104%, Paper 117% on average (peaks ~250% while Chunky or new chunks load). So 8 bots ≈ 2.2 cores.
- **Memory:** Paper ~3.75 GB per server; the collector ~200 MB per bot, flat over time.
- **Size:** 0.6 KB a step gzipped, so 5M steps ≈ 3 GB.
- **Read back:** an episode loads in `collect/read_episode.py`.
- **It took three fixes to get here:** `collect/` missing from the image (#21), logins throttled and chunk-load timeouts (#22), and a stop inside the route-finder's tick that crashed it (#23; live Jeeve had it too).
- **What it means for the big run:**
  - ~60 bots finish 5M steps in ~4.6 h, on 8 servers using ~18 cores on average. A c2d-standard-32 (~$7) fits the current 32-CPU quota, so the c2d-standard-56 and the quota request below may be unneeded.
  - Run one collector per server: 60 bots in one Node process would need ~12 GB, past Node's default heap.
  - One seed gave 39% savanna and 6 river episodes; variety has to come from phase 2's seeds and scenes.

0. **Prerequisite:** land the water-drop fix (`moves.infiniteLiquidDropdownDistance = false` in `guardedMovements`), so the route-finder never plans a drop the guards veto. Otherwise every water label would teach the bug.
1. **Recorder, format and the reused actions:** written and unit-tested in the repo. Then the smoke run: one server, 4 then 8 bots, ~1 hour. It measures:
   - steps per second per bot (target ≥ 4.5);
   - CPU per bot and per server;
   - MB per step;
   - Chunky's chunks per second.

   Check: replay one episode in the monitor and read it back with the Python reader. **Go/no-go for the big run, and the final VM size, come from these numbers.**
2. **Variety and authoring:**
   - the seed and biome sampler, terrain pre-generation, the built stress scenes (done, [[world-model-collector]] → "Worlds": a queue of seeds in rounds of 8 servers, ~35 min a seed, scenes built per episode);
   - the hand-written actions, the noise and random input, the scheduler, the coverage report;
   - **2B authors bridge, swim across and shelter** on the smoke VM, against the 20-scene validation set. *The harness is built (`collect/author.ts`, `deploy/collect/author.sh`; [[world-model-collector]] → "2B's actions") and was tested end to end with a stubbed builder on the dev server. The real run (keys on the smoke VM, ~$3–8 expected, $25 cap) is still to do;*
   - a second smoke run with everything on.
3. **The big run,** after the quota increase. *Started 2026-11-02 18:28 UTC on `jeeve-collect` (c2d-standard-32, 8 servers × 8 bots, 60 seeds), into `gs://jeeve-worlddata/v3`; `v1/` holds smoke run 1.* *v4, the second collection (fixes #34 and #36, weighted toward crossing and climbing), went into `gs://jeeve-worlddata/v4` on 2026-11-03: 60 new seeds, 5.08M steps, on a c2d-standard-16 for 6.2 h (~$4.5). Its coverage against v3 is in [[world-model-collector]] → "The v4 run, against v3".*
4. **Training** (separate decision; code written 2026-11-02, not yet run: [[world-model-training]]): a no-neural-net baseline first (decision trees on hand-built features), then Tier 1, tested on the held-out seeds and on the river scene against the code-only baseline. Decided with Joshua, 2026-11-02:
   - **True state, no handicap:** the model trains on the server's views as recorded, and live Jeeve reads the chunks the server sends in the same way. Masking to what a player could see can come later.
   - **One view builder:** live inference calls the recorder's view code (`collect/recorder.ts`) on the live bot, giving the same byte layout; Python only reads it.
   - **Sizes:** train ~2M, 5M and 15M parameters on one L4 and keep the best by held-out calibration. ~160k labelled actions (one per ~31 steps) cap the outcome head; a dense extra objective over all 5M steps (where the bot is 1 s and 3 s later, vetoes, damage) is what can use the larger sizes.
   - **Durations are censored at 20 s:** a survival-style loss, not plain regression.
   - **Defaults, not yet questioned:** the action is an input (a query against the encoded state, so many options score for the cost of one); samples are rotated so the action's target points one way, with rotations and mirrors as augmentation; `error` outcomes are dropped, and `none_found` is left out of the success head; temperature scaling on the held-out seeds.
5. **Joshua's play** (later): an observer bot in spectator mode on the Jeeve server records his sessions in the same format, for demonstrations and fine-tuning ([[3d-world-representation]]).

## Safety (outward-facing, so confirm first)
Creating the VMs and the bucket, the quota request, putting keys on the smoke VM, and each run need Joshua's yes, with this plan as the brief. Creating them: Claude, with gcloud from Joshua's account. All of it is in project `jeeve-513410`; teardown is `gcloud compute instances delete` and `gcloud storage rm -r`.

## Done when
- 5M steps across the 60 seeds are in the bucket, held-out seeds kept apart, with a coverage report showing every biome, scene and action group represented, and the Python reader loading them.
- 2B's three actions pass their validation bar and sit in `collect/actions/`.
- The smoke-run measurements and the actual costs are recorded here, and the VMs are gone.
