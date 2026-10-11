---
date: 2026-10-11
tags: [task, behaviors, system-2, modules, bitter-lesson]
status: active
progress: done
---
# Task: behaviors System 2 writes at runtime

**Outcome (2026-10-11):** built. Decisions and results are in [[behaviors-and-guards]] → "How it's built". The block view is shared with [[perception-tools]] (`src/world.ts`).

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/runtime-authored-behaviors.md`."

## Why
In a live session on 2026-10-11, Jeeve was asked to break a tree's leaves. He collected the reachable logs, got `stuck` on the leaves in the canopy, then refused "place the blocks you collected to reach the rest":
> Refusing g-4: none of my behaviors (navigate/follow/track/attack_when_ready/collect) can place blocks, so I can't pillar up to reach the canopy leaves.

System 2 diagnosed the problem correctly, but it had no way to gain the ability. The architecture says it should: when the library is missing a capability, System 2 writes a new behavior ([[behaviors-and-guards]] → "Runtime-authored behaviors"). This is Voyager's skill library moved down to the motor level, and it's the main way Jeeve gains abilities we didn't give him ([[bitter-lesson]], [[learning]]: knowledge lives in context and code).

## Goal
System 2 can write a new behavior when it needs one, trial it safely in the live world, register it, and reuse it in later runs. The first test case: write `pillar` (or `place`) on its own and use it to reach the leaves.

## Read first
- [[behaviors-and-guards]]: the behavior contract (channels, parameters, lifecycle, events, ending), guards, and the five runtime-authoring steps (write, sandbox, trial, register, version)
- [[seed-behaviors]]: how the seed behaviors wrap Mineflayer plugins, why behaviors claim channel *sets*, and the guarded `Movements` config
- [[system-1]] → "Modules System 2 writes" and "Module library": the existing pipeline for checks and watch conditions (`src/modules.ts`). Reuse it; don't build a parallel one.
- [[system-2]]: how decisions are applied, `new_modules`, `module_failed` escalations
- [[layers]]: which work belongs to code, to Jev and to System 2
- Evidence: [[mindcraft-and-voyager]] (Voyager's skill library; Mindcraft's `coder.js` and `lockdown.js` sandbox)
- Code: `src/behaviors.ts` (the `Spec` contract, `BEHAVIORS`, the channel runtime), `src/modules.ts`, `src/guards.ts`, `src/system2.ts`

## What exists today
- Modules System 2 writes come in two kinds, `check` and `watch` (`ModuleKind`, `src/modules.ts`). Both are **pure, synchronous predicates over a JSON snapshot** in a `node:vm` realm. They have no access to the bot.
- The pipeline is compile → trial on ~30 recent snapshots → register as `name@version` → persist in `modules/library.json`.
- Behaviors are TypeScript in `BEHAVIORS`. Each one is **asynchronous, has side effects, and drives the live bot** through Mineflayer and its plugins.

Behaviors are a different kind of module from checks. The core design problem is giving authored code enough power to act, without letting it bypass the guards or hold our objects.

## Questions to answer
1. **The action API.** What can an authored behavior call?
   - A narrow, guarded, async API (e.g. move, look, jump, sneak, dig at a position, place a block against a face, equip, wait for ticks), plus read-only world queries (block at a position, nearby entities, inventory)?
   - Can it call existing behaviors such as `navigate`, so behaviors layer as [[behaviors-and-guards]] describes?
   - The guards must wrap every action, so authored code can't get around them.
2. **The sandbox.** `node:vm` with a JSON boundary works for predicates, but behaviors are async and long-running.
   - Options: a vm realm with an async message bridge, a worker thread, or an SES compartment.
   - Weigh hot-path latency, Mineflayer safety and isolation.
   - [[system-1]] records that `node:vm` is not a security boundary, which is fine for now (local only, our own System 2 as author). Say whether that still holds when the code can act.
3. **The contract for authored behaviors.** Channels claimed, parameters, events emitted, how it ends, a time limit, and how `stop` is guaranteed when the behavior is replaced.
4. **Trial.** There's no simulator. Trials happen in the live world, under guards, with a time limit.
   - What counts as a pass?
   - How does a failure become evidence for System 2's next attempt (a `module_failed`-style escalation carrying the trace)?
   - The agent must not depend on server privileges ([[layers]]), so no `/fill` or resets to stage a trial.
5. **What the author can see.** *Owned by [[perception-tools]]: agree a shared read-only query layer with that task rather than building a separate one.* Writing `pillar` needs block information, and today System 2 can't see blocks: in the same session it guessed a tree had "a few logs" because "the snapshot shows no blocks", set a done-check of 3, and left a log standing. Decide what block view System 2 and authored code get. Options include a local block query in the API, a richer snapshot, or a module that summarizes nearby structure. This is a perception gap, separate from the behavior gap, but the first test case needs both.
6. **How Jev gets the new behavior.** Once registered, a behavior appears as a Jev option when System 2's guidance allows it. How are its options and parameters enumerated?
7. **Library and versioning.** Extend `modules/library.json` with the new kind, record the behavior version on `behavior_start` spans, and decide how a broken behavior gets retired.
8. **Broken behavior or bad choice?** [[behaviors-and-guards]] lists this as open: did the new behavior fail, or did Jev pick it at the wrong time? Traces need to tell these apart.

## Done when
- An architecture note (or an update to [[behaviors-and-guards]] and [[system-1]]) records the action API, the sandbox choice, the authored-behavior contract, trial rules, the block view, and library and versioning. Anything superseded is marked `superseded`.
- It's built and tested end to end. The e2e (or a new scenario) places a tree whose leaves are out of reach and asks Jeeve to break all of it. System 2 writes a placing or pillaring behavior, it passes its trial, it's registered, the leaves get broken, and the next run reloads it from the library.
- A guard vetoes at least one unsafe action from authored code during that test.
- `npm run check`, `npm run typecheck` and `npm run e2e` pass.
- [[roadmap]] and the index are updated, and this task's `progress` is `done`.
