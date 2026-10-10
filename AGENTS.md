# Jeeve: agent instructions

This repo is also an Obsidian vault and the project's shared memory. Work from it, not just from the code.

## Before you start
1. Read [brain/index.md](brain/index.md).
2. Read [brain/architecture/overview.md](brain/architecture/overview.md), plus any `brain/research/` notes that touch your task.
3. Be able to say how the task fits the architecture. If you can't, read more before you write anything.

## Stay aligned
- **The architecture is binding.** Don't silently work around it.
- **If a task would break it, or the brain contradicts the code,** stop and tell the user. Don't pick one yourself.
- **Check `brain/research/` before researching a question.** Someone may have already answered it.
- **The [[bitter-lesson]] smell test:** if a change hand-builds Minecraft knowledge, ask whether a discovery method (search or learning) would fix it instead.

## When you finish
Write back anything a future agent shouldn't have to rediscover:
- **A finding from outside** (paper, project, model): add a note to `brain/research/` with sources.
- **A change to how the agent works:** update `brain/architecture/`. If an idea gets replaced, mark the old note `superseded` and link the new one.

Follow the conventions in `brain/index.md` (frontmatter, `[[wikilinks]]`, add to the index). Skip anything the code or git history already makes obvious.

## Subagents
When you hand work to a subagent, include the brain notes that matter, and tell it to follow this file.
