# Jeeve brain

The project's knowledge store. The whole repo is an Obsidian vault: open the repo root with "Open folder as vault". It holds the *why* and the *how it fits together*. Code facts belong in the code.

The architecture is settled for the first milestone and a first runtime slice exists (`src/`, see [[system-1]] → "First implementation"). Code facts live in the code; this vault keeps the why.

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
- [[roadmap]]: research ✓, architecture ✓, tracing ✓, goals and reward (open), first milestone (reached 2026-10-11), and what's next

### Tasks
- [[system-1-infrastructure]] (done → [[system-1]]): decide what the runtime provides around System 1 vs. what System 2 decides (state encoding, questions, when to call)
- [[seed-behaviors-and-traces]] (done → [[seed-behaviors]], [[trace-schema]]): the smallest behavior set for the first milestone, plus the span/trace schema and ingest into Judgment
- [[system-2-and-goals]] (done → [[system-2]]): the goal-tree data model, instruction intake, success checks, how System 2 writes program changes, escalations and window summaries
- [[runtime-authored-behaviors]] (done → [[behaviors-and-guards]]): System 2 writes, trials and registers new behaviors (first case: pillaring to reach leaves), on the shared block view from [[perception]]
- [[perception-tools]] (done → [[perception]]): System 2 asks for detail (scan, reachable) instead of guessing from buckets; owns the block view; exact counts and heights in the summary

### Architecture
- [[overview]]: what we build vs. what the agent discovers, the discovery loop, fast and slow thinking, goals and time as one hierarchy, open questions
- [[layers]]: System 2 / Jev / behaviors / guards; the one-right-answer vs. judgment vs. plan rule; concurrent channels; System 2 sets when Jev decides; first milestone: a local client that takes instructions
- [[system-1]]: System 1 is a program System 2 writes (manifest + modules); the runtime owns channels, `decide()`, bounds, tracing and a pinned fallback; the default program; how programs are compared
- [[seed-behaviors]]: the M1 seed set wrapping mineflayer plugins (behaviors claim channel sets, so M1 asks one joint `body` choice), guards, and the three instructions walked end to end
- [[trace-schema]]: one session per episode, one trace per window (root ends last), span kinds and `jeeve.*` attributes, judgeval-js ingest (<1 s to queryable), virtual SQL queries System 2 runs, volume
- [[system-2]]: the goal tree (one writer, program versions stack with goals), instruction intake by whisper and local API, success checks as code modules, escalations, program changes scoped by goal, window summaries written by code
- [[behaviors-and-guards]]: the deterministic layer: the behavior contract, layered behaviors, safety guards, behaviors System 2 writes at runtime (action API, sandbox, live trials, library)
- [[perception]]: perception as tools: `scan` and `reachable` for System 2 (traced as `perceive` spans), one read-only query layer (`src/world.ts`) shared with modules and authored behaviors, exact counts and heights in the summary, x-ray vs. line of sight
- [[learning]]: decision: context only, no training. Live and cross-episode loops, per-minute traces linked by lineage, agentic search over past traces

### Research
- [[bitter-lesson]]: search and learning beat hand-built knowledge. The organizing principle.
- [[mindcraft-and-voyager]]: how the two best-known LLM Minecraft agents work, and what they hand-build vs. discover
- [[gitm]]: GITM's LLM goal tree + structured actions + knowledge + memory, the ablation showing what carried it, and what transfers to Jeeve
- [[perception]]: how bots see Minecraft (data, not pixels), where the view gets narrow, encoding time
- [[decision-models]]: Jev, Microsoft-Decision-1 and local small LLMs as fast decision-makers
- [[jev-measurements]]: our own Jev measurements: ~160–300 ms, questions nearly free, position bias on close calls, vendor limits
- [[spatial-models]]: generative world models vs. fast spatial policies, the AlphaStar entity-token recipe, and three ways to give System 1 spatial context
- [[fast-slow-agents]]: prior art for fast/slow agents in Minecraft and robotics, and AlphaZero-style expert iteration
- [[realtime-landscape]]: fast, smart, general: pick two. Scripted bots vs. pixel policies vs. LLM agents, why nobody has combined them, and the gap Jeeve targets
- [[fast-bots]]: how scripted bots (mineflayer-pvp, KillAura, Baritone) perceive and decide: tick timers, filter→sort→act, A* with hand-tuned costs. Physics rules vs. strategy rules.
- [[mineflayer-plugin-compat]]: which server version the seed plugins work on (1.21.10, or 26.1.2 with a one-line physics fix), why 1.21.11+ stalls, and which channels pathfinder, pvp and collectblock really drive
- [[sota-minecraft-agents]]: survey of ~30 Minecraft agents (2023 → Oct 2026), grouped by family, action level, and whether the world waits for the model. What's unsolved.
- [[peam]]: slow GPT-4o distilled into a fast Qwen3-VL-8B over Mineflayer. The closest Minecraft precedent for System 2 → System 1 distillation.
- [[openha-crossha]]: no single action level wins; learning which level to use per step does. Evidence for the primitives question.
- [[benchmarks]]: Minecraft benchmarks compared for a real-time Mineflayer agent, how each measures success, and which to adopt first
- [[realtime-game-agents]]: how real-time and long-horizon game agents split slow and fast thinking (SIMA 2, AgileThinker, DPT-Agent, StarCraft II…), nine named patterns, and a proposed System 1 / System 2 split
- [[project-sid]]: Altera's PIANO: concurrent modules over shared state, with one decision-maker that keeps speech and action consistent
- [[llm-plays-pokemon]]: Claude and Gemini Pokémon harnesses, what broke over 400–800 hour runs, and lessons for memory and goals
