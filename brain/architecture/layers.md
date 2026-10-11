---
date: 2026-10-10
tags: [architecture, system-1, system-2, motor]
status: active
---
# Layers

How Jeeve's layers split the work and talk to each other. Refines the fast and slow section of [[overview]].

```
System 2  goals · writes Jev's guidance (live + across episodes) · writes new behaviors
   │ guidance + allowed behaviors          ▲ escalations, events, traces
System 1  Jev: picks a behavior per channel + parameters, woken by mechanisms whose policy System 2 sets
   │ channel settings                      ▲ behavior events (done, stuck, blocked, vetoed)
Behaviors deterministic, layered, added at runtime: navigate, track, aim, bridge, ride_boat…
   │
Guards    invariants on every command: edges, lava, void, suffocation
   │
Mineflayer
```

## The dividing rule
- **One right answer, given the goal → code** (behaviors, guards). Pathfinding, aim and arrow lead, attack-cooldown timing, not walking off a cliff.
- **Needs judgment → System 1.** Strafe or retreat, sword or bow, which target, what to do when navigation reports stuck.
- **Needs a plan → System 2.** What to do next, in what order, and what guidance System 1 should run under.

This is the physics-vs-strategy split from [[fast-bots]], with planning added on top. Under the [[bitter-lesson]], search (pathfinding) and physics stay as code. Judgment and plans come from models and improve through context ([[learning]]).

## System 2: the planner
- A reasoning model. Runs for seconds to minutes and never blocks the layers below.
- **Owns the goal tree** ([[overview]]): expands nodes, replans on failure.
- **Writes System 1's context** for each directive:
  - the situation and what matters ("bridging to the red base; the void ends the game; enemies come from the left"),
  - which behaviors each channel may use right now,
  - a few examples,
  - when to escalate.
  
  The directive *is* the category, so no router or hand-made skill categories are needed (the contrast with [[peam]]).
- **Learns live and across episodes, through context only** ([[learning]]).
- **Writes new behaviors at runtime** when the library is missing one ([[behaviors-and-guards]]).

## System 1: Jev
What Jev sees, what it's asked and when it's called is a **program System 2 writes**, running on a fixed runtime. The split, the program format, the fixed bounds and the default program are in [[system-1]]. The bullets below describe the default program and the runtime.

- A decision model ([[decision-models]]). Each call takes a state and typed questions, and returns choices with calibrated probabilities. Context only, no training.
- **In the default program, one call is one choice question per channel**, plus "escalate?" as a yes/no. Jev evaluates the questions in parallel, and extra questions add almost no latency ([[jev-measurements]]). Other programs can lay questions out differently ([[system-1]]).
  ```json
  { "legs": "navigate:red_base", "aim": "track:Steve", "hands": "attack_when_ready:Steve", "stance": "sprint" }
  ```
- **Steers a local path, not single steps.** `navigate(target)` is one choice. Crossing terrain, swimming, bridging and pillaring happen in code underneath.
- **When Jev decides is System 2's call, not a fixed rule.** The infrastructure provides the *mechanisms* for waking Jev:
  - behavior events (done, stuck, blocked, vetoed),
  - subscriptions to changes in game state,
  - watch conditions,
  - timers.

  System 2 sets the *policy*: what to react to, when to be proactive, and how often to re-decide in this situation. Shipped defaults are scaffolding, not design ([[system-1]]).
- **The latest state wins.** At most one call is in flight per bot. If the state changes during a call, the next call uses the newest state; stale states aren't queued.
- **Escalates** on low confidence, on an explicit yes to "escalate?", or when a typed escalation event arrives from code ([[realtime-game-agents]]: done or failed, budget exceeded, stuck, expected ≠ observed).
- ~~**Always has a small fixed base context**~~ *Superseded by the pinned fallback program in [[system-1]]:* the default program runs whenever System 2's program fails its check, the watchdog trips, or System 2 is unavailable, so the bot acts sensibly during the 2–5 s before System 2 rewrites its program.

## Channels: why it runs live
The motor layer is a few channels, like a person's hands on WASD, mouse and clicks. Each runs one behavior at a time, concurrently:

| Channel | Example behaviors |
|---|---|
| **Legs** | `navigate(pos)`, `move(dir, until)`, `follow(entity, dist)`, `ride_boat(dir)`, `stop` |
| **Aim** | `track(entity)`, `aim_bow(entity)` (leads the target), `look_at(block)` |
| **Hands** | `attack_when_ready(entity)`, `use(item)`, `charge_and_release(bow)`, `place(block, face)`, `eat` |
| **Stance** | `sprint`, `sneak`, `jump_when_blocked` |

- **Behaviors keep running between Jev calls.** A 300 ms call only delays a *change*: the bot keeps strafing and tracking while it waits. This is action chunking from the real-time research.
- **Each channel has one owner,** so behaviors don't fight. Code enforces game rules between channels, e.g. using an item slows you, so sprint is adjusted.

## First milestone: a client that takes instructions
Jeeve is a client, not a simulator harness. It joins a server like a player, and takes instructions from outside.
- **Start local.** A local Minecraft server on this machine, in offline mode. Later the same agent can join a server we run on GCP, or any other server. Mineflayer auto-detects the version (1.8 → 26.1); online-mode servers need a Microsoft account for the bot.
- **Instructions come from outside.** An external channel sets System 2's root goal and reports status back: in-game whispers from allowed players, and a small local API. The root of the goal tree is whatever the latest instruction says.
- **Assume no server privileges.** No op, RCON, `/tick`, world resets or `/give`. Nothing in the agent may depend on them; they're only for evaluation on our own server.
- **Unknown worlds and modes are part of the state.** Plugins, menus (inventory windows), scoreboards and chat all count. A mode like Bed Wars is something the agent discovers on the server, not something we code in.

**First run:** join the local server and follow external instructions such as "come here", "collect 10 logs" and "follow me and defend me". That exercises the whole stack end to end: connection, perception, seed behaviors, guards, the Jev loop, System 2's root goal, and traces.

**Evaluation is separate.** Our own Paper server, with RCON, gives reproducible scenarios: resets, slowed time with `/tick`, and the benchmarks in [[benchmarks]]. The PvP arena (Jev vs. mineflayer-pvp, win rate) is one of those scenarios, not the shape of the product. The agent code is identical in both places.

**Later, not now:** behaving like a legitimate client on public servers. That means vanilla movement and attack timing so anti-cheat isn't tripped, x-ray off ([[fast-bots]]: fairness is a setting), and only joining servers that allow bots.
