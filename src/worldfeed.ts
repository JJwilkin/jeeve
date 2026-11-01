// The bot's view of the world as a stream, for the spectate page (GET /world): every loaded column and entity on
// connect, then deltas. Messages are prismarine-viewer's Viewer.listen events plus a `type`, so the browser emits them
// into viewer.listen() as they are; the web relay caches them for its viewers. No UI dependencies here.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Vec3 } from 'vec3'

type XYZ = { x: number, y: number, z: number }
export type EntityMessage = { type: 'entity', id: number, pos?: XYZ, yaw?: number, pitch?: number, name?: string, username?: string, width?: number, height?: number, delete?: true }
export type FeedMessage =
  | { type: 'loadChunk', x: number, z: number, chunk: string } // chunk: prismarine-chunk's column.toJson()
  | { type: 'unloadChunk', x: number, z: number }
  | { type: 'blockUpdate', pos: XYZ, stateId: number }
  | EntityMessage

const spawned = (e: Entity): EntityMessage => ({ type: 'entity', id: e.id, name: e.name, username: e.username, pos: e.position, yaw: e.yaw, pitch: e.pitch, width: e.width, height: e.height })
const moved = (e: Entity): EntityMessage => ({ type: 'entity', id: e.id, pos: e.position, yaw: e.yaw, pitch: e.pitch })

// Moves (the bot's own included, so a camera can follow it) are kept to the latest per entity and sent `hz` times a
// second; everything else goes out in order at the same flush. Nothing is built while no one is connected.
// ponytail: no dimension change, entity metadata (dropped item names, armour) or skins; add when the page shows them.
export function worldFeed (bot: Bot, hz = 10) {
  const clients = new Set<(m: FeedMessage) => void>()
  const queue: FeedMessage[] = []
  const moves = new Map<number, EntityMessage>()
  const push = (m: () => FeedMessage) => { if (clients.size) queue.push(m()) }
  const move = (e: Entity) => { if (clients.size) moves.set(e.id, moved(e)) }

  bot.on('chunkColumnLoad', (p: Vec3) => push(() => ({ type: 'loadChunk', x: p.x, z: p.z, chunk: bot.world.getColumnAt(p).toJson() })))
  bot.on('chunkColumnUnload', (p: Vec3) => push(() => ({ type: 'unloadChunk', x: p.x, z: p.z })))
  bot.on('blockUpdate', (_old, b) => { if (b) push(() => ({ type: 'blockUpdate', pos: b.position, stateId: b.stateId })) })
  bot.on('entitySpawn', e => push(() => spawned(e)))
  bot.on('entityMoved', move)
  bot.on('move', () => move(bot.entity))
  bot.on('entityGone', e => { moves.delete(e.id); push(() => ({ type: 'entity', id: e.id, delete: true })) })

  const flush = () => {
    const out = [...queue.splice(0), ...moves.values()]
    moves.clear()
    for (const m of out) for (const send of clients) send(m)
  }
  const timer = setInterval(flush, 1000 / hz)
  timer.unref()

  return {
    flush,
    // Sends the current world to `send`, then every delta until the returned function is called.
    connect (send: (m: FeedMessage) => void) {
      // No world before login.
      for (const { chunkX, chunkZ, column } of bot.world?.getColumns() ?? []) send({ type: 'loadChunk', x: Number(chunkX) * 16, z: Number(chunkZ) * 16, chunk: column.toJson() })
      for (const e of Object.values(bot.entities)) send(spawned(e))
      clients.add(send)
      return () => { clients.delete(send) }
    },
    close: () => clearInterval(timer)
  }
}
