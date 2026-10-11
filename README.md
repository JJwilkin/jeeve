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
Architecture mostly settled. A first runtime slice runs: System 1 on Jev, seed behaviors on channels, instructions by whisper, decisions traced to `traces/*.jsonl`. No System 2 or Judgment ingest yet. See the [roadmap](brain/roadmap.md).

## Run it
Needs Node ≥ 22.18, Java 21 (`brew install openjdk@21`), the Paper 1.21.4 jar in `.server/`, and `TYPESAFE_API_KEY` in `../judgment/.env.typesafe`.
```bash
npm install
npm run check        # offline self-check
npm run e2e          # local server + agent + a scripted player: "come here", "follow me and defend me"
npm run server       # just the server (type console commands into it)
JEEVE_ALLOWED=YourName npm run agent   # the agent; whisper it instructions in game
```
The first server start needs `MINECRAFT_EULA=true` to accept the [Minecraft EULA](https://aka.ms/MinecraftEULA).
