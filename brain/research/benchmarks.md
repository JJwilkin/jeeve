---
date: 2026-10-10
tags: [research, benchmarks, evaluation, outcome-signals, judges]
status: active
---
# Minecraft agent benchmarks

A survey of benchmarks and evaluation suites for Minecraft agents, plus close proxies, read 2026-10-10. The question for each one: can it give Jeeve an **outcome signal** ([[overview]]) for a Mineflayer bot on a real Paper server, playing in real time ([[perception]])?

**How to read the numbers:** every score below is **self-reported** by the benchmark or agent authors. We reproduced none of them. "Last push" is the GitHub `pushed_at` date on 2026-10-10.

## Comparison
| Benchmark | Task types | Success measured by | Env / interface | Real time? | Best reported (self-reported) | Saturated? | Maintained (last push) | Port to Jeeve |
|---|---|---|---|---|---|---|---|---|
| **MineRL ObtainDiamond** ([docs](https://minerl.readthedocs.io/en/stable/environments/diamond.html)) | Tech tree | Programmatic (milestone items) | Malmo; pixels + keyboard/mouse | No (step-based gym) | GITM 67.5% diamond, with 100× break speed ([[gitm]]). ODYSSEY 92.5% in 10 min on Mineflayer ([arXiv 2407.15325](https://arxiv.org/pdf/2407.15325)) | Yes for structured agents | Competition over. `minerl` last push 2025-01 ([repo](https://github.com/minerllabs/minerl)) | **Easy to re-create:** an inventory check on a fresh world. The published numbers aren't comparable. |
| **MineRL BASALT** ([arXiv 2107.01969](https://arxiv.org/pdf/2107.01969), [2022 retro](https://arxiv.org/pdf/2303.13512)) | Fuzzy tasks (e.g. build a village house) | **Human pairwise votes → TrueSkill** | Malmo; pixels | No | Relative scores only. BEDD has 3,000+ pairwise evaluations as a reusable leaderboard ([arXiv 2312.02405](https://arxiv.org/pdf/2312.02405)) | n/a | Last edition 2022 | Hard: the agent is pixel-based, and the videos must come from the real client. The **method** transfers. |
| **MineDojo** ([NeurIPS 2022](https://papers.nips.cc/paper_files/paper/2022/file/74a67268c5cc5910f64938cac4526a90-Paper-Datasets_and_Benchmarks.pdf), [repo](https://github.com/MineDojo/MineDojo)) | 3,142 tasks: programmatic (survival, harvest, tech tree, combat) and creative | Programmatic checks. Creative tasks use MineCLIP or humans. | Malmo-derived gym; RGB plus some structured state | No | Not tracked; superseded by MCU | Not tracked | Stale (2024-03) | Medium: the programmatic task *specs* can be ported as inventory or kill checks. Creative judging is weak (below). |
| **MCU** ([arXiv 2310.08367](https://arxiv.org/html/2310.08367v4)) | 3,452 atomic tasks in 11 categories (mine, craft, combat, build, navigate…), composable | **VLM judge** (GPT-4o on video frames, 6 rubric dimensions). 91.5% agreement with humans. | MineStudio, MC 1.16.5; 640×360 pixels + keyboard/mouse | No | GROOT best. Task progress ~0.72 navigation → 0.23 compositional. | No | Active (MineStudio 2026-09) ([repo](https://github.com/CraftJarvis/MineStudio)) | Hard to run as-is: it excludes non-native action spaces. **Adapt** the task list and judge rubric, feeding the judge renders. |
| **MineCollab / Mindcraft tasks** ([arXiv 2504.17950](https://arxiv.org/html/2504.17950v1), [tasks/](https://github.com/mindcraft-bots/mindcraft/tree/develop/tasks)) | Multi-agent cooking, crafting and construction; also single-agent | **Programmatic:** item in inventory (binary). Construction uses edit distance to the blueprint. | **Mineflayer**, real server, 47 commands | Yes, as far as we know: no pause mod found | Claude 3.5 Sonnet: crafting 0.47, cooking 0.64, construction 0.36 | No | Very active (2026-10) | **Easiest.** Task JSON (goal, inventory, target, timeout, blueprint) and validators are already Mineflayer-native. |
| **PillagerBench** ([arXiv 2509.06235](https://arxiv.org/html/2509.06235v1), [repo](https://github.com/aialt/PillagerBench)) | **Competitive** 2v2 team scenarios (Mushroom War, Dash & Dine) | **Programmatic:** points, sabotage, point difference, win rate against rule-based opponents | **Mineflayer**, MC 1.19.4; agents write JS | **Yes:** "a real-time benchmark". Voyager's pause call is commented out ([bridge.py](https://github.com/aialt/PillagerBench/blob/main/voyager/env/bridge.py)). | TactiCrafter (GPT-4o) win rate 0.46 against built-in opponents | No | Small (11★); last push 2026-04 | **Easy:** add an `Agent` subclass. MIT. |
| **TeamCraft** ([arXiv 2412.05255](https://arxiv.org/html/2412.05255v1)) | Multi-agent building, clearing, farming, smelting; 55k variants | Programmatic subgoal completion | Mineflayer underneath; RGB + inventory obs; 8 high-level skills | No (step-based) | TeamCraft-VLA-13B building 0.48. GPT-4o ≈0. | No | 2025-09 ([repo](https://github.com/teamcraft-bench/teamcraft)) | Medium: the checks are reusable, but it's built for VLAs. |
| **VillagerBench** ([arXiv 2406.05720](https://arxiv.org/html/2406.05720v1)) | Multi-agent construction, farm-to-table cooking, escape room | Programmatic completion, efficiency, balance. Construction uses multi-view IoU. | **Mineflayer** | Time-limited; pausing not stated | VillagerAgent (GPT-4) cooking 85.26 | No | Active (2026-10) ([repo](https://github.com/cnsdqd-dyb/VillagerAgent)) | Easy to medium |
| **ODYSSEY** ([arXiv 2407.15325](https://arxiv.org/html/2407.15325)) | Combat against mobs (from scratch), farming, open exploration | Programmatic success rate, health left, time. Exploration counts items and advancements. | Voyager/Mineflayer | **No:** it inherits Voyager's server-pause mod ([docs](https://github.com/zju-vipa/odyssey)) | MineMA-8B 8/8 on 1 zombie | Partly | 2025-10 | Easy to port the tasks. **Results don't transfer**, because the world waits for the LLM. |
| **MineLand** ([arXiv 2403.19267](https://arxiv.org/html/2403.19267v2)) | ~6k tasks: programmatic, creative, hybrid (construction, stage performance); up to 48–128 agents | Programmatic checks. Construction is scored 1–5 by a GPT-4o VLM plus humans. | **Mineflayer**, Fabric server, code actions | Tick-stepped code (50–200 ms steps) | Qualitative only | No | **Archived** (2025-09) ([repo](https://github.com/cocacola-lab/MineLand)) | Medium: the task specs are reusable; the repo is dead. |
| **MineNPC-Task** ([arXiv 2601.05215](https://arxiv.org/html/2601.05215v2)) | Co-play subtasks elicited from expert players; memory and clarification | **Machine-checkable validators**, from in-world evidence only | **Mineflayer**, real co-play | Yes (with humans) | GPT-4o, 216 subtasks; no headline rate | No | Release claimed; repo not found | Easy in principle. Its "bounded-knowledge" rule fits [[bitter-lesson]]. |
| **MineExplorer** ([arXiv 2605.30931](https://arxiv.org/abs/2605.30931), [repo](https://github.com/meituan-longcat/MineExplorer)) | Exploration with hidden multi-hop prerequisites | **Rule-based milestone evaluators**, auto-synthesized with the task | MLLM agents; framework not checked | Unverified | Strong on single-hop, sharp drop on multi-hop | No | 2026-06 | Unknown; worth reading the code |
| **SciCrafter** ([arXiv 2604.24697](https://arxiv.org/abs/2604.24697), [repo](https://github.com/scicrafter-bench/scicraft-bench)) | Parameterized redstone: light lamps in patterns or timed sequences | Success rate (exact criteria not read) | Code-agent scaffold | Unverified | GPT-5.2, Gemini-3-Pro and Claude-Opus-4.5 plateau ≈26% | No | 2026-04 | Unknown. It's a discovery-to-application test, which suits [[bitter-lesson]]. |
| **Parallelized Planning-Acting** boss/PvP tasks ([arXiv 2503.03505](https://arxiv.org/pdf/2503.03505)) | Elder Guardian, Wither, Ender Dragon; team-vs-team PvP | Programmatic: success, time, team health ratio, boss damage | **Mineflayer**, "operates continuously without pausing" | **Yes** | Ender Dragon: 0% with 3 agents, 100% with 20 agents, **starting with supplied gear** | No | No code link found | Medium: the tasks are easy to rebuild. PvP is framework vs. framework, with no fixed opponent. |
| **Plancraft** ([arXiv 2412.21033](https://arxiv.org/html/2412.21033v2), [repo](https://github.com/gautierdag/plancraft)) | Crafting-GUI planning, 17% impossible tasks | Programmatic: goal crafted, or "impossible" correctly declared | **Python re-implementation**, not the game; text or image | No | Llama-70B 0.67 overall, 0.31 on hard | No | 2025-11 | No server needed. A cheap unit test for crafting reasoning only. |
| **MineAnyBuild** ([arXiv 2505.20148](https://arxiv.org/html/2505.20148v3), [repo](https://github.com/MineAnyBuild/MineAnyBuild)) | ~4,000 spatial-planning tasks: blueprint generation, VQA, creativity | **LLM critic** (GPT-4.1, /10) on the executed blueprint; accuracy for VQA; humans for creativity | Blueprint matrix → **Mineflayer** builds it | No (offline) | Overall: GPT-4o 41.02, Claude-3.7 40.70 | No | 2025-10 | Easy to medium. It tests the planner, not survival execution. |
| **MC-Bench** ([TechCrunch](https://techcrunch.com/2025/03/20/a-high-schooler-built-a-website-that-lets-you-challenge-ai-models-to-a-minecraft-build-off), [org](https://github.com/mc-bench)) | Open-ended builds from a prompt | **Blind human pairwise votes → Elo** (K=32, start 1000; [config](https://github.com/mc-bench/mc-bench-backend/blob/main/src/mc_bench/apps/worker/config.py)) | Model writes JS; a **Mineflayer** bot runs `/setblock` and `/fill` commands ([build.js](https://github.com/mc-bench/mc-bench-backend/blob/main/src/mc_bench/apps/server_worker/js_scripts/build.js)) | No (offline build) | Claude 3.7 Sonnet #1 in March 2025 ([TechCrunch](https://techcrunch.com/2025/03/20/a-high-schooler-built-a-website-that-lets-you-challenge-ai-models-to-a-minecraft-build-off)). Current board unverified: site unreachable. | Unknown | Backend last push 2025-09; looks quiet | Medium. Command-built, not survival-built: it measures design, not gathering. |
| **MineBench** ([repo](https://github.com/Ammaar-Alam/minebench), [ranking doc](https://raw.githubusercontent.com/Ammaar-Alam/minebench/master/docs/arena-ranking-system.md)) | Voxel builds from a prompt | Blind pairwise votes → **Bradley-Terry** with intervals | Model emits voxel JSON or calls `voxel.exec`. Not Minecraft itself. | No | Live board didn't load | Unknown | Very active (2026-10) | The ranking method transfers. The environment doesn't. |
| **Crafter** ([repo](https://github.com/danijar/crafter)) | 2D survival tech tree, 22 achievements | Programmatic: geometric mean of achievement rates | 64×64 pixels; LLM text wrapper in BALROG | No | RL: Curious Replay 19.4%. Human expert 50.5%. BALROG LLM leader 76.8% Crafter progress ([balrogai.com](https://balrogai.com/), unverified entry) | LLMs near or above human | Crafter frozen (2024); BALROG 2026-04 | n/a. A proxy for the slow planner. |
| **Craftax** ([repo](https://github.com/MichaelTMatthews/Craftax), [ICML 2024](https://arxiv.org/pdf/2402.16801)) | 2D Crafter plus NetHack-like dungeons | Programmatic: % of max return | JAX; symbolic or pixel obs | No (fast sim) | Full Craftax 1B steps: PPO-GTrXL 18.3%. Classic: 69.66% at 1M steps ([arXiv 2502.01591](https://arxiv.org/abs/2502.01591v3)) | Classic nearly; full no | 2026-06 | n/a. A proxy for training a fast policy cheaply. |

## How success is measured
This section feeds Jeeve's outcome-signal design ([[overview]]). Across the field, success is measured in three ways.

### 1. Mechanical checks (most benchmarks)
| Check | Used by | Covers |
|---|---|---|
| **Item in inventory**, with quantity | Mindcraft `checkItemPresence` ([tasks.js](https://github.com/mindcraft-bots/mindcraft/blob/develop/src/agent/tasks/tasks.js)), MineDojo, ObtainDiamond, Plancraft | Gathering, crafting, tech tree |
| **Milestone or subgoal sets**, scored for partial credit | TeamCraft subgoal rate, MineExplorer milestone evaluators, MineNPC validators, ObtainDiamond milestones | Long chains, with credit for each step |
| **World-state diff against a target** | MineCollab construction (edit distance to blueprint), VillagerBench (multi-view IoU) | Building *to a spec* |
| **Game score or match result** | PillagerBench points and win rate; boss health dealt and team health left ([arXiv 2503.03505](https://arxiv.org/pdf/2503.03505)) | Combat, competition |
| **Counts from exploration** | ODYSSEY: distinct items, advancements, distance | Open exploration |
| **Efficiency side metrics** | Time to success, LLM calls, tokens (Plancraft, ODYSSEY, VillagerBench) | Cost per outcome |

**Pattern:** anything that ends as a fact in game state can be checked mechanically: inventory, blocks at positions, entity dead, score, advancement. Mineflayer exposes all of these directly ([[perception]]). [[gitm]]'s typed goals `(object, count, material, tool)` are this kind of check.

### 2. Model judges (for "how good", not "whether")
- **MCU AutoEval** ([arXiv 2310.08367](https://arxiv.org/html/2310.08367v4)): the most carefully validated judge.
  - GPT-4o gets one frame in every 30 plus task-specific criteria (themselves LLM-generated).
  - It scores 6 dimensions (progress, action control, material use, efficiency, error recognition, creativity), each on 0–1 in steps of 0.25.
  - It was validated on 500 trajectories labelled by 20 expert players: 91.5% agreement overall, and F1 84.0 on comparative judgments against 34.6 for MineCLIP.
  - Pearson correlation is lowest on creativity (0.63).
- **MineAnyBuild:** GPT-4.1 as a critic, giving a weighted score out of 10 for the executed blueprint ([arXiv 2505.20148](https://arxiv.org/html/2505.20148v3)). Non-executable plans score 0. Creativity is also rated by humans.
- **MineLand:** construction scored 1–5 by GPT-4o and by humans, with the same criteria ([arXiv 2403.19267](https://arxiv.org/html/2403.19267v2)).
- **MineCLIP** (MineDojo's video-text similarity) is the older approach. MCU's comparison suggests it's much weaker than a VLM judge.

### 3. Pairwise preference (for taste)
- **BASALT** ([arXiv 2107.01969](https://arxiv.org/pdf/2107.01969), [2303.13512](https://arxiv.org/pdf/2303.13512)):
  - Humans compare two videos from the same seed, and TrueSkill turns the votes into ratings.
  - Scores are normalized per task (mean 0, SD 1) and then averaged, so no single task dominates.
  - In 2022, requiring raters to **justify their choice** filtered out low-quality votes.
  - Draws fell from 80% to 27–44%, though the platform also changed.
- **MC-Bench:**
  - Two models build the same prompt. Voters see renders blind, and the model names are revealed after the vote.
  - The code is an online **Elo** update ([elo.py](https://github.com/mc-bench/mc-bench-backend/blob/main/src/mc_bench/util/elo.py); K=32, start 1000).
  - Builds are rendered with a prismarine-viewer fork, i.e. rendered from data, like Jeeve would ([org](https://github.com/mc-bench)).
- **MineBench** ([ranking doc](https://raw.githubusercontent.com/Ammaar-Alam/minebench/master/docs/arena-ranking-system.md)) is the more careful version:
  - It **refits Bradley-Terry over the full vote history** rather than using order-dependent Elo, and reports confidence intervals.
  - "Both bad" votes are kept as a quality signal but excluded from the fit.
  - Matchups are sampled actively: 40% coverage, 30% top contenders, 20% most uncertain pairs, 10% exploration.

### What this means for Jeeve's reward design
| Objective kind | Example | Signal |
|---|---|---|
| Acquire or craft | "get iron armor" | Mechanical: inventory |
| Build to a spec | "copy this blueprint" | Mechanical: block diff or IoU |
| Win or score | Bed Wars, boss fight, 2v2 | Mechanical: match result, damage dealt, health left |
| Explore or discover | "find a village" | Mechanical: position, entity or structure seen, advancements |
| Build with taste | "a nice house" | Judge: pairwise VLM over renders, calibrated against some human votes |
| Play quality | "fought well", "was efficient" | Judge: rubric over the trace, MCU-style, per goal-tree node |

- **Prefer pairwise to absolute** for taste. All three arenas do. Absolute VLM scores were least reliable exactly on creativity (MCU, 0.63).
- **A judge needs a human-agreement number.** MCU's 500 labelled trajectories are the template. Without one, a judge is an unvalidated reward that will be hill-climbed on.
- **Mechanical checks can be hacked.** MC-Bench builds with `/setblock` (creative powers). The x-ray in Mineflayer ([[perception]]) makes "find diamonds" easier than for a human. The rules of an objective need to state what powers and information the agent is allowed. MineNPC's "bounded-knowledge policy" is one example ([arXiv 2601.05215](https://arxiv.org/html/2601.05215v2)).

## Caveats
- **Most published results paused the world.** Voyager and ODYSSEY pause the server while the LLM thinks, using the Multi Server Pause mod ([Voyager](https://github.com/MineDojo/Voyager/blob/main/installation/fabric_mods_install.md), [ODYSSEY](https://github.com/zju-vipa/odyssey)). MineRL, MineDojo, MCU and TeamCraft are step-based gyms.
  - Only PillagerBench and the Parallelized Planning-Acting paper explicitly run in real time. MineCollab and MineNPC probably do too (real server, no pause found), but neither paper says so.
- **Changed physics and supplied gear inflate numbers.**
  - GITM used 100× block-breaking speed ([[gitm]]).
  - The Ender Dragon "100%" result started with supplied weapons and armor and used 20 agents ([arXiv 2503.03505](https://arxiv.org/pdf/2503.03505)).
- **The BALROG leaderboard** lists models such as "GPT-6-Astra-Max" with 76.8% Crafter progress (fetched 2026-10-10). These are leaderboard submissions we haven't checked, and the page doesn't define the Crafter metric.
- **Not re-checked:**
  - Whether MineExplorer uses Mineflayer.
  - SciCrafter's exact success criteria.
  - MC-Bench's current leaderboard (mcbench.ai didn't resolve from here).
  - Whether a MineRL Diamond 2021 team obtained a diamond. An AIcrowd summary says the easier track did ([overview](https://www.aicrowd.com/research/minerl-diamond-2021-competition-overview-results-and-lessons-learned)).

## Takeaways for Jeeve
**Adopt or adapt first:**
1. **Mindcraft / MineCollab tasks:** the cheapest real benchmark.
   - It's Mineflayer-native and runs on a real server.
   - Tasks are plain JSON (goal, starting inventory, target, timeout, blueprint), and the validators already exist: inventory checks and blueprint edit distance.
   - It also comes with a ready baseline: Mindcraft itself ([[mindcraft-and-voyager]]).
   - Use the single-agent crafting and construction subsets first, and the multi-agent ones later.
2. **PillagerBench:** the only real-time, competitive, Mineflayer benchmark with fixed rule-based opponents. It's MIT-licensed, and adding an agent means writing one subclass.
   - The best win rate is 0.46, so there's headroom.
   - It's the nearest thing to the "win this Bed Wars match" objective in [[overview]]. LLM latency is part of the score, which is what [[fast-slow-agents]] is meant to fix.
3. **A real-time tech-tree ladder in the ObtainDiamond style**, re-created on our Paper server.
   - Fresh world, vanilla break speed, wall clock running, with checks on the milestone items (log → … → diamond, then iron armor, Nether, Ender Dragon).
   - It's trivial to check mechanically, and it maps one-to-one onto goal-tree nodes and trace spans.
   - Published numbers ([[gitm]], ODYSSEY) are paused or have modified physics, so we report our own baseline rather than compare.
4. **An MC-Bench-style build arena for "taste" objectives:**
   - Jeeve builds in survival.
   - Render with prismarine-viewer.
   - Run pairwise VLM judgments, fitted with Bradley-Terry (MineBench's method), and calibrate them against a small set of human votes (BASALT's justification trick, MCU's agreement check).
   - MineAnyBuild's blueprint tasks can score the planner offline before any survival building.

**Cheap side checks:** Plancraft, for crafting reasoning with no server. BALROG-Crafter or Craftax, for fast-policy experiments ([[decision-models]]).

**Gaps no benchmark fills:**
- **Real-time 1v1 or small-team PvP against a fixed, reproducible opponent.**
  - PillagerBench is a resource race with sabotage, not a fight.
  - The PvP in [arXiv 2503.03505](https://arxiv.org/pdf/2503.03505) pits frameworks against each other, and its code wasn't found.
  - Bed Wars-style objectives (protect a bed, break theirs) don't exist as a benchmark ([search](https://arxiv.org/html/2509.06235v1)).
- **The full game from scratch, in real time** (spawn → Ender Dragon) with no supplied gear.
- **Cost and latency as first-class metrics.** Dollars or tokens per success, and decisions per second, are rarely reported. PillagerBench treats response time as a factor; others ignore it.
- **Calibrated judges for survival-built structures or "play quality".** Existing judges score pixel videos (MCU) or command-built builds (MC-Bench), not traces.
- **Fairness controls for protocol bots.** No benchmark limits Mineflayer's x-ray view ([[perception]]). Jeeve has to define its own information rules for each objective.
