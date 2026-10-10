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
System 1  Jev: picks a behavior per channel + parameters, ~2–10 Hz, triggered by events
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
- A decision model ([[decision-models]]). Each call takes a state and typed questions, and returns choices with calibrated probabilities. Context only, no training.
- **One call is one choice question per channel**, plus "escalate?" as a yes/no. Jev evaluates the questions in parallel.
  ```json
  { "legs": "navigate:red_base", "aim": "track:Steve", "hands": "attack_when_ready:Steve", "stance": "sprint" }
  ```
- **Steers a local path, not single steps.** `navigate(target)` is one choice. Crossing terrain, swimming, bridging and pillaring happen in code underneath.
- **Calls are triggered by events** (behavior done, stuck, damage taken, new entity in range), not a fixed timer. There's a timeout so it never goes quiet for too long.
- **Escalates** on low confidence, on an explicit yes to "escalate?", or when a typed escalation event arrives from code ([[realtime-game-agents]]: done or failed, budget exceeded, stuck, expected ≠ observed).
- **Always has a small fixed base context** (survive: fight, flee, eat) on top of System 2's guidance. When something unexpected happens, it acts sensibly during the 2–5 s before System 2 rewrites its guidance.

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

## First experiment: the arena
A flat arena, against a zombie and then a mineflayer-pvp bot:
- Jev drives the channels at about 5 Hz with fixed guidance (no live updates).
- Compare the win rate with mineflayer-pvp on its own.

If it wins or ties, the layering holds. If it loses, the traces should show whether to blame the guidance, the state encoding, or the call speed.
