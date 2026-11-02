---
date: 2026-10-12
tags: [task, infrastructure, deployment, visualization]
status: active
progress: done
---
# Task: Jeeve live at a URL

**Done 2026-11-02** → [[deployment]]: three Jeeves on a GCP VM at `https://35.197.6.238.sslip.io`, watched publicly and steered by Joshua.

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/live-deployment.md`."

## Why
The brain monitor ([[brain-monitor]]) shows what Jeeve is doing and thinking, but only on this laptop. Joshua wants:
- **a URL** where anyone can watch Jeeve play live, with its reasoning alongside;
- **a box only he can use** to give Jeeve high-level goals.

This is also the roadmap's "online infrastructure" step. It comes before stage 4 and the benchmarks, so that scenarios run on real infrastructure ([[roadmap]] → "Order after the current work").

## Decisions (Joshua, 2026-10-12)
- **Watching is public; prompting is Joshua only.** The goal box sits behind auth. No strangers' prompts, so no prompt injection from viewers, and model spend stays under his control. A public queue ("Twitch plays Jeeve") is a later, separate task.
- **The game view is a browser 3D view:** prismarine-viewer renders the bot's world live in the viewer's browser from game data. No game client, GPU or video encoding. The brain-monitor work already uses prismarine-viewer: its GitHub master supports 26.1, while npm stops at 1.21.4 ([[brain-monitor]]).
- **Hosting is one GCP Compute Engine VM** running Docker Compose, with Caddy for HTTPS.

## The page
```
┌──────────────────────────────────────────────┐
│ caption · goal path · health                 │
│ ┌───────────────┐ ┌────────────────────────┐ │
│ │ live 3D view  │ │ System 2 · builder ·   │ │  the existing monitor panels
│ │ of Jeeve      │ │ System 1 · running code│ │  (from the agent's /events stream)
│ └───────────────┘ └────────────────────────┘ │
│ [ give Jeeve a goal…                 ] [Send]│  only when Joshua is signed in
└──────────────────────────────────────────────┘
```
It should also have a short "what am I looking at" explainer for visitors, and a history of recent goals and their outcomes.

## Architecture
```
browser ── HTTPS ── Caddy (domain, TLS)
                      │
          ┌───────────┴──── one VM, Docker Compose ─────────────┐
          │ web    monitor UI + live 3D view + API proxy (auth)  │
          │ agent  Jeeve: Jev, Claude (2A), builder (2B)         │──► Judgment traces
          │ paper  Minecraft server, world on a persistent disk  │
          └──────────────────────────────────────────────────────┘
```
- **The agent's local API** (`/instructions`, `/status`, `/events`, `/marker`) binds to `127.0.0.1` today. Keep it private. The web service proxies:
  - `/events` publicly, read-only, after filtering out anything that shouldn't be public;
  - `/instructions` behind auth.
- **The live 3D view:** decide whether it comes from the bot's own connection (a prismarine-viewer server on the agent) or from a separate viewer that reads world data. It has to handle many viewers without loading the bot.
- **Persistent disk:** the world, `modules/library.json`, `traces/`, and bench and clip outputs if the bench runs there too.
- **Secrets:** Jev, Anthropic and Judgment keys on the VM (GCP Secret Manager or an env file on the VM), never in the image or the repo. The repo is public.
- **The Minecraft port** (25565) stays closed, or open only to Joshua's IP so he can join in his client. Viewers watch through the page.

## Read first
- [[brain-monitor]]: the monitor app (`viz/`), the `/events` stream, the timeline core, prismarine-viewer rendering
- [[system-2]] and [[orchestrator-and-builder]]: how an instruction becomes the root goal; 2A and 2B
- [[trace-schema]]: what's in the stream, and what must not be public
- [[layers]]: "assume no server privileges", and fairness on public servers (deferred)
- Code: `src/main.ts` (local API, `JEEVE_*` env vars), `scripts/server.ts` (Paper setup, Java 25, the 26.1.2 jar), `viz/`

## Questions to answer
1. **Auth for the goal box.** Simplest is a long secret token or password. Alternatives: Google login through an identity-aware proxy, or Cloudflare Access. Pick the lightest option that's safe on a public URL.
2. **What's public in the stream.** Filter out:
   - API keys and anything secret;
   - player names other than Jeeve and Joshua;
   - raw prompts if they're too large.

   Decide whether System 2's full reasoning text is shown, or only its notes.
3. **Idle and cost.** With no goal, does Jeeve idle cheaply (no Claude calls, a slow Jev heartbeat)? Set a model-spend cap per hour and per day, with a visible "paused: budget" state.
4. **Judgment project.** Public traces go to a **production** Judgment project made for Jeeve, not staging ([[trace-schema]]). Confirm with Joshua which org and project.
5. **VM size and region.** Paper (about 2 GB heap) plus the agent plus the web service. Start around 4 vCPU and 16 GB, and measure. Choose a region close to the model APIs and to viewers.
6. **Domain.** Which domain or subdomain, and DNS. Ask Joshua.
7. **Operations.** Restart policies, log rotation, how to deploy a new version (pull and rebuild), backups of the world and library.

## Safety (outward-facing, so confirm first)
Creating GCP resources, copying API keys to a VM, opening ports and pointing DNS are all visible outside this machine. **Write the full deployment plan and get Joshua's yes** before any of it: what runs where, which keys go where, what's public, and the estimated monthly cost.

## Coordination
- **Builds on the `brain-monitor` branch** (`viz/`, `/events`, the timeline core). If it isn't merged into `main` yet, branch from `brain-monitor`.
- A `defend-fixes` follow-up (slime tracking) and the `curate` branch (2B's offline curation) may land on `main` meanwhile. Rebase onto `main` before finishing.
- Keep running locally first: the same Docker Compose setup should work on Joshua's Mac before it goes to GCP.

## Done when
- `docker compose up` on the Mac serves the page locally, with the live 3D view, the panels, and a working authenticated goal box.
- After Joshua approves the plan, the same setup runs on a GCP VM at an HTTPS URL. Joshua can give a goal and watch Jeeve carry it out, with the panels updating live.
- The idle mode and spend cap work. Traces go to the agreed Judgment project.
- An architecture note (e.g. `brain/architecture/deployment.md`) records the setup, auth, what's public, costs, and how to deploy and roll back. [[roadmap]] and the index are updated, and this task's `progress` is `done`.
