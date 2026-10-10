---
date: 2026-10-10
tags: [research, prior-art, system-2, memory, long-horizon]
status: active
---
# Claude and Gemini play Pokémon

The longest-horizon public LLM game runs: hundreds of hours and hundreds of thousands of actions per playthrough. Pokémon is turn-based and the harness controls the pace, so these runs say nothing about latency. They are the best evidence on **memory, context management and getting stuck** over very long horizons, which is System 2's job in [[overview]].

## Timeline
| When | What | Source |
|---|---|---|
| Feb 2025 | Claude 3.7 Sonnet earns 3 badges; earlier Sonnets stuck near the start | [Anthropic](https://www.anthropic.com/news/visible-extended-thinking) |
| Mar 2025 | Claude 3.7 stuck in Mt. Moon about 24 h (run #3) | [Bradshaw, LessWrong](https://www.greaterwrong.com/posts/HyD3khBjnBhvsp8Gb/so-how-well-is-claude-playing-pokemon) |
| May 2, 2025 | Gemini 2.5 Pro beats Pokémon Blue in **813 h**. This was the development run, and the harness changed during it. | [Gemini 2.5 report §4.1](https://storage.googleapis.com/deepmind-media/gemini/gemini_v2_5_report.pdf) |
| May–Jun 2025 | Gemini run 2, on a frozen harness, starts May 22 and finishes in **406.5 h** | same |
| Jan 2026 | Claude Opus 4.5: all 8 badges, stuck on Victory Road at about 230k steps | [Snider, LessWrong](https://www.greaterwrong.com/posts/gogZyeistdaDFuhbG/claude-plays-pokemon-opus-4-5-follow-up) |
| May 16, 2026 | Claude Opus 4.7 beats Pokémon Red | [Bradshaw, LessWrong](https://www.lesswrong.com/posts/sehJYg5Yny9fvpbpt/a-year-late-claude-finally-beats-pokemon) |

- **Unverified:** a comment on the Opus 4.7 recap puts the run at about 325 h. Another comment says only edited video was published, not the full stream.
- **The two projects are not comparable benchmarks.** They use different tools and different inputs. The Gemini developer said so himself, crediting a "better framework" ([Bradshaw, Apr 2025](https://www.lesswrong.com/posts/7mqp8uRnnPdbBzJZE/is-gemini-now-better-than-claude-at-pokemon)).

## The harnesses
**What both share** ([Bradshaw, Apr 2025](https://www.lesswrong.com/posts/7mqp8uRnnPdbBzJZE/is-gemini-now-better-than-claude-at-pokemon)):
- a system prompt with advice,
- a screenshot overlaid with information read from game RAM,
- text notes the model writes,
- a tool that turns text into button presses,
- pathfinding,
- periodic summarization of the context,
- a second instance of the model that critiques the first.

**Gemini Plays Pokémon** is built by Joel Zhang, an independent developer. The details below are from the [Gemini 2.5 report, §8.2](https://storage.googleapis.com/deepmind-media/gemini/gemini_v2_5_report.pdf).
- **Context and summaries:**
  - The action history stays in context.
  - The context is cleared into a summary every 100 turns.
  - Every 1,000 turns, the summaries themselves are compressed again.
- **Goal slots:** primary, secondary and tertiary goals, plus contingency, preparation, exploration and team goals.
- **Guidance Gemini:** every 25 turns, a separate instance reads the same context, critiques the main agent and points out hallucinations.
- **Map memory, owned by the harness:**
  - A fog-of-war map is kept in context as XML.
  - Tiles are recorded automatically from RAM once explored, with a visited counter, a tile type (water, cuttable, spinner, …) and labelled warps.
  - Unseen coordinates stay hidden until explored.
- **Specialist sub-agents:** `pathfinder` and `boulder_puzzle_strategist`. Both are prompted Gemini instances that "mentally simulate" search over the map.
  - Pathfinder handled paths up to 50 actions long (150 at most) over contexts of 100k+ tokens.
  - Gemini wrote most of these prompts itself.
- **Vision barely mattered.** In an ablation that removed vision entirely, the agent played "roughly as well". The necessary screen information came from RAM as text (§4.1).

**Claude Plays Pokémon** is built by David Hershey at Anthropic. He calls it "a pretty straightforward tool-using agent".
- **The original harness** (2025): a knowledge base, a `use_emulator` button tool, and a navigator ([Anthropic](https://www.anthropic.com/news/visible-extended-thinking), [Bradshaw](https://www.greaterwrong.com/posts/HyD3khBjnBhvsp8Gb/so-how-well-is-claude-playing-pokemon)).
  - When the context fills, it's summarized into a fresh window.
  - Per a commenter, the navigator only reaches coordinates that are *on screen*, so Claude has to find its own way around walls.
  - Editable short-term and long-term memory files were added after run #2.
- **By the Opus 4.7 run**, per the [recap](https://www.lesswrong.com/posts/sehJYg5Yny9fvpbpt/a-year-late-claude-finally-beats-pokemon):
  - Added: a zoom tool, stored reference screenshots, and multiple button presses per step.
  - Removed: Critic Claude, the visual hints, and the general advice in the prompt.
- Anthropic's [context-engineering post](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) uses the run as its example of structured note-taking:
  - Claude keeps tallies, e.g. "for the last 1,234 steps I've been training…".
  - It builds maps of explored areas without being told to.
  - It resumes multi-hour sequences from its notes after a context reset.

## What went wrong over long horizons
- **Context poisoning.** A false belief gets into the goals or the summary and keeps being repeated. Gemini spent "many, many hours" looking for a TEA item, which exists only in the remakes. It also tried the "black-out" strategy as a way to leave a place ([report §8.2](https://storage.googleapis.com/deepmind-media/gemini/gemini_v2_5_report.pdf)).
- **Loops in long context.** Past about 100k tokens, Gemini favoured "repeating actions from its vast history rather than synthesizing novel plans" (§4.1).
- **Not noticing it's stuck.**
  - Claude's notes said it had "THOROUGHLY confirmed" a path didn't exist, and it kept trying anyway.
  - After a whiteout, it deleted its Mt. Moon notes and concluded it had beaten the cave ([Bradshaw](https://www.greaterwrong.com/posts/HyD3khBjnBhvsp8Gb/so-how-well-is-claude-playing-pokemon)).
  - With Opus 4.7, an over-eager memory cleanup deleted a useful note ([recap](https://www.lesswrong.com/posts/sehJYg5Yny9fvpbpt/a-year-late-claude-finally-beats-pokemon)).
- **Topological traps.** The goal looks close, but the solution needs a long detour. Asked to solve the whole puzzle in one go (e.g. via pathfinder), the model *can*. Moving step by step, it falls for the attractor (§8.2).
- **"Agent panic".** When the party is low on health, reasoning gets visibly worse and the model forgets to use pathfinder (§8.2).
- **Prior knowledge hurts as well as helps.**
  - Gemini mixed up facts between game generations.
  - Telling it to act as a new player cut the hallucinations, but cost it useful knowledge (§8.2).
  - A commenter reports that Claude's system prompt says to rely on the memories in its context, not its instincts ([Bradshaw](https://www.greaterwrong.com/posts/HyD3khBjnBhvsp8Gb/so-how-well-is-claude-playing-pokemon)).
- **Poor long-term planning.** Opus 4.5 ignored the Gold Teeth, which meant it never got the Strength HM needed for Victory Road. It backtracked only after realizing ([Snider](https://www.greaterwrong.com/posts/gogZyeistdaDFuhbG/claude-plays-pokemon-opus-4-5-follow-up)).
- **What fixed things over time** was mostly the model, not the harness:
  - better vision (seeing the boulder switches),
  - noticing loops,
  - abandoning stuck goals. This sometimes went too far, with Opus 4.7 giving up on solvable dungeons ([recap](https://www.lesswrong.com/posts/sehJYg5Yny9fvpbpt/a-year-late-claude-finally-beats-pokemon)).
- **The model matters a great deal.** On the same harness, Gemini 2.5 Flash stalled at milestones that Pro passed (report, Fig. 13).

## Takeaways for Jeeve
- **Split memory by who can be trusted to write it.**
  - **Facts the game can confirm** should be written by the harness: the map, explored tiles, warps, inventory.
  - **Beliefs and goals** are written by the model and need checking.
  - Gemini's auto-filled map was its most reliable memory. Model-written notes were where poisoning started.
  - For Jeeve: world memory such as places, chest contents and explored chunks should be recorded by code from Mineflayer data ([[perception]]), not by System 2 writing notes.
- **The goal tree in [[overview]] is a better form of Gemini's goal slots.** Two things it should add:
  - **Goals need a way to be falsified.** A goal that can't fail ("find the TEA") is how poisoning happens. Each node needs a success check and a budget, and exceeding the budget forces escalation and re-evaluation.
  - **Keep the context to the path from the root.** Past about 100k tokens, Gemini started looping. Jeeve's summarize-up rule (finished nodes shrink to one line) is the right defence. Keep System 2's prompt well under that.
- **The harness should detect "stuck", not the model.** Models are bad at noticing loops. A cheap code-level check (same region or state for N minutes, repeated failed actions, no change in goal progress) should escalate to System 2 with that evidence. A critic on a timer, like Gemini's every 25 turns, is the LLM version of the same check.
- **Sub-agents with a clean context, for search-heavy subproblems.**
  - Pathfinder and the boulder solver show that a model solves a puzzle much better in one focused call than step by step.
  - In Jeeve, System 2 can spawn these for "plan a route" or "solve this redstone puzzle". The resulting plan is handed to System 1 and code to execute.
  - Better still, through the [[bitter-lesson]] lens, use real search such as A* in code. Gemini's pathfinder only simulated BFS inside its reasoning.
- **Hours and steps hide cost and latency.** Pokémon waits for the agent. Gemini's 406 hours would be far longer in a game with real time pressure. These runs set a lower bound on how much slow thinking a long horizon needs, not a model for real-time play.
