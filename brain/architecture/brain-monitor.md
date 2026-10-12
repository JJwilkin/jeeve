---
date: 2026-10-12
tags: [architecture, tracing, visualization, distribution]
status: active
---
# The brain monitor and clip pipeline

One visual of Jeeve's three systems working, from the trace alone: live next to a running agent, and rendered as clips over recorded game footage. This note is the outcome of [[brain-monitor-and-clips]]. It reads the rows [[trace-schema]] describes; it adds no state of its own.

```
┌──────────────────────────────────────────────────────────────┐
│ caption: what's happening, in plain words          ⏩ 8×     │
├────────────────────────────────────┬─────────────────────────┤
│                                    │ SYSTEM 2 · orchestrator │
│         Minecraft view             │ ▲ ▼ messages on a lane  │
│                                    │ BUILDER · 2B  + code    │
├────────────────────────────────────┤                         │
│ goal path · health · channels      │ SYSTEM 1 · Jev          │
│ last messages                      │                         │
└────────────────────────────────────┴─────────────────────────┘
```
1920×1080 (`wide`), and 1080×1920 (`tall`), which stacks the same parts: caption, game, strip, cards.

## Parts
Everything visual lives in `viz/`, its own package, so the agent's runtime takes no UI dependencies (React, Vite, Remotion).

| Part | Where | What |
|---|---|---|
| **Timeline core** | `viz/src/timeline.ts` | Pure functions over trace rows: `stateAt(rows, t)` (every panel's state), `messages` (the arrows), `beats` (caption moments with their facts), `activity` and `speedups` (the time map for clips). Self-check: `npm run check` in `viz/` |
| **Stage** | `viz/src/Stage.tsx` | The panels as React components at fixed pixel sizes. The monitor scales the stage to its window; Remotion renders it as is |
| **Monitor** | `viz/src/monitor/main.tsx` | `npm run monitor` in `viz/` (Vite, port 5288). Live from the agent's `GET /events`, or a replay of a JSONL with a time slider |
| **Clip render** | `viz/src/remotion/index.tsx` | Remotion compositions `wide` and `tall`. A clip directory is Remotion's public dir |
| **Clip command** | `scripts/clip.ts` | `npm run clip <scenario>`: scene, agent, OBS recording, captions, both renders |
| **Scenes** | `scripts/scenes.ts` | World setups the e2e and the clips share (the canopy so far) |

## Decisions (with Joshua, 2026-10-12)
- **Remotion** for rendering: a personal project, so its license is fine.
- **Live transport: server-sent events on the agent's local API.** `GET /events` on `JEEVE_API_PORT` replays the session's rows, then streams each new one as the recorder writes it (`Recorder.listeners`). No extra process, and it works for `npm run agent`, the e2e and clips. Each reconnect replays from the first row, so the monitor replaces what it had.
- **Camera: a scripted wide shot.** Each clip scenario names a vantage point. `npm run clip` puts Joshua's client (`JEEVE_CAMERA`, any name: the server is offline-mode) in spectator mode there with `tp … facing …`. It doesn't move after that. A follow cam would judder at tick-rate teleports.
- **Speed-ups: squash dull stretches to about 2 s.** A stretch is dull when no visible change happens for at least 6 s (with 1 s margins at 1×), and only if it plays at 2× or faster. A visible change is any trace row except heartbeat `decide` calls that changed nothing while the bot stayed within 0.3 blocks, and bookkeeping rows (window cuts, carry-overs, perceive, suppressed escalations, markers). The badge shows the rate (`⏩ 27×`). Knobs: `SPEEDUP` in the timeline core.
- **Captions: plain, one per beat, editable.** Beats come from the trace: instruction, request, each draft, trial window, trial result, pre-emption, a stuck escalation, the goal closing. Each has a template and the facts it may use. `npm run clip` asks Claude (System 2's model) to rewrite the templates from the facts only: at most 14 words, no jargon. It falls back to the templates if Claude is unavailable. The result is `captions.json` in the clip directory. Edit it and re-render with `npm run clip -- --render <dir>`. Each caption stays up at least 2.5 s (`CAPTION_MIN_MS`), so beats in the same second read in sequence. Jev's own doubts (`low_confidence`, `jev_escalate`) get no caption: they come every few seconds.
- **Long authored code:** the code box shows a window of lines that keeps the running line a third of the way down. The line is highlighted with ▶, and lines whose calls returned show ✓ or ✗. The call in flight is printed under the box.

## What each panel reads
| Panel | Rows |
|---|---|
| System 2 | `start` (name `system2`) until its `system2` row → "thinking… n s"; the latest decision `note`; guidance from the latest activated `program` (highlighted for 4 s after a change) |
| Builder | the latest `request`; status from `start` (name `builder`), `builder_tool` `write_behavior` start/end, `trial_window` / `trial_preempted` events, `trial` and `builder` rows; "trial n of 4"; the model's latest text from `builder_step` |
| Code | an authored run on the body (a `behavior_start` whose name has code from a draft or a `module` row), else the latest draft. `api_call` rows give the running line and the ✓/✗ marks |
| System 1 | the latest `decide`: trigger, latency, each question's choice and confidence, the escalate probability; a `vetoed` event flashes the card for 1.5 s |
| Strip | goal path from `goal` rows, health from the latest `decide`'s raw snapshot, channel holders from `behavior_start`/`behavior_end`, the last four messages |
| Arrows | player → System 2 (a root goal pushed with a sender); System 1 → System 2 (`escalation_sent`); System 2 → System 1 (a program System 2 caused); System 2 → builder (`request`); builder → System 1 (`trial_window`: it takes the body); System 1 → builder (`trial_preempted`); builder → System 2 (`capability_result`); System 2 → player (a decision's message) |

## Clips
`npm run clip canopy`:
1. Starts the Paper server on `JEEVE_PORT`, the agent with an empty scratch library (so the builder has to write the skill), and a scripted "Josh" who gives the instruction, as in the e2e.
2. Sets up the scene, then waits for `JEEVE_CAMERA` to join and places that player.
3. Starts OBS recording through its websocket (v5, `OBS_URL`, `OBS_PASSWORD`; a small client on Node's own `WebSocket`, no dependency). When OBS reports the output started, it writes a `marker` row (`record_start`): footage time 0 is that row's `t`.
4. Whispers the instruction and waits for the goal to complete or fail (10 min at most), plus 3 s.
5. Stops recording and remuxes OBS's file to `footage.mp4`.
6. Writes `clips/<scenario>-<time>/clip.json` (the slimmed rows up to the end, the clip's span from 1.5 s before the instruction, the recording start) and `captions.json`.
7. Renders `clip-16x9.mp4` and `clip-9x16.mp4`.

`--no-record` skips OBS and renders the panels over a "no footage" box. In the render, the footage is cut into the same segments as the speed-up map: each segment is an `OffthreadVideo` with its own `trimBefore` and `playbackRate`, so the game and the panels stay frame-synced through every speed-up.

**Client-look footage without a client** (2026-10-12): `node viz/src/world-video.ts clips/<dir>` draws the recorded world (`world.jsonl`) with [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer): real block models, textures, and mob models with walk cycles.
- It renders headless (node-canvas-webgl) to `world.mp4` at 30 fps in trace time, then points `clip.json`'s `footage` at it, so the clip cuts and speeds it up exactly like OBS footage.
- It takes about 26 s for a 166 s run.
- Both packages are pinned to GitHub commits in `viz/package.json`. Master supports 26.1, while npm's 1.33.0 stops at 1.21.4. `npm install` builds the textures, which takes about 6 min. No Mojang assets are committed.
- Around the recorded box it adds a plains biome (without it, grass and oak leaves render brown), a grass apron and dirt underneath, plus a sky colour and fog.
- Name tags are off: the viewer draws them as small black text.
- The viewer's own zombie and husk models render as a crumpled head, so they're drawn as players wearing the zombie skin with arms out. The skin is cropped to the old 64×32 layout so the viewer mirrors the blank left limbs. Check new mob types on a still before trusting them; slimes are fine.
- Without `world.mp4`, clips fall back to the flat-colour three.js scene (`viz/src/WorldScene.tsx`).

## First clips (2026-10-12)
- **Without footage** (`--no-record`): `clips/canopy-2026-10-12T05-13-52-548Z/`. 2B's first trial got `stuck`, its second passed. The 210 s run renders to 104 s.
- **Recorded from Joshua's client** (OBS 32.2, window capture, `JEEVE_CAMERA=JoshBGosh321`): `clips/canopy-2026-10-12T05-33-04-716Z/`. 2B's `fell_whole_tree@1` failed its first trial (`none_found`) and passed its second, and the goal completed after 168 s. The panels and footage stay in sync through the speed-ups; the 173 s run renders to 86 s.
- **Lesson: OBS window capture goes black when the window is left.** About 20 s of that footage is black, from switching apps mid-run. For takes: Minecraft fullscreen (F11) with an OBS **Display Capture** source (no window title bar or letterbox), F1 to hide the HUD, and don't switch away until the script says the goal closed. Recordings land in `~/Movies` and are remuxed into the clip directory.

## Open questions
- **The spectator camera may be visible to Jeeve.** Mineflayer can list a spectating player as an entity, so Jev's state may mention it. It hasn't mattered for the canopy. If it does, the encoder could drop spectators.
- **More scenes.** Only the canopy is in `scripts/scenes.ts`. The chest, the craft and the slime fight move there when a clip needs them.
- **Captions for long, quiet stretches** (the builder thinking for minutes) say only what the beat said. Showing the builder's own text (`builder_step`) as a sub-caption could fill them.
