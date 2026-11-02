---
date: 2026-11-02
tags: [research, perception, world-models, spatial, system-2]
status: active
---
# Representing the 3D world for System 2

How an agent can understand 3D space well enough to route, cross and build, and what that means for 2A. Follows [[spatial-models]] (fast models and space) and [[perception]] (the tools 2A has today). Items marked † are from memory and weren't re-checked.

## Why now: the river (2026-11-02)
On the live server, Jeeve_1 spent 10 minutes and ~$3.50 of 2A calls stuck at a river bank ([[deployment]]). The traces show:
- **2A did plan spatially.** It called `reachable` 16 times, set waypoints from the answers, and failed and re-planned steps.
- **But it couldn't see the terrain.** `seen_map` drops any block type with more than 512 nearby, so ground, stone and water never reach 2A. [[perception]] turned down a height map on 2026-10-11 because "navigate handles terrain"; the river is the case where that bet fails.
- **And its tools disagreed with the guards.** `reachable` uses the pathfinder's rules, which allow a drop of any height into water; the drop guard allows water only within 4 blocks below. So `reachable` promised routes the guard then vetoed.

So the gap is **representation**, and **agreement between the planner's view and the guard's rules**, not seeing (Jeeve already has exact block data).

## Three jobs called "world model"
1. **Representation:** what is where (a map).
2. **Query:** can I get from here to there; where is the narrowest crossing.
3. **Prediction:** what happens if I do X.

Jeeve has (1) as a voxel store (the seen memory in `src/world.ts`) but shows 2A almost none of it, has bugs in (2), and gets (3) exactly from the server and code.

## Prior art
### Minecraft agents
- **Voyager, Mindcraft** ([[mindcraft-and-voyager]]): no spatial map. The model writes Mineflayer code and the pathfinder handles space. Jeeve's design today.
- **GITM** ([[gitm]]): simulated LiDAR (ray casts) fed scripts; its LLM never saw it.
- **Dreamer 4** (DeepMind, Sep 2025): a world model learned from offline video; the agent trains by RL inside it ("imagination training") and was the first to get diamonds from offline data alone, at 0.7%. Pixels in, pixels out; needs training.

### Generative Minecraft world models (MineWorld, Oasis)
- **MineWorld** (Microsoft Research, Apr 2025): an autoregressive transformer over image tokens and action tokens. Given past frames and the player's action, it generates the next frame, 4–7 fps with parallel "diagonal decoding". Open source, Minecraft only.
- **Oasis**† (Decart/Etched, 2024): a diffusion model doing the same.
- **Their memory is a short window of frames.** Memory Forcing (Oct 2025) and the LOOPNAV benchmark find that MineWorld and Oasis become inconsistent when the player returns to a place: the scene they generate on return doesn't match what was there.
- **The fix the field reaches for is an explicit 3D map.** Memory Forcing keeps a global point cloud (depth back-projected with the camera pose, voxel-downsampled) and retrieves past frames by which points are in view.
- **Their internals don't hold clean geometry.** Geometry Forcing (ICLR 2026) found that video diffusion models trained only on raw video "often fail to capture meaningful geometric-aware structure", and has to align their features with a 3D model (VGGT) to get it.

**Could MineWorld perceive the world for Jeeve?** Not usefully:
- **It runs the wrong way for Jeeve.** It turns pixels and actions into more pixels. Jeeve has no pixels, and already has the exact block data MineWorld approximates. Using it would mean rendering exact state to images, then getting back an imagined, less exact version.
- **Its "understanding" isn't readable.** It sits in latents with weak geometry (Geometry Forcing). Reading heights or water out of it would need a trained probe, and then it's a worse copy of the block data.
- **Its prediction job is already covered.** "If I walk forward, do I fall?" has one right answer from blocks and physics, which code gives exactly ([[layers]]: one-right-answer questions belong to code).
- **Where it could fit:** a cheap simulator for training a learned policy (Dreamer-style). That conflicts with "context only, no training" ([[learning]]), and Jeeve has real servers to roll out on.

The research direction matters more than the model: generative world models are adding explicit 3D memory to stay consistent, and Jeeve has that memory natively.

### Robotics: 3D scene graphs
- **Hydra** (MIT, RSS 2022): builds a layered 3D scene graph in real time: a local distance field → a graph of **places** (free-space nodes) → **rooms** (community detection over places) → building. Places ~33 ms, rooms ~55 ms on a Jetson Xavier NX.
- **ConceptGraphs** (ICRA 2024): objects as graph nodes, with captions and relations, turned into text for an LLM planner.
- **SayPlan** (CoRL 2023): an LLM plans over a **collapsed** 3D scene graph, calling `expand(node)` / `contract(node)` to see detail only where it needs it. A classical path planner (Dijkstra) connects the nodes it picks, and a scene-graph simulator checks each plan and feeds failures back. Tested on up to 3 floors and 36 rooms.
- **VoxPoser** (CoRL 2023): the LLM **writes code** that builds 3D value and cost maps over voxels; a motion planner acts on them. No training. The model never reads voxels; it writes the code that does.

### Spatial reasoning in big models
- **VSI-Bench / "Thinking in Space"** (CVPR 2025): chain-of-thought and similar prompting didn't help multimodal models on 3D spatial questions; having the model **draw a cognitive map** (a grid) did help on distance questions. Local maps were reliable, global ones weak.
- **VoxelCodeBench** (Meta FAIR, Apr 2026): LLMs writing code that builds voxel scenes, including Claude models. "Producing executable code is far easier than producing spatially correct outputs"; geometric construction was the hardest category.
- **MineAnyBuild** ([[benchmarks]]) found "severe limitations" in multimodal models' Minecraft building.

## Options for Jeeve
| | What | Cost | Fit |
|---|---|---|---|
| **A. Better views** | a height map (per column: ground height relative to the bot, water, lava, drops > 3), side views, floor plans, a rendered image | small | Fixes the blind spot; Opus still does the spatial reasoning. VSI-Bench says a map beats reasoning in prose. |
| **B. A region graph** | code splits the voxel memory into walkable regions (Hydra's places) with typed links: walk, drop ≤ 3, swim, bridge N, pillar N, each with a cost | medium | **Best fit.** Opus plans at region level and expands where it needs detail (SayPlan); code handles distances and checks the plan. |
| **C. Spatial code** | 2A writes small queries over the voxel memory ("narrowest water crossing within 20 blocks") as a module kind | small | VoxPoser's pattern; matches "System 2 writes code" ([[system-1]]). VoxelCodeBench warns the code runs before it's right, so results need checking. |
| **D. A learned model** | a trained voxel encoder (AlphaStar, [[spatial-models]]) or learned dynamics (Dreamer 4, MineWorld) | large | Conflicts with [[learning]]; the server already simulates exactly. |
| **E. Vision** | render the scene (prismarine-viewer, as the spectate page does) and show it to Opus | medium (rendering on the VM) | For how a build looks, not for exact geometry. |

## Proposal
B on top of the existing voxel memory, with A's height map as its first view and C as the escape hatch:
- **One set of movement rules.** Regions and links are computed with the same rules the guards enforce (`src/guards.ts`), and so is `reachable`, so the map can't promise a route a guard will veto. This alone would have unstuck the river.
- **2A sees the collapsed graph on every call:** each region with its size, height range and what's in it, and each link with its type and cost. It can `expand(region)` to get a height map or side view.
- **Links that need a behavior** (bridge, pillar) name it. 2A asks 2B for one if the library doesn't have it.
- **Code checks the plan** before System 1 runs it, as SayPlan's simulator does, and returns the failing link.
- **The spectate page draws the same graph** as a minimap, so a viewer sees what 2A sees.

This keeps the line the brain already draws: code does the geometry and the model gets conclusions ([[architecture/stateful-system-1|stateful-system-1]] → "objects, not voxels or frames").

**Built (2026-11-02):** the region graph and height map for 2A, see [[region-graph]]. Not yet: code checking the plan, the minimap.

## Open questions
- **Region size.** Hydra cuts places from free space; Minecraft's grid may make simple flood-fill over standable cells enough. Measure cost on the VM: CPU, not memory, is the limit there ([[deployment]]).
- **Seen vs. true.** The graph is built from what Jeeve has seen, so an unseen far bank is a frontier, not a wall. Links into unseen space need their own type.
- **Building.** A region graph covers moving; building needs floor plans and side views (A), and maybe objects for walls and floors.
- **The test:** a bench scene with this river. Does Jeeve cross, and in how many 2A calls?

Sources: [MineWorld](https://arxiv.org/abs/2504.08388) · [Memory Forcing](https://arxiv.org/abs/2510.03198) · [LOOPNAV / memory-aided world models](https://arxiv.org/abs/2505.22976) · [Geometry Forcing](https://arxiv.org/abs/2507.07982) · [Dreamer 4](https://arxiv.org/abs/2509.24527) · [Hydra](https://arxiv.org/abs/2201.13360) · [ConceptGraphs](https://arxiv.org/abs/2309.16650) · [SayPlan](https://arxiv.org/abs/2307.06135) · [VoxPoser](https://arxiv.org/abs/2307.05973) · [Thinking in Space / VSI-Bench](https://arxiv.org/abs/2412.14171) · [VoxelCodeBench](https://arxiv.org/abs/2604.02580)
