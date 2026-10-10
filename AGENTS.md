# Jeeve: agent instructions

This repo is also an Obsidian vault and the project's shared memory. Work from it, not just from the code.

## Before you start
1. Read [brain/index.md](brain/index.md).
2. Read whatever fits the task:
   - its roadmap phase and any plan in `brain/plans/`
   - every active note in `brain/decisions/` that touches the area
   - the module note (`src/<module>/<module>.md`) for each module you'll change
   - the root [README.md](README.md) sections on the concepts involved
3. Be able to say how the task fits the architecture: which layer, which concept, which phase. If you can't, read more before you write code.

## Stay aligned
- Active decisions are binding. Don't silently work around one.
- If the task needs to break a decision, or the brain contradicts the code, stop and tell the user. Don't pick one yourself. If the user agrees to change course, write a new decision note and mark the old one `superseded`, linking the two.
- Check `brain/insights/` before researching a design question. Someone may have already answered it.

## When you finish
Write back anything a future agent shouldn't have to rediscover:
- **A new or changed `src/` module:** create or update `src/<module>/<module>.md`, and link it in the index's code map.
- **A choice between real alternatives:** add a `brain/decisions/` note covering context, options, the choice, and its consequences.
- **A non-obvious finding:** add a `brain/insights/` note.
- **A change to scope or the phase plan:** update the note in `brain/plans/`.

Follow the conventions in `brain/index.md`: frontmatter, `[[wikilinks]]`, and add the note to the index. Skip anything the code or git history already makes obvious.

## Subagents
When you hand work to a subagent, include the brain notes that matter, and tell it to follow this file.
