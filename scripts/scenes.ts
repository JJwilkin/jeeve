// Scenes the e2e and the clips share (scripts/e2e.ts, scripts/clip.ts), set up through server commands.
type Command = (cmd: string) => void

// A tree whose canopy is out of reach from the ground (eyes at -58.4, lowest leaf centre at -53.5): 6 logs, 27
// persistent leaves (as player-placed leaves are, so none decay instead of being broken). Jeeve 3 blocks west.
export const CANOPY = { x: 30, z: -12, instruction: "break that whole tree, leaves included. The leaves won't decay on their own" }
export function canopy (command: Command, instructor = 'Josh') {
  const { x, z } = CANOPY
  command(`fill ${x - 6} -60 ${z - 6} ${x + 6} -45 ${z + 6} air`) // the world persists between runs
  command('fill 4 -60 6 20 -50 20 air') // logs "collect 10 logs" left, and older runs' oaks: collect would walk off to them
  command(`fill ${x} -60 ${z} ${x} -55 ${z} oak_log`)
  command(`fill ${x - 1} -54 ${z - 1} ${x + 1} -52 ${z + 1} oak_leaves[persistent=true]`)
  command(`tp Jeeve ${x - 3} -60 ${z}`)
  command(`tp ${instructor} ${x - 6} -60 ${z + 4}`)
}
