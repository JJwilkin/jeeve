// The web relay for the spectate page: one /events and one /world upstream per Jeeve, cached and replayed to each
// viewer, so the number of viewers never reaches a bot. The god feed is the union of the Jeeves' worlds. Caddy, in
// front, puts basic auth on the POSTs.
//   JEEVES=Jeeve_1=http://jeeve-1:7777,Jeeve_2=http://jeeve-2:7777 WEB_PORT=8080 node web/server.ts
import { createServer, get, type ServerResponse } from 'node:http'
import type { EntityMessage, FeedMessage } from '../src/worldfeed.ts'
import { publicRow } from './public-row.ts'

const RETRY_MS = 2000
const STATUS_MS = 2000 // a viewer polling /status reaches the Jeeve at most this often
const MAX_BODY = 16_000
const MAX_QUEUED = 64e6 // bytes a slow viewer may have waiting before it is dropped (a world snapshot is ~22 MB)
const SSE = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }

type Viewers = Set<ServerResponse>
// A Jeeve's world as its feed last described it: each column's load message plus the block updates since, and
// every entity merged from its spawn and moves. Messages are kept framed, so every viewer is sent the same Buffer.
type World = { columns: Map<string, { load: Buffer, blocks: Map<string, Buffer> }>, entities: Map<number, EntityMessage> }
type Jeeve = {
  api: string, rows: Buffer[], world: World, viewers: { events: Viewers, world: Viewers }, up: { events: boolean, world: boolean }
  status?: { at: number, reply: Promise<{ code: number, body: string }> }
}

const jeeves = new Map((process.env.JEEVES ?? 'Jeeve=http://127.0.0.1:7777').split(',').map(s => {
  const [name, api] = s.split('=')
  const j: Jeeve = { api, rows: [], world: { columns: new Map(), entities: new Map() }, viewers: { events: new Set(), world: new Set() }, up: { events: false, world: false } }
  return [name, j] as const
}))
const god: Viewers = new Set()

const frame = (line: string) => Buffer.from(`data: ${line}\n\n`)
// A viewer that can't keep up is dropped rather than buffered without end; its EventSource reconnects.
function send (res: ServerResponse, framed: Buffer) {
  res.write(framed)
  if (res.writableLength > MAX_QUEUED) res.destroy()
}
const column = (x: number, z: number) => `${Math.floor(x / 16) * 16},${Math.floor(z / 16) * 16}`

// Follows an upstream event stream for good: `open` on each (re)connect, `data` per event.
// node:http rather than fetch: fetch drops a body that goes quiet for 5 min, as an asleep Jeeve's trace does.
function follow (url: string, up: (open: boolean) => void, data: (line: string) => void) {
  let retried = false
  const retry = () => {
    if (retried) return
    retried = true
    up(false)
    setTimeout(() => follow(url, up, data), RETRY_MS)
  }
  get(url, res => {
    res.on('error', retry).on('close', retry)
    if (res.statusCode !== 200) return res.resume()
    console.log(`upstream ${url}: connected`)
    up(true)
    let buf = ''
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (event.startsWith('data: ')) data(event.slice(6))
      }
    })
  }).on('error', retry)
}

// A Jeeve's upstream reconnects with everything from the start (the trace's rows, the world's columns), so the cache
// starts over and its viewers are closed: their EventSource reconnects and gets the fresh cache.
function startOver (cache: () => void, ...viewers: Viewers[]) {
  cache()
  for (const vs of viewers) {
    for (const v of vs) v.end()
    vs.clear()
  }
}

function applyWorld (w: World, m: FeedMessage, line: Buffer) {
  if (m.type === 'loadChunk') w.columns.set(column(m.x, m.z), { load: line, blocks: new Map() })
  else if (m.type === 'unloadChunk') w.columns.delete(column(m.x, m.z))
  else if (m.type === 'blockUpdate') w.columns.get(column(m.pos.x, m.pos.z))?.blocks.set(`${m.pos.x},${m.pos.y},${m.pos.z}`, line)
  else if (m.delete) w.entities.delete(m.id)
  else w.entities.set(m.id, { ...w.entities.get(m.id), ...m })
}

// The god feed passes every Jeeve's deltas on, except an unload or a despawn while another Jeeve still sees it.
function toGod (m: FeedMessage, line: Buffer) {
  const seen = [...jeeves.values()].map(j => j.world)
  if (m.type === 'unloadChunk' && seen.some(w => w.columns.has(column(m.x, m.z)))) return
  if (m.type === 'entity' && m.delete && seen.some(w => w.entities.has(m.id))) return
  for (const v of god) send(v, line)
}

// Columns then entities, for one world or the union of several (a column two Jeeves see comes from either).
function worldLines (worlds: World[]): Buffer[] {
  const columns = new Map(worlds.flatMap(w => [...w.columns]))
  const entities = new Map(worlds.flatMap(w => [...w.entities]))
  return [...[...columns.values()].flatMap(c => [c.load, ...c.blocks.values()]), ...[...entities.values()].map(e => frame(JSON.stringify(e)))]
}

for (const j of jeeves.values()) {
  follow(`${j.api}/events`, open => {
    j.up.events = open
    if (open) startOver(() => { j.rows = [] }, j.viewers.events)
  }, data => {
    let line
    try { line = frame(JSON.stringify(publicRow(JSON.parse(data)))) } catch { return } // a half-written last row
    // ponytail: the whole filtered session is held and replayed per viewer; replay from the last window_open if sessions get long.
    j.rows.push(line)
    for (const v of j.viewers.events) send(v, line)
  })
  follow(`${j.api}/world`, open => {
    j.up.world = open
    if (open) startOver(() => { j.world.columns.clear(); j.world.entities.clear() }, j.viewers.world, god)
  }, data => {
    const m = JSON.parse(data) as FeedMessage
    const line = frame(data)
    applyWorld(j.world, m, line)
    for (const v of j.viewers.world) send(v, line)
    toGod(m, line)
  })
}

function stream (res: ServerResponse, viewers: Viewers, lines: Buffer[]) {
  res.writeHead(200, SSE)
  for (const l of lines) res.write(l)
  viewers.add(res)
  res.on('close', () => viewers.delete(res))
}

function cachedStatus (j: Jeeve) {
  if (!j.status || Date.now() - j.status.at > STATUS_MS) {
    const reply = fetch(`${j.api}/status`, { signal: AbortSignal.timeout(5000) })
      .then(async r => ({ code: r.status, body: await r.text() }))
      .catch((err: Error) => ({ code: 502, body: JSON.stringify({ error: err.message }) }))
    j.status = { at: Date.now(), reply }
  }
  return j.status.reply
}

const server = createServer((req, res) => {
  const reply = (code: number, body: string) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body) }
  const [, api, name, what] = new URL(req.url ?? '/', 'http://relay').pathname.split('/')
  if (api !== 'api') return reply(404, '{"error":"not found"}')

  if (req.method === 'GET' && name === 'jeeves') {
    return reply(200, JSON.stringify([...jeeves].map(([name, j]) => ({ name, upstream: j.up, viewers: { events: j.viewers.events.size, world: j.viewers.world.size } }))))
  }
  if (req.method === 'GET' && name === 'god' && what === 'world') return stream(res, god, worldLines([...jeeves.values()].map(j => j.world)))

  const j = jeeves.get(name)
  if (!j) return reply(404, JSON.stringify({ error: `no Jeeve named ${name}` }))
  if (req.method === 'GET' && what === 'events') return stream(res, j.viewers.events, j.rows)
  if (req.method === 'GET' && what === 'world') return stream(res, j.viewers.world, worldLines([j.world]))
  if (req.method === 'GET' && what === 'status') return void cachedStatus(j).then(s => reply(s.code, s.body))
  if (req.method === 'POST' && ['instructions', 'wake', 'sleep'].includes(what)) {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => { body += c; if (body.length > MAX_BODY) req.destroy() })
    req.on('end', () => {
      fetch(`${j.api}/${what}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000) })
        .then(async r => reply(r.status, await r.text()))
        .catch((err: Error) => reply(502, JSON.stringify({ error: err.message })))
    })
    return
  }
  reply(404, '{"error":"GET /api/jeeves, /api/god/world, /api/<jeeve>/events|world|status; POST /api/<jeeve>/instructions|wake|sleep"}')
})

const port = Number(process.env.WEB_PORT ?? 8080)
const host = process.env.WEB_HOST ?? '127.0.0.1'
server.listen(port, host, () => console.log(`web relay on ${host}:${port} for ${[...jeeves.keys()].join(', ')}`))
