---
date: 2026-10-10
tags: [architecture, bitter-lesson]
status: active
---
# Architecture overview

Jeeve is a general Minecraft agent. Give it any objective ("build a house", "win this Bed Wars match", "beat the game") and it should get better at it through experience, without us writing Minecraft strategy into it.

## The organizing question
From [[bitter-lesson]]: for every part of the agent, are we building in **the knowledge** or **a method for discovering it**? Prefer the method.

## What we build
General machinery that holds no Minecraft strategy:

- **An interface to the world:** observation and action primitives.
  - Bots don't see pixels; they get the world as data: blocks, entities, velocities, inventory ([[perception]]).
  - Primitives should be generic (move, look, dig, place, use, attack, craft, chat), not strategies.
- **A shape for thinking:** a goal hierarchy, time at several scales, and fast decisions that escalate to slow ones. This is structure with no content.
- **Outcome signals:** what counts as success for an objective, with judges for the parts that can't be checked mechanically. Nothing can be learned without them.
- **A record of experience:** traces of what the agent saw, decided and caused.

## What the agent discovers
| | Discovered by | Method |
|---|---|---|
| **Plans:** how to break an objective down | Reasoning at the time it's needed | Search |
| **Skills:** reusable routines that worked | Writing code, keeping what succeeded | Learning |
| **World knowledge:** where things are, what failed | Writing its own memory | Learning |
| **Fast reactions** | System 2 rewriting the fast model's guidance, with examples it retrieves from past traces | Learning (in context) |

## The discovery loop
```
      ┌──────────────────────────────────────────────┐
      ▼                                              │
     act ──► record ──► evaluate ──► distill ────────┘
             (traces)   (outcomes,   (guidance, examples,
                         judges)      behaviors, memory)
```
The agent is a loop that improves itself, not a fixed pipeline. Every episode produces experience. Outcomes say which experience was good. Distillation turns good experience into something reusable: guidance and examples in context, and behaviors in code. No model weights are trained ([[learning]]).

## Fast and slow
- **Slow thinking (System 2)** is a reasoning model. It's general and capable, but takes seconds or more per decision. This is **search**.
- **Fast thinking (System 1)** is a decision model (Jev) that decides several times a second. It isn't trained. It improves because System 2 keeps rewriting its context: guidance, plus examples of good decisions retrieved from traces ([[learning]]).
- **The two loops feed each other**, in the spirit of AlphaZero, but through context rather than weights: search finds better decisions, those decisions become the fast layer's examples, and a better fast layer frees search for harder problems.
- **Escalation:** fast thinking hands back to slow thinking when it's unsure, when it's done, or when something unexpected happens.
- **Below both** is plain code that runs every tick (e.g. keep aiming at a target). Neither model is fast enough for that.

See [[fast-slow-agents]] for prior art and [[decision-models]] for candidate fast models.

## Goals and time as one hierarchy
```
beat the game                         ← always in context
├─ ✓ get basic tools   → one-line summary of what happened
├─ ▶ get iron armor    ← log of this task so far
│   └─ ▶ mine iron     ← last ~minute
│       └─ ⚡ fight     ← last few seconds (fast thinking)
└─ ○ …                 ← not expanded yet
```
- **Goals break down from the top.** Slow thinking expands a node when it reaches it, not all at the start.
- **History summarizes up from the bottom.** Each node keeps a log for the time it's active. When it finishes, the log becomes a one-line summary on its parent.
- **Context** for any decision is the path from the root to the current node. Finished branches shrink to summaries, and future ones are just names.
- **Interrupts** push a temporary node, e.g. "fight", and pop back to the task afterwards. The active path behaves like a call stack. *Refined by [[system-2]]:* only System 2 pushes nodes; a fight Jev starts is a behavior run under the current goal.
- **The structure is built in; what goes in it is discovered.** We never write the tree for "beat the game".

## Time in decisions
A decision model is stateless: it sees one state per call. Time has to be encoded ([[perception]]):
- **Features with motion built in:** closing speed, facing angle, health trend.
- **A sliding window of recent events:** detailed for the latest moments, sparser further back.
- **Running summaries:** facts that need to outlast the window.

Fast decisions are *options*: an action plus a stop condition ("strafe left until hit or 0.6 s"). They're not per-frame actions, so the agent commits to something instead of dithering.

## Scaffolding
Hand-written reflexes and heuristics are allowed where we need the agent to work before it can learn, but each one is temporary. Each should have:
- a known way to replace it with something learned,
- a baseline it has to beat.

## Where Judgment fits
Judgment isn't bolted on. It provides the loop's experience and reward.
- **Traces are experience.** The trace tree mirrors the goal tree: one session per episode, one span per node, fast decisions nested underneath.
- **Judges are the reward signal** for outcomes that can't be checked mechanically, scored at every level of the hierarchy.
- **Failures become diagnosable.** Was it a bad plan (slow thinking), bad execution (fast thinking), or missing information (perception)?

## Open questions
- ~~**The primitive set.**~~ Answered in [[layers]]: one right answer → code behaviors; judgment → Jev picks behaviors per channel; plans → System 2.
- **Outcome signals for open-ended objectives.** What does "a good house" mean? How far can judges go? For the first milestone, [[system-2]] gives open-ended goals `escalate_if` checks and a review interval instead of a success check; judges are still stage 4.
- ~~**What form distillation takes.**~~ Answered in [[learning]]: context (guidance and examples) and code (behaviors). No weight training.
- **Perception.** Is data alone enough, or do images help for some judgments, like how a build looks?
- **How much of the hierarchy is fixed.** Could the structure itself be learned?
