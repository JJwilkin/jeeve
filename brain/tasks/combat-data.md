---
date: 2026-11-02
tags: [task, world-models, data, combat, pvp]
status: active
progress: todo
---
# Task: combat data for the world model (PvP)

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/combat-data.md`."

## Why
Joshua wants Jeeve to fight well: switch between sword, bow and shield, and attack and defend against several opponents at once. Combat is mostly timing and spacing: whether a raised shield stops this swing, whether an arrow at 20 blocks lands, whether a hit lands before the cooldown is back. That's the question the Tier 1 outcome model answers ("if I run action A with parameters P here, what happens?", [[world-model-data]] → "How the model would fit into Jeeve"). So combat data uses the same collector ([[world-model-collector]]): scripted actions with random parameters, run under the guards, labelled by their outcomes.

**The [[bitter-lesson]] smell test:** moves like the w-tap or a shield counter are hand-written, but only as vocabulary. Which one to use, at what range, against how many, is learned from the outcomes, as with the crossing methods. The noise, random input and messy multi-bot fights are what keep the starting states varied.

**Comes after v4** (the crossing and climbing collection), and needs a record-format change first: without it the data can't teach combat (below).

## What the record lacks today
What `collect/recorder.ts` captures that combat can already use: self position, velocity, look, health, held item, controls; the 8 nearest entities within 32 blocks (no type filter, so arrows in flight are there, with velocity), as type, position and velocity; per-action outcome, duration and health change, and the dense "damage within 3 s" label ([[world-model-training]]).

What's missing, and where it would come from in Mineflayer:

| Missing | Why it matters | Source |
|---|---|---|
| Own attack cooldown (ticks since the last swing, and the held weapon's attack speed) | A hit at half cooldown does a fraction of the damage | Track swings in the recorder's wrap (it already wraps `dig` and `place`); attack speed by item from `minecraft-data` |
| Own item in use, and for how long | A shield needs ~5 ticks up before it blocks; a bow's damage grows with draw time | `bot.usingHeldItem`, plus ticks since `activateItem` |
| Off-hand item and armour | Shield in the off-hand; armour changes damage taken | `bot.inventory.slots[45]`, slots 5–8 |
| Each entity's health (or damage taken), held item, look direction | Whether a target is nearly dead, holds a bow, faces you | `entity.metadata` (health, hand-state flags), `entity.equipment`, `entity.yaw`/`pitch` |
| Each entity's blocking, drawing or swinging state | The tell for when to strike or dodge | hand-state metadata bits; `entitySwingArm` events |
| Per-action damage dealt, hits and misses, kills | The outcome labels a fight action needs (health change only says what you took) | `entityHurt` / `entityDead` for the action's target(s), counted in `collect/bot.ts` |
| Arrows crowding the 8 slots | In a crowd, nearby arrows can push opponents out (or the reverse) | Decide: a separate projectile slot set, or opponents first |

These go in `collect/format.ts` (new step fields; the header lists every field, so `collect/read_episode.py` needs no change), and as inputs in `train/data.py` / `train/model.py` (entity tokens get the new per-entity fields, the self token the new self fields). Old episodes lack them: train with them zeroed and a "present" flag, or train combat separately. **Decide with Joshua.**

Also: combat actions should carry the opponent's position at the action start as a position parameter (`at`), so training's action frame points at it. Today `fight` and `track` pass only `{ id, name }`, so they fall back to the bot's facing.

## Scripted actions
All in the authored format (`async (api, t) => 'done' | 'stuck' | 'none_found'`, one file each in `collect/actions/`), on the existing API: `attack(id)`, `use(offhand)` / `release()`, `look`, `turn`, `equip`, `hotbar`, `control`, `entities`, `next('entityHurt')`. "Fits" means an opponent (a mob or another bot) within the given range.

### Melee
| Action | Random parameters | Fits | Done when | Made by |
|---|---|---|---|---|
| `strike_timed` | cooldown fraction to wait for (0.3–1.0) | opponent ≤ 6 | the target is hurt | hand |
| `crit_jump_hit` | – | opponent ≤ 4, on the ground | the target is hurt while the bot falls | hand |
| `sprint_hit` / `w_tap` | hits 1–4 | opponent ≤ 8 | that many hits land | hand |
| `strafe_circle` | radius 2.5–3.5, left or right, 2–6 s | opponent ≤ 6 | the time is up with hits landed | hand |

### Defence
| Action | Random parameters | Fits | Done when | Made by |
|---|---|---|---|---|
| `shield_block` | hold 0.5–3 s | a shield, an opponent ≤ 6 or an arrow coming | the time is up without damage | hand |
| `shield_counter` | – | a shield, opponent ≤ 4 | blocked, then a hit landed | hand |
| `kite` | distance to keep 4–8, 3–10 s | a melee opponent ≤ 10 | the time is up, never in reach | hand |
| `dodge_arrow` | strafe left or right | an arrow coming, or an archer drawing | not hit | hand |
| `retreat_and_heal` | distance 8–20 | food, hurt, opponent ≤ 12 | healed and back in range | hand |

### Ranged
| Action | Random parameters | Fits | Done when | Made by |
|---|---|---|---|---|
| `shoot_bow` | draw 0.2–1.0 s, aim noise | bow + arrows, opponent 6–40 | the target is hurt within 2 s | hand first, then 2B with lead and arc |
| `snipe_from_height` | pillar 2–5 | bow, blocks, opponent ≤ 40 | a hit from the top | hand (pillar_up + shoot_bow) |
| `bow_then_close` | switch distance 3–6 | bow + sword, opponent 8–25 | a bow hit, then a sword hit | hand |
| `crossbow_shot` | hold charged 0–2 s | crossbow + arrows | the target is hurt | hand |

### Loadout and several opponents
| Action | Random parameters | Fits | Done when | Made by |
|---|---|---|---|---|
| `switch_loadout` | to sword, bow, shield or food | the item in the kit | equipped (the cost: equip delay, cooldown reset) | hand |
| `fight_many` | target order: nearest, weakest, archer first | 2+ opponents ≤ 12 | survived 10 s, or every target dead | 2B |
| `funnel` / `back_to_wall` | – | 2+ opponents, a 1-wide gap or a wall within 8 | in place, at most one opponent in reach | 2B |
| `break_line_of_sight` | – | an archer, cover within 8 | out of the archer's line | hand (a ray test on the views) |
| `block_wall_defence` | wall 1–3 wide | blocks, an opponent ≤ 8 | the wall stands between | hand (2B's place code) |

2B's ones go through `collect/author.ts` as bridge, swim and shelter did, with a pass check (damage dealt ≥ X, damage taken ≤ Y) and an arena validation set. Each needs a scene where the check can pass.

## Opponents
1. **Night mobs** (already there): zombies, skeletons (archers), spiders, creepers. Free, but rare and unscheduled.
2. **Mob packs in a scene:** a new arena scene in `collect/scenes.ts`, plus `/summon` of 1–4 mobs (mixed melee and skeletons) at 8–20 blocks. Cheap and controllable.
3. **Bot vs bot:** each server's 10 bots are players. Three changes:
   - `features()` (`collect/actions.ts`) drops `type === 'player'` from opponents today; let collector bots in.
   - PvP on the server: itzg's `PVP` defaults to on, but `collect/compose.ts` should set it explicitly.
   - **Pairing:** a fight needs its bots in one place at once. `collect/main.ts` already broadcasts counts to its bots; it could also call arena episodes, teleporting 2–5 bots into one arena, each with its own kit. Each bot keeps running its own scheduler, so the fights are messy and varied, not scripted duels.

## Kit
Add to `KIT()` (`collect/bot.ts`): a bow with 8–32 arrows, a shield (into the off-hand), a crossbow, and armour (leather to iron, some pieces missing). Arena episodes always get a loadout of 2–3 weapons, so `switch_loadout` fits.

## Other movement ideas (candidates, not in this task)
- Parkour: sprint-jump chains, diagonal gaps, ladders, sneaking along an edge.
- A boat across water: a third way to cross, for the river problem ([[3d-world-representation]]); `mount`, `steer` and `place_entity` exist.
- Water-bucket clutch (water placed just before landing a fall), lava escape (a block or water onto lava), fire out (into water).
- Escapes: pillar away from melee, dig in two and cap the hole.

## Phases
1. **Format:** the fields above, in the recorder, `format.ts` and `train/`. Check with `npm run collect:check` and `train/` tests on tiny episodes.
2. **Hand-written core:** `strike_timed`, `shield_block`, `shoot_bow`, `switch_loadout`, `kite`; the kit; the arena scene with mob packs. A local run, as for phase 2 of [[world-model-data]].
3. **Bot vs bot:** pairing in `collect/main.ts`, players as opponents.
4. **2B's hard ones:** `fight_many`, `funnel`, `shoot_bow` with lead.
5. **A combat collection run** on GCP: its own bucket prefix, about 1–2M steps, ~$3–4 on a c2d-standard-32 at v3's rate.

## Decisions for Joshua
- Old episodes without the new fields: train with them zeroed and a flag, or keep combat a separate model or head.
- How much of a run is combat: a slice of every run, or runs of its own.
- Bot vs bot first, or mob packs first (cheaper, no pairing).
- Whether Jeeve live fights players at all, or only mobs. This sets whether bot-vs-bot data is for Jeeve's own use or only for the model.

## Done when
- The new fields are recorded and read by `train/`.
- The core actions run in a local arena, against mobs and against other bots.
- A combat run is in the bucket with a coverage report by action × outcome × number of opponents.
