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
- System 2 looks at the world with `scan` and `reachable` ([perception](brain/architecture/perception.md));
- when no behavior fits, System 2 (the orchestrator, 2A) asks a builder (2B, on the Vercel AI SDK) for one, with a pass check of its own. 2B writes, trials and saves it on an API with every player action Mineflayer has (e.g. pillaring to reach a canopy, crafting a pickaxe from logs, filling a chest), while 2A keeps playing ([orchestrator and builder](brain/architecture/orchestrator-and-builder.md), [behaviors and guards](brain/architecture/behaviors-and-guards.md)). `JEEVE_BUILDER_MODEL` picks 2B's model;
- between episodes, `npm run curate` has 2B propose which library behaviors to keep, retire or merge, and lessons citing trace ids, for a person to review;
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
npm run curate       # between episodes: 2B proposes library changes and lessons from recent traces
```
The first server start needs `MINECRAFT_EULA=true` to accept the [Minecraft EULA](https://aka.ms/MinecraftEULA).

**Several Jeeves on one server** (the live setup, the same on the Mac and the VM): `docker-compose.yml` runs Paper 26.1.2 (offline mode, whitelist in `paper/whitelist.json`) and `Jeeve_1..3`, one container each. Secrets come from `JEEVE_ENV_FILE` (default `.env`) at run time, never the image.
```bash
MINECRAFT_EULA=true JEEVE_ENV_FILE=../judgment/.env.jeeve docker compose up --build
```

**The spectate page** comes up with the same command: `caddy` serves the built `viz/` on 80 and 443 and proxies `/api/*` to the `web` relay. Anyone can watch; every POST (goal box, wake, sleep) needs basic auth as user `joshua`. Two variables, from the shell or a `.env` next to `docker-compose.yml`:
- `JEEVE_BASIC_AUTH_HASH`: a bcrypt hash of the password. Without it Caddy refuses to start. In a `.env` file, single-quote it, or compose reads its `$`s as variables.
- `SITE_ADDRESS`: `localhost` (the default) or `<ip>.sslip.io` on the VM.
```bash
read -rs PW && export JEEVE_BASIC_AUTH_HASH="$(printf '%s\n' "$PW" | docker run --rm -i caddy:2.11.7-alpine caddy hash-password)" && unset PW
```
Then open `https://localhost`. The Jeeves start asleep; wake one from the page (the browser asks for the password), and put it back to sleep when done. The first build of the page takes about 15 minutes on Apple Silicon (an emulated amd64 `npm ci`); later builds reuse it. On `localhost` Caddy signs with its own local CA, which it can't add to the Mac's trust store from inside a container, so the browser warns once. To trust it instead: `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .` and add that to Keychain Access.

**Modules System 2 writes** persist in `modules/library.json`. Runs update it and never commit it; review the diff and commit the modules worth keeping. `npm run curate` (`-- --days 7 --sessions '<glob>,…' --library <file>`; label episodes with `JEEVE_CONTEXT`, e.g. `pvp-arena`, to curate per use case) writes a proposal to `curation/<time>/`: `review.md`, `lessons.md` and `library.diff` (apply with `git apply`). It applies nothing.

**Instructions from outside the game** go to the agent's local API, bound to 127.0.0.1:
```bash
curl -s localhost:7777/instructions -d '{"from":"operator","text":"come here"}'
```
```bash
curl -s localhost:7777/status
```
