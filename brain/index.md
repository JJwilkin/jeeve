# Jeeve brain

The project's knowledge store. The whole repo is an Obsidian vault: open the repo root with "Open folder as vault". It holds the *why* and the *how it fits together*. Code facts belong in the code.

We're in the research and architecture stage: no code yet. Plans, decisions and per-module notes will get folders when building starts.

## Layout
| Where | What |
|---|---|
| `brain/architecture/` | How Jeeve works at a high level: principles and structure, not implementation |
| `brain/research/` | What we learned from outside: papers, other projects, models. Facts and sources, not prescriptions. |

## Conventions
- One idea per note. Frontmatter: `date`, `tags`, `status` (`active` | `superseded`).
- Link with `[[note-name]]`.
- When a note is wrong, mark it `superseded` and link the replacement. Don't silently delete it.
- Add every note to the index below.

## Index
### Architecture
- [[overview]]: what we build vs. what the agent discovers, the discovery loop, fast and slow thinking, goals and time as one hierarchy, open questions

### Research
- [[bitter-lesson]]: search and learning beat hand-built knowledge. The organizing principle.
- [[mindcraft-and-voyager]]: how the two best-known LLM Minecraft agents work, and what they hand-build vs. discover
- [[perception]]: how bots see Minecraft (data, not pixels), where the view gets narrow, encoding time
- [[decision-models]]: Jev, Microsoft-Decision-1 and local small LLMs as fast decision-makers
- [[fast-slow-agents]]: prior art for fast/slow agents in Minecraft and robotics, and AlphaZero-style expert iteration
