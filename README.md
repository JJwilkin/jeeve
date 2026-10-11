# Jeeve: Minecraft agent

A general Minecraft agent. Give it any objective, whether that's building a house, winning a Bed Wars match or beating the game, and it should get better through experience, without us writing Minecraft strategy into it.

## The idea
The design follows [the bitter lesson](brain/research/bitter-lesson.md): build in **methods for discovering knowledge**, not the knowledge itself.

- **We build** general machinery: an interface to the world, a shape for thinking (goal hierarchy, time at several scales, fast and slow decisions), outcome signals, and a record of experience.
- **The agent discovers** plans (search), skills, world knowledge and fast reactions (learning).

```
act ──► record (traces) ──► evaluate (outcomes, judges) ──► distill (guidance, examples, behaviors, memory) ──► act better
```

Slow thinking (a reasoning model) plans and searches. Fast thinking (a decision model) reacts several times a second, guided by context that slow thinking keeps rewriting from experience. No model weights are trained. Every decision is traced with [Judgment](https://judgmentlabs.ai). Traces are the agent's experience, and judges are its reward signal.

## Where to read
The repo is an Obsidian vault; open the root folder as a vault.
- [Architecture overview](brain/architecture/overview.md)
- [Brain index](brain/index.md): every research and architecture note

## Status
Architecture mostly settled; no code yet. First milestone: join any server and follow instructions given from outside. See the [roadmap](brain/roadmap.md).
