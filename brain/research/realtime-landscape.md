---
date: 2026-10-10
tags: [research, real-time, prior-art, system-1, system-2]
status: active
---
# The real-time landscape: fast, smart, general — pick two

Real-time Minecraft bots exist, and some are very good. **None is fast, intelligent and general at once.** Every existing kind of bot gets two of the three. Jeeve is a bet on getting all three.

## Three kinds of bot
| Kind | Examples | Real-time? | Intelligent? | General? |
|---|---|---|---|---|
| **Scripted bots / hacked clients** | [Baritone](https://github.com/cabaletta/baritone) (pathfinding, auto-mining), PvP "killaura" clients, [mineflayer-pvp](https://github.com/PrismarineJS/mineflayer-pvp) | Yes, every tick | Skilled at narrow tasks, no reasoning | No: all hand-coded |
| **Learned pixel policies** | [VPT](https://ar5iv.labs.arxiv.org/html/2206.11795), [STEVE-1](https://arxiv.org/abs/2306.00937), ROCKET, DreamerV3 | Yes, act every frame (20 Hz) from the screen | Short-horizon only. VPT: diamonds ~20%, diamond pickaxe 2.5% of 10-min episodes. No real planning. | Somewhat |
| **LLM agents** | Voyager, [[gitm]], Mindcraft, [[project-sid]] | No: 1–25 s per decision | Yes: plans, crafts, talks, builds | Yes |

**Note on "live" LLM agents.** Some LLM agents do run with the world moving: Mindcraft on a normal server (no pause mod in its code, see [[mindcraft-and-voyager]]), and Project Sid by design. But while the model thinks, the bot mostly stands still and scripted reflexes keep it alive. The world doesn't wait, but the agent isn't reacting intelligently either. Others pause the world outright: Voyager installs a server mod, Multi Server Pause, "to pause the server when waiting for GPT-4 to reply" ([install docs](https://github.com/MineDojo/Voyager/blob/main/installation/fabric_mods_install.md)).

## Why nobody has combined them
1. **The speed gap is huge.**
   - A game tick is 50 ms; an LLM call takes 1–25 s (PillagerBench measured 5–25 s, see [[benchmarks]]). That's a 20–500× gap.
   - The model can't sit in the per-tick loop, so a fast layer is needed underneath. That layer is the hard part.
2. **Research rewards pausing the world.**
   - The standard benchmarks (MineRL, MineDojo) are step-based: the world only advances when the agent acts.
   - That makes results reproducible and isolates reasoning from speed, so the published numbers are mostly paused ([[sota-minecraft-agents]]).
3. **Learned fast policies are expensive and shallow.** VPT pretrained on ~70k hours of video, for ~9 days on 720 V100s, and still can't reason or follow a long plan.
4. **The two halves come from different research communities.**
   - Reinforcement-learning and pixel-policy researchers build fast controllers. LLM-agent researchers build planners.
   - Few have worked on the interface between them: what the slow layer hands down, when the fast one escalates, who overrides whom.
   - The few that did (Optimus-3, WISE) paired a planner with a *learned pixel* controller, and still evaluated with the world paused ([[fast-slow-agents]]).
5. **The fast bots that exist were built for other reasons.**
   - Baritone and PvP clients exist for grinding and cheating, and are built by hand.
   - They're excellent, but they are exactly the hand-built knowledge [[bitter-lesson]] warns about, and nobody has connected them to a reasoning model.

## What this means for Jeeve
The open problem isn't "real-time play". It's the **combination**:
- reflexes as good as Baritone's,
- planning as good as a reasoning model's,
- a **learned layer in between that improves with experience**.

Most of the pieces exist separately:

| Piece | Exists as |
|---|---|
| Fast scripted layer | Mineflayer + plugins (pathfinder, pvp, collectblock) |
| Reasoning | Frontier models (System 2) |
| Learned middle layer | Decision models ([[decision-models]]), slow→fast distillation ([[peam]]) |

What would be new: wiring them together with a real interface (directives down, escalation up, see [[realtime-game-agents]]), and making the middle layer improve from traced experience ([[overview]]'s discovery loop).
