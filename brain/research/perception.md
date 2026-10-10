---
date: 2026-10-10
tags: [research, perception]
status: active
---
# How a bot perceives Minecraft

## Three ways to connect to the game
| Approach | Example | Sees / acts | Good for |
|---|---|---|---|
| **Protocol client** | [Mineflayer](https://github.com/PrismarineJS/mineflayer), and everything built on it (Mindcraft, Voyager, Minecraft MCP servers) | Speaks the network protocol and joins as a player. Gets the world as structured data. Acts through API calls. | Anything that needs a real avatar on a real server |
| **Server mod / world API** | [agentcraft](https://github.com/bytewife/agentcraft) (GDMC HTTP Forge mod) | Reads and writes blocks directly, with no avatar | Procedural building only |
| **Pixels + keyboard/mouse** | OpenAI VPT, MineRL, MineStudio | Vision model on screen frames, sending mouse and keyboard input | Research. Slow and needs a GPU. |

Mineflayer supports MC 1.8 → 26.1 (per its README, 2026-10).

## What Mineflayer gets
The server sends every client packets: chunk data (every block in the loaded area), entity spawns and movement, health and inventory, time, weather, and chat. A normal client draws these as pixels. Mineflayer keeps them as data:

- `bot.blockAt(pos)` and `bot.findBlocks(...)`
- `bot.entities`: position, **velocity**, facing, held item, equipment
- `bot.inventory`, `bot.health`, `bot.food`, `bot.time`
- events: `entityHurt`, `chat`, `blockUpdate`, entity swing and hurt animations

**What this means:**
- **More than a player sees.** It sees every loaded block, including ores behind stone and players behind walls: effectively x-ray. If that's unfair for a scenario, filter what the agent gets through line of sight (`bot.canSeeBlock`, ray casts).
- **Less than a player sees.** It has no idea what's visible on screen, and nothing purely visual exists in the data: how a build looks, map art, skins.
- **Images are possible but reconstructed.** A screenshot can be rendered from the data (prismarine-viewer), but it's a render of the data, not the real client.

## Where it gets narrow
The data is complete. What makes the view narrow is the summary handed to the model. Models are weak at reasoning over raw coordinates, so how state is encoded matters more than what's available:

- **Relative, egocentric descriptions:** "zombie 4 blocks ahead-left, closing"
- **Top-down ASCII maps** of the area around the bot
- **Perception as tools the agent calls:** `describeArea`, `scan`, `look`. The agent asks for detail when it needs it, and each look gets traced.

## Time
A frozen snapshot can't tell "running at me" from "running away". The data already contains motion (velocity at 20 Hz), so time can be encoded explicitly:

- **Features with motion built in:** closing speed (velocity · direction to me), facing angle, health trend, cooldowns.
- **A sliding window of events:** detailed for recent moments, sparser for older ones. Events ("t-0.8 hit me −3") are far cheaper than repeated snapshots.
- **Running summaries** for facts that must outlast the window ("he's used both golden apples").
- **Windows nest:** a few seconds for fast decisions, a task's log, then the whole goal hierarchy ([[overview]]).

This is the hand-built version of what learned sequence models (transformers over frames, recurrent state) do internally.
