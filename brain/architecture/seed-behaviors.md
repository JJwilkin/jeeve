---
date: 2026-10-10
tags: [architecture, motor, behaviors, first-milestone]
status: active
---
# Seed behaviors for the first milestone

The smallest behavior set for the first milestone ([[layers]]): a local server, with instructions given from outside. The three instructions are "come here", "collect 10 logs" and "follow me and defend me". Every behavior here is scaffolding under the [[bitter-lesson]]. The contract and guards are in [[behaviors-and-guards]]. What the traces record is in [[trace-schema]].

## Wrap, don't write
The seed set wraps `mineflayer-pathfinder` (2.4.5), `mineflayer-pvp` (1.3.2) and `mineflayer-collectblock` (1.6.0, which uses `mineflayer-tool`). All are old but are what Mindcraft runs on ([[mindcraft-and-voyager]]). Pin the local server to a version they're known to work with.

**None of the three stays on one channel:**
- pathfinder turns the head while walking (legs and aim);
- pvp drives pathfinder, looks at the target and attacks (legs, aim and hands);
- collectblock paths, equips a tool and digs (legs, aim and hands).

So a behavior **claims a set of channels**, and starting it replaces whatever holds any of them ([[behaviors-and-guards]]). Every seed behavior claims legs, aim and hands. Channels cost nothing to keep in the runtime. They start to matter when native single-channel behaviors (`strafe`, `track`, `attack_when_ready`) replace `fight`.

**Change to the default program ([[system-1]]):** it asks one Choice per channel. Since every M1 behavior claims all three channels, the M1 default asks **one joint `body` Choice** instead: allowed behaviors × encoded targets, plus `keep_current`. [[system-1]] already allows joint questions; this changes only the default's layout. It splits back into per-channel questions once single-channel behaviors exist.

## The set
| Behavior | Wraps | Ends | Events |
|---|---|---|---|
| `navigate(target, range)` | pathfinder `GoalNear`, or `GoalFollow` for an entity | arrived, timeout, replaced | `done`, `stuck` (noPath or timeout, or no progress for N s), `vetoed` |
| `follow(entity, range)` | pathfinder `GoalFollow`, dynamic | only when replaced | `target_lost`, `stuck`, `vetoed` |
| `collect(block_types, count)` | `bot.findBlocks` + collectblock | count reached, nothing found, replaced | `progress(n/count)`, `done`, `none_found`, `inventory_full`, `stuck` |
| `fight(entity)` | `bot.pvp.attack` | target dead or gone, replaced | `target_dead`, `target_lost` |
| `stop` | clears pathfinder and pvp | immediately | `done` |

- **No restart for the same option.** `keep_current`, or the running option with the same parameters, leaves the behavior running.
- **A count comes from the goal, not the behavior.** After an interruption, `collect` is restarted with what's left (`collect:oak_log(4)`).
- **Skipped:** `eat` (add it the first time an episode starves) and `explore` (Jev picks `navigate` toward a compass point instead).

## Guards
There's no separate filter layer in M1:
1. **One shared pathfinder `Movements` config:** `maxDropDown = 3`, avoid lava and fire, no parkour. pvp and collectblock move through pathfinder, so it covers every mover.
2. **One wrapper on `bot.setControlState`, `bot.dig` and `bot.placeBlock`:** checks the block ahead and below (edge, lava, void). It clears the input and emits `vetoed` on the running behavior.

## Who does what
| | Job |
|---|---|
| **Code** | Allowlist check on instructions, goal success checks, path, dig, aim, attack timing, guards |
| **Jev** | Which option to run right now: which target, whether to fight or keep collecting, pulling back, retrying after `stuck` |
| **System 2** | Turns an instruction into a success check and a System 1 program (guidance, allowed behaviors, triggers); handles escalations; writes failure and clarification replies ([[system-2]]) |

**Jev re-decides at least every second, not only on events.** It has to react to changes in the surroundings: a mob walking up, lava on the route. The default program ([[system-1]]) covers this:
- a 1 s heartbeat,
- event triggers (behavior events, damage, a hostile within 6 blocks, a new directive),
- a ~5 s event window in the state.

System 2 can shorten the heartbeat down to the 5 calls/s cap when a situation needs it.

## The three instructions end to end
All three start the same way:
1. An allowed player whispers. Code checks the allowlist.
2. ~~A `system2` span sets the root goal and its success check~~ *Superseded by [[system-2]]:* code creates the root at once and hands Jev the raw text; a `system2` span then fills in the success check and writes a System 1 program: guidance and allowed behaviors, on top of the default.
3. That's a new `program` version, which the next `decide` runs under.
4. A root-goal change cuts the window, so each instruction starts a fresh trace ([[trace-schema]]).

**"come here" (from Josh)**
1. Goal: `dist(bot, Josh) ≤ 3`, checked in code. Options: `navigate:Josh(r=2)`, `stop`.
2. Jev picks `navigate:Josh`, then `keep_current` on each heartbeat while Josh moves. If lava appears on the route, Jev sees it on a heartbeat before pathfinder stalls.
3. `done` → the check passes → a `goal` span marks it `completed` → ~~System 2 whispers "here"~~ code whispers a fixed "done" message ([[system-2]]).
4. **On failure:** `stuck` → Jev retries or escalates → System 2 whispers "can't reach you".

**"collect 10 logs"**
1. Goal: +10 `*_log` in inventory, counted from the moment of the instruction.
2. Options:
   - `collect:<log type>(remaining)` for each log type in view,
   - `navigate:<N|E|S|W 32 blocks>`,
   - `fight:<hostile>`,
   - `stop`.
3. `collect` emits `progress 6/10`.
4. A zombie comes within 6 blocks, which is a default trigger. Jev picks `fight:Zombie#42` before it hits, and `collect` ends with `replaced`.
5. `target_dead` → Jev picks `collect:oak_log(4)`.
6. `none_found` → Jev picks a `navigate` direction. After two failed tries, it escalates.

**"follow me and defend me"**
1. The goal is open-ended, with no code check. It ends on a new instruction. Judging it is roadmap stage 4.
2. Guidance: "engage hostiles that target Josh or come within 6 of him; don't chase beyond 12 from Josh; go back to following."
3. Options:
   - `follow:Josh(r=3)`,
   - `fight:<hostile>` for hostiles within 16 blocks, ranked by distance to Josh,
   - `stop`.
4. The loop: `follow` → a skeleton appears 16 blocks away and the next heartbeat sees it → `fight:Skeleton#7` → `target_dead` → `follow`.
5. "Beyond 12 from Josh" starts as guidance that Jev reads on every call. If traces show Jev chasing too far, System 2 can add a watch-condition module ([[system-1]]).
6. This instruction runs for minutes, so it crosses 60 s window cuts. The `behavior.follow` and `behavior.fight` spans are cut and continued under the same `run_id` ([[trace-schema]]).

## What System 2 should eventually write itself
- **`collect`** is just navigate + dig + pick up. It's the first behavior System 2 should be able to rewrite ([[behaviors-and-guards]], runtime-authored behaviors).
- **`fight`** freezes strategy into pvp's constants: follow distance, shield use, the target chosen by the caller ([[fast-bots]]). Those belong to Jev, which means splitting `fight` into native single-channel behaviors.
- **`navigate` and `follow`** stay as code: pathfinding is search, which the bitter lesson endorses.

## Open questions
- **Dithering.** Can a heartbeat flip between `follow` and `fight`? `keep_current` and guidance are the first fix. Add a hold time only if traces show churn: a choice reversed within a second ([[system-1]]).
- **Plugin versions.** Do the plugins hold up on the newest server versions? That decides which version the local server pins.
