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

## Open questions
- ~~**How much to write up front.**~~ Answered in [[seed-behaviors]]: `navigate`, `follow`, `track`, `attack_when_ready` and `collect` (whole-body, wraps collectblock).
- **Telling a broken behavior from a bad choice.** Did the new behavior fail, or did Jev pick it at the wrong time? Traces need to tell these apart. [[trace-schema]] keeps the full state on every `decide` and links each behavior run to the call that chose it (`decided_by`).
- **Retiring behaviors.** What happens to ones that stop working or get replaced?
