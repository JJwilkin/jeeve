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
- [[full-player-action-api]] (done → [[behaviors-and-guards]]): give code System 2 writes every action a player has (craft, containers, attack, use, eat, chat…), keeping no raw bot, guards and channels
- [[system-2a-2b]] (done → [[orchestrator-and-builder]]): split System 2 into an orchestrator (2A, custom loop) and a builder (2B, Vercel AI SDK; Luna later) that talk through capability requests and trial windows
- [[brain-monitor-and-clips]] (done → [[brain-monitor]]): live monitor + Remotion clips showing System 1, System 2 and the builder side by side with the game; fills five trace gaps
- [[live-deployment]] (done → [[deployment]]): Jeeve live at a URL: public spectate page, a goal box only Joshua can use, on one GCP VM
- [[tasks/stateful-system-1|stateful-system-1 task]] (doing → [[architecture/stateful-system-1|stateful-system-1]], proposal): System 1 keeps a working memory (commitment, intent, outcomes) and takes on commitments, local recovery and when to escalate; replay done (moot-answer filter + plan/doing memory; persistent doubt rejected; needs defaults and objects replayed), build and bench A/B next

- [[world-model-data]] (doing → [[world-model-collector]]): collect game-state data for a small world model (Tier 1): a 64-block layered view, 18 scripted actions (3 written by 2B), 60 natural seeds plus built stress scenes, on a separate GCP VM; how the model would plug into Jeeve, cost (~$20–30), phases

### Architecture
- [[overview]]: what we build vs. what the agent discovers, the discovery loop, fast and slow thinking, goals and time as one hierarchy, open questions
- [[layers]]: System 2 / Jev / behaviors / guards; the one-right-answer vs. judgment vs. plan rule; concurrent channels; System 2 sets when Jev decides; first milestone: a local client that takes instructions
- [[system-1]]: System 1 is a program System 2 writes (manifest + modules); the runtime owns channels, `decide()`, bounds, tracing and a pinned fallback; the default program; how programs are compared; needs as the standing objective (eat, wander, glance)
- [[seed-behaviors]]: the M1 seed set wrapping mineflayer plugins (behaviors claim channel sets, so M1 asks one joint `body` choice), guards, and the three instructions walked end to end
- [[trace-schema]]: one session per episode, one trace per window (root ends last), span kinds and `jeeve.*` attributes, judgeval-js ingest (<1 s to queryable), virtual SQL queries System 2 runs, volume
- [[system-2]]: the goal tree (one writer, program versions stack with goals), instruction intake by whisper and local API, success checks as code modules, escalations, program changes scoped by goal, window summaries written by code
- [[orchestrator-and-builder]]: System 2 split in two: 2A runs the game (custom loop), 2B builds behaviors (Vercel AI SDK); capability requests with 2A's pass check, trial windows a code gate grants and pre-empts, 2B's own traces linked to the request, the between-episode loop (`npm run curate`: keep, retire or merge proposals and lessons for review)
- [[behaviors-and-guards]]: the deterministic layer: the behavior contract, layered behaviors, safety guards, behaviors System 2 writes at runtime (sandbox, live trials, library), and the player action API: every Mineflayer action, menus on hands, events, item targets, chat policy
- [[perception]]: perception as tools: `scan` and `reachable` for System 2 (traced as `perceive` spans), one read-only query layer (`src/world.ts`) shared with modules and authored behaviors, exact counts and heights in the summary, x-ray vs. line of sight
- [[brain-monitor]]: the one visual of the three systems (caption, game, System 2 / builder / System 1 with message arrows and the running code): the timeline core, the live monitor on `GET /events`, Remotion clips with speed-ups and captions, `npm run clip <scenario>`, client-look footage from recordings (prismarine-viewer), reels and highlight cuts
- [[bench-hill-climb]]: three scenes scored by Josh (orchard, workshop, guard), unattended `npm run bench`, a skill library shared across runs, `gaps.ts` (ground truth vs what Jeeve believed), the round-by-round log of gaps and harness fixes, and the river, ravine and ledge crossing scenes
- [[architecture/stateful-system-1|stateful-system-1]] (proposal): a working memory rendered into every Jev call, one writer per slot; escalate on persistent doubt, not one close call; stages 2A writes only if needed; needs as System 1's default objective; objects (not voxels or frames) for space and time; replay results
- [[deployment]]: three Jeeves on one GCP VM (Docker Compose, Caddy, a relay that fans the streams out to viewers); what's public vs. locked (basic auth on POSTs, 25565 tailnet-only), sleep and spend caps, measured cost (~$25/h for three awake), CPU and RAM
- [[world-model-collector]]: the world-model data collector: the episode format (header + fixed records, 63 block classes), the step recorder, scripted actions through `Channels` with noise and random input, the rarity-weighted scheduler, the seed queue in rounds, biome start points, Chunky per start, built stress scenes per episode; local measurements (5 steps/s, ~7.5% CPU a bot, ~0.67 KB a step gzipped); phase 2's hand-written actions (`collect/actions/`, authored format) and the terrain queries they fit by
- [[region-graph]]: 2A's view of terrain: regions code flood-fills from the seen memory (water and far ground now seen), links by the guards' rules (drop ≤ 3, climb N, swim, bridge N, unseen), `region_graph` in every call, the `terrain` height-map tool, token budget, ceilings
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
- [[3d-world-representation]]: why 2A got stuck at a river (no terrain in its view, `reachable` disagreeing with the guards), prior art for 3D understanding (MineWorld and Oasis, Memory/Geometry Forcing, Dreamer 4, Hydra, SayPlan, VoxPoser, VSI-Bench), and the proposal: a region graph code builds from the voxel memory, which 2A plans over
- [[sota-minecraft-agents]]: survey of ~30 Minecraft agents (2023 → Oct 2026), grouped by family, action level, and whether the world waits for the model. What's unsolved.
- [[peam]]: slow GPT-4o distilled into a fast Qwen3-VL-8B over Mineflayer. The closest Minecraft precedent for System 2 → System 1 distillation.
- [[openha-crossha]]: no single action level wins; learning which level to use per step does. Evidence for the primitives question.
- [[benchmarks]]: Minecraft benchmarks compared for a real-time Mineflayer agent, how each measures success, and which to adopt first
- [[realtime-game-agents]]: how real-time and long-horizon game agents split slow and fast thinking (SIMA 2, AgileThinker, DPT-Agent, StarCraft II…), nine named patterns, and a proposed System 1 / System 2 split
- [[project-sid]]: Altera's PIANO: concurrent modules over shared state, with one decision-maker that keeps speech and action consistent
- [[llm-plays-pokemon]]: Claude and Gemini Pokémon harnesses, what broke over 400–800 hour runs, and lessons for memory and goals
