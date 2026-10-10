# Jeeve brain

The project's knowledge store. The whole repo is an Obsidian vault: open the repo root with "Open folder as vault". Code facts belong in the code. This is for the *why* and the *how it fits together*.

## Layout
| Where | What |
|---|---|
| `README.md` (repo root) | Architecture overview. The source of truth for concepts until one outgrows its section. |
| `brain/concepts/` | A concept that has outgrown its README section (e.g. goal tree, state builder). Make one only when needed. |
| `brain/plans/` | Working plans per roadmap phase: scope, open questions, done criteria. |
| `brain/decisions/` | One note per decision: context, options, choice, consequences. |
| `brain/insights/` | Findings and research that inform design. |
| `src/<module>/<module>.md` | The code map. Each module documents itself next to its code (see below). |

## Conventions
- One idea per note. Frontmatter: `date`, `tags`, `status` (`active` | `superseded`).
- Link with `[[note-name]]`, or `[[README#Heading]]` for a README section.
- When a note is wrong, mark it `superseded` and link the replacement. Don't silently delete it.
- Add every note to the index below.

### Module notes
Every `src/<module>/` gets a short `<module>.md`, named after the module and not `README.md`, so wikilinks stay unique and `[[README]]` always means the root README:
```md
---
concepts: ["[[README#System 1 (fast decisions)]]", "[[bitter-lesson]]"]
---
# <module>
What it owns, its public entry points, what it depends on, gotchas.
```
The `concepts` links connect code to design, so the Obsidian graph and backlinks show which modules implement a concept. Keep these short. Signatures live in the code.

## Index
### Concepts (in the root README for now)
- [[README#System 1 (fast decisions)]] · [[README#System 2 (goal tree)]] · [[README#Perception]] · [[README#Memory]] · [[README#Tracing]] · [[README#Scenarios]]

### Plans
- [[README#Roadmap]]

### Decisions
_none yet_

### Insights
- [[bitter-lesson]]: search and learning beat hand-built knowledge. What that means for Jeeve's layers.

### Code map
_no code yet. Link each `[[<module>]]` note here as modules land._
