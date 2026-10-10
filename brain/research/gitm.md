---
date: 2026-10-10
tags: [research, prior-art, system-2, goal-tree]
status: active
---
# GITM (Ghost in the Minecraft)

Source: Zhu et al. 2023, [arXiv 2305.17144](https://arxiv.org/html/2305.17144v2).

The best-known LLM goal-tree agent for Minecraft. It's the closest prior art to the goal hierarchy in [[overview]]. Through the [[bitter-lesson]] lens, its results come mostly from hand-provided knowledge plus one learned component: memory.

## How it works
Every part runs on **gpt-3.5-turbo**.
- **Decomposer:** breaks a goal into a recursive sub-goal tree.
  - Goals are typed: `(object, count, material, tool, info)`.
  - Minecraft Wiki text and MineDojo recipes are retrieved for each goal.
- **Planner:** turns each sub-goal into a list of structured actions. It gets feedback after every action (inventory, biome, y-level, above or below ground) and revises.
- **Interface:** **9 hand-scripted structured actions**: equip, explore, approach, mine/attack, dig_down, go_up, build, craft/smelt, apply.
  - Explore is a breadth-first search on the surface and a depth-first search underground. Approach uses A* pathfinding.
  - The set was derived from data: the LLM broke MineDojo's ~3,000 tasks into action tuples, and the most frequent were kept and merged.
- **Memory:** maps each sub-goal to action sequences that succeeded. At 5 sequences, the LLM merges them into one reference plan.
- **Perception:** LiDAR rays every 5° and a 10-block voxel radius for navigation, no RGB. Data, not pixels, like Mineflayer ([[perception]]).

## Results
ObtainDiamond, 10-minute limit (12,000 steps at 20 Hz):

| Method | Iron pickaxe | Diamond |
|---|---|---|
| DreamerV3 | 0.01% | 0.01% |
| DEPS | 10% | 0.6% |
| VPT | 85% | 20% |
| **GITM** | **95%** | **67.5%** |

- All 262 Overworld items unlocked. Prior agents managed roughly 15–78; the paper's own figures disagree.
- About 2 days on one 32-core CPU, versus 6,480 GPU-days for VPT. **LLM API cost isn't counted.**

## Ablation
| Added | Iron pickaxe | Diamond |
|---|---|---|
| Bare LLM + structured actions | 0% | 0% |
| + goal decomposition | 2.5% | 0% |
| + feedback | 20% | 5% |
| + external knowledge | 57.5% | 35% |
| + memory | 95% | 67.5% |

The appendix adds that an **LLM on raw keyboard/mouse scores 0% on every milestone.** Structured actions are the precondition for everything above.

## Caveats
- **Block-breaking speed and strength set to 100** (following DreamerV3), so mining is much faster than in normal play.
- No PvP, Nether or multiplayer. Combat is "approach and attack until dead". At night it uses a shelter plus an iron golem.
- **It never paid for latency.** MineDojo is a step-based gym environment, so as far as we know the world waits while the LLM thinks. The paper doesn't say; this is our inference about MineDojo.
- Its benchmark (diamonds, Overworld tech tree) is essentially solved now. The open problems are real-time play, opponents, multiple agents, the full game, and cost per hour.

## Takeaways for Jeeve
- **Bitter-lesson reading of the ablation.** The two big jumps are knowledge (hand-provided wiki text) and memory (learned from its own successes).
  - Memory is the part that fits [[overview]]'s discovery loop: plans that worked get kept and reused.
  - Knowledge is the part to question. A 2026 reasoning model already knows the tech tree; exact recipes can come from game data, not wiki prose.
- **On the primitive-set open question in [[overview]].**
  - Raw input scored 0%, and 9 mid-level actions scored 67.5%. That's evidence the line sits above raw movement.
  - GITM *derived* its primitives from task statistics rather than hand-picking them. That's a discovery-flavoured way to choose them.
  - Some of its actions (`explore`, `build`) embed strategy, which [[overview]] wants to avoid.
- **The per-action planner is a decision problem.** "Given this sub-goal and state, which of 9 actions?" is one Choice question for a fast model ([[decision-models]]). Escalating to slow thinking replaces GITM's re-plan-on-feedback. See [[fast-slow-agents]].
- **Typed goals** `(object, count, material, tool)` make success checks mechanical for gathering and crafting. They don't cover goals like "win this fight" or "build something nice".
- Compared with [[mindcraft-and-voyager]]: GITM has the goal tree that Mindcraft and Voyager lack. It has no world memory and no fast reactions.
