# Jeeve: Minecraft agent

A general Minecraft agent. Give it any objective, whether that's building a house, winning a Bed Wars match or beating the game, and it should get better through experience, without us writing Minecraft strategy into it.

## The idea
The design follows [the bitter lesson](brain/research/bitter-lesson.md): build in **methods for discovering knowledge**, not the knowledge itself.

- **We build** general machinery: an interface to the world, a shape for thinking (goal hierarchy, time at several scales, fast and slow decisions), outcome signals, and a record of experience.
- **The agent discovers** plans (search), skills, world knowledge and fast reactions (learning).

```
act ──► record (traces) ──► evaluate (outcomes, judges) ──► distill (skills, memory, fast reactions) ──► act better
```

Slow thinking (a reasoning model) searches. Fast thinking (a small decision model) learns to imitate slow thinking's good decisions. Every decision is traced with [Judgment](https://judgmentlabs.ai). Traces are the agent's experience, and judges are its reward signal.

## Where to read
The repo is an Obsidian vault; open the root folder as a vault.
- [Architecture overview](brain/architecture/overview.md)
- [Brain index](brain/index.md): every research and architecture note

## Status
Research and high-level architecture. No code yet.
