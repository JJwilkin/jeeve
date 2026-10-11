---
date: 2026-10-11
tags: [task, system-2, architecture, harness]
status: active
progress: todo
---
# Task: split System 2 into an orchestrator (2A) and a builder (2B)

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/system-2a-2b.md`."

## Why
Today one System 2 does everything ([[system-2]]): it keeps the goal tree, rewrites Jev's guidance, handles escalations, *and* writes, trials and fixes new behaviors ([[behaviors-and-guards]] → "How it's built"). That causes three problems:
- **Slowness.** Writing a behavior plus 2–3 trial rounds takes a minute or more. Meanwhile the same System 2 is the one that should be reacting to the game.
- **Behaviors grade themselves.** A trial can pass on the behavior's own `done` claim unless System 2 remembered a `pass_when` check. In one e2e run a behavior returned `done` after clearing 9 of 27 leaves.
- **Prompt injection.** An allowlisted player's raw text steers the code that gets written.

## The split (agreed with Joshua, 2026-10-11)
| | **2A: orchestrator** | **2B: builder** |
|---|---|---|
| Job | Game state, the goal tree, Jev's guidance, handling escalations | Writing, trialling and fixing behaviors and modules; reviewing traces between episodes |
| Speed | Responsive: seconds | Can take minutes, at higher effort |
| Context | Small: the goal path, recent events | Large: the action API, trial logs, the library |
| Writes | Goals and guidance. It stays the **only writer of commitments** ([[system-2]]) | Library entries only (behaviors, modules). It *proposes* guidance; 2A decides |

**How they talk:**
1. 2A spots a gap and sends 2B a **capability request**: what's needed, constraints, and a **required** pass check that 2A writes, not 2B.
2. 2A keeps playing meanwhile: it tells the player "working on it", keeps Jev safe, or works on other parts of the goal.
3. When 2B needs the body for a live trial, it asks. 2A grants a **trial window** when it's safe.
4. 2B returns a registered behavior, or a failure report with evidence.

Between episodes, 2B runs the cross-episode loop: curating the library, retiring broken behaviors, and mining traces for lessons ([[learning]]; the roadmap's "lessons that outlive their goal").

## Harness (decided 2026-10-11)
- **2A keeps the current custom loop** (`src/system2.ts`: the Anthropic SDK directly, at most 4 turns, event-driven and stateless). Its calls are seconds-scale, and a framework would add little.
- **2B runs on the Vercel AI SDK.** Its loop is narrow: write → request a trial → read the evidence → fix. The sandbox, trial and library already exist. The AI SDK gives:
  - any model provider, so models can be compared for 2B;
  - judgeval tracing through OpenTelemetry (`Tracer.getOTELTracer()`), the same path Luna uses.
- **Not chosen:**
  - **Claude Agent SDK:** a general coding-agent loop (files, shell, compaction) that 2B doesn't need yet. Claude only. No judgeval-js integration.
  - **OpenAI Agents SDK:** OpenAI-first, no judgeval-js integration, and a third way of calling models.
- **Luna later.** Luna is the AI SDK plus durable runs, a native waiting state (fits "wait for a trial window"), built-in judgeval tracing and an HTTP service. It's the better long-term fit. But its packages are private (Judgment's AWS CodeArtifact) and this repo is public, so it's deferred. Build 2B on the AI SDK so that porting to Luna is mechanical.

## Read first
- [[system-2]]: the current loop, tools, `MAX_TURNS`, escalations, the no-repeat window, decisions to review
- [[behaviors-and-guards]] → "How it's built": `write_behavior`, the action API, sandbox, trial and `pass_when`, library
- [[system-1]]: the module pipeline and library, and how a registered behavior reaches Jev
- [[learning]]: the inner and outer loops, agentic search over traces
- [[trace-schema]]: span kinds; 2B needs its own spans and a link to the 2A request that started it
- Evidence: [[realtime-game-agents]] (named slow/fast patterns, clean-context sub-calls), [[project-sid]] (concurrent modules with one decision-maker)
- Code: `src/system2.ts`, `src/main.ts` (`escalate`, `wakeSystem2`, trials), `src/behaviors.ts`, `src/modules.ts`

## Questions to answer
1. **The request format.** The fields of a capability request (need, constraints, pass check, priority, the goal it serves), the result format (registered name and version, or a failure report), and cancelling a request when its goal closes.
2. **Sharing the body.** How 2B asks for a trial window, how 2A decides it's safe (no threat nearby, no conflicting goal), how a window is pre-empted when a threat appears, and what Jev does during it.
3. **Concurrency.** How many requests can be in flight? How are they queued and prioritized? Does 2B run in the agent's process or as a separate process?
4. **Who writes what.** 2A stays the only writer of goals and guidance. Does 2B ever write guidance directly, or only propose it? Where do proposals go?
5. **Prompt injection.** 2B works from 2A's structured request, never the player's raw text. Say what this protects against and what it doesn't.
6. **The between-episode loop.** What 2B does when no episode is running: library curation, retiring behaviors, trace mining. What triggers it, and where its output goes.
7. **Tracing.** 2B's spans: a session or trace of its own, linked to 2A's request span and to the trial's behavior spans. Update [[trace-schema]].
8. **Model and effort.** Which model and effort level for 2A and 2B. The AI SDK makes 2B's model a config value, so compare at least two.

## Coordination
- [[full-player-action-api]] widens what 2B can write. Nothing here should assume today's narrow API. If both are active, agree the request format first.
- E2e runs can run in parallel on separate ports: `JEEVE_PORT=25566 npm run e2e`.

## Done when
- [[system-2]] (or a new architecture note) records the split, the request and result formats, trial windows, concurrency, the between-episode loop, the harness decision and tracing.
- In the e2e, an instruction that needs a new behavior shows the split working:
  - 2A answers within seconds ("working on it") and keeps handling a threat summoned mid-build;
  - 2B writes and trials the behavior in a window 2A grants;
  - the behavior is registered and used to finish the goal.
- 2B's work appears in Judgment, linked to the 2A request.
- `npm run check`, `npm run typecheck` and `npm run e2e` pass.
- [[roadmap]] and the index are updated, and this task's `progress` is `done`.
