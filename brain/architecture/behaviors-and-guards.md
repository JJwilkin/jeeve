---
date: 2026-10-10
tags: [architecture, motor, skills]
status: active
---
# Behaviors and guards

The deterministic layer under Jev ([[layers]]). It runs like control-system code: no model is involved, it handles precision and physics, and it's fast.

## Behaviors
A behavior is a small controller that runs on its channels until it finishes, times out, or is replaced.

**The contract every behavior follows:**
- **Channels:** the set it claims, from legs, aim, hands and stance. Starting it replaces whatever holds any of them. Wrapped mineflayer plugins claim several channels at once ([[seed-behaviors]]).
- **Parameters:** e.g. `navigate(target, avoid)`.
- **Lifecycle:** start, every tick, stop. It must stop cleanly when replaced.
- **Events it emits:** `done`, `stuck`, `blocked`, `target_lost`, `vetoed`, and so on. These trigger the next Jev call ([[layers]]) and go into the trace ([[learning]]).
- **Ending:** a duration, a condition, or cancellation.

**Behaviors are layered.** `navigate` calls `bridge` when there's a gap, `pillar` to climb, `swim` in water, and `dig` when blocked. Jev picks `navigate(red_base)`, and the code works out the route. Much of this already exists in `mineflayer-pathfinder` (scaffolding, bridging, digging, swimming).

**Behaviors combine across channels:** for example, `navigate` on legs while `track(Steve)` runs on aim and `attack_when_ready` runs on hands.

## Guards
Invariants that **every** motor command passes through, whichever behavior issued it. In control terms, it's a safety filter.
- don't step off a drop of more than 3 blocks
- don't walk into lava or the void
- don't place a block where it would suffocate you
- stop sprinting at an edge

These are physics checks (position relative to the edge, the block type below), so they belong in code ([[bitter-lesson]]).

- **On by default; System 2 can lift one on purpose:** "drop into the water below", "pearl across the gap".
- **A veto is an event.** Jev learns its choice was blocked instead of watching it silently do nothing.

## Runtime-authored behaviors
The library isn't fixed. When System 2 finds a missing capability ("I need to ride a boat"), it writes a new behavior. This is Voyager's skill library ([[mindcraft-and-voyager]]) moved down to the motor level. It fits "no training": learned knowledge lives in context (guidance) and in code (behaviors).

1. **Write** against the contract, using only the bot API.
2. **Sandbox:** run the code in a restricted environment, like Mindcraft's `lockdown.js`. Guards still wrap it, so authored code can't get around the edge guard.
3. **Trial:** run it with a time limit and its own trace spans. A failure becomes evidence for System 2's next attempt.
4. **Register:** once it has worked, add it to the library. It then appears as a Jev option whenever System 2's guidance allows it.
5. **Version:** every behavior is versioned, so a trace shows which version ran.

### How it's built (2026-10-11)
*Refined by [[orchestrator-and-builder]]:* the builder (System 2B) now writes and trials behaviors, at 2A's request. `pass_when` is required, and it's 2A's check, not the writer's. Trials wait for a window that a code gate grants when nothing threatens the bot. Below, "System 2 writes" means 2B, and "System 2 adds it to `allowed_behaviors`" means 2A. 2B's prompt embeds `API_DOC`, as System 2's did.

Decided with Joshua while working on [[runtime-authored-behaviors]]. Code is in `src/behaviors.ts` (`authoredSpec`, the action API), `src/modules.ts` (sandbox, library) and `src/main.ts` (trials).

**Writing.** System 2 calls a `write_behavior` tool next to `submit_decision`. It isn't a `submit_decision` field, because one more strict object made the API reject the grammar as too large. A behavior is:
- a name and a description (Jev reads the description, with the target appended);
- the channels it claims: one channel, or all three, since those are the only question layouts ([[system-1]]);
- a target type, `block` (`{name, count}`) or `entity` (plain data, never the live object);
- a time limit (at most 120 s);
- `code`: `async (api, target) => 'done' | 'stuck' | 'none_found'`, at most 8000 characters;
- a trial target, optionally with `pass_when` (see Trial).

**The action API.** *Superseded by "The player action API" below, which gives authored code every player action. This was the first, narrow version.* Authored code never holds `bot`. It gets:
- **Reads, synchronous:** `self`, `inventory`, `entities`, plus `blockAt` from the shared world queries in `src/world.ts`. `scan` from the same layer is asynchronous: host time inside a synchronous call counts against the realm's 20 ms slice, and the first e2e trial died that way on a radius-16 scan. That layer is owned by [[perception-tools]], and System 2's perception tools use the same one, so there's one block view and not three.
- **Actions, asynchronous:**
  - `scan` and `reachable` (the world layer's clusters and A*);
  - `control` (forward/back/left/right/jump/sneak/sprint) and `goto` (the pathfinder with the shared guarded `Movements`, i.e. what `navigate` wraps), both on legs;
  - `look`, on aim;
  - `dig`, `place` (the held block at a position, against any solid neighbour) and `equip`, on hands;
  - `wait(ticks)`.
- **Channels:** each action needs the channel it drives, so a hands-only behavior can't walk.
- **Guards:** every action calls the bot methods `installGuards` already wrapped, so authored code can't get around them. A veto rejects the call with `vetoed: <reason>`. The code can catch it and try another way; uncaught, it ends the run as `vetoed`.
- **Other behaviors:** authored code can't call them by name yet. `goto` covers `navigate`'s job. Nested channel ownership comes when a behavior needs it.

**Sandbox: `node:vm` with a string-only bridge.**
- **A fresh realm per run.** The realm gets one host function, captured in a closure and deleted from its globals. Arguments and results cross as JSON strings, and promises are made inside the realm and settled by the host running a script. No host function, object or Promise enters the realm, which closes the `.constructor` route back to host `Function`.
- **Every entry into the realm is timed** (20 ms), and `microtaskMode: 'afterEvaluate'` puts promise jobs inside that timeout. A busy loop after an `await` is killed instead of freezing the bot.
- **Every action settles in a macrotask** (`setImmediate`), so each action's round trip yields to the event loop. Found 2026-10-11 ([[orchestrator-and-builder]], Sonnet run). A builder-written craft loop recursed through recipes, with crafts and walks that failed at once. Each entry into the realm was short, so the 20 ms limit never fired. But settling in microtasks never let a timer run: not the run's own time limit, not the heartbeat. The agent froze at 99% CPU for 20 minutes.
- **Not chosen:** a worker would still need vm inside it to block `require`, and makes every action a round trip. SES `lockdown()` still risks Mineflayer.
- **The [[system-1]] caveat still holds locally.** The realm isn't a hardened boundary, but the capability boundary is now the API plus the guards. The risk that grows when code can act is prompt injection: an allowlisted player's text steers what System 2 writes. Revisit before Jeeve runs anywhere else.

**Ending and stop.**
- The run ends with what the code returns. Otherwise it ends as `vetoed`, as `error` (a throw, a bad return value, or the 20 ms slice limit), or as `timeout`.
- Stopping cancels the realm, which is then never entered again: pending calls are dropped. Stopping also clears the claimed controls, the pathfinder goal and any digging, so `stop` holds whatever the code was doing.

**Trial.** There's no simulator, so a trial is one live run that System 2 starts.
- System 2 names the target (`trial: {block, count}` or `{entity}`). The run is **pinned**: Jev can't replace it.
- **Pass:** it returns `done` and its `pass_when` check (a check module System 2 names, e.g. "no `oak_leaves` in `s.blocks`") holds, or the goal it was written for completes while it runs. Without `pass_when`, `done` alone passes, but that's only the code's own claim: in e2e run 3 a `clear_tree` broke 9 of 27 leaves, failed every pillar, returned `done` and passed.
- **Either way,** a `behavior_trial` escalation (exempt from the no-repeat window) brings System 2 the end reason, the error, the last 30 actions with their results or vetoes, and the bot's own state. That's the evidence for its next attempt.
- **Only a passing behavior is registered.** System 2 then adds it to `allowed_behaviors`, and validation rejects a name that hasn't passed.
- No server privileges are used to stage a trial ([[layers]]).

**How Jev gets it.** A registered behavior is an entry in `BEHAVIORS`, the same table the seed set is in. `optionsFor` enumerates it by its channel set and target type like any other. One change: under an authored done-check (no count), block targets offer how many of that block are in view (the encoder's 8-block radius), instead of nothing. Counting within 32 sent `collect` after logs from an earlier scenario, away from the tree (e2e run 5).

**Going back to a place.** Jev's targets are what's in view (entities within 16 blocks, notable blocks within 8), so once Jeeve walks off, nothing leads back to the goal (e2e run 5 sat on `keep_current`). Decided with Joshua (2026-10-11): **System 2 sets the place; `navigate` takes it as a target.**
- `submit_decision`'s `goal` has `place: [x, y, z] | null`, e.g. a block `scan` found. Like `done_when`, setting `goal` again replaces it. A sub-goal inherits its parent's place, as it inherits the program.
- While Jeeve is 3 or more blocks from it horizontally, the legs question offers `navigate:place` ("Walk back to the goal's place (medium, behind, ~3 up), then stop"). Closer, it would mean the same as standing still, so it isn't offered.
- **Jev has to be told in its own words.** The e2e asks Jeeve to stay by a pumpkin, then teleports him 18 blocks off.
  - **Run 1:** with only the option, Jev chose "Stand still" at 0.9 over `navigate:place (far, right)`, though System 2's guidance said to walk back when farther than 3 blocks.
  - **Runs 3 and 4:** with `place: "far, ahead"` in Jev's state, run 3 walked back on a close call (0.53). Run 4 stood still at 0.75–0.95 for 45 s. Seeing low confidence, System 2 rewrote the guidance to "keep_current (idle) is CORRECT while within ~3 blocks", which made it worse (0.9+).
  - **First fix, measured by replaying those states ([[jev-measurements]]):** the state said it as a sentence, "you are far from the goal's place; it is ahead", and the System 2 prompt asked for guidance in Jev's distance words ("close, medium or far"), not blocks. That took P(walk back) from 0.08–0.25 to 0.97–0.98.
  - **Run 5:** Jev walked back from far and kept walking at medium. But at "you are close to the goal's place" it chose "Stand still" (0.83), 7.5 blocks short, though the guidance said "if you are close, medium or far … navigate back". Jev hears "close to" as "by it".
  - **What's built:** Jev is told `directive.place: "you are not at the goal's place yet; it is close, ahead"`, or "you are at the goal's place" within 3 blocks. System 2 is asked to write guidance in those words ("if you are not at the goal's place yet, walk back to it"). Replayed on run 5's states, P(walk on) at "close" went from 0.12–0.29 to 0.93 with the state alone, and to 0.98–0.99 with matching guidance, with far and medium unchanged at 0.97.
  - **Run 6 (E2E PASS, every check):** Jev picked `navigate:place` at 0.99 and kept it through medium (0.99) and close (1.0). Jeeve was back by the pumpkin 3.4 s after the teleport.
- The walk belongs to its place. When the goal's place moves or goes (a new instruction, the goal closing, System 2 setting another), a running `navigate:place` stops with `place_changed`. Without that, e2e run 3's walk back to a pumpkin outlived its goal: after the next instruction ("break that whole tree"), it carried Jeeve 30 blocks away from the tree, and System 2 found no tree in view.
- `navigate` walks to a place by x and z only (`GoalNearXZ`, range 2): the block System 2 named may be a trunk or a leaf, not a spot to stand. A place underground would need a standable spot instead.
- Not an authored behavior: a written "go back" would still need an out-of-view target offered to Jev. And not a place code picks (where the instruction came from): which place matters is System 2's call, so the runtime holds no heuristic for it ([[bitter-lesson]]). Walking to a coordinate is a generic primitive.

**Library and versioning.**
- Behaviors persist in `modules/library.json` beside checks and watches, with their channels, target type, time limit, trial result and origin. At startup they join `BEHAVIORS`.
- `behavior.*` spans carry `jeeve.behavior.version` and, for authored runs, `jeeve.behavior.detail` (the error and the last actions).
- **Retiring:** 3 runs in a row that end in `error` or `timeout` disable a behavior. It stays allowed, so programs still validate, but it's no longer offered, and `module_disabled` escalates. A new version from System 2 replaces it. Curation is git, as for checks.

**First results (e2e, 2026-10-11).** A 6-log trunk under a 3×3×3 canopy of persistent leaves, all out of reach from the ground. Josh says "break that whole tree, leaves included".
- **Run 1:** System 2 first tried `collect`. On the second `stuck` it wrote `pillar_and_break`.
  - v1 died in its first slice: a synchronous radius-16 `scan` was charged to the 20 ms limit. That's why `scan` is now asynchronous.
  - System 2 read the error and wrote a version that passed.
  - That version's own code was vetoed with "place: would suffocate", because it pillared up under leaves. That's a natural guard veto on System 2's code. System 2's next version cleared the block overhead first.
- **Run 2:** System 2 wrote `clear_tree` straight from the instruction.
  - v1 timed out. It treated `reachable`'s result object as a boolean, which was a gap in our prompt.
  - v2 dug its own pillar log as if it were tree.
  - Both failures were plain in the trial's action log, and System 2 named them. v3 skipped blocks it had placed, passed in 15 s, and all 27 leaves were broken.
- **Run 3:** v1 was refused for length (4000 chars, the predicate limit; behaviors now get 8000). v2 broke the bottom layer and returned `done` though every pillar failed, so it passed. System 2 spotted that, then waited for the leaves to decay, which is right for a natural tree but wrong for our persistent test leaves. That run led to `pass_when`.
- **Runs 4–7** found gaps around the behavior pipeline rather than in it:
  - **A false "done" (run 4).** System 2's goal check was "no logs or leaves in `s.blocks`". `collect` walked Jeeve 6 blocks off, the canopy left the 8-block view, and the goal "completed". The prompt now says that a type missing from `s.blocks` may just be out of view.
  - **Walking off (run 5).** Block counts from 32 blocks away sent `collect` after leftover logs (see "How Jev gets it").
  - **Waiting for decay (runs 3 and 6).** Jeeve can't see block states, so System 2 expected the logless canopy to decay. The test's leaves are persistent, as player-placed ones are, so the e2e instruction now says so.
  - **A goal-wide `pass_when` (run 7).** The trial's code broke every leaf, but the check was the whole goal's, so its own pillar logs failed it. The prompt now scopes `pass_when` to the trial target.
  - **What worked:** the guard vetoed System 2's pillar code ("would suffocate"), and System 2 fixed it from the trial log.
- **Run 8:** a trial's code broke the last leaves, its own final scan found none, and still `pass_when` read false. The likely cause was `notableBlocks`' 50 ms cache in `src/world.ts`, filled by the goal tick just before the last dig. Since c96c79f that cache is keyed on block updates, and `pass_when` is judged 3 ticks after the run ends either way. A failed `pass_when` carries the snapshot it judged.
- **Run 9 (E2E PASS, every check):**
  - v1 claimed `done` from the ground, and `pass_when` refused it (the snapshot showed the leaves);
  - v2 was vetoed for placing into its own body;
  - v3 waited until its feet cleared the block, passed, and broke the last leaves.

  That's 169 s from instruction to registration, with three System 2 rewrites.
- **Combined with [[perception]] (rebased on its commits, E2E PASS):** System 2 wrote behaviors without being asked to, in the oak scenario that scenario owns.
  - `dig_log_in_reach` passed its trial when the goal completed.
  - `clear_blocks_nearby` broke the oak's leaves.
  - In this scenario, `pillar_clear_blocks` broke all 27 leaves in 75 s during its trial, which was still running when the episode ended.
  - The e2e now checks that authored code does the work in this scenario, whether written there or reused. Registration is checked across the run.
- **Every run:** a fresh registry reloads the behavior from the library.
- **Lessons:**
  - The action log *is* the evidence: each rewrite cited a specific call.
  - Budget for 2–3 rounds per new behavior: a System 2 call takes 5–40 s, and a failed trial can take up to its time limit.
  - Jev escalates while a pinned trial holds its channels. Those escalations are now dropped (and traced) during a trial.

### The player action API (2026-10-11)
Decided with Joshua while working on [[full-player-action-api]]. It replaces the narrow API above, which held only what pillaring needed. Code: `READS`, `ACTIONS` and `NOT_MAPPED` in `src/behaviors.ts`.

**Every player action, one entry each.** Code System 2 writes gets everything a player can do, mapped one to one from Mineflayer (4.39). It doesn't get the abilities we happened to need first. Under the [[bitter-lesson]], we don't decide which abilities exist; the only offline work left is genuinely new inputs or outputs (e.g. vision).

| Channel | Actions |
|---|---|
| none | `scan`, `reachable`, `wait`, `next(event)`, `whisper` |
| legs | `control`, `goto`, `mount`, `dismount`, `steer`, `sleep`, `wake`, `fly` |
| aim | `look`, `turn` |
| hands | `dig`, `stop_digging`, `place`, `place_entity`, `equip(glob, dest)`, `unequip`, `hotbar`, `toss`, `attack`, `use`, `release`, `consume`, `fish`, `activate_block`, `activate_entity`, `use_on`, `swing`, `craft(item, count, table?)`, `open`, `open_entity`, `click`, `deposit`, `withdraw`, `close`, `trade`, `enchant`, `rename`, `write_book`, `sign` |

**Reads**, synchronous: `self`, `inventory`, `slots` (every slot, including armor and off-hand), `held` (with durability), `entities`, `blockAt`, `blockInfo` (name and block states, e.g. `persistent`, which [[perception]] had as an open question), `window` (the open window's slots and, for a villager, its trades) and `recipes(item)`. Recipes are game data, not strategy.

**Hand-written, but checked for completeness.** The mapping can't be generated. Mineflayer's arguments are live objects (`Block`, `Entity`, `Item`, `Window`), so each entry turns plain data (a position, an entity id, an item glob, a slot) into them. Which channel an entry drives is a judgment call too. So each entry names the Bot methods it `covers`, and `NOT_MAPPED` lists the rest with a reason:
- the client lifecycle (`quit`, plugins, `respawn`…);
- public `chat` (see below);
- operator and creative-mode actions;
- queries code can answer from the reads (`nearestEntity`, `blockAtCursor`…).

The selfcheck parses Mineflayer's typed `Bot` interface and fails on any method that's neither covered nor explained. A Mineflayer upgrade that adds an action fails until someone decides what it is. Several methods share an entry: `open` covers `openBlock`, `openChest`, `openFurnace`, `openEnchantmentTable` and `openAnvil`, and `click` covers the slot helpers (`moveSlotItem`, `transfer`…).

**Events are generated.** `api.next(event, ticks)` waits for the next Mineflayer bot event of any name (`windowOpen`, `entityHurt`, `playerCollect`, `chat`…). It resolves with that event's arguments, converted to plain data by their shape (entities, blocks, windows, items, Vec3s), or with null on timeout. Polling still works. Events from before the call aren't buffered, and a run's listeners are removed when it ends.

**Menus belong to the hands.** `open` and `open_entity` need the hands channel. The window they open is held by that run across awaits, until `close()` or the run ends (the cleanup closes it). One window at a time, as in the game. Legs and aim aren't frozen while it's open: walking away closes it on the server's side, as it does for a player. "No moving with a menu open" is an anti-cheat convention, so it waits for the fairness settings for public servers ([[layers]]). `craft` with a table opens and closes the table itself.

**Guards: none new (Joshua, 2026-10-11).** The physics guards still wrap `setControlState`, `dig` and `placeBlock`, so every action built on them is covered. We considered guards on hitting the instructor, chat spam, lava or fire near the bot, and tossing the whole inventory. None were added: guards are a runtime matter, added for the context Jeeve plays in (an arena wants players hittable, a co-op server doesn't), and only once a context needs one. Known holes, for when it does:
- `steer` drives a vehicle without the movement guard;
- `use` with a lava bucket isn't checked;
- `attack` can hit anyone.

**Chat: whispers to allowlisted players only.** For the local milestone, authored code can `whisper` the players who may give instructions, and never runs a `/` command. There's no public chat. Speech stays tied to the people Jeeve works for ([[system-2]] → "Reporting back"). Incoming chat reaches code only as event data from `next("chat")`; code can't eval it, so the injection risk stays where it was: System 2 reading players' text. **Revisit before other servers:** public chat, and marking chat from players who aren't allowlisted as untrusted in System 2's context.

**Item targets.** A behavior can take an `item` target (`{ name, count }`), e.g. something to craft. Jev is offered it for the item an `inventory_delta` goal still needs, the way `collect` is offered block types. Without it, a registered craft behavior would pass its trial and never be picked again.

**Seed behaviors stay wrapped plugins.** They could be written on this API: `track` is `look` plus `wait(1)`, and `attack_when_ready` is `attack` on a cooldown. Rewriting them would give one kind of behavior instead of two, but no new capability, and it would risk an e2e that passes today. `navigate` and `follow` are pathfinding, which is search ([[seed-behaviors]]). `collect` is still the first one System 2 should replace, now that it can.

**Describing it to System 2.** `API_DOC` is generated from the tables, one line per entry, and goes into System 2's cached system prompt. A builder (System 2B, [[system-2a-2b]]) should use the same string. The base system prompt grew from 2,525 to 4,187 tokens. It's cached, so a call pays for it once per 5 minutes.

**First results (e2e, 2026-10-11, E2E PASS, every check).** Two instructions no seed behavior can do. Jeeve starts each with only what the e2e gives him.
- **"craft a wooden pickaxe"** (4 oak logs, no table): System 2 wrote `craft_item` from the instruction.
  - v1's arithmetic left 2 planks for a head that needs 3. `craft` said "not enough ingredients", and the run ended `stuck`.
  - v2 crafted more planks, walked to the table it had placed, and crafted the pickaxe. That was 55 s and two System 2 writes.
  - On a mini run before that, v1 gave up without acting. `recipes` was capped at 8 entries, and Mineflayer lists one recipe per wood type, so oak was cut off. The cap is gone, and recipes whose ingredients Jeeve holds come first.
- **"put your logs in the chest"** (a chest 3 blocks off): `deposit_in_chest` passed its first trial in 16 s, and all 7 logs ended up in the chest. The code: `scan` → `goto` → `open` → `deposit("*_log")` → `close`.
- **Chat policy:** an e2e fixture's whisper to Josh arrives, and its whisper to a stranger is refused.
- **Cost:** with the longer prompt, instruction calls took 4–15 s for 1–2 turns, in line with [[system-2]]'s 5–9 s. No latency change shows.

**Broken behavior or bad choice.** Traces separate the two:
- `error` and `timeout` are code faults;
- `stuck` and `none_found` are what the code itself reported about the situation;
- `decided_by` says who started the run: `system2:<span>` for a trial, a `decide` span for Jev's pick.

## Open questions
- ~~**How much to write up front.**~~ Answered in [[seed-behaviors]]: `navigate`, `follow`, `track`, `attack_when_ready` and `collect` (whole-body, wraps collectblock).
- ~~**Telling a broken behavior from a bad choice.**~~ Answered above (end reasons plus `decided_by`). Still open: a behavior that returns `done` without doing its job looks healthy until its goal's check disagrees.
- ~~**Retiring behaviors.**~~ Answered above: disabled after 3 failed runs in a row; an outcome-based retire step waits for the outer loop (stage 4).
- **Calling other behaviors.** When should authored code get `api.run(name, target)`, and how do nested runs share channels?
- ~~**Going back to a place.**~~ Answered above ("Going back to a place"): System 2 sets the goal's place, and `navigate` takes it as a target. Still open: one place per goal; named waypoints if a goal needs several.
