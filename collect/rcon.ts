// A minimal RCON client (https://minecraft.wiki/w/RCON): the collector's server commands (teleport, kit, time,
// weather, Chunky). ponytail: one packet per reply (≤4096 bytes); responses split over several packets are cut.
import net from 'node:net'
import { once } from 'node:events'

export type Rcon = { command: (cmd: string) => Promise<string>, close: () => void }

export async function rcon (host: string, port: number, password: string): Promise<Rcon> {
  const sock = net.connect(port, host)
  await once(sock, 'connect')
  let buf = Buffer.alloc(0)
  let next = 0
  const waiting = new Map<number, (body: string) => void>()
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
      const len = buf.readInt32LE(0)
      const id = buf.readInt32LE(4)
      const body = buf.toString('utf8', 12, 4 + len - 2)
      buf = buf.subarray(4 + len)
      // A failed login answers with id −1.
      const w = waiting.get(id) ?? (id === -1 ? [...waiting.values()][0] : undefined)
      waiting.delete(id === -1 ? [...waiting.keys()][0] : id)
      w?.(id === -1 ? '\0auth failed' : body)
    }
  })
  sock.on('error', () => {})
  const send = (type: number, body: string) => new Promise<string>((resolve, reject) => {
    if (sock.destroyed) return reject(new Error('rcon closed'))
    const id = ++next
    const payload = Buffer.from(body, 'utf8')
    const p = Buffer.alloc(14 + payload.length)
    p.writeInt32LE(10 + payload.length, 0)
    p.writeInt32LE(id, 4)
    p.writeInt32LE(type, 8)
    payload.copy(p, 12)
    waiting.set(id, resolve)
    sock.write(p)
  })
  if (await send(3, password) === '\0auth failed') { sock.destroy(); throw new Error('rcon: wrong password') }
  return { command: cmd => send(2, cmd), close: () => sock.destroy() }
}

// Retries until the server takes RCON (it opens it a while after starting).
export async function rconWhenUp (host: string, port: number, password: string, tries = 120): Promise<Rcon> {
  for (let i = 0; ; i++) {
    try { return await rcon(host, port, password) } catch (err) {
      if (i >= tries || String(err).includes('wrong password')) throw err
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }
}
