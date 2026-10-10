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
- **Reflexes** (scripted Mineflayer code) are hand-built knowledge. That's fine as scaffolding for P0–P3. Treat them as a baseline to beat, not a foundation to keep growing.
- **System 1** follows the bitter lesson when it's learned. The plan to fine-tune a local model on slowed-down (`/tick rate`) reasoning-model traces is the learning path. Keep the `decide()` interface so learned backends can replace hand-tuned ones.
- **System 2** goal-tree expansion is a kind of search over plans. More compute (deeper expansion, retrying alternatives on failure) should help. Avoid hard-coding scenario-specific plans.
- **Skills** (Voyager-style) are learned. Prefer an agent-written skill library over a hand-curated one.
- **Smell test**: if a fix adds a Minecraft-specific heuristic, ask whether more search or more data would fix it instead.
