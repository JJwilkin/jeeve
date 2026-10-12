---
date: 2026-10-12
tags: [task, tracing, visualization, distribution]
status: active
progress: todo
---
# Task: brain monitor and clip pipeline

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/brain-monitor-and-clips.md`."

## Why
Jeeve is going to be shared publicly as short video clips (the launch plan: [Jeeve Launch Plan](https://claude.ai/artifact/1CQco89A6nFXkb7aUeUW63)). A clip of a bot walking around says nothing. What makes Jeeve interesting is invisible: the fast and slow systems deciding, messages passing between them, and code the builder writes and runs. This task makes that visible, live and in rendered clips, from data the traces already record.

## Goal
One visual, three uses:
1. **Live monitor:** a web page that shows the systems' state while Jeeve plays. Use it to debug, and as an OBS browser source.
2. **Rendered clips:** recorded game footage plus the panels, rendered with **Remotion** from the trace file, frame-synced. Joshua chose Remotion (2026-10-12): this is a personal project, so its license is fine.
3. **One command per clip:** `npm run clip <scenario>` sets up a scene, records it and renders a finished mp4.

## The layout (16:9; a 9:16 variant stacks it)
```
┌──────────────────────────────────────────────────────────────┐
│ caption: what's happening, in plain words          ⏩ 8×     │
├────────────────────────────────────┬─────────────────────────┤
│                                    │ SYSTEM 2 · orchestrator │  status, latest note, guidance changes
│         Minecraft view             │      │ request ▼        │
│   (Jeeve, third person or POV)     │ BUILDER (2B)            │  request, trial n of 4, current draft
│                                    │ ┌ code ─────────────┐   │  the line running now highlighted,
│                                    │ │ await api.place…  │   │  ✓/✗ as each call returns
│                                    │ └───────────────────┘   │
│                                    │      ▲ escalation       │
│                                    │ SYSTEM 1 · Jev  188 ms  │  trigger, choice per question with
│                                    │ legs navigate ▓▓▓▓░ .82 │  probability bars, latency
└────────────────────────────────────┴─────────────────────────┘
```
- **Messages** are animated arrows between the cards:
  - escalations go up from System 1;
  - guidance comes down from System 2;
  - capability requests and results travel between 2A and 2B;
  - trial windows open;
  - guard vetoes flash.
- **Health and the goal path** appear somewhere compact.
- **The caption** says what's happening in words a viewer understands ("Josh asks it to break the leaves, which it can't reach. System 2 asks the builder for a pillaring skill.").

## Read first
- [[trace-schema]]: span kinds, `jeeve.*` attributes, windows, `traces/<session>.jsonl` (the local mirror of every span)
- [[orchestrator-and-builder]]: 2A, 2B, requests, trial windows, the builder trace
- [[behaviors-and-guards]]: authored behaviors, the action API, trials and action logs
- [[system-1]] (what a `decide` span holds) and [[system-2]] (what a `system2` span holds)
- Code: `src/trace.ts` (recorder, `jsonl`), `src/main.ts` (local API on `JEEVE_API_PORT`, escalate, trials), `src/builder.ts`, `src/behaviors.ts`, `scripts/e2e.ts` (scenario setup to reuse)

## Gaps to fill in the traces
Most of the data exists already: `decide`, `system2`, `perceive`, `goal`, `request`, `trial`, `builder`, `behavior_start`/`behavior_end`, vetoes, and damage with its source. Add:
1. **Each authored-behavior API call, timestamped:** `{t, run_id, call, ok, out}` as it happens. Today the action log only arrives at the end of a run, in `behavior_end.detail`. Put these in the JSONL as rows, not one span per call, to keep span volume down. That's enough to highlight the running line.
2. **The builder's intermediate steps** mirrored into the JSONL: each draft's code and each tool call. Today they reach Judgment only, through AI SDK OpenTelemetry spans.
3. **Started events** for System 2 and builder calls, so "thinking…" can show live. Replay can work it out from the latency.
4. **"Escalation sent"** as its own row. Suppressed escalations are already rows.
5. **Clock sync** between a recording and the trace: record when recording starts (OBS websocket) or write a marker row at clip start.

Update [[trace-schema]] for every new row.

## Building blocks
1. **Timeline core:** a pure function from trace rows to "the state of every panel at time *t*", plus the message events around *t*. Small and testable, with one self-check.
2. **Monitor app:**
   - **live mode** streams from the agent (e.g. a server-sent events endpoint on the existing local API);
   - **replay mode** loads a trace file and has a time slider.
   - Keep it in its own folder with its own `package.json` (e.g. `viz/`), so the agent's runtime doesn't take on UI dependencies.
3. **Remotion composition:**
   - the recorded footage on the left, the same panel components on the right, the caption on top;
   - **speed-ups** for stretches where nothing changes on screen (e.g. the builder thinking for 2 minutes), with a badge;
   - **captions** written after the fact by Claude from each trace segment, with templates as a fallback;
   - outputs at 16:9 and 9:16.
4. **`npm run clip <scenario>`:**
   - reuse the e2e's scene setup (tree, chest, slimes);
   - start the agent and give the instruction;
   - start and stop OBS recording at the goal's start and `done` events through OBS's websocket;
   - render the clip.

   Joshua records with his own Minecraft client in spectator mode (`/spectate Jeeve`) or a third-person camera.

## Questions to answer
- **Camera.** Spectator POV, third person, or switching? Can a scripted camera follow Jeeve, or is it manual for now?
- **Live transport.** Server-sent events from the local API, or tail the JSONL file?
- **Speed-up rules.** What counts as dull, and how fast to go?
- **Captions.** How much to write per segment, the tone, and how to keep them accurate to the trace.
- **The authored code.** How to show long behaviors readably (scroll to the running line, collapse the rest).

## First clip
**"It wrote itself a skill"**: the out-of-reach canopy. Jeeve gets stuck, 2A requests a skill, 2B drafts and trials a pillaring behavior, the trial passes, and Jeeve climbs and clears the leaves. It's the one moment that shows all three systems talking.

## Done when
- The five trace gaps are filled, [[trace-schema]] is updated, and `npm run check`, `npm run typecheck` and `npm run e2e` still pass. E2e runs can run in parallel with `JEEVE_PORT`.
- The monitor works live next to a running agent, and as an OBS browser source.
- The canopy clip is rendered from a real run, at 16:9 and 9:16, with synced panels, speed-ups and captions.
- `npm run clip <scenario>` produces it end to end, apart from the camera, if that has to stay manual.
- An architecture note (e.g. `brain/architecture/brain-monitor.md`) records the design. [[roadmap]] and the index are updated, and this task's `progress` is `done`.
