---
date: 2026-10-10
tags: [roadmap]
status: active
---
# Roadmap

How we're breaking the problem down before writing code. Each stage ends with notes in the brain, and later stages build on earlier ones.

## 1. Research: state of the art and benchmarks
- What the best Minecraft and real-time game agents do: action spaces, what they hand-build vs. learn, how they handle latency and long horizons.
- Which benchmarks exist, how they measure success, and which ones a Mineflayer agent can actually run.
- Output: notes in `brain/research/`.

## 2. Architecture
- **Primitives and routes:** the agent's interface to the world. Where the line between low- and high-level actions sits, and which overall approach we take.
- **System 1:** what "fast" actually does. Not a vague "decision model that executes", but its inputs, outputs, rate, action set, and what it owns.
- **System 2:** goals and time. The goal tree, nested time windows, planning and replanning.
- **The interface between them:** directives down, escalation up, what runs concurrently, who can interrupt whom.
- Output: notes in `brain/architecture/`, replacing the open questions in [[overview]].

## 3. Tracing with Judgment
- How the goal tree, System 1 segments and decisions map onto sessions, traces and spans.
- What gets recorded so failures can be diagnosed (plan vs. execution vs. perception) and traces can become training data.

## 4. Goals and reward
- How an objective is defined, and what counts as success.
- Programmatic checks vs. judges, and scoring at each level of the hierarchy.
- The signal the agent hill-climbs on.
