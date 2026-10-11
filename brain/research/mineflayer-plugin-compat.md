---
date: 2026-10-11
tags: [research, mineflayer, server-version, motor, behaviors]
status: active
---
# Mineflayer plugins by server version

Which Minecraft server version the seed plugins ([[seed-behaviors]]) work on, and which channels each plugin actually drives. Measured on local offline-mode Paper servers, 2026-10-10/11.

**Stack:** mineflayer 4.39.0 (prismarine-physics 1.11.1, minecraft-data 3.117.0), mineflayer-pathfinder 2.4.5, mineflayer-pvp 1.3.2, mineflayer-collectblock 1.6.0, mineflayer-tool 1.2.0.

## Answer
- **Without a patch, the newest version that works is 1.21.10.** On 1.21.11 and 26.1.2, `collect` stalls: the server rejects the bot's movement every tick. The other behaviors pass on every version.
- **With one line, 26.1.2 works too.** Set `bot.physics.playerHalfWidth = Math.fround(0.6) / 2` after spawn. That's the fix proposed in [mineflayer#3911](https://github.com/PrismarineJS/mineflayer/issues/3911), and it isn't released yet.
  - With the fix, 26.1.2 passed every behavior in all 10 rounds, including the repo's own `Movements` setup and a knockback check.
  - With the fix, 1.21.11 collected in 5/5 rounds.
- **Recommended pin: Paper 26.1.2 (build 74) plus that line.** 26.1 is the newest version mineflayer 4.39 supports. It needs Java 25.
- **Fallback:** Paper 1.21.10 (build 130), with no patch and Java 21. Mineflayer reads it as 1.21.9: same protocol (773), and 1.21.9's data.
- **Not supported by mineflayer 4.39:** 26.2 and 26.3, although minecraft-data lists their protocol numbers.

## How it was tested
- **Setup:**
  - A scratch script outside the repo.
  - Superflat world, mob spawning off, fixed midnight.
  - A creative-mode "player" bot, and a survival test bot with all four plugins loaded.
- **Each round runs:**
  - **navigate:** `GoalNear(player, 2)` to a player 25 blocks away.
  - **follow:** `GoalFollow(player, 2)` while the player walks a 24-block L.
  - **collect:** +10 `oak_log`, collected one block at a time with `bot.collectBlock.collect`, from 7 trees about 8 blocks away. 180 s limit.
  - **fight:** `bot.pvp.attack` on a summoned adult zombie, holding an iron sword.
  - **knockback** (later runs only): let a zombie hit the bot, then walk 8 blocks.
- **Trees, two kinds:**
  - **random:** `/place feature minecraft:oak`, so shapes vary.
  - **fixed:** the same hand-built tree each time, for comparing versions.
- **Pass rules:**
  - navigate: ends within 3 blocks.
  - follow: the bot is never more than 6 blocks behind, and ends within 4.75. `GoalFollow` only re-targets once the player is more than `range` from the last goal point, so the bot settles up to about `2 × range` away. Ending at 3.9–4.1 blocks happens on every version, 1.21.4 included.
  - collect: +10 logs.
  - fight: the zombie dies and the bot lives.

## Results
"Airborne stalls" counts collect attempts that hit the 45 s per-block timeout with `onGround=false`. That's the signature described in the next section.

| Config | Server | Rounds | navigate | follow | collect | fight | knockback | Airborne stalls |
|---|---|---|---|---|---|---|---|---|
| plugin defaults, random trees | 26.1.2 | 3 | 3/3 | 3/3 | **1/3** | 3/3 | | 6 |
| | 1.21.11 | 3 | 3/3 | 3/3 | **1/3** | 3/3 | | 6 |
| | 1.21.10 | 3 | 3/3 | 3/3 | 3/3 | 3/3 | | 0 |
| | 1.21.9 | 3 | 3/3 | 3/3 | 3/3 | 3/3 | | 0 |
| | 1.21.8 | 3 | 3/3 | 3/3 | 3/3 | 3/3 | | 0 |
| | 1.21.4 | 3 | 3/3 | 3/3 | 3/3 | 3/3 | | 0 |
| plugin defaults, fixed trees | 26.1.2 / 1.21.11 | 3 + 3 | 6/6 | 6/6 | 6/6 | 6/6 | | 5 |
| | 1.21.10 / .9 / .8 / .4 | 12 | 12/12 | 12/12 | 11/12 | 12/12 | | 0 |
| shared Movements, pathfinder may break only logs, fixed trees | all 6 versions | 18 | 18/18 | 18/18 | 18/18 | 18/18 | | 2 (1.21.11) |
| same, random trees | 26.1.2 | 5 | 5/5 | 5/5 | **1/5** | 5/5 | | 9 |
| shared Movements, may break logs and leaves, random trees | 26.1.2 | 5 | 5/5 | 5/5 | 4/5 | 5/5 | | 7 |
| | 1.21.4 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | | 0 |
| **+ half-width fix** | **26.1.2** | 5 | 5/5 | 5/5 | **5/5** | 5/5 | | 0 |
| | **1.21.11** | 5 | 5/5 | 5/5 | **5/5** | 5/5 | | 0 |
| repo's `guardedMovements` (as of 7a0b517), random trees, + knockback | 26.1.2 | 5 + 3 | 8/8 | 8/8 | **1/8** | 8/8 | 3/3 | 21 |
| | 1.21.10 (+ knockback) | 3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0 |
| | 1.21.4 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | | 0 |
| **same + half-width fix** | **26.1.2** | 5 | 5/5 | 5/5 | **5/5** | 5/5 | 5/5 | 0 |

- No run logged a protocol error, kick or parse warning. The only console warning was pvp's use of the deprecated `physicTick` event.
- `canDig = false` on the `Movements` collectblock uses makes `collect` return in about 2 s with 0 logs and no error ([[#Guard findings]]).

## Why 1.21.11+ stalls
**Symptom.** In each stall, the bot stands on grass with zero velocity and no controls held, but `onGround=false`. The pathfinder waits for `onGround` before its next move, so it never moves again.

**Mechanism, measured with a 1 s probe at the stall:**
- The server sends a position correction 18–20 times a second, and each correction resets `onGround=false`.
- Corrections during collect: 3,378 on 26.1.2 and 6,477 on 1.21.11, against 3 on 1.21.10 and 3 on 1.21.4.

**Cause, per [mineflayer#3911](https://github.com/PrismarineJS/mineflayer/issues/3911):**
- prismarine-physics uses a player half-width of `0.3`. The game uses `0.6F / 2`, which is `0.30000001…` as a double.
- From 1.21.11 on, the server rejects a move from flush against a block face, because its slightly wider box overlaps the block by about 1e-8.
- Trees put the bot flush against trunks and leaves, so collect hits this constantly. Open-ground walking rarely does.

**Fixes:**
- The one-line half-width fix ends the loop: 0 stalls in 15 rounds on 1.21.11 and 26.1.2.
- The server-side workaround in that thread is `/attribute <bot> minecraft:scale base set 0.9999999`. It needs op, which the agent must not depend on.

**Related open issues:**
- [#3913](https://github.com/PrismarineJS/mineflayer/issues/3913): can't step up a block, gets stuck on walls.
- [#3887](https://github.com/PrismarineJS/mineflayer/issues/3887): freezes in mid-air after knockback.
- Our knockback check (open ground, zombie hit, then walk 8 blocks) passed on 26.1.2 with and without the fix. Knockback into a wall wasn't tested.

## Which channels each plugin drives
These counts come from wrapping `bot.look`/`lookAt`, `setControlState`, `dig`, `equip`, `attack`, `activateItem` and `pathfinder.setGoal`/`goto`/`setMovements`, then attributing each call to the plugin from its stack trace. The code reading agrees.

| Plugin | Legs | Aim | Hands | Drives pathfinder? |
|---|---|---|---|---|
| **pathfinder** | `forward`/`sprint`/`jump` every tick while moving | **`bot.look` every tick while moving** (about 1 per `forward`). `lookAt` when it bridges or squeezes to a block centre. | **`bot.dig` + `bot.equip`** when a path breaks a block. `placeBlock` when scaffolding is allowed. | n/a |
| **pvp** | through pathfinder | `lookAt(target head)` before each swing; `lookAt` for the creeper-shield move | `attack`; `activateItem`/`deactivateItem` for a shield. **Never equips a weapon.** | **Yes:** `setGoal(GoalFollow(target, 2))`, **and `setMovements(its own default Movements)`** |
| **collectblock** | through pathfinder | through `bot.dig`, which calls `lookAt` on the block | `bot.dig`; `equip` through mineflayer-tool | **Yes:** `goto(GoalLookAtBlock)` per block and `goto(GoalFollow(drop, 0))` per item, **and `setMovements(its own Movements)`** |

**Corrections to [[seed-behaviors]]:**
- pathfinder claims **hands** too: it digs and equips, and places blocks unless `canDig` and scaffolding are off. It also claims aim, through `bot.look`.
- pvp and collectblock each switch the pathfinder to their own `Movements`.

## Guard findings
These touch `src/guards.ts`/`src/main.ts` as of 7a0b517.
**Applied in 3560da7:** the repo now uses the last bullet's config plus the half-width fix, and pins Paper 26.1.2 ([[seed-behaviors]] → Guards).
- **Plugins replace the shared `Movements`.**
  - pvp: `attack()` calls `setMovements` with its own default `Movements` (parkour on, digging on, `maxDropDown = 4`). `bot.pvp.movements = null` stops this. Verified.
  - collectblock: each `collect()` installs `bot.collectBlock.movements` and first sets `dontCreateFlow = false` and `dontMineUnderFallingBlock = false` on it. That turns off pathfinder's own "don't break blocks next to liquid" check during collect.
- **`canDig = false` silently breaks collect.** collectblock drops any target for which `movements.safeToBreak(block)` is false, and that's every block when `canDig` is false. That's why the repo gives collectblock its own `canDig = true` copy.
- **That copy stays installed after collect.** Nothing resets the pathfinder, so `navigate`/`follow` after a `collect` keep running on the copy that can dig. Measured: after every collect, `bot.pathfinder.movements` was the collect copy (`canDig=true`).
- **What gave the most reliable collect:** one shared `Movements` with `canDig = true` and every non-`*_log`/`*_leaves` block in `blocksCantBreak`, with `bot.collectBlock.movements = null`.
  - Logs-only makes low-leaf trees unreachable ("No path"). Allowing leaves fixes that.
  - Allowing all blocks lets the pathfinder dig a hole into the ground next to a tree and get stuck in it.

## Sources
- Our spike. The script and per-run JSON stayed outside the repo, in the session scratchpad: `mc-compat/spike/run.mjs` and `mc-compat/results/`.
- Upstream code, read 2026-10-10:
  - [mineflayer-pvp](https://github.com/PrismarineJS/mineflayer-pvp) `lib/PVP.js`
  - [mineflayer-collectblock](https://github.com/PrismarineJS/mineflayer-collectblock) `lib/CollectBlock.js`
  - [mineflayer-tool](https://github.com/PrismarineJS/mineflayer-tool) `lib/Tool.js`
  - [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder): `index.js` (look, dig, equip and place call sites), `lib/goals.js` (`GoalFollow`), `lib/movements.js` (`safeToBreak`)
  - [mineflayer](https://github.com/PrismarineJS/mineflayer): `lib/version.js` (tested versions 1.8.8–26.1), `lib/plugins/physics.js` (a forced move resets `onGround`)
  - [minecraft-data](https://github.com/PrismarineJS/minecraft-data) protocol table: 773 = 1.21.9/1.21.10, 775 = 26.1/26.1.1/26.1.2
- Issues:
  - [mineflayer#3911](https://github.com/PrismarineJS/mineflayer/issues/3911): 1.21.11 pathfinding stalls; float half-width cause and the one-line fix
  - [#3913](https://github.com/PrismarineJS/mineflayer/issues/3913)
  - [#3887](https://github.com/PrismarineJS/mineflayer/issues/3887)
- [PaperMC Fill API](https://fill.papermc.io/v3/projects/paper): builds and minimum Java per version (26.1.2 needs Java 25; 1.21.x needs Java 21)
