---
date: 2026-11-03
tags: [architecture, world-models, system-1]
status: active
---
# The world model live (Tier 1 on Jev's options)

How the Tier 1 outcome model ([[world-model-training]]) runs inside Jeeve: plug-in point 1 of [[world-model-data]] → "How the model would fit into Jeeve". Code: `src/wm.ts`; the hook is in `src/decide.ts`.

## One view builder
- **The live bot reads the world with the recorder's code** (`collect/recorder.ts` `fill` + `farView`): a recorder that never records an episode. So training and live can't drift apart.
- **The frame and the hashing are ported from `train/data.py`** (`sample`, `param_vector`, `target_of`, the four rotations). `train/tests/test_parity.py` checks them on random episodes: every row `data.py` makes (action starts and dense rows, all four rotations) must give the same arrays, exactly for the grids and within 1e-6 for the floats. Change either side and that test must still pass.
- **Inference:** `onnxruntime-node` on one thread. One encoding per rotation the options need (at most 4), then one query batch per rotation. Measured locally: 7–50 ms per decision, including the view capture. Node's outputs match torch to 5e-6 on the 2M weights.

## What Jev sees
- **Scored options.** A live behavior maps to the collector action with the same parameter shapes:
  - navigate (an entity or the goal's place) → `navigate`;
  - collect → `collect`;
  - track → `track`;
  - attack_when_ready → `fight`;
  - wander → `wander`;
  - eat → `eat`.

  follow, glance and authored behaviors have no match, so they go unscored.
- **"Likely to fail."** An option the model gives under `JEEVE_WM_BLOCKED_BELOW` (default 0.2) success gets that, with its most likely failure, appended to its description. Live behaviors have no 20 s limit, so for them success is anything but stuck, vetoed or died: "timeout" means the action was still going at the collector's limit.
- **Crossings.** The collector's three seekers become whole-body options when `terrain()` finds their feature within 12 blocks: `cross_water`, `get_down_cliff` and `reach_ledge`.
  - The nearest feature of each kind is offered as one option, e.g. `reach_ledge:east:pillar_up`.
  - The method is the model's top pick among those that fit. For crossings success means done within 20 s.
  - A method that just got stuck there cools down, as any option does, so the next method gets its turn.
  - They run through `authoredSpec` under the same guards as any behavior.
  - This puts hand-written behaviors on Jev's menu, which [[bitter-lesson]] would question. It was Joshua's call (2026-11-03), so the model's method choice changes what Jeeve does. 2A and 2B still own crossings that these can't do.

## Seeing it
- **In the logs,** each decide prints `[wm] <ms>; <question> picked <option> (<odds>) | <top options>`.
- **In the decide span,** `output.wm` holds every scored option (outcome probabilities, expected duration, health change, every crossing method's odds), and `jeeve.wm.ms` holds the time taken.
- **In the brain monitor** (System 1 card), the chosen option shows its odds (`· wm 74%`), with a "world model" line of the best options. `✗` marks options flagged likely to fail.

## Switches and files
- `JEEVE_WM=0` turns it off. So does a missing model (`wm/` empty).
- `JEEVE_WM_DIR` picks another model directory.
- `deploy/setup.sh` copies `gs://jeeve-worlddata/models/${WM_MODEL:-2m-v3}/*` into `wm/`, and the image bakes it in (`wm/README.md`). A larger size goes live by exporting it to its own folder and re-running setup with `WM_MODEL`.
- `ORT_DISABLE_TELEMETRY=1` is set before onnxruntime loads, since its Linux build sends usage telemetry otherwise.

## Known limits
- **The model ranks crossing methods only about as well as its eval says** (reach_ledge top pick 71% vs. 62% at random). In the local ledge check its top method, navigate, failed on a 2-high ledge with no way round.
- **No runtime toggle:** switching it off means editing `.env` and restarting.
- **Plug-in points 2–4 aren't built:** a 2A tool, region-graph link costs, and 2B trial screening.
