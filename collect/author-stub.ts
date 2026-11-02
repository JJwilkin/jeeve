// Canned drafts for `npm run author -- --stub`: a stand-in for 2B that tests the harness without model calls.
// Bridge's first round writes one that stops after 3 blocks (it can pass a trial, then fail validation); later rounds
// write one that claims done without bridging, then one that bridges the whole gap. Swim and shelter get one plain draft each.
import { MockLanguageModelV4 } from 'ai/test'

const bridge = (limit: string) => `async (api, t) => {
  const [dx, dz] = t.dir
  const solid = (x, y, z) => { const b = api.blockAt(x, y, z); return !!b && !/^(air|cave_air|water|lava)$/.test(b) }
  await api.equip(t.name)
  const p = api.self().pos
  let x = Math.floor(p[0]), y = Math.floor(p[1]), z = Math.floor(p[2])
  for (let i = 0; i < 12 && solid(x + dx, y - 1, z + dz); i++) { x += dx; z += dz }
  await api.goto(x, y, z, 0)
  for (let placed = 0; placed < ${limit} && !solid(x + dx, y - 1, z + dz); placed++) {
    await api.place(x + dx, y - 1, z + dz)
    x += dx; z += dz
    await api.goto(x, y, z, 0)
  }
  if (solid(x + dx, y - 1, z + dz)) await api.goto(x + dx, y, z + dz, 0)
  return 'done'
}`
const LIAR = `async (api, t) => {
  const p = api.self().pos
  await api.goto(Math.floor(p[0]) + 3 * t.dir[0], Math.floor(p[1]), Math.floor(p[2]) + 3 * t.dir[1], 1)
  return 'done'
}`
const SWIM = `async (api, t) => {
  const [x, y, z] = t.at
  await api.goto(x, y + 1, z, 1)
  return 'done'
}`
const SHELTER = `async (api, t) => {
  await api.equip(t.name)
  const p = api.self().pos
  const x = Math.floor(p[0]), y = Math.floor(p[1]), z = Math.floor(p[2])
  const h = Math.floor(t.size / 2)
  const cells = []
  if (t.template === 'wall') {
    for (let dy = 0; dy < 2; dy++) for (let i = 0; i < t.size; i++) cells.push([x - h + i, y + dy, z + 2])
  } else {
    for (let dy = 0; dy < 3; dy++) for (let dx = -h; dx <= h; dx++) for (let dz = -h; dz <= h; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === h) cells.push([x + dx, y + dy, z + dz])
    for (let d = h - 1; d >= 0; d--) for (let dx = -d; dx <= d; dx++) for (let dz = -d; dz <= d; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === d) cells.push([x + dx, y + 2, z + dz])
  }
  for (const [cx, cy, cz] of cells) if (api.blockAt(cx, cy, cz) === 'air') await api.place(cx, cy, cz).catch(() => {})
  return 'done'
}`

const draft = (name: string, code: string, channels = ['legs', 'aim', 'hands']) =>
  ({ name, description: `stub ${name}`, code, channels, targets: 'block', timeout_s: 20, usage: `stub ${name}` })
const DRAFTS: Record<string, (round: number) => string[]> = {
  bridge: round => round === 1 ? Array(4).fill(bridge('Math.min(t.count, 3)')) : [LIAR, ...Array(3).fill(bridge('t.count'))],
  swim_across: () => Array(4).fill(SWIM),
  shelter: () => Array(4).fill(SHELTER)
}

export function stubModel (action: string, round: number) {
  const usage = { inputTokens: {}, outputTokens: {} } as any
  return new MockLanguageModelV4({
    doGenerate: [
      ...DRAFTS[action](round).map((code, i) => ({
        content: [{ type: 'tool-call' as const, toolCallId: `${action}-${round}-${i}`, toolName: 'write_behavior', input: JSON.stringify(draft(action, code)) }],
        finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage, warnings: []
      })),
      { content: [{ type: 'text' as const, text: 'stub: out of drafts' }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] }
    ]
  })
}
