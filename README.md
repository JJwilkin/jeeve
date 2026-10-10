# Jeeve: Minecraft agent

A general-purpose Minecraft agent that can take on many kinds of scenarios: building a house, PvP, Bed Wars, or "beat the game". It's built as a traceable agent: every decision, at every level, shows up as a span in a [Judgment](https://judgmentlabs.ai) trace.

The core idea is **System 1 / System 2**. A fast decision model reacts to the world several times a second. A reasoning LLM sets and revises the higher-level objectives.

## Architecture

```
System 2  reasoning LLM (Claude)      seconds → minutes   goal tree, planning, memory
   │  directive ↓   ↑ escalation
System 1  fast decision model         ~2–10 Hz            picks the next micro-action from recent state
   │  option (action + stop condition)
Reflexes  scripted Mineflayer code    20 Hz (every tick)  pathfinding, aiming, auto-eat, self-defense
   │
Mineflayer bot  ──  Minecraft server (Paper)
```

### Perception
[Mineflayer](https://github.com/PrismarineJS/mineflayer) is a headless client that speaks the Minecraft protocol. It gets the world as data (blocks, entities, velocities, inventory, health), not pixels. A **state builder** runs every tick and turns that stream into what each layer sees:
- **Derived features:** e.g. closing speed, facing angle, health trend, cooldowns.
- **A sliding event window:** dense for the most recent moments, sparser further back. For example, "t-0.8 Steve hit me (-3)".
- **Running summaries:** facts that need to outlast the window.

### System 1 (fast decisions)
System 1 sits behind a single interface:

```ts
decide(state, questions) → { choice, probs, confidence }
```

Questions are typed: the next action (a choice over an action enum), threat level (a score), and whether to escalate (yes/no). Low confidence escalates to System 2.

Backends are swappable:
- [TypeSafe Jev](https://typesafe.ai)
- Microsoft-Decision-1
- A local small LLM (e.g. Qwen3 or Gemma, run with llama.cpp or vLLM) that reads its choice from token logprobs

Actions are **options**: an action plus a stop condition, e.g. "strafe left until hit or 0.6 s". The reflex layer executes them across ticks.

### System 2 (goal tree)
System 2 maintains one structure that is at once the plan, the context, and the trace:

```
beat the game
├─ ✓ basic tools          → "6 min, stone tools + 2 stacks wood"
├─ ▶ iron armor
│   ├─ ✓ find iron        → "cave at (120, -30)"
│   ├─ ▶ mine 24 iron     ← log: last ~1 min
│   │   └─ ⚡ fight zombie ← interrupt; System 1 window: last 5 s
│   └─ ○ smelt + craft
└─ ○ nether → eyes of ender → stronghold → dragon
```

- Each node has `goal`, `status`, `doneCheck`, `log`, `summary` and `children`.
- Nodes are expanded just in time.
- When a node finishes, its log compresses into a one-line summary that bubbles up to its parent.
- The context for any decision is the path from the root to the current node.
- An interrupt pushes a temporary node onto the active path and pops back off when it's handled.

### Memory
| Kind | Holds |
|---|---|
| Goals | The goal tree, durable across restarts |
| World | Base, chests and their contents, resource sightings, danger spots (structured, keyed by position) |
| Episodes | An append-only log of what happened and what failed |
| Skills | Later: Voyager-style learned JS skills |

## Tracing
The trace tree mirrors the goal tree:
- **Session:** one episode.
- **Spans:** goal nodes, then System 1 segments under them, then `decide()` calls.
- **Tool and skill spans** record their arguments, their result, and the game-state change they caused.
- **Reflex activations** get their own spans.
- **The root span** carries `mc.scenario` and `mc.success`.

Judges score each level. They can say whether a subgoal succeeded and how efficient it was, and whether a failure came from a bad directive (System 2) or a bad execution (System 1).

## Scenarios
Each scenario is config, not code:

```
{ name, setup: [server commands | world template], goal, reflexProfile, check, timeBudget }
```

1. **Tech tree:** wood → crafting table → stone pickaxe → iron
2. **Build a house:** the LLM writes a blueprint, and a deterministic builder places it. A block scan checks the result.
3. **PvP:** fight a zombie, then another bot
4. **Bed Wars:** Paper plus a Bed Wars plugin, with several bots on teams
5. **Beat the game:** kill the Ender Dragon

The world is reset over RCON between runs (`/tp`, `/clear`, `/fill`, `/gamerule`). `/tick rate` slows the game down so a reasoning model can play the System 1 role at full quality. Those traces become labelled data for evaluating and fine-tuning the local System 1 model.

## Stack
- TypeScript on Node, with Mineflayer and its plugins (pathfinder, pvp, collectblock, auto-eat, prismarine-viewer)
- Claude for System 2, traced with judgeval
- Pluggable System 1 decision models
- Paper server via [`itzg/minecraft-server`](https://github.com/itzg/docker-minecraft-server)

## Server
- **Size:** 2 vCPU / 4 GB RAM for a small world and 1–3 bots. 4 vCPU / 8 GB for Bed Wars with 4–8 bots.
- **Version:** pin one that Mineflayer, Paper and the Bed Wars plugin all support (1.21.x for now).
- **Security:** bots log in with `online-mode=false`, so firewall port 25565 to your own IP, enable the whitelist, and never expose RCON.

## Roadmap
- [ ] **P0:** Paper server running, plus a Mineflayer hello-bot that joins, chats and follows you
- [ ] **P1:** state builder and skills, System 2 tool loop, tech-tree scenario with a success check
- [ ] **P2:** goal tree and memory, house scenario
- [ ] **P3:** reflex layer, `decide()` with System 1 backends, PvP scenario
- [ ] **P4:** multi-agent, Bed Wars
- [ ] **P5:** beat the game

## Prior art
- [Mindcraft](https://github.com/mindcraft-bots/mindcraft): an LLM + Mineflayer framework with text commands, reflex "modes" and a self-prompted goal
- [Voyager](https://github.com/MineDojo/Voyager): an automatic curriculum and a library of code skills
- Optimus-3 and WISE: System 1 / System 2 agents for Minecraft that use learned pixel policies
