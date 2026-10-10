---
date: 2026-10-10
tags: [research, real-time, prior-art, reflexes, system-1]
status: active
---
# Fast bots: how scripted Minecraft bots perceive and decide

The "fast, not general" corner of [[realtime-landscape]]. These bots see the world as exact data, like Mineflayer ([[perception]]), and decide with small hand-written loops tuned by constants. They're fast because they never think: each runs a fixed procedure every tick.

Sources: the code itself, read 2026-10-10.
- [mineflayer-pvp](https://github.com/PrismarineJS/mineflayer-pvp) `src/PVP.ts`
- [Baritone](https://github.com/cabaletta/baritone) `ActionCosts.java`, `Settings.java`, `process/MineProcess.java`, `cache/CachedChunk.java`, `utils/PathingControlManager.java`
- [Meteor Client KillAura](https://github.com/MeteorDevelopment/meteor-client/blob/master/src/main/java/meteordevelopment/meteorclient/systems/modules/combat/KillAura.java)

## Perception
All of them read the client's copy of the world, which is built from server packets. None uses pixels.

| Bot | Runs as | What it reads |
|---|---|---|
| **mineflayer-pvp** | Mineflayer plugin | `bot.entities`: target position and height, distance, raw entity metadata (`metadata[16]` tells it a creeper is about to explode) |
| **KillAura** (Meteor Client) | Mod inside the real client | The entity list with hitboxes, plus a line-of-sight ray cast (`canSeeEntity`). A separate `walls-range` allows hitting through walls up close. |
| **Baritone** | Mod inside the real client | Loaded chunks plus **its own persistent, compressed chunk cache** saved to disk. It remembers notable blocks (chests, spawners, portals, furnaces) beyond view distance and across sessions. It scans ores from the data, which is x-ray; `legitMine` turns that off. |

## Three patterns of rules

### 1. Tick-timer state machine: mineflayer-pvp (~290 lines)
Every physics tick:
1. If the target is more than 128 blocks away (`viewDistance`), stop.
2. Check whether it's within 3 blocks (`attackRange`). On entering range, reset the attack timer.
3. Count the timer down. At zero:
   - drop the shield, wait 100 ms,
   - look at the target's head, attack,
   - wait 150 ms, raise the shield.
4. Reset the timer from the weapon's attack-speed cooldown (`TimingSolver`).
5. If a creeper is about to explode, stop moving and hold the shield up for 2 s.

Movement is delegated: the pathfinder keeps within 2 blocks of the target (`GoalFollow(target, 2)`). **It doesn't choose targets.** The caller passes one in.

### 2. Filter → sort → act: KillAura (~515 lines, 25 settings)
Every tick:
- **Filter** entities with hard rules:
  - alive, and in range;
  - an allowed type;
  - visible, or close enough to hit through walls;
  - not a friend, a named mob, your own pet or a creative-mode player;
  - not shielding (optional);
  - not a baby (optional).
- **Sort** by `priority`: closest to the crosshair by default, or lowest health, or nearest.
- **Attack** up to `max-targets`, once the delay check passes: the attack cooldown, synced to the server's tick rate, or a custom delay.
- **Extra settings:** weapon auto-switch and swap-back, shield handling, and pausing while eating, under lag, or while Baritone is moving.

The "intelligence" is the settings list.

### 3. Search with hand-tuned costs: Baritone
- **Pathfinding is A\*** over a graph of blocks. Edges are movement types: traverse, ascend, descend, diagonal, pillar, parkour, fall, downward.
- **Costs are in ticks of game physics:**
  - walking `20 / 4.317 = 4.633` ticks per block, sprinting `3.564`,
  - fall costs generated per height,
  - impossible moves cost `COST_INF = 1,000,000`.
- **Danger is just more cost.** With `avoidance` on, blocks near mobs (`mobAvoidanceRadius` 8) or spawners (radius 16, cost ×2) are more expensive.
- **Behaviors are "processes"**: Mine, Follow, Build, Farm, Explore, GetToBlock, Elytra, and others.
  - Each tick, every process proposes a pathing command.
  - `PathingControlManager` sorts them by `priority()` and runs the top one. That's interrupts without a model.
- **Mining:**
  - re-scans the chunk cache for ore on a background thread,
  - goes to the closest ore, and blacklists it if that fails,
  - in `legitMine`, branch-mines at a fixed Y level instead.

## Pixel policies, for contrast
VPT and STEVE-1 have no rules: a network maps screen frames straight to keyboard and mouse, 20 times a second. Everything is learned, nothing is inspectable, and there's no planning ([[sota-minecraft-agents]]).

## Takeaways for Jeeve
- **Their perception is what we already have.** Mineflayer reads the same packet data, so we lose nothing to them there.
- **Two kinds of rules, two different fates under the [[bitter-lesson]]:**
  - **Physics rules** (path costs in ticks, attack cooldown timing) have one correct answer. Keep them as code. Baritone's A* is search, which the bitter lesson endorses.
  - **Strategy rules** (whom to target, when to shield, how close to follow, when to flee) are judgment calls frozen into constants. These are what System 1 should learn.
- **The settings are a natural action space for System 1.**
  - KillAura's `priority`, `range` and `shield-mode`, and pvp's `followRange`, are knobs a fast decision model ([[decision-models]]) could set several times a second while code executes.
  - That fits [[overview]]'s "options with stop conditions": System 1 picks the knob values, and the scripted loop runs them.
- **Baritone's process arbitration is a working interrupt design** (each process proposes, a manager picks by priority). It's a proven, model-free base under the escalation design in [[realtime-game-agents]].
- **Fairness is a setting.** Each of these bots can choose whether to use x-ray (`legitMine`, `walls-range`). Jeeve needs the same switch per scenario.
