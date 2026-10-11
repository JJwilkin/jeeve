---
date: 2026-10-10
tags: [research, prior-art, action-space, system-1]
status: active
---
# OpenHA and CrossHA: which action level?

Sources (CraftJarvis team, Peking University; all numbers self-reported):
- **OpenHA:** Sep 2025, [arXiv 2509.13347](https://arxiv.org/html/2509.13347v1), ICML 2026 ([poster](https://icml.cc/virtual/2026/poster/66679)), [code](https://github.com/CraftJarvis/OpenHA)
- **CrossHA:** He et al., Dec 2025, [arXiv 2512.09706](https://arxiv.org/html/2512.09706), CVPR 2026 Highlight

The only controlled study we found of **which action abstraction a Minecraft agent should act in**. That's the open "primitive set" question in [[overview]]. Both are pixel agents on MineRL, so the specific levels differ from Jeeve's, but the method transfers. Part of the [[sota-minecraft-agents]] survey.

## How it works
**The action spaces compared** (OpenHA Table 1):

| Space | What it is | Example |
|---|---|---|
| Raw | Keyboard and mouse at 20 Hz (24 primitives; 35 discretized tokens) | camera Δ, attack |
| Text action | Serialized low-level calls | `move(dx, dy)`, `keyDown(...)` |
| Motion | Object-agnostic, temporally extended movements | "sprint forward", "turn left" |
| Grounding | Verb + object + pixel target | `Mine(object, position)` |
| Language skill | Verb-object goal for a controller | "chop down trees" |
| Latent | 15,000 VQ-VAE codes, learned with no hand design | — |

**OpenHA's Chain of Action.** One Qwen2-VL-7B emits an abstract action as a "thought", then the low-level action conditioned on it: `P(A, a | obs) = P(a | obs, A) · P(A | obs)`. It runs in two modes:
- **Fast:** a separate lightweight decoder handles the low-level action, like a hierarchical agent.
- **Slow:** one pass generates both.

Training data is the VPT dataset relabeled into each space by rule-based heuristics, about 5B tokens released.

**CrossHA** builds on OpenHA. At each step the model chooses raw, motion or grounding, marked by a text prefix (`Action:`, `Motion:`, `Grounding:`).
- **Cold start:** supervised fine-tuning on mixed-space data. Candidates in every space are kept only if the environment or parser verifies them.
- **Then multi-turn GRPO** with reward `1{success} − λ·(tokens generated)`. The token penalty favors the more concise, higher-level action when both succeed. λ isn't given in what we read.
- **No rule says which level to use.** The choice is learned.

## Results
**OpenHA: no single space wins** (success rate %, Table 3):

| Category | Best | Runner-up | Worst hierarchical |
|---|---|---|---|
| Embodied (mine, navigate) | GroundingHA 37.1 | OpenHA-text 30.1 | — |
| GUI (craft, smelt) | OpenHA 32.5 | TextVLA 25.8 | MotionHA 0.0, GroundingHA 6.7 |
| Combat | OpenHA 31.9 | ROCKET-1 27.9 | — |

Speed trades against success (Table 4, frames per second):

| Model | FPS |
|---|---|
| GroundingHA, fast | 5.61 |
| MotionHA, fast | 3.75 |
| TextVLA | 1.36 |
| GroundingVLA, slow | 1.22 |
| MotionVLA, slow | 0.98 |

The slow (unified) models succeed more. **None is near 20 Hz.**

**CrossHA vs fixed levels** (average success %, in distribution, Table 1):

| Category | CrossHA | GroundingHA | MotionHA |
|---|---|---|---|
| Mine blocks | 40.0 | 37.1 | 27.4 |
| Kill entities | 45.1 | 26.5 | 4.3 |
| Craft items | 78.8 | 6.7 | 0.0 |
| All | **54.6** | 23.4 | 10.6 |

Out of distribution, each trained with RL (Table 2): CrossHA 49.1 vs RawHA 42.4, GroundingHA 39.4, MotionHA 39.1.

**What it learned to pick** (qualitative, from density plots over 20 episodes):
- **Kill sheep:** motion to navigate, grounding to target, raw for rapid attacks.
- **Chop tree:** mostly "walk forward" motion, then grounding on the log.
- **Crafting GUI:** raw for fixed clicks (open the recipe book), grounding to find icons.

## Ablations
- **Without the RL stage** (the paper calls it STRL): All-tasks success 54.6 → 41.6 in distribution, 49.1 → 39.7 out of distribution. Most of the gain comes from RL learning *when* to switch, not from having the levels available.
- No ablation of the token-cost penalty was found.

## Caveats
- **Pixel agents.** Their "GUI" and "grounding" problems (find the icon, aim at the block) mostly vanish under Mineflayer, where `bot.craft` and `bot.dig(block)` are single calls ([[perception]]). Their absolute numbers don't carry over.
- **Step-locked MineRL.** At 1–6 FPS these models would fall behind a live 20 Hz game. Neither paper says how latency is handled.
- **Spaces and relabelers are hand-defined**; only the choice among them is learned.
- **Internal inconsistencies:** benchmark size is given as "over 800", "nearly 1,000" and 1,000 in different places. One OpenHA number differs between two tables (30.1 vs 27.5). CrossHA trains on only 30 tasks.
- **Follow-up:** DeepHA (ICML 2026, [poster](https://icml.cc/virtual/2026/poster/66241)) extends this with deeper action chains and a KV-cache memory that cuts context ~75%. We read only the abstract.

## Takeaways for Jeeve
> **Note:** [[learning]] decided Jeeve trains no models. Training-based takeaways below are evidence of what works elsewhere, not the plan. Jeeve's equivalent is context: which action level pays off where is learned from traced outcomes and written into Jev's guidance.

- **Direct evidence for the [[bitter-lesson]] answer to the primitive-set question.**
  - Don't pick one level by hand. Expose a few and let learning decide per step.
  - A cost term breaks ties toward the higher level: fewer decisions, less latency.
- **Concrete shape for Jeeve's fast model** ([[decision-models]]):
  - A Choice question whose options span levels: generic primitives ("strafe left 0.6 s", "attack target"), and agent-written skills from the library ("mine to iron").
  - The chosen level is logged in the trace. Distillation learns from outcomes which level pays off where.
- **Different tasks want different grain, even within one task:** coarse for travel, fine for fights. That matches [[overview]]'s *options* (action + stop condition) better than a fixed primitive set.
- **The RL stage carried the result,** not the menu of levels. For Jeeve, level choice should be trained from outcomes (judges, mechanical checks), not just imitated from slow thinking.
