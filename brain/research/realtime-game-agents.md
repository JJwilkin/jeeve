---
date: 2026-10-10
tags: [research, prior-art, system-1, system-2, latency, memory, long-horizon]
status: active
---
# Real-time and long-horizon game agents

A survey of LLM and foundation-model game agents beyond the usual Minecraft papers. It asks two questions:
- **(a)** How do they handle real time, when the world keeps moving while the model thinks?
- **(b)** How do they handle long horizons and memory?

The aim is to pin down what System 1 and System 2 each do in [[overview]], and how they talk to each other.

Related: [[fast-slow-agents]] covers Minecraft and robotics planner/controller pairs (Optimus-3, DualVLN, …). [[decision-models]] covers fast-model candidates. Deep dives: [[project-sid]] and [[llm-plays-pokemon]]. For Minecraft-specific state of the art and benchmarks, see [[sota-minecraft-agents]] and [[benchmarks]].

## Systems

### Concurrent-module agents
- **Project Sid / PIANO** (Altera, 2024). See [[project-sid]].
  - Modules run concurrently over a shared Agent State: memory, goal generation, social, talking, skills, and reflexes as non-LLM networks.
  - One Cognitive Controller reads a filtered view of that state, and its decision is broadcast to every output so speech and action agree.
  - Scaled to 500 agents, and to 1000+ until the server gave out.
  - Self-reported. No latency numbers and no code.
- **Lyfe Agents** ([arXiv 2310.02172](https://arxiv.org/html/2310.02172)), PIANO's precursor.
  - The LLM chooses an *option*, and cheap non-LLM checks decide when the option ends.
  - A slow self-monitor summarizes asynchronously, off the action path.

### Generalist 3D agents that play from pixels
- **SIMA 1** ([arXiv 2404.10179](https://arxiv.org/html/2404.10179)).
  - Environments "do not stop and wait while the agent computes its next action."
  - It outputs chunks of 8 keyboard-and-mouse actions.
  - It's trained to predict actions **offset in time** to cover its own latency, with the same offset buffered at evaluation.
  - Instructions take about 10 s or less, so it has no long horizon.
- **SIMA 2** ([arXiv 2512.04797](https://arxiv.org/html/2512.04797), Dec 2025).
  - It's a fine-tuned **Gemini Flash-Lite**, chosen over Pro because of "latency constraints". It takes 720p frames and outputs action chunks, with optional reasoning and dialogue at each step.
  - **Hierarchy:** Gemini Pro "operates at a slower cadence". Every *k* steps (value not given) it reads recent video and issues a language instruction. It also keeps a text summary it gets back on its next call, "a form of recurrent memory". Only a qualitative demo is reported.
  - **Self-improvement:** a Gemini task-setter proposes tasks and a Gemini reward model scores them 0–100. In ASKA, success went from under a quarter of tasks to over the threshold on all of them (self-reported).
  - **Limits:** a "limited context window to achieve low-latency interaction". It is weak at combat and at very long tasks.
- **Lumine** (ByteDance Seed, [arXiv 2511.08892](https://arxiv.org/html/2511.08892), Nov 2025): Qwen2-VL-7B playing Genshin Impact.
  - **Rates:** frames at 5 Hz. Each 200 ms step emits six 33 ms action chunks, a 30 Hz output.
  - **Hybrid thinking:**
    - The model decides when to think. A short thought (about 37 tokens) appears at transitions, e.g. a plan becomes invalid or a task finishes. In training data that's roughly every 3.2 s.
    - The first action takes about 114 ms without a thought and about 234 ms with one, so thinking causes brief idle gaps.
    - The latest thought acts as long-term memory, and recent frames as short-term memory. The context resets when a new thought is generated.
  - **Memory window:** 20 frames, though performance peaked at 10.
  - **Latency engineering:** a 25× reduction from StreamingLLM KV reuse, speculative decoding, W8A8 quantization and 4-GPU tensor parallelism. It still acts on frames about 200 ms old.
  - **Results:** finishes the 5-hour Mondstadt storyline at human-like pace, and transfers to other games (self-reported). Hard combat is still 0% in some fights.
- **Game-TARS** (ByteDance Seed, [arXiv 2510.23691](https://arxiv.org/html/2510.23691), Oct 2025): pretrained on 500B tokens over a native keyboard-and-mouse action space.
  - **Sparse thinking:**
    - Reasoning is added to training data *only at steps where an action-only model fails to predict the human's action*.
    - That works out to about 37 tokens per step, against 68 when thinking at every step.
    - Thinking at every step caused hallucinated reasoning loops in Doom.
  - **Memory:** a 32k-token sliding window. Steps that fall out of it keep only their thought text, which supports 2,000+ steps.
  - **Real time:** web games were **paused** during inference.
- **NitroGen** (NVIDIA, [CVPR 2026](https://arxiv.org/html/2601.02427v1)).
  - A pure fast policy, mapping pixels to gamepad actions. It was trained on 40k hours of video from 1,000+ games, with actions recovered from on-screen input overlays.
  - It has no reasoning layer. It shows a learned System 1 can be pretrained broadly.

### Long-horizon harnesses (turn-based)
- **Claude / Gemini Plays Pokémon.** See [[llm-plays-pokemon]].
  - These are 400–800 h runs.
  - The harness keeps a fog-of-war map filled from RAM, goal slots, summaries every 100 turns, a critic every 25 turns, and sub-agents for pathfinding.
  - The main failures: context poisoning, loops once the context passes about 100k tokens, and not noticing it's stuck.
- **Cradle** ([arXiv 2403.03186](https://arxiv.org/html/2403.03186)) plays Red Dead Redemption 2 with GPT-4o.
  - "We must pause those game environments while waiting for backbone model responses."
  - It writes code skills and keeps episodic and procedural memory.
  - It can follow the storyline, but scores 1/5 on combat missions. The cause given is "GPT-4o struggles with real-time combat tasks."

### Real-time action and strategy
- **TextStarCraft II / Chain of Summarization** ([arXiv 2312.11865](https://arxiv.org/html/2312.11865)).
  - The LLM is called once per K observations and returns K macro actions, which go into an action queue.
  - Placement and targeting are handled by rule scripts.
  - GPT-3.5 beat the built-in Level 5 AI 50% of the time, and Level 6 8.3%.
- **Orak** (Krafton, [arXiv 2506.03610](https://arxiv.org/html/2506.03610)): 12 games.
  - Street Fighter III, Super Mario and StarCraft II "require pausing for evaluation".
  - In *real-time* StarCraft II, every model scored 0 on hard.
  - On easy, paused, every model was perfect. In real time, only GPT-4o stayed perfect. Its agent took **about 27 s per step**, against Gemini 2.5 Pro's 99 s.
  - Agent modules (reflection, planning) help strategy games but *hurt* Street Fighter.
- **LLM Colosseum** ([GitHub](https://github.com/OpenGenerativeAI/llm-colosseum)): Street Fighter III, real time.
  - The LLM picks named moves ("Move closer", "Fireball"), and code executes them.
  - The early leaderboard was topped by GPT-3.5 Turbo over GPT-4. Per [press coverage](https://www.3dtested.com/tech-industry/artificial-intelligence/fourteen-llms-fight-it-out-in-street-fighter-iii-ai-showdown-finds-out-which-models-make-the-best-street-fighters), a developer put that down to speed.
  - On the current leaderboard, GPT-4o leads.
  - Claude 3 Sonnet ranked low because of refusals and API latency.
- **OpenRA-RL** (Red Alert, Apr 2026; found only via a [secondary listing](https://qpluslab-openenv-competition.static.hf.space/index.html), unverified).
  - An asynchronous loop for agents slower than real time.
  - Qwen3-32B scored 0.58–0.80 on economy and **0 on combat**.

### Real-time collaboration (Overcooked and others)
- **HLA** ([arXiv 2312.15224](https://arxiv.org/abs/2312.15224)) has three layers:
  - a Slow Mind, a large LLM for intentions and language,
  - a Fast Mind, a small LLM that produces macro actions,
  - an Executor, a reactive policy that turns them into atomic actions.
- **DPT-Agent** ([arXiv 2502.11882](https://arxiv.org/html/2502.11882v1), ACL 2025).
  - System 1 is a **finite-state machine** that keeps acting on its own every 0.25 s step. A* executes its macro actions.
  - System 2 runs Theory-of-Mind and reflection **asynchronously** and writes **code that rewrites the FSM's logic**.
  - Standalone LLMs, including reasoning models, all scored below the plain FSM. The authors argue a small-LLM System 1 like HLA's "still cannot resolve the contradiction between latency and performance."
- **AgileThinker** ([arXiv 2511.04898](https://arxiv.org/html/2511.04898v1), ICLR 2026) on Real-Time Reasoning Gym (Freeway, Snake, Overcooked).
  - **Time is counted in tokens:** the world steps every N generated tokens, and a default action fires if the agent hasn't answered.
  - **Two parallel threads:**
    - a planner that streams long reasoning over a frozen snapshot of the state,
    - a reactive model that runs in the last T_R tokens of each step, reading the **latest observation plus the planner's partial trace so far**.
  - **Results:**
    - Under high time pressure, planning-only fell from 0.92 to 0.05. AgileThinker fell from 0.90 to 0.58.
    - It still won when the two threads *took turns* on one model instead of running in parallel. The gain comes from splitting the roles, not from extra compute.
    - Forcing a thinking model under a hard token budget mostly produced no-ops.
- **GPTNT** ([arXiv 2606.28514](https://arxiv.org/abs/2606.28514), TMLR 2026): Keep Talking and Nobody Explodes, with a live clock and asynchronous partners. **No model defused a single bomb in real time.**

### Benchmarks that measure the latency cost directly
- **VideoGameBench** ([arXiv 2505.18134](https://arxiv.org/html/2505.18134)): 1990s games played from raw frames.
  - The best models scored **0.48%** in real time and **1.6% in "Lite"**, where the emulator pauses while the model thinks.
  - Latency is "a major limitation". But the low Lite scores mean reasoning is a bottleneck too.
- **BALROG** ([arXiv 2411.13543](https://arxiv.org/html/2411.13543v2)): turn-based (NetHack, Crafter, …).
  - Best average progress was about 35%. NetHack progress was about 1.5%.
  - It names a "knowing-doing gap": models know rotten food kills, then eat it anyway.
- **lmgame-Bench** ([arXiv 2505.15146](https://arxiv.org/html/2505.15146)): turn-based.
  - The harness supplies perception as text, memory and reflection.
  - Without it, about 40% of runs on non-text games fail to beat random. With it, 86.7% beat random.
  - Memory alone took Llama-4-Maverick from 44.6 to 98.1 on 2048.

### Latency techniques from outside games
- **Real-Time Chunking** (Physical Intelligence, [arXiv 2506.07339](https://arxiv.org/html/2506.07339), NeurIPS 2025).
  - The next action chunk is generated *while the current one executes*.
  - The actions guaranteed to run before inference finishes are **frozen**, and the rest are inpainted to agree with them.
  - With +100 to +200 ms of injected delay it showed no degradation, while synchronous inference degraded roughly linearly.
- **Figure Helix** ([Figure](https://www.figure.ai/news/helix), Feb 2025).
  - System 2 is a VLM at 7–9 Hz that continuously updates a shared **latent vector** in the background.
  - System 1 runs at 200 Hz on the latest observation plus the latest latent.
  - The two are trained end to end.
- **Speculative actions** ([arXiv 2510.04371](https://arxiv.org/pdf/2510.04371), ICLR 2026).
  - A fast model guesses the next action and it runs in parallel. The result is committed only if the slow model agrees.
  - Up to 55% of guesses matched, cutting latency by up to 20% (self-reported, includes game environments).
- **PORTAL** (Tencent, [arXiv 2503.13356](https://arxiv.org/html/2503.13356v1)).
  - The LLM writes **behavior trees** offline, and those run in real time.
  - Self-reported across thousands of FPS games, with no independent reproduction.

## Comparison
**How the slow and fast parts are split**

| System | Slow part | Fast part | Runs concurrently? | Real-time handling |
|---|---|---|---|---|
| PIANO | Cognitive Controller (GPT-4o) | Reflex nets, skill code | Yes: all modules over shared state | Never blocks; no numbers |
| SIMA 2 | Gemini Pro every *k* steps | Flash-Lite policy, action chunks | Yes | Smaller model for latency |
| Lumine | Same model, thinks sometimes | Same model, acts at 5 Hz | No, one stream | Adaptive thinking + inference engineering |
| Game-TARS | Same model, sparse thinking | Same model | No | Paused (web games) |
| Pokémon harnesses | Main LLM + critic + sub-agents | Navigator / pathfinder code | No | Game waits |
| Cradle | GPT-4o modules | Code skills | No | Paused |
| TextSC2 | LLM every K steps | Action queue + micro scripts | Partly (the queue drains) | Batched macro actions |
| DPT-Agent | ToM + reflection, writes code | FSM + A* | Yes, asynchronous | FSM never waits |
| AgileThinker | Planner thread | Reactive LLM thread | Yes | Reads the planner's partial trace |
| Helix | VLM at 7–9 Hz | Policy at 200 Hz | Yes | Latent updated in background |

**Memory, long horizons and results**

| System | Memory / long horizon | What the harness provides | Result | Known failure modes |
|---|---|---|---|---|
| PIANO | Working / short / long-term memory (not specified) | Skills, server | ~320 items with 49 agents in 4 h (self-reported) | Hallucinations spread between agents; incoherence |
| SIMA 2 | Pro's text summary as recurrent memory | Nothing privileged (pixels only) | About 2× SIMA 1 (self-reported) | Long tasks, combat |
| Lumine | Latest thought = long-term; 10–20 frames | None beyond pixels | 5 h storyline (self-reported) | Hard combat, small objects |
| Game-TARS | 32k window; keeps only old thoughts | None beyond pixels | MCU 72% embodied (self-reported) | Loops when thinking every step |
| Pokémon (Gemini) | Summaries every 100/1000 turns; goal slots; auto map | RAM text, map, tools | Beat Blue in 406 h | Poisoning, >100k loops, panic |
| VideoGameBench agent | Scratchpad | Frames only | 0.48% real time vs 1.6% paused | Knowing-doing gap, overwritten notes |

## Recurring patterns for slow/fast interaction
1. **Pause-the-world.** The game waits while the model thinks.
   - Examples: Cradle, Game-TARS on web games, VideoGameBench Lite, Orak's action games, Pokémon, and [[gitm]] on MineDojo.
   - It isolates reasoning from latency.
   - The cost of removing it is large: real-time StarCraft II hard went to 0, and VideoGameBench fell from 1.6% to 0.48%.
   - It's useful as a *mode* (for evaluation and collecting labels), not as an architecture.
2. **Directive + executor.** The slow model sends a goal *down*, and a fast layer carries it out.
   - Examples: SIMA 2 with Pro, Helix, HLA, TextSC2's macro-then-micro, LLM Colosseum's named moves.
   - The directive can be language (SIMA 2), a latent (Helix), or a named macro (TextSC2).
   - **Almost none of these have a path back up.** The executor runs until the next directive on a fixed cadence (every *k* steps).
3. **Option + cheap termination.** The slow model commits to an option, and non-LLM code decides when it's done (Lyfe Agents).
   - This is [[overview]]'s "options with a stop condition".
   - The evidence: without it, the controller gets called every step and behaviour churns.
4. **Concurrent modules with a coherence bottleneck** (PIANO).
   - Many modules run at their own pace over a shared state.
   - One decision-maker reads a filtered view of it and broadcasts its decision, which every output stream must follow.
   - This fixes saying one thing and doing another.
5. **Think-while-acting with streamed plans** (AgileThinker).
   - The planner never blocks. The reactive layer acts on time, reading whatever the planner has produced *so far*.
   - It is allowed to override a plan that has gone stale.
   - The key detail: the planner reasons over a snapshot that's out of date by its own latency.
6. **Compile slow thought into fast code.** System 2 writes a *policy*, not an action, and the policy runs at full speed.
   - Examples: DPT-Agent rewriting its FSM, PORTAL's behavior trees, Cradle and Voyager skills ([[mindcraft-and-voyager]]).
   - Mixed results for code-as-policy in AgileThinker: it worked on Freeway but did worse on Snake and Overcooked.
7. **Adaptive thinking inside one model** (Lumine, Game-TARS).
   - There's no separate System 2. One model learns *when* to think, and its thoughts double as long-term memory.
   - Game-TARS's training recipe is the interesting part: add reasoning only where the fast policy alone gets the action wrong.
8. **Latency-aware action chunks** (SIMA 1's time offset, Lumine's sub-steps, RTC's freeze-and-inpaint, TextSC2's queue).
   - Whatever is already committed keeps running while the next decision is computed.
   - The new decision has to agree with what will already have happened by the time it lands.
9. **Speculation** (speculative actions). A fast model guesses, and the slow model confirms. The guess runs early, and a wrong guess is rolled back.

**Patterns for long horizons**
- **Rolling summaries:** Pokémon every 100/1000 turns, Lumine's latest thought, Game-TARS keeping only old thoughts.
- **Memory the harness owns:** Gemini's map filled from RAM.
- **Explicit goal slots** (Gemini).
- **A critic on a timer** (Guidance Gemini, Critic Claude).
- **Clean-context sub-agents** for search-heavy problems (pathfinder).

**Recurring failures**
- context poisoning,
- loops once the context passes about 100k tokens,
- not noticing being stuck,
- the knowing-doing gap,
- falling for an obvious-looking but wrong path,
- panic.

## Takeaways for Jeeve
Taken together, this points to a concrete split. It's a proposal for [[overview]], not yet a decision.

**System 2: owns commitments and time.**
- Expands and edits the goal tree. Each directive it sends down is an option with a success check, a stop condition, a budget (time or steps) and any constraints.
- Never sends per-tick actions.
- Runs **continuously and asynchronously**. It never blocks System 1, and it plans against a state that will be stale by its own latency (AgileThinker, Helix). So:
  - directives should be conditional ("mine iron here unless threatened"), not exact trajectories,
  - each directive carries a version, so System 1 always acts on the latest one.
- Is the **only writer of commitments**. Chat and actions both follow the active node, which is PIANO's bottleneck-and-broadcast rule.
- Spawns **clean-context sub-calls** for search-heavy subproblems such as routes, builds and puzzles. Better still, it calls real search in code.

**System 1: chooses within the directive, several times a second.**
- Picks the next option or primitive from the current state plus the active directive. Optionally it also reads System 2's in-progress reasoning (AgileThinker).
- **Has authority to override a stale directive** for safety (dodge, flee, fight), by pushing an interrupt node ([[overview]]) and escalating.
- **Learned the Game-TARS way:** train it on System 2's decisions, and treat the states where it disagrees with System 2 as the escalation signal. That's a learned answer to "when to escalate", in the spirit of [[bitter-lesson]]. [[peam]] is the Minecraft precedent for distilling slow decisions into a fast model.
- Should be a small model or code. Evidence: SIMA 2 took Flash-Lite for latency, standalone LLMs scored below DPT-Agent's FSM, and a reasoning model forced under a budget produced no-ops. That fits the local and hosted options in [[decision-models]].

**Code at 20 Hz: executes and *terminates*.**
- Runs pathfinding, aiming and reflexes.
- Evaluates each option's stop condition (Lyfe), so neither model gets called just to ask "am I done?".
- Keeps committed action chunks running while the next decision is computed (RTC, SIMA 1).

**Escalation up: typed events with evidence, not a model's self-report.**
| Event | Detected by |
|---|---|
| done / failed | the option's success check |
| budget exceeded | code timer |
| stuck (no progress, repeated failures, same area) | code (Pokémon: models don't notice they're stuck) |
| surprised (expected ≠ observed) | PIANO's action awareness |
| low confidence | System 1's probabilities ([[decision-models]]) |
| directive overridden | System 1 |

**Memory: split by who writes it.**
- Code records **facts** from Mineflayer data: map, explored chunks, chests, deaths ([[perception]]).
- System 2 writes **beliefs and plans** into the goal tree, where each one can be checked and expires.
- Keep System 2's prompt to the path from the root, well under about 100k tokens. A periodic critic call can look for poisoned beliefs.

**Use pause-the-world as a tool, not the design.**
- Run a tick-frozen local server to collect System 2 labels without latency, for distillation as in AlphaZero ([[fast-slow-agents]]).
- Run the same tasks paused and live to measure exactly what latency costs, the way VideoGameBench does.
- Minecraft Java has a `/tick freeze` command from 1.20.3. That's from memory, not checked against Mineflayer.

**Open questions this leaves**
- Should System 1 read System 2's partial reasoning (AgileThinker), or only finished directives?
- Are directives language, structured options, or code (DPT-Agent)?
- Does System 2 run on a fixed cadence (SIMA 2, Helix) or only on events?
