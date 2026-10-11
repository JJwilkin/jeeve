---
date: 2026-10-10
tags: [research, perception, system-1, world-models]
status: active
---
# Spatial understanding in fast models

How models can make sense of space quickly. Two separate ideas get called "world models", and only one of them is about deciding. Background: [[perception]] (bots get data, not pixels) and [[decision-models]] (the fast layer). Items marked † are from memory and weren't re-checked when this note was written.

## First: "LiDAR" in Minecraft agents isn't a sensor
GITM's LiDAR ([[gitm]]) is simulated ray casting through the game's block data: rays from the eyes every 5°, each returning what it hit (block or entity type) and the distance. It's the same as Mineflayer's `bot.world.raycast`. That gives a sparse view of what's in line of sight. GITM's scripts used it; its LLM never saw it.

## 1. Generative world models: predicting what happens next
These learn how the world changes over time, and several run in real time.

| Model | What it does |
|---|---|
| **Genie 3** (DeepMind, Aug 2025) | Interactive 3D worlds generated at 720p and 24 fps, with persistent objects. Waymo built its driving world model on it (Feb 2026). |
| **Matrix-Game 3.0** ([arXiv 2604.08995](https://arxiv.org/pdf/2604.08995), 2026) | Real-time, streaming, interactive world model with long-horizon memory |
| **V-JEPA 2** (Meta, Jun 2025) → **V-JEPA 2.1** (2026) | Predicts in an internal learned representation, not pixels. Used for zero-shot robot planning; 2.1 adds spatial precision. |
| **Dreamer 4**, **Solaris** | Minecraft world models; see [[sota-minecraft-agents]] |
| **MineWorld**† (Microsoft, 2025), **Oasis**† (Decart/Etched, 2024) | Real-time playable Minecraft world models |
| **Muse/WHAM**† (Microsoft, 2025) | Trained on one game's play (Bleeding Edge) to predict visuals and controller actions |

- These clearly encode space, since geometry stays consistent across frames.
- They answer "what happens if I do X", not "what should I do". In an agent they're for *imagination*: training inside a simulation (Dreamer), or rolling out options before committing.
- **For Jeeve, the real server is already a perfect simulator.** A spare server can do rollouts for training. Generative world models aren't on the critical path.

## 2. Fast models that decide over space
- **Big multimodal models are still weak at spatial reasoning.**
  - MineAnyBuild found "severe limitations" ([[benchmarks]]).
  - VSI-Bench† (2024) showed models struggle to reason about 3D space from video.
  - They're also slow.
- **Fast spatial policies exist, but they're trained, not general reasoners.** Examples: robot vision-language-action models, where a slow VLM sets intent and a small policy acts at high frequency ([[fast-slow-agents]]), and Game-TARS, which acts from pixels.
- **The closest prior art to "spatial tokens at a fast frame rate" is AlphaStar and OpenAI Five**†. They read structured game state, not pixels:
  - **Entity tokens:** each unit was one token (type, relative position, velocity, health…) passed through a transformer.
  - **A spatial map:** a grid of local terrain passed through a small convolutional network.
  - **A recurrent core** carried memory over time.
  - **Small networks** deciding in milliseconds.

  That's the shape Mineflayer data already has.

## Three ways to give System 1 spatial context
| | Input | Speed | Cost to start | Notes |
|---|---|---|---|---|
| **A. Text into a decision model** | Relative entity list + ASCII map + event window | 70–500 ms | None: works today with Jev, Microsoft-Decision-1 or a small LLM | Weak spatial reasoning from text, but it starts producing traces |
| **B. Spatial tokens into a small trained model** | Entity tokens (type, relative position, velocity, facing) + a local voxel block (e.g. 16³ around the bot) + recent frames | ~1–10 ms, runs on CPU | Needs training data | The AlphaStar recipe. A *learned* System 1 in the [[bitter-lesson]] sense. |
| **C. Pixels into a vision-language-action model** | Rendered frames | Slow, needs a GPU | Big | Only for visual judgments, e.g. how a build looks |

## Takeaways for Jeeve
- **A is the path. B and C are evidence of what others do.** Jeeve trains no models ([[learning]]), so a trained spatial policy (B) is out.
- **Borrow B's input design, as text for A.** The AlphaStar recipe tells us what spatial information matters. We encode the same information for Jev instead of training on it:
  - **Entity tokens** → a structured entity list: type, relative position, velocity, facing, health.
  - **A local voxel grid** → ASCII or height maps centered on the bot, plus GITM-style ray casts ([[gitm]]) for line of sight.
  - **A recurrent core** → the event window and running summaries ([[perception]]).
- **C stays for visual judgments only,** e.g. scoring how a build looks.
- **The least certain part is encoding quality.** How big the map is, whether it's egocentric, and how many entities to include decide whether Jev can use it. Traces will show which encodings lead to good decisions.

Sources: [Genie 3 / world models overview](https://en.wikipedia.org/wiki/World_model_(artificial_intelligence)), [Matrix-Game 3.0](https://arxiv.org/pdf/2604.08995), [V-JEPA 2](https://ai.meta.com/blog/v-jepa-2-world-model-benchmarks/), [V-JEPA 2.1 (Turing Post)](https://www.turingpost.com/p/jepa), [MineAnyBuild](https://arxiv.org/html/2505.20148v3), [Game-TARS](https://arxiv.org/abs/2510.23691), [PillagerBench](https://arxiv.org/abs/2509.06235)
