---
date: 2026-11-02
tags: [architecture, perception, system-2, spatial, terrain]
status: active
---
# Region graph and height map

How 2A sees terrain: a graph of regions and links that code builds from what Jeeve has seen, plus a height map on demand. It builds the proposal in [[3d-world-representation]] (options B and A) and keeps the line from [[layers]]: code does exact geometry, the model gets conclusions. Code is in `src/regions.ts`.

**Why:** at a river on 2026-11-02, 2A's `seen_map` showed the landscape as one 1,445-block cluster, and the water not at all, so it planned waypoints the guards then vetoed.

## Seen terrain
The graph reads the seen memory (`src/world.ts`, [[perception]] → "Seen memory"), with two changes:
- **Liquids are seen.** Water and lava have no collision shape, so the visibility ray passed straight through them and they were never remembered. A liquid now counts as seen when the ray reaches its face unblocked.
- **The far look keeps column tops.** It skips types with more than 512 blocks in its box, i.e. ground and often water, so ground was only remembered within 8 blocks of where Jeeve had stood. It now also keeps each column's top (the highest block you can stand on or swim in) where the eyes can see it, checked against the other columns' tops, with no extra block reads (~5 ms on a 33 ms far look). These tops go in a store of their own, so `seen_map`, the checks and Jev's summary don't fill with ground.

`seenGrid(bot, centre, radius)` merges the two for the graph and the map. A spot it doesn't hold is air, or unseen.

## Regions
- **A cell** is where feet can be: on a solid block with two free blocks above (land), or on a water surface.
- **A region** is a flood fill over cells, within 40 blocks of the bot, joined by steps of at most one block up or down. So walking inside a region needs no link, and there are no "walk" links.
- Each region has its size, height range relative to the bot's feet, bounds, a central cell (`at`, a waypoint) and what's there (blocks beside or above its cells, terrain types left out).
- **Names in plain words, where code can tell:** river, pond or lake by shape (a river is at least 3× as long as it is wide); bank beside water; ravine floor or low ground 4+ below the bot; high ground 4+ above; treetops on leaves; shelter under a roof (a hut). A compass word from the bot tells them apart ("east bank"); the bot's own region is "(you are here)", always R1.

## Links
Computed with the guards' own rule (`unsafeAt`, `MAX_DROP` from `src/guards.ts`), over the seen grid, where an unseen column reads as void. So the graph can't promise a move a guard vetoes.

| Link | When | Rough cost |
|---|---|---|
| `drop N` | down 2–3 onto land, one way | 1 s |
| `climb N` | up 2 or more: a pillar of N blocks | 2 s a block |
| `swim` | into water where the guards allow the drop (water within 4 below), or out onto a bank at most 1 up | 2 s |
| `bridge N` | straight across a gap of N ≤ 8 (water, lava, a drop) to land at about the same height | 2 s a block |
| `unseen` | the next column holds nothing seen: a frontier, not a wall | — |

- A drop of 4 or more onto land is **no link**: the guards veto it. The way back up is `climb`.
- Per region pair and type, the cheapest crossing is kept, nearest the bot on a tie, with its cell as `at`.

## What 2A gets
- **`region_graph`** in every 2A call, next to `seen_map`: one line per region, then one per link, the bot's own first. Swim and bridge links that go both ways print once with `↔`.
  ```
  R1 bank (you are here): 104 blocks, y 0, x -7..-3 z -10..10, at [-5,0,0], has oak_log 2
  R2 river: water ~5 wide, 105 blocks, y -1, x -2..2 z -10..10, at [0,-1,0]
  R1↔R2 swim ~2s at [-3,0,0]
  R1↔R4 bridge 5 (5 blocks) ~10s at [-3,0,0]
  R5→R4 climb 4 (pillar 4 blocks) ~8s at [7,-4,0]
  ```
- **`terrain(region | at, radius)`**, a tool beside `scan` and `reachable`: a height map, one row per z and three characters per column, the ground height relative to the bot's feet; `~` water, `L` lava, `?` unseen, `@` the bot, `v` more than 3 below a neighbour.
- **Token budget.** The graph: at most 10 regions (the bot's, then the nearest of 4+ cells) and 16 links, under 1,800 characters (~500 tokens; ~1,100 characters at a river). The height map: 21×21 by default (~1.7k characters), 33×33 at most (~3.6k).
- Building the graph costs ~10 ms per 2A call.

## Ceilings
- **Regions are not cut by size.** Flat land within 40 blocks is one region; hilly land with 2-block steps splits into many small ones, and only the 10 nearest show. Cut regions Hydra-style (places) if traces show 2A losing the plot on hills.
- **Water depth is unknown** (only surfaces are seen), and head room for a step up isn't checked.
- **Column tops go stale** until the far look sees the column again (a dug block clears its top).
- **`reachable` still uses the pathfinder's rules,** not this graph (the river fixes give the pathfinder the guards' drop limit into water). Not built yet: code checking 2A's route against the graph before System 1 runs it, the spectate minimap, and Jev's options from the graph.
