---
date: 2026-10-10
tags: [research, prior-art]
status: active
---
# Mindcraft and Voyager

Two of the best-known LLM agents for Minecraft. Both are built on Mineflayer ([[perception]]). Through the [[bitter-lesson]] lens: Mindcraft mostly hand-builds knowledge, while Voyager's skill library discovers it.

## Mindcraft
Source: [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft), `develop` branch, read 2026-10-10.

- **Loop** (`src/agent/agent.js` `handleMessage`):
  1. Build a prompt from the profile template: commands, stats, inventory, memory.
  2. Call the model.
  3. A regex finds a command in the reply, e.g. `!collectBlocks("oak_log", 10)`.
  4. Run the command and append its result as a `system` message.
  5. Repeat until the reply has no command.
- **No agent SDK and no native tool calling.** Commands are text the model writes. `models/claude.js` takes the first text block of the reply.
- **About 49 commands** (`commands/actions.js`, `queries.js`) wrap hand-written skills (`library/skills.js`, `world.js`) over Mineflayer.
- **Modes** (`modes.js`) are scripted reflexes that run every tick: `self_preservation`, `self_defense`, `unstuck`, `hunting`, and so on.
  - They interrupt actions.
  - They log what they did to a behavior log that goes into the next prompt.
- **Memory** (`history.js`, `memory_bank.js`):
  - The context keeps 15 messages. Older ones are summarized by an LLM into a string capped at 500 characters.
  - Places are remembered as named coordinates.
  - Full transcripts are written to disk and never read back.
  - Memory is reloaded across restarts only if `load_memory` is set; the default is off.
- **Long-term objectives:**
  - `!goal("…")` stores one goal string. The self-prompter (`self_prompter.js`) re-prompts with it while the bot is idle. There's no breakdown into subgoals and no progress tracking.
  - There's also a scripted goal system for gathering items and building from blueprints (`npc/`).
- **Code mode** (`coder.js`): the LLM writes JS against the skills library, run in a sandbox. Off unless `allow_insecure_coding` is set.
- **Vision** (`vision/camera.js`): renders a screenshot from the block data (prismarine-viewer + three.js) and sends it to a vision model when the agent looks at a player or position.
- **Tasks:** JSON files with a goal, a starting inventory, a target and a timeout, used for evaluation (MineCollab paper: [arXiv 2504.17950](https://arxiv.org/pdf/2504.17950)).

## Voyager
Source: [arXiv 2305.16291](https://arxiv.org/html/2305.16291v2) (2023).

- **Automatic curriculum:** an LLM proposes the next task based on the tasks completed and failed so far. The fixed objective is to discover as many diverse things as possible.
- **Code as the action space:** the LLM writes JS programs against Mineflayer. They're refined with execution feedback and self-verification.
- **Skill library:** programs that succeed are saved with an embedding and retrieved for similar tasks later. This is the "how to do things" memory, and it persists across runs.
- **No world memory:** no places, no chest contents.

## Takeaways for Jeeve
- Mindcraft's commands, modes and blueprints are hand-built knowledge. They're useful as a reference for *what primitives exist*, and as a baseline.
- Voyager's skill library and curriculum are discovery methods. They're the closest prior art to [[overview]]'s discovery loop.
- Neither has a durable goal hierarchy, structured world memory, or fast learned reactions.
