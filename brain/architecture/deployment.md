---
date: 2026-11-02
tags: [architecture, infrastructure, deployment]
status: active
---
# Deployment: Jeeve live at a URL

Three Jeeves on one persistent Minecraft server, which anyone can watch from a public page and only Joshua can steer. This note is the outcome of [[live-deployment]]. The steps for deploying, updating and rolling back are in `deploy/README.md`; this note keeps the why.

```
browser ── HTTPS ── caddy ─┬─ /            spectate page (viz/spectate.html), static
  (public)                 └─ /api/*  ──── web relay (web/server.ts) ──┬── jeeve-1 :7777 ─┐
                              POST needs basic auth                    ├── jeeve-2 :7777 ─┼── paper :25565 ── Tailscale ── Joshua's client
                                                                       └── jeeve-3 :7777 ─┘
                                                     one VM, Docker Compose (docker-compose.yml)          Judgment prod traces ◄── each Jeeve
```

## Where it runs
- **One GCP VM:** `jeeve` in project `jeeve-513410`, e2-standard-4 (4 vCPU, 16 GB), us-west1-b, Debian 12, static IP `35.197.6.238`. `deploy/setup.sh` sets it up and is safe to re-run.
- **The same compose file runs on the Mac** (`SITE_ADDRESS=localhost`, Caddy's local CA) and on the VM (`SITE_ADDRESS=35.197.6.238.sslip.io`, Let's Encrypt). sslip.io stands in for a domain, so there's no DNS to manage.
- **Secrets** live in `/opt/jeeve/.env` (mode 600, root), never in the image or the public repo.

## What's public, what's locked
- **Watching is public.** The relay keeps one `/events` and one `/world` upstream per Jeeve and replays them to each viewer, so the number of viewers never reaches a bot. A god feed merges every Jeeve's world.
- **The public stream is filtered** (`web/public-row.ts`): it drops the raw snapshot and Jev's input from decide rows, and 2A's full input and SQL from system2 rows, and caps every string. Player names stay (Joshua: "Show them").
- **Steering is Joshua's.** Every POST to `/api/*` (goal box, wake, sleep) needs Caddy basic auth. A POST that isn't JSON gets a 403, so another site's form can't ride the browser's cached password.
- **Minecraft (25565) is off the internet.** Paper runs in offline mode with a whitelist; only the tailnet reaches 25565, so a faked name can't get in. The GCP firewall opens only 80/443, and 22 from IAP.

## Idle and spend
- **Jeeves start asleep** (`JEEVE_START_ASLEEP`): no model calls at any tier until woken from the page or by whisper. A restart (crash, VM reboot) puts them back to sleep, since spend is kept in memory.
- **Caps per Jeeve:** $10 an hour and $50 a day (`src/budget.ts`); going over puts it to sleep with reason "budget". The Anthropic workspace limit is the hard cap.
- **Traces** go to production Judgment, project `jeeve-test`, with environment `production`.

## Measured (2026-11-02, three Jeeves awake for 28 minutes, Joshua playing)
- **Spend:** about $11.70, or about $25 an hour for three awake Jeeves. 2A (Opus 5.5) was $9.54 of it over 208 calls; 2B $1.83 over 16 calls; Jev $0.31 over 5,632 decisions.
- **Latency:** Jev p50 82 ms, p99 782 ms. 2A p50 6.5 s, p99 40 s.
- **CPU and RAM:** each Jeeve ~35–40% CPU on average (peaks past 100%) and ~250–310 MB; Paper ~20% CPU and 3.9 GB; relay ~3% and ~250 MB; Caddy ~1%. 4.4 of 16 GB in use, so CPU, not memory, limits how many Jeeves fit.
- **An asleep Jeeve still uses ~40% CPU:** its world observation keeps running with no model calls. That's the first thing to cut before adding Jeeves.
- **20 viewers** (40 streams) all connected. A viewer stream closes whenever its Jeeve's upstream reconnects (a Jeeve restarts while Paper boots); the page reconnects.

## Operations
- **Deploy or update:** pipe `deploy/setup.sh` to the VM over IAP ssh. It pulls `main` and rebuilds. Containers restart `unless-stopped`; logs rotate at 3 × 10 MB; traces older than 7 days are deleted by cron.
- **What the Jeeves learn** is written to the checkout's `modules/` on the VM. Diff it out before an update and stash it across the pull (`deploy/README.md`).
- **Rollback** is a checkout of the previous commit and a re-run of setup.

## Open
- An asleep Jeeve's CPU, above, and the dev traces an asleep Jeeve on the Mac still writes.
- 2A can't read links or images yet (draft PR JJwilkin/jeeve#12).
- No world backup beyond the VM disk.
