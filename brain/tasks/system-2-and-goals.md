---
date: 2026-10-10
tags: [task, system-2, goals, architecture]
status: active
progress: done
---
# Task: System 2 and goals for the first milestone

**Outcome:** [[system-2]].

**Start a chat with:** "Read `AGENTS.md` and follow it, then work on `brain/tasks/system-2-and-goals.md`."

## Goal
Design System 2 and the goal tree, so that an instruction from outside becomes a goal with a success check, for the first milestone ([[layers]]): a local server and three instructions, "come here", "collect 10 logs" and "follow me and defend me". This is the last piece of pre-code design left in [[roadmap]] stage 2.

Judges and the outer-loop reward signal stay deferred to roadmap stage 4.

## Read first
- [[overview]]: goals and time as one hierarchy (expand down, summarize up, interrupts push and pop)
- [[layers]]: what System 2 owns; the first milestone's instruction channel
- [[system-1]]: programs System 2 writes; "evidence is recorded, not required"
- [[learning]]: guidance updates must cite evidence and expire; who writes window summaries
- [[seed-behaviors]]: the three instructions walked through for System 1; "who does what"
- [[trace-schema]]: `goal`, `system2`, `program` and `carry_over` spans; `jeeve.goal.path`; the open summary question
- Evidence: [[gitm]] (typed goals, goal tree), [[llm-plays-pokemon]] (falsifiable goals, budgets, code detects stuck), [[project-sid]] (one writer of commitments), [[realtime-game-agents]] (directives as options with checks and budgets; typed escalations)

## Questions to answer
1. **Goal tree data model:** nodes, status, success checks, budgets, summaries rolling up, interrupts as push and pop. How it maps to the window root's `jeeve.goal.path` and the `goal` spans.
2. **Instruction intake:** in-game whispers from allowlisted players, plus a small local API. What sets the root goal, and how status is reported back.
3. **Success checks:** programmatic checks for "come here" and "collect 10 logs". What an open-ended instruction like "follow me and defend me" has instead.
4. **How System 2 writes program changes:** resolve the contradiction between [[learning]] (guidance updates must cite evidence and expire) and [[system-1]] (evidence recorded, not required). Raise it with Joshua; don't pick one silently.
5. **Escalation handling,** and **who writes the `carry_over` previous-window summary** (open in [[trace-schema]]).

Walk all three instructions end to end against the design with Joshua before writing the architecture note.

## Done when
- A `brain/architecture/` note covers the questions above, and superseded text elsewhere is marked.
- [[roadmap]] stage 2 and stage 4's first bullet are updated.
- This task's `progress` is `done`.
