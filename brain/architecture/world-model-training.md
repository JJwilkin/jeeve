---
date: 2026-11-02
tags: [architecture, world-models, training]
status: active
---
# World-model training (Tier 1)

How `train/` turns the collector's episodes ([[world-model-collector]]) into the Tier 1 outcome model of [[world-model-data]] → "Phases" → 4. Code facts are in the code; this is the shape and the why. **Written, not yet run on the real data.**

## Pieces
| File | What |
|---|---|
| `train/data.py` | Episodes → one shard per seed (state rows in the world frame, `.npy`); `Rows`, which turns a row into model inputs in the action's frame |
| `train/baseline.py` | The no-neural-net baseline: per action, gradient-boosted trees on hand-built features |
| `train/model.py` | The encoder, the action query, the heads and their losses; the 2M / 5M / 15M configs |
| `train/fit.py` | Trains one size, then evaluates it |
| `train/evaluate.py` | Held-out Brier, temperature, AUROC, top-ranked success |
| `train/export.py` | Two ONNX graphs (encoder, query), parity with torch, CPU latency |
| `deploy/train/run.sh` | The whole run on one g2-standard-8 + L4 in us-west1-b, bucket to bucket, power off at the end |

`uv` project in `train/` (`uv run pytest tests`). The tests build tiny episodes with the real TypeScript encoder (`train/tests/fixture.ts`).

## Rows and labels
- **A row at every action start** (the step before it: what the action was chosen from) and **one every 2 s** (dense rows). 5M steps → ~660k rows (~19 GB uncompressed), which fits a g2-standard-8's page cache. Every step would be ~120 GB.
- **Action labels:**
  - outcome: done, stuck, vetoed, died, timeout (`target_dead` → done, `target_lost` → stuck);
  - duration;
  - end displacement;
  - health change (died: minus the starting health).
- **Dropped or unlabelled:**
  - `error` drops the action;
  - `none_found` gets no outcome label, so it stays out of the success target; its duration and displacement still count;
  - `episode_end` and `stopped` get no outcome, and their duration is censored.
- **Dense labels:** displacement 1 s and 3 s on, a veto within 1 s, damage within 3 s. A dense row carries the action running then (with the time elapsed in it), or `none`.

## The frame
- **Rotated so the action's target points along +x:**
  - the target is the parameters' position (`place`, `at`, `far`, `floor`, `top`, `near`) or direction (`dir`, `yaw`);
  - undirected actions (and `flee`, for now) use the bot's facing.
- **Only the four 90° rotations,** exact on the voxel grids. The residual (±45°) is in the target's direction vector.
- **Mirrors are about the centre of the feet block,** so the feet stay at the same token in every frame. The one slice a mirror pushes off the grid becomes "unloaded".
- **Augmentation:**
  - directed actions: a random mirror across the target axis, which keeps the target on +x;
  - undirected actions: any of the eight symmetries.
- **Cost at inference:** one encoding per rotation the options need, so at most 4 per decision, not one per option.

## Inputs
**Parameters are hashed, with no per-action schema:**
- numbers go into 16 slots (signed log);
- strings and booleans go into 48 buckets;
- positions and directions go into the target instead.

Entity types and held items are crc32-hashed into 256 buckets, so a new name needs no vocabulary. Jeeve can hash the same way with Node's `zlib.crc32`.

## Model
- **Tokens:**
  - block-class embeddings (256 rows, 255 = unloaded);
  - near 16³ in 4³ patches (64 tokens);
  - mid 16³ cells in 4³ patches (64 tokens, with the water, lava and air flags);
  - far 64² columns in 8² patches (64 tokens: top class, height, no-ground, water depth);
  - 8 entity tokens (an empty slot is type 0) and 1 self token.

  The encoder is a pre-norm transformer over these 201 tokens.
- **The action query:** the action embedding, a parameter vector and the target vector make one query token. It goes through 1–2 decoder layers that cross-attend to the encoded state.
- **Heads:**
  - outcome (5 classes);
  - duration: 40 hazard bins of 0.5 s with a discrete-time survival loss, censored at timeout or episode end;
  - end displacement and health change (Huber);
  - the dense head (displacement 1 s and 3 s, veto, damage).
- **Sizes:**

  | Config | Width | Layers | Parameters |
  |---|---|---|---|
  | 2m | 160 | 4 | 2.35M |
  | 5m | 224 | 6 | 5.42M |
  | 15m | 320 | 8 | 14.55M |

  Action starts are weighted to half of each batch. Training uses AdamW with cosine decay, bf16, and 20k steps of 256 by default.

## Evaluation
- **The held-out seeds are split in two:** temperature is fitted on one half, and everything is reported on the other.
- **Per action:**
  - success Brier, raw and after temperature;
  - AUROC;
  - the success rate in the top fifth by predicted success;
  - the duration error on actions that ended by themselves.
- **Whether the top-ranked option succeeds.** This is measured on the actions that draw a method at random (cross_water, get_down_cliff, reach_ledge), by replay: the success rate over the samples whose method was the model's top pick.
- **The baseline is scored on the same half.**

## Export
- **Two graphs:** `encoder.onnx` (state → tokens) and `query.onnx` (tokens plus N options → calibrated outcome probabilities, expected duration, displacement, health change).
- **Jeeve's side does the frame and the hashing.** The graphs take a sample's arrays as they are.
- **Random-weight latency,** on Apple-silicon, 1 thread, 1 encoding plus 32 options: 2m 3.7 + 3.1 ms, 5m 7.6 + 4.6 ms, 15m 14.5 + 14.3 ms. onnxruntime matches torch to 2e-5.

## Not done yet
- Running it: shards, baseline, three sizes and export on the VM.
- The river scene against the code-only baseline.
- Wiring the ONNX graphs into Jeeve: the frame and hashing in TypeScript, the recorder's view code on the live bot.
