# Jeeve brain

The project's knowledge store. The whole repo is an Obsidian vault: open the repo root with "Open folder as vault". It holds the *why* and the *how it fits together*. Code facts belong in the code.

We're in the research and architecture stage: no code yet. Plans, decisions and per-module notes will get folders when building starts.

## Layout
| Where | What |
|---|---|
| `brain/architecture/` | How Jeeve works at a high level: principles and structure, not implementation |
| `brain/research/` | What we learned from outside: papers, other projects, models. Facts and sources, not prescriptions. |
| `brain/tasks/` | Self-contained briefs for open work items. Each one can start a fresh chat. Frontmatter adds `progress: todo \| doing \| done`. |

## Conventions
- One idea per note. Frontmatter: `date`, `tags`, `status` (`active` | `superseded`).
- Link with `[[note-name]]`.
- When a note is wrong, mark it `superseded` and link the replacement. Don't silently delete it.
- Add every note to the index below.

## Index
- [[roadmap]]: the four stages before code: research, architecture (primitives, System 1, System 2, their interface), tracing, goals and reward

### Tasks
- [[system-1-infrastructure]]: decide what the runtime provides around System 1 vs. what System 2 decides (state encoding, questions, when to call)
- [[seed-behaviors-and-traces]]: the smallest behavior set for the first milestone, plus the span/trace schema and ingest into Judgment

### Architecture
- [[overview]]: what we build vs. what the agent discovers, the discovery loop, fast and slow thinking, goals and time as one hierarchy, open questions
- [[layers]]: System 2 / Jev / behaviors / guards; the one-right-answer vs. judgment vs. plan rule; concurrent channels; System 2 sets when Jev decides; first milestone: a local client that takes instructions
- [[behaviors-and-guards]]: the deterministic layer: the behavior contract, layered behaviors, safety guards, behaviors System 2 writes at runtime
- [[learning]]: decision: context only, no training. Live and cross-episode loops, per-minute traces linked by lineage, agentic search over past traces

### Research
- [[bitter-lesson]]: search and learning beat hand-built knowledge. The organizing principle.
- [[mindcraft-and-voyager]]: how the two best-known LLM Minecraft agents work, and what they hand-build vs. discover
- [[gitm]]: GITM's LLM goal tree + structured actions + knowledge + memory, the ablation showing what carried it, and what transfers to Jeeve
- [[perception]]: how bots see Minecraft (data, not pixels), where the view gets narrow, encoding time
- [[decision-models]]: Jev, Microsoft-Decision-1 and local small LLMs as fast decision-makers
- [[spatial-models]]: generative world models vs. fast spatial policies, the AlphaStar entity-token recipe, and three ways to give System 1 spatial context
- [[fast-slow-agents]]: prior art for fast/slow agents in Minecraft and robotics, and AlphaZero-style expert iteration
- [[realtime-landscape]]: fast, smart, general: pick two. Scripted bots vs. pixel policies vs. LLM agents, why nobody has combined them, and the gap Jeeve targets
- [[fast-bots]]: how scripted bots (mineflayer-pvp, KillAura, Baritone) perceive and decide: tick timers, filter→sort→act, A* with hand-tuned costs. Physics rules vs. strategy rules.
- [[sota-minecraft-agents]]: survey of ~30 Minecraft agents (2023 → Oct 2026), grouped by family, action level, and whether the world waits for the model. What's unsolved.
- [[peam]]: slow GPT-4o distilled into a fast Qwen3-VL-8B over Mineflayer. The closest Minecraft precedent for System 2 → System 1 distillation.
- [[openha-crossha]]: no single action level wins; learning which level to use per step does. Evidence for the primitives question.
- [[benchmarks]]: Minecraft benchmarks compared for a real-time Mineflayer agent, how each measures success, and which to adopt first
- [[realtime-game-agents]]: how real-time and long-horizon game agents split slow and fast thinking (SIMA 2, AgileThinker, DPT-Agent, StarCraft II…), nine named patterns, and a proposed System 1 / System 2 split
- [[project-sid]]: Altera's PIANO: concurrent modules over shared state, with one decision-maker that keeps speech and action consistent
- [[llm-plays-pokemon]]: Claude and Gemini Pokémon harnesses, what broke over 400–800 hour runs, and lessons for memory and goals
