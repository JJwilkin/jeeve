// Scenes the e2e and the clips share (scripts/e2e.ts, scripts/clip.ts), set up through server commands.
type Command = (cmd: string) => void

// A tree whose canopy is out of reach from the ground (eyes at -58.4, lowest leaf centre at -53.5): 6 logs, 27
// persistent leaves (as player-placed leaves are, so none decay instead of being broken). Jeeve 3 blocks west.
export const CANOPY = { x: 30, z: -12, instruction: "break that whole tree, leaves included. The leaves won't decay on their own" }
export function canopy (command: Command, instructor = 'Josh') {
  const { x, z } = CANOPY
  command(`fill ${x - 6} -60 ${z - 6} ${x + 6} -45 ${z + 6} air`) // the world persists between runs
  command('fill 4 -60 6 20 -50 20 air') // logs "collect 10 logs" left, and older runs' oaks: collect would walk off to them
  tree(command, x, z)
  command(`tp Jeeve ${x - 3} -60 ${z}`)
  command(`tp ${instructor} ${x - 6} -60 ${z + 4}`)
}

const tree = (command: Command, x: number, z: number) => {
  command(`fill ${x} -60 ${z} ${x} -55 ${z} oak_log`)
  command(`fill ${x - 1} -54 ${z - 1} ${x + 1} -52 ${z + 1} oak_leaves[persistent=true]`)
}

// Four canopy trees in a row, 6 apart along x: one to learn the skill on, three to use it on.
export const ORCHARD = {
  trees: [30, 36, 42, 48].map(x => ({ x, z: -12 })),
  instructions: [
    "break the tree closest to you, leaves included. The leaves won't decay on their own",
    'now break the other three trees the same way, leaves included'
  ]
}
export function orchard (command: Command, instructor = 'Josh') {
  command('fill 22 -60 -20 56 -45 -4 air')
  for (const t of ORCHARD.trees) tree(command, t.x, t.z)
  command('tp Jeeve 27 -60 -12')
  command(`tp ${instructor} 32 -60 -7`)
}

// A workshop: two small reachable trees and a chest. Making a pickaxe and storing it chains collect, crafting
// (a crafting table first) and a chest, which no seed behavior does: 2A has to plan and ask the builder.
export const WORKSHOP = {
  trees: [{ x: 31, z: -12 }, { x: 34, z: -16 }],
  chest: [27, -60, -9] as [number, number, number],
  instruction: 'make a wooden pickaxe and put it in the chest'
}
export function workshop (command: Command, instructor = 'Josh') {
  command('fill 18 -60 -24 44 -45 0 air')
  for (const t of WORKSHOP.trees) {
    command(`fill ${t.x} -60 ${t.z} ${t.x} -57 ${t.z} oak_log`)
    command(`fill ${t.x - 1} -56 ${t.z - 1} ${t.x + 1} -56 ${t.z + 1} oak_leaves[persistent=true]`)
  }
  command(`setblock ${WORKSHOP.chest.join(' ')} chest`)
  command('tp Jeeve 27 -60 -12')
  command(`tp ${instructor} 24 -60 -8`)
}

// Guard duty at night: Josh moves between spots while zombies come in waves. Josh plays in survival here (with
// resistance, so a wave can't kill him outright), so the zombies go for him and Jeeve has to keep them off.
export const GUARD = {
  spots: [[30, -60, -8], [38, -60, -12], [32, -60, -18], [24, -60, -12]] as Array<[number, number, number]>,
  instruction: 'follow me and keep me safe',
  waves: 4, waveEveryMs: 25_000
}
export function guard (command: Command, instructor = 'Josh') {
  command('fill 14 -60 -28 48 -45 4 air')
  command('time set midnight')
  command(`gamemode survival ${instructor}`)
  command(`effect give ${instructor} resistance 600 2 true`)
  command(`tp ${instructor} ${GUARD.spots[0].join(' ')}`)
  command('tp Jeeve 28 -60 -8')
}
