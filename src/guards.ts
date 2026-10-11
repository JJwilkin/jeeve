// Guards: invariants on motor commands, whichever behavior issued them (brain/architecture/seed-behaviors.md).
// Two parts: the guarded pathfinder Movements config, and a wrapper on raw controls, dig and place.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Block } from 'prismarine-block'
import pf from 'mineflayer-pathfinder'
import type { Channel } from './behaviors.ts'

type BlockAt = (x: number, y: number, z: number) => { name: string, boundingBox: string } | null

export const MAX_DROP = 3

// Is standing at (x, y, z) safe? Feet not in lava, and solid ground or water within MAX_DROP below.
export function unsafeAt (blockAt: BlockAt, x: number, y: number, z: number): string | null {
  if (blockAt(x, y, z)?.name.includes('lava')) return 'lava'
  for (let d = 1; d <= MAX_DROP + 1; d++) {
    const b = blockAt(x, y - d, z)
    if (!b) return 'void'
    if (b.name.includes('lava')) return 'lava below'
    if (b.name === 'water' || b.boundingBox === 'block') return null
  }
  return `drop of more than ${MAX_DROP}`
}

// Unit vector (x, z) a movement control pushes toward, for a Mineflayer yaw (0 = north, + turns left).
export function controlVector (control: string, yaw: number): [number, number] | null {
  const s = Math.sin(yaw)
  const c = Math.cos(yaw)
  switch (control) {
    case 'forward': return [-s, -c]
    case 'back': return [s, c]
    case 'left': return [-c, s]
    case 'right': return [c, -s]
    default: return null
  }
}

// Guards, part 1: the pathfinder Movements config everything that paths uses. Only collect may dig,
// because mineflayer-collectblock refuses targets the Movements says can't be broken.
export function guardedMovements (bot: Bot, canDig: boolean) {
  const moves = new pf.Movements(bot)
  moves.maxDropDown = MAX_DROP
  moves.allowParkour = false
  moves.allow1by1towers = false
  moves.canDig = canDig
  return moves
}

// Guards, part 2: a wrapper on raw controls, dig and place; a veto reaches the behavior holding the channel.
export function installGuards (bot: Bot, veto: (channel: Channel, reason: string) => void) {
  const blockAt: BlockAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z))

  const setControlState = bot.setControlState.bind(bot)
  bot.setControlState = (control, state) => {
    const v = state && controlVector(control, bot.entity.yaw)
    if (v) {
      const p = bot.entity.position
      const reason = unsafeAt(blockAt, Math.floor(p.x + v[0] * 0.8), Math.floor(p.y), Math.floor(p.z + v[1] * 0.8))
      if (reason) { setControlState(control, false); veto('legs', `${control}: ${reason}`); return }
    }
    setControlState(control, state)
  }

  const dig = bot.dig.bind(bot) as (...args: any[]) => Promise<void>
  bot.dig = ((block: Block, ...rest: any[]) => {
    const p = block.position
    const lava = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
      .some(([dx, dy, dz]) => blockAt(p.x + dx, p.y + dy, p.z + dz)?.name.includes('lava'))
    const feet = bot.entity.position.floored()
    const underFeet = p.x === feet.x && p.z === feet.z && p.y === feet.y - 1
    const reason = lava ? 'lava next to the block' : underFeet ? unsafeAt(blockAt, p.x, p.y, p.z) : null
    if (reason) { veto('hands', `dig: ${reason}`); return Promise.reject(new Error(`vetoed: ${reason}`)) }
    return dig(block, ...rest)
  }) as typeof bot.dig

  const placeBlock = bot.placeBlock.bind(bot)
  bot.placeBlock = (ref, face) => {
    const t = ref.position.plus(face)
    const feet = bot.entity.position.floored()
    if (t.x === feet.x && t.z === feet.z && (t.y === feet.y || t.y === feet.y + 1)) {
      veto('hands', 'place: would suffocate')
      return Promise.reject(new Error('vetoed: would suffocate'))
    }
    return placeBlock(ref, face)
  }
}
