---
date: 2026-10-11
tags: [task, behaviors, action-api, bitter-lesson]
status: active
progress: done
---
# Task: the full player action API

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/full-player-action-api.md`."

## Why
The API that behaviors written by System 2 get ([[behaviors-and-guards]] → "How it's built") is **narrow by accident**. It holds what the first test case (pillaring up to a canopy) needed, and nothing more:
- reads: `self`, `inventory`, `entities`, `blockAt`;
- actions: `scan`, `reachable`, `control`, `goto`, `look`, `dig`, `place`, `equip`, `wait` (`API_READS` / `API_ACTIONS` in `src/behaviors.ts`).

So System 2 can write pillaring or a staircase live, but not "craft a pickaxe", "put this in the chest", "eat", "attack that" or "tell me when you're done". Each of those would need us to add an action offline first. That's us deciding which abilities exist, which the [[bitter-lesson]] says not to do.

## Goal
Give code System 2 writes **every action a human player has**, mapped one-to-one from Mineflayer, so the only offline work left is genuinely new inputs or outputs (e.g. vision).

**These three stay fixed**, because they protect the runtime rather than limit what Jeeve can do:
1. **No raw `bot` handle.** Everything crosses the string-only bridge, so code can't get around guards, leave listeners behind or freeze the agent.
2. **Guards on physical danger** wrap every action.
3. **Channel ownership.** Each action names the channel it drives.

## Read first
- [[behaviors-and-guards]]: the contract, the action API, the sandbox and trial ("How it's built"), guards
- [[seed-behaviors]]: what the seed set wraps, and channel *sets*
- [[system-1]]: how a registered behavior becomes a Jev option (`optionsFor`), the module library
- [[system-2]]: the `write_behavior` tool, and how the API is described in System 2's prompt
- [[perception]]: the shared read-only world layer (`src/world.ts`) the API reads through
- Code: `src/behaviors.ts` (`actionApi`, `API_READS`, `API_ACTIONS`, `authoredSpec`), `src/modules.ts` (sandbox), `src/guards.ts`, `src/system2.ts`

## Questions to answer
1. **The full action set.** List what a player can do, and the Mineflayer call for each. For example:
   - attack an entity;
   - use or activate an item, a block or an entity (`activateItem`, `activateBlock`, `activateEntity`);
   - eat;
   - open a container or crafting table, and move items between slots;
   - craft (`recipesFor`, `craft`);
   - drop items;
   - sleep, mount and dismount;
   - chat and whisper.

   Decide which are missing, and whether the mapping can be generated rather than hand-written, so it stays complete as Mineflayer grows.
2. **Reads that go with them.** Inventory slots (not just counts), the open window and its slots, recipes the game data allows, held item details. Game data such as recipes is data, not strategy, so exposing it is fine.
3. **Menus and channels.** Which channel owns an open window? What happens to legs and aim while a menu is open? Can a behavior hold a window across ticks?
4. **Guards for the new actions.** Physical danger still applies (don't drop into lava). Decide whether anything else needs a guard: hitting the player who gave the instruction, dropping or destroying the whole inventory, chat spam. Prefer few guards. A guard is code that can't be talked around, so only add ones that protect the runtime or the player.
5. **Chat and prompt injection.** Chat lets code System 2 writes talk to other players, and other players' messages already steer System 2 ([[behaviors-and-guards]] flags this risk). Decide what chat is allowed to do for the local milestone and what to revisit later.
6. **Events.** Should code be able to wait on game events (e.g. `windowOpen`, `entityHurt`, `playerCollect`) through the bridge, and not only poll?
7. **Seed behaviors on the same API.** Could `navigate`, `follow`, `collect`, `track` and `attack_when_ready` be rewritten as library entries on this API, so there's one kind of behavior instead of two? Or are some seeds better left as wrapped plugins?
8. **Describing it to System 2.** The API docs live in System 2's cached system prompt. Keep them complete but short, and measure the prompt-size and latency cost.

## Coordination
- [[system-2a-2b]] splits System 2 into an orchestrator and a builder, and the builder leans on this API. Nothing here should assume one System 2; if both are active, agree the request format first.
- E2e runs can run in parallel on separate ports: `JEEVE_PORT=25566 npm run e2e`.

## Done when
- [[behaviors-and-guards]] (or a new architecture note) records the full action set and its mapping, reads, menus and channels, guards, chat policy, events, and what happened to the seed behaviors.
- The e2e has a scenario where System 2 writes behaviors live, using the new actions, for instructions it can't do today:
  - "craft a wooden pickaxe" (from logs: planks, sticks, crafting table, pickaxe);
  - "put your logs in the chest" (a chest placed by the e2e).
- ~~A guard vetoes at least one unsafe use of a new action.~~ Dropped by Joshua (2026-10-11): no new guards for now; guards are added by the runtime for the context Jeeve plays in. The e2e checks the chat policy's refusal instead (a whisper to a stranger).
- `npm run check`, `npm run typecheck` and `npm run e2e` pass.
- [[roadmap]] and the index are updated, and this task's `progress` is `done`.
