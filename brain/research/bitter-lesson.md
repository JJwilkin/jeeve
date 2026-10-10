---
date: 2026-10-10
tags: [design-principle, system-1, system-2, reflexes]
status: active
---
# The bitter lesson, applied to Jeeve

Source: Rich Sutton, "The Bitter Lesson" (2019).

## The claim
General methods that scale with compute end up beating methods that encode human domain knowledge. There are two such methods:

- **Search**: spend compute at decision time exploring possibilities. Examples: alpha-beta in chess (Deep Blue), MCTS in Go. Today's equivalent is test-time compute: planning, rollouts, sample-and-verify.
- **Learning**: spend compute extracting regularities from data or experience. Examples: self-play (AlphaZero), HMMs and deep nets in speech, learned vision features replacing SIFT and edge detectors.

Build in the *meta-methods that discover* knowledge, not the knowledge itself. Hand-built knowledge helps early, then plateaus, and can block scaling.

## Implications for Jeeve
This is the organizing question of [[overview]]: for each part of the agent, do we build in the knowledge, or the method for discovering it?
- **Hand-written reflexes and heuristics** are hand-built knowledge. They're fine as scaffolding, but treat them as a baseline to beat, not a foundation to keep growing.
- **Fast reactions (System 1)** follow the bitter lesson when they're learned from experience, not hand-tuned.
- **Breaking goals down** is a kind of search over plans. More compute should help. Avoid hard-coding plans for specific objectives.
- **Skills** should be written and kept by the agent, not curated by hand.
- **Smell test:** if a fix adds a Minecraft-specific heuristic, ask whether more search or more data would fix it instead.
