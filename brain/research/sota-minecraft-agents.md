---
date: 2026-10-10
tags: [research, prior-art, survey, system-1, system-2, action-space]
status: active
---
# State of the art in Minecraft agents (2023 to Oct 2026)

A survey of the main Minecraft agents since 2023, weighted toward 2025–2026. It sorts them by **where the action line sits** (raw keyboard/mouse, mid-level skills, or code) and by **whether the world waits while the model thinks**. Those are the two axes that matter for [[overview]].

Already covered elsewhere, and only linked here: [[gitm]], [[mindcraft-and-voyager]], [[fast-slow-agents]], [[perception]], [[decision-models]]. Project Sid / Altera is out of scope here. Deeper notes: [[peam]] (slow LLM distilled into a fast module, on Mineflayer) and [[openha-crossha]] (which action level to use).

**On numbers:** every result below is **self-reported by the paper or vendor**. None is independently reproduced. Benchmarks differ in episode length, block-breaking speed and task sets, so numbers in different rows are rarely comparable.

## Two axes
**Action level.**
- **L0, raw:** keyboard and mouse at 20 Hz from pixels (MineRL, MineStudio). This is what VPT-lineage agents use.
- **L1, mid-level skills:** parameterized calls such as `mine(block)`, `craft(item)`, `approach(target)`, run by scripts or a learned controller.
- **L2, code:** the model writes programs against an API (Mineflayer JS), as in Voyager.

Mineflayer starts Jeeve at roughly L1: dig, place, craft and pathfind are API calls, not held keys ([[perception]]).

**Clock.**
- **Step-locked:** MineRL and MineDojo are gym environments. As far as we know the game advances only when the agent calls `step`, so model latency is free. This is our inference about those simulators; most papers don't say.
- **Paused server:** Voyager installs a Fabric mod, Multi Server Pause, "used to pause the server when waiting for GPT-4 to reply" ([Voyager install docs](https://github.com/MineDojo/Voyager/blob/main/installation/fabric_mods_install.md)). ODYSSEY and PEAM build on Voyager's code, so they probably inherit it (unverified).
- **Live:** the server keeps ticking while the model thinks. This is what Jeeve faces. It is rare in the literature: PillagerBench, Parallelized Planning-Acting, and Mindcraft (Mindcraft is our reading of its design, unverified).

## Comparison table
Action level: L0 raw / L1 skills / L2 code. Clock: S = step-locked sim (inferred), P = paused server, L = live, ? = not stated.

| System | Family | Action | Hand-built | Learned / discovered | Clock | Headline result (self-reported) | Cost (stated) |
|---|---|---|---|---|---|---|---|
| [VPT](https://ar5iv.labs.arxiv.org/html/2206.11795) (2022) | Pixel policy | L0 | Item-milestone reward for the RL stage (from memory, unverified) | Behavior prior from ~70k h IDM-labeled video; RL fine-tune | S | Diamond pickaxe in 2.5% of 10-min episodes, diamonds ~20% | Pretrain ~9 days on 720 V100s |
| [STEVE-1](https://arxiv.org/abs/2306.00937) (2023) | Pixel policy | L0 | — | VPT tuned to follow MineCLIP / text goals via hindsight relabeling | S | 12 of 13 early-game tasks | $60 of compute |
| [DreamerV3](https://www.nature.com/articles/s41586-025-08744-2) (Nature, Apr 2025) | World-model RL | L0 (flat categorical, MineRL) | Milestone rewards; faster block breaking | Everything else, from scratch, no human data | S | Every run finds a diamond within 100M steps; 0.4% of episodes at budget | 1 A100, ~9 days per run |
| [Dreamer 4](https://arxiv.org/html/2509.24527v1) (Sep 2025) | World-model RL | L0 | — | World model from 2.5k h of video; policy trained only in imagination | Offline | First diamonds from offline data only: 0.7% diamond, 29% iron pickaxe | 256–1024 TPU-v5p |
| [DEPS](https://arxiv.org/abs/2302.01560) (NeurIPS 2023) | Planner + controller | L0 via goal-conditioned controller | Prompted describe/explain/plan loop | Goal selector (trained) | S | 70+ tasks zero-shot | — |
| [Plan4MC](https://arxiv.org/abs/2303.16563) (2023) | Planner + controller | L0 via RL skills | Skill types, intrinsic rewards | Skills by RL; skill graph by LLM | S | 40 tasks, "large margin" over baselines | — |
| [GITM](https://arxiv.org/html/2305.17144v2) (2023) | LLM + scripted skills | L1 (9 scripted actions) | Actions, wiki knowledge | Plan memory | S | Diamond 67.5% (10 min, fast breaking). See [[gitm]]. | 32-core CPU, 2 days, plus API |
| [Voyager](https://arxiv.org/abs/2305.16291) (2023) | LLM + code | L2 (Mineflayer JS) | API primitives | Skill library, curriculum | **P** | 3.3x items, 15.3x faster tech tree than prior SOTA | GPT-4 API |
| [JARVIS-1](https://ar5iv.labs.arxiv.org/html/2311.05997) (2023) | Planner + controller | L0 via STEVE-1; craft/smelt are env macros | Prompted planner | Multimodal plan memory, self-instruct curriculum | S | Diamond pickaxe 6.22% (20 min), 12.5% (60 min); 200+ tasks | — |
| [OmniJARVIS](https://arxiv.org/abs/2407.00114) (NeurIPS 2024) | Unified VLA | L0 via behavior-token decoder | — | Behavior tokens learned self-supervised | S | "Excellent" on atomic/programmatic/open tasks (no number on abstract) | — |
| [Optimus-1](https://arxiv.org/abs/2408.03615) (NeurIPS 2024) | Planner + controller | L0 | Planner prompts | Knowledge graph + experience pool (how the graph is built: unverified) | S | Diamond group 0.11 (see table below) | — |
| [Optimus-2](https://arxiv.org/html/2502.19902) (CVPR 2025) | Planner + controller | L0 (VPT action head) | GPT-4V planner prompts | GOAP policy (1.3B) from 30M goal-obs-action pairs | S | Diamond group 0.13; +27% atomic vs prior SOTA | 8x L40; ~7 d data, ~2 d training |
| [Optimus-3](https://arxiv.org/html/2506.10357v2) (Jun 2025) | One MoE model, System 1 + 2 | L0 (VPT head) | Router task classes | Planning, perception, action, reflection experts; RL (DGRPO) | S | Planning 0.94; open-ended SR 0.60 vs 0.16 for Optimus-2; Diamond group 0.15 | 8x L40; ~$300 API for data |
| [ROCKET-1](https://arxiv.org/html/2410.17856v3) (2024) | Planner + controller | L0 | GPT-4o / Molmo reasoner, SAM-2 tracker | Mask-conditioned policy | S | Interaction benchmark 0.82 vs STEVE-1 0.19; diamond 0.25 | — |
| [ROCKET-2](https://arxiv.org/abs/2503.02505) (Mar 2025) | Planner + controller | L0 | — | Cross-view goal policy | S | 3–6x faster inference than ROCKET-1; zero-shot to Doom/DMLab/Unreal | — |
| [MrSteve](https://arxiv.org/abs/2411.06736) (ICLR 2025) | Planner + controller | L0 (STEVE-1) | Memory structure | Place-event memory contents | S | "Significantly" better exploration/task solving | — |
| [WISE](https://arxiv.org/html/2606.12852v2) (Jun 2026) | Planner + controller | L0 (STEVE-1, VPT-Nav) | Causal event graph, scheduler | Affordance graph via GPT-4o | S, but VLM runs async to control | ABA-Sparse 62% vs MrSteve 32%; ABC-Sparse 77% vs 33% | ~$0.48 API per episode |
| [MineDreamer](https://arxiv.org/abs/2403.12037) (2024) | Planner + controller | L0 | — | Diffusion "imagined" goal images | S | ~2x best generalist baseline | — |
| [JARVIS-VLA](https://arxiv.org/abs/2503.16365v1) (ACL Findings 2025) | Pixel VLA | L0 | — | VLM post-trained on game VQA, then imitation | S | 1k+ atomic tasks; +40% over best baseline | — |
| [OpenHA](https://arxiv.org/html/2509.13347v1) (Sep 2025, ICML 2026) | Pixel VLA, mixed levels | L0 plus text, motion, grounding | Action-space definitions, relabeling rules | One 7B model over all spaces (chain of action) | S | No single action space wins; mixed model best overall. See [[openha-crossha]]. | — |
| [CrossHA](https://arxiv.org/html/2512.09706) (CVPR 2026) | Pixel VLA, mixed levels | Picks raw, motion or grounding per step | Space definitions | **Which level to use**, via multi-turn GRPO | S | ASR 54.6% vs 23.4% best single-space; OOD 49.1% vs 42.4% | — |
| [XENON](https://arxiv.org/abs/2505.24157) (ICLR 2026) | Planner + controller | ? | — | Item dependency graph and action knowledge corrected from own successes/failures | ? | 7B planner beats agents on larger proprietary models (no number on abstract) | — |
| [MineEvolve](https://arxiv.org/abs/2603.13131) (Mar 2026) | Planner + controller | ? (MCU suite) | Monitor/inducer/curator roles | Skills and remedies from execution feedback | ? | Gains across several planners (no number on abstract) | — |
| [ODYSSEY](https://arxiv.org/abs/2407.15325) (IJCAI 2025) | LLM + skills | L1/L2 (Voyager code base, [repo](https://github.com/zju-vipa/Odyssey)) | 40 primitive + 183 compositional skills | LLaMA-3 fine-tuned on 390k wiki Q&A | P? | Benchmark paper; no headline number on abstract | — |
| [PEAM](https://arxiv.org/html/2605.27762) (May 2026) | Slow LLM + fast learned module | L2 (Mineflayer JS) | Voyager primitives | Fast Qwen3-VL-8B LoRA experts consolidated from GPT-4o successes and corrections | ? | 69.7% vs Voyager 54.5% on 11 tasks (33 trials). See [[peam]]. | 3.2 s median per call |
| [SIMA 2](https://arxiv.org/html/2512.04797) (Google DeepMind, Nov 2025) | Pixel generalist | L0 (96 keys + mouse, from 720p) | — | Gemini Flash-Lite agent; self-improves with Gemini task setter and Gemini reward model | ? | Held-out MineDojo: tasks in 26 of 50 categories vs 2 for SIMA 1 | — |
| [MineCollab](https://arxiv.org/html/2504.17950) (Apr 2025) | Multi-agent LLM | L1 (47 commands) + L2 fallback | Commands | 8B SFT on own successful runs | L? | Claude 3.5 Sonnet best; detailed plan-sharing costs >15% | — |
| [TeamCraft](https://arxiv.org/html/2412.05255) (Dec 2024) | Multi-agent VLA | L1 (8 skills with coordinates) | Skills | 7B/13B VLA by imitation | S | Centralized 7B: building 0.42; GPT-4o ≈ 0 | — |
| [PillagerBench](https://arxiv.org/html/2509.06235v1) (IEEE CoG 2025) | Multi-agent, competitive | L2 (Mineflayer JS) | Rule-based opponents | Tactics, opponent adaptation via self-play | **L** | TactiCrafter win rate 0.46 vs scripted teams | 5–25 s per LLM response |
| [Parallelized Planning-Acting](https://arxiv.org/html/2503.03505v2) (Mar 2025) | Multi-agent LLM | L1 (Mineflayer skills) | Skill library | — | **L** | Planner and actor threads; Ender Dragon 91.7% with 10 agents | Qwen-Plus |

## The families
### 1. Pixel policies and VLAs
One network maps frames to keyboard and mouse.
- **VPT** set the template: label 70k hours of YouTube with an inverse dynamics model trained on ~2k contractor hours, then clone ([VPT](https://ar5iv.labs.arxiv.org/html/2206.11795)).
- **STEVE-1** made VPT follow instructions for $60 ([STEVE-1](https://arxiv.org/abs/2306.00937)). It became the default low-level controller for the hierarchical family.
- **2025's VLAs** fold a pretrained vision-language model into the policy. Examples: JARVIS-VLA ([arXiv](https://arxiv.org/abs/2503.16365v1)), OpenHA and CrossHA ([[openha-crossha]]).
- **SIMA 2** is the frontier-lab entry ([paper](https://arxiv.org/html/2512.04797), [blog](https://deepmind.google/blog/sima-2-an-agent-that-plays-reasons-and-learns-with-you-in-virtual-3d-worlds/)).
  - A Gemini Flash-Lite agent plays many commercial games through keyboard and mouse. Flash-Lite was picked over Pro partly for latency.
  - Minecraft (MineDojo) was **held out**. SIMA 2 completes tasks in 26 of 50 MineDojo categories. Naive humans managed ~19% on 16 tasks.
  - It self-improves: a Gemini task setter proposes tasks, a Gemini reward model scores the trajectories 0–100, and the agent trains on the result.
- **NVIDIA's NitroGen** (40k hours, 1,000+ games, gamepad actions) reports no Minecraft results that we found ([project](https://nitrogen.minedojo.org/)).

### 2. World-model RL
- **DreamerV3** (Nature, April 2025) is the only agent that gets diamonds **from scratch with no human data** ([Nature](https://www.nature.com/articles/s41586-025-08744-2), [arXiv PDF](https://arxiv.org/pdf/2301.04104v2)).
  - The paper is candid about the cost. Every run finds a diamond within 100M steps (~100 in-game days), but at the budget only **0.4% of episodes** get one.
  - It also borrowed the faster block-breaking setting "because the provided action space would make it challenging for stochastic policies to keep a key pressed".
- **Dreamer 4** (Sep 2025) trains the policy **entirely inside a learned world model** from the 2.5k-hour VPT contractor set, with no environment interaction ([paper](https://arxiv.org/html/2509.24527v1), [project](https://danijar.com/project/dreamer4/)).
  - Over 60-minute episodes it reaches iron pickaxe 29% and diamond 0.7%. A Gemma-3 VLA baseline reaches iron pickaxe 11%. Fine-tuned VPT stalls at sticks.
  - The 2B-parameter world model runs interactively in real time on one GPU.
- **Adjacent:** Solaris builds a *multiplayer* Minecraft video world model from 12.64M frames ([arXiv](https://arxiv.org/abs/2602.22208)).

### 3. Hierarchical: planner + learned controller
This is the dominant academic pattern, and the closest to a System 2 / System 1 split. A VLM or LLM plans, and a STEVE-1-family pixel controller acts. Over time the work changed **the interface between the two levels**:

| Interface | Example |
|---|---|
| Text subgoal | DEPS, JARVIS-1, Optimus-2 |
| Imagined goal image | MineDreamer |
| Segmentation mask on the agent's view | ROCKET-1 |
| Mask from a *different* camera | ROCKET-2 |
| Learned behavior tokens | OmniJARVIS |
| No separate controller: one model, fast and slow paths | Optimus-3, OpenHA |

Long-horizon success on the Optimus benchmark (67 tasks in 7 tech groups, MineRL, self-reported, [Optimus-2](https://arxiv.org/html/2502.19902), [Optimus-3](https://arxiv.org/html/2506.10357v2)):

| Group | Optimus-1 | Optimus-2 | Optimus-3 | Human |
|---|---|---|---|---|
| Wood | 0.98 | 0.99 | 0.99 | 1.00 |
| Stone | 0.92 | 0.93 | 0.95 | 1.00 |
| Iron | 0.46 | 0.53 | 0.55 | 0.86 |
| Gold | 0.08 | 0.09 | 0.10 | 0.17 |
| Diamond | 0.11 | 0.13 | 0.15 | 0.16 |
| Redstone | 0.25 | 0.28 | 0.29 | 0.33 |
| Armor | 0.19 | 0.21 | 0.23 | 0.28 |

Three years of the family moved Diamond from 0.11 to 0.15. The human baseline is low too (0.16), which suggests the benchmark's time limit is tight.

**Optimus-3** ([paper](https://arxiv.org/html/2506.10357v2)) is the explicit System 1/2 design. It's covered briefly in [[fast-slow-agents]]; here is the extra detail:
- One Qwen2.5-VL-7B turned into a mixture of experts (6.8B active): a shared expert plus planning, perception, action, grounding and reflection experts.
- A Sentence-BERT **task router** picks the expert. A **layer router** skips layers on action calls, because without it per-action latency exceeds the 50 ms a 20 Hz game allows.
- Its reasoning training data is synthesized *from* System 1 trajectories (System 2 traces written after the fact). That is the reverse of Jeeve's direction, where slow decisions get distilled into a fast model.
- The abstract's headline gains ("3.4x grounding") don't match its own tables (0.80 vs 0.79), as the summary above notes.

**WISE** (2026) is the current long-horizon leader on sparse tasks over MrSteve ([paper](https://arxiv.org/html/2606.12852v2)).
- It is notable for one engineering detail: VLM inference runs **asynchronously** so it doesn't block 20 Hz control.
- It costs ~$0.48 of GPT-4o per episode.
- It is evaluated on fixed maps only.

**Knowledge-from-experience planners** (2025–26) all learn the tech tree instead of being handed it, which is the [[bitter-lesson]] direction:
- XENON corrects a dependency graph from its own successes and failures ([ICLR 2026](https://arxiv.org/abs/2505.24157)).
- MineEvolve induces skills and remedies from execution feedback ([arXiv](https://arxiv.org/abs/2603.13131)).
- JARVIS-1's plan memory is the earlier version of the idea ([JARVIS-1](https://ar5iv.labs.arxiv.org/html/2311.05997)).

### 4. LLM planners + scripted skills or code (structured state)
This is the family Jeeve belongs to: Mineflayer, structured data, no pixels.
- **GITM and Voyager:** see [[gitm]] and [[mindcraft-and-voyager]]. The new fact here is that **Voyager pauses the server while GPT-4 thinks** ([install docs](https://github.com/MineDojo/Voyager/blob/main/installation/fabric_mods_install.md)).
- **ODYSSEY** ships 223 hand-written skills plus a wiki-tuned LLaMA-3 ([arXiv](https://arxiv.org/abs/2407.15325), [repo](https://github.com/zju-vipa/Odyssey)). That's hand-built knowledge in both places.
- **PEAM** (May 2026) is the only system we found that **distills a slow LLM into a fast learned module over Mineflayer** ([paper](https://arxiv.org/html/2605.27762)). See [[peam]]. This partly closes the gap that [[fast-slow-agents]] calls "largely unexplored", though at small scale and not in real time.

### 5. Multi-agent
- **MineCollab** (Mindcraft's benchmark): the bottleneck is communication, not acting ([paper](https://arxiv.org/html/2504.17950)).
  - Best success rates: Claude 3.5 Sonnet with 0.47 crafting, 0.64 cooking, 0.36 construction.
  - Requiring detailed plan-sharing cut performance by >15%.
  - An 8B model fine-tuned on ~200 of its own successful runs beat GPT-4o at crafting (0.28 vs 0.17).
- **TeamCraft:** a fine-tuned 7B VLA beats GPT-4o, which scores ~0 ([paper](https://arxiv.org/html/2412.05255)). Decentralized agents do far worse than centralized ones.
- **PillagerBench** is the one **real-time, competitive** benchmark ([paper](https://arxiv.org/html/2509.06235v1)).
  - Two-minute team-vs-team matches. The best LLM team wins 46% against *scripted* opponents.
  - Response time is part of the score: GPT-4o ~9 s per response, o3-mini ~25 s and worse overall despite reasoning more.
- **Parallelized Planning-Acting** runs a planner thread and an actor thread per agent, over a single-slot interruptible action buffer, on a live server ([paper](https://arxiv.org/html/2503.03505v2)). It reports no measured serial-vs-parallel speedup.
- **2026 multi-agent papers seen but not read past the abstract:** TickingCollabBench ([2606.15684](https://arxiv.org/abs/2606.15684)), Gated Coordination ([2604.18975](https://arxiv.org/abs/2604.18975)), GenCoord ([2608.22055](https://arxiv.org/pdf/2608.22055)).

### 6. Benchmarks that measure frontier models (2026)
- **MineExplorer** (EMNLP 2026): screenshots plus a discrete move/jump/collect/place/craft/attack action space ([paper](https://arxiv.org/html/2605.30931v4)).
  - Best overall task success is Claude Opus 4.6 at 41.1%, then Gemini 3.1 Pro at 37.0% and GPT-5.2 at 21.3%.
  - Opus 4.6 drops from 77.7% on single-hop tasks to 23.9% on multi-hop tasks with hidden prerequisites.
  - Thinking variants of Qwen-3-VL scored *lower* than instruct variants.
- **SciCrafter:** redstone circuits under a code-agent scaffold ([arXiv](https://arxiv.org/abs/2604.24697)). GPT-5.2, Gemini 3 Pro and Claude Opus 4.5 all plateau around 26%. Applying discovered knowledge is the biggest gap.
- **MC-Bench:** models write code to build, and humans vote ([TechCrunch](https://techcrunch.com/2025/03/20/a-high-schooler-built-a-website-that-lets-you-challenge-ai-models-to-a-minecraft-build-off)). It's the one live outcome signal for "does this build look good". Current rankings are unverified.
- **Not found:** any frontier lab publishing a full-survival or beat-the-game Minecraft agent result. A search turned up none (as of 2026-10-10).

## Diamonds, the old yardstick
The settings differ in every row, so this is not a leaderboard.

| System | Diamond | Setting |
|---|---|---|
| VPT + RL | ~20% (diamond pickaxe 2.5%) | 10-min episodes, human-video prior |
| GITM | 67.5% | 10 min, fast breaking, 9 scripted actions |
| JARVIS-1 | diamond pickaxe 6.22% / 12.5% | 20 / 60 min |
| ROCKET-1 (hierarchical) | 25% | Own long-horizon task |
| Optimus-3 | 0.15 group SR | Optimus benchmark |
| DreamerV3 | 0.4% of episodes | From scratch, fast breaking, 30 min |
| Dreamer 4 | 0.7% | Offline data only, 60 min |

**Reading:** with scripted mid-level actions it's mostly solved (GITM). Learned end-to-end from pixels with little or no human data, it's still under 1%.

## Takeaways for Jeeve
### Where the line between low- and high-level actions sits
- **Raw input is out.** An LLM on raw keyboard and mouse scores 0% ([[gitm]]). DreamerV3 needed faster block breaking just to hold a key.
  - Pixel agents spend most of their effort on things Mineflayer gives Jeeve for free: holding attack, crafting through the GUI, pathfinding.
  - OpenHA's "GUI" task category, where hierarchical pixel agents score 0–7%, is a single `bot.craft` call for us ([[openha-crossha]]).
- **No single level is best.** OpenHA's controlled comparison found that no action space wins everywhere.
  - Motion primitives help navigation, grounding (verb + target) helps targeting, and raw helps fixed sequences.
  - CrossHA's answer is a [[bitter-lesson]] one: **offer several levels and let RL learn which to use per step.** A token-cost penalty favors the higher level when both succeed. That beat every fixed level (49.1% vs 42.4% out of distribution).
- **What this suggests for [[overview]]'s primitive-set question:**
  - Keep generic primitives at Mineflayer's grain (≈ OpenHA's grounding level: verb + target).
  - Let *higher* levels (composite skills) be written and kept by the agent, as Voyager, MineEvolve, XENON and PEAM do.
  - Make level choice a learned decision, not a fixed layer. Hand-written composite skills (ODYSSEY's 223, Mindcraft's 49 commands) are the knowledge-building pattern to avoid.
- **The trend in 2025–26 is one model with switchable depth.** Optimus-3 uses a layer router; OpenHA has fast and slow modes.
  - Optimus-3's stated reason: one dense model serving both systems causes task interference.
  - Jeeve's two-model split (frontier slow, small fast) is a different bet. PEAM is the evidence it can work: separate per-category adapters stopped forgetting (0% vs 32% for one shared LoRA).

### What's genuinely unsolved in 2026
- **Real-time play with a reasoning model.**
  - Almost every result above was measured with the world stopped: a step-locked simulator, or Voyager's pause mod.
  - Where the clock runs (PillagerBench), LLM responses take 5–25 s, the slower reasoning model did *worse*, and teams lose most games to scripted bots.
  - The pixel family hits latency from the other side: Optimus-3 had to skip layers to fit 50 ms.
  - Jeeve's fast/slow split targets exactly this gap. Asynchronous planning (WISE) and interruptible action buffers (Parallelized Planning-Acting) are the only concrete mechanisms we found.
- **Long horizons with hidden prerequisites.**
  - Frontier models do well on one-hop tasks and collapse on multi-hop ones (MineExplorer: 77.7% → 23.9%). More thinking didn't help.
  - Diamond-tier groups sit at ~10–15% for the best hierarchical agents.
- **Learning without human data.** From-scratch or offline-only diamonds are under 1% per episode (DreamerV3, Dreamer 4).
- **Applying what was discovered.** SciCrafter's frontier models plateau at ~26% and fail most at turning a discovered rule into a working build.
- **Opponents and teams.**
  - Only one competitive benchmark exists (PillagerBench), and its opponents are scripted.
  - In cooperative play, communication is the bottleneck (MineCollab).
  - No PvP or Bed Wars results exist.
- **The full game.** We found no agent that beats the Ender Dragon solo from a fresh survival world.
  - Parallelized Planning-Acting reports Dragon kills with 10+ agents. Its starting conditions are unverified.
- **Outcome signals for open-ended goals.**
  - SIMA 2 is the strongest precedent for Jeeve's "judges as reward": a Gemini task setter plus a Gemini reward model scoring 0–100 drove its self-improvement.
  - Building quality still relies on human votes (MC-Bench).
- **Cost per hour.** Almost no paper reports it. The exceptions are WISE (~$0.48 per episode), Optimus-3 (~$300 of API for data) and PEAM (~4.6K tokens per task). A real-time agent's cost per hour is an open number.
