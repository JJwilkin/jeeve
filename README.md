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
The first milestone runs end to end on a local server:
- System 1 decides on Jev, over the seed behaviors and both guard layers;
- System 2 on Claude turns instructions into goals with success checks and tunes System 1's program;
- every episode is traced to Judgment.

See the [roadmap](brain/roadmap.md).

## Run it
**Requirements:**
- Node ≥ 22.18;
- Java 25 (`brew install openjdk@25`);
- the Paper 26.1.2 jar (build 74, from [fill.papermc.io](https://fill.papermc.io/v3/projects/paper/versions/26.1.2/builds/74)) in `.server/`;
- credentials in `../judgment/.env.jeeve`: `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`, and `JUDGMENT_API_KEY` / `JUDGMENT_ORG_ID` / `JUDGMENT_API_URL` (staging, project `jeeve-dev`).

  Without Anthropic, System 2 is off; without Judgment, traces go only to `traces/*.jsonl`.

```bash
npm install
npm run check        # offline self-check
npm run e2e          # local server + agent + a scripted player; real Jev, Claude and Judgment staging
JEEVE_PORT=25566 npm run e2e   # a parallel run: own port, own world in .server/runs/<port>/ (about 20 min)
npm run server       # just the server (type console commands into it)
JEEVE_ALLOWED=YourName npm run agent   # the agent; whisper it instructions in game
```
The first server start needs `MINECRAFT_EULA=true` to accept the [Minecraft EULA](https://aka.ms/MinecraftEULA).

**Modules System 2 writes** persist in `modules/library.json`. Runs update it and never commit it; review the diff and commit the modules worth keeping.

**Instructions from outside the game** go to the agent's local API, bound to 127.0.0.1:
```bash
curl -s localhost:7777/instructions -d '{"from":"operator","text":"come here"}'
```
```bash
curl -s localhost:7777/status
```
