// The all-seeing eye (brain/architecture/benchmarks.md): a bench run's ground truth (world.jsonl, recorded by Josh,
// who sees every block) next to what Jeeve believed and did (its trace), to find gaps in its perception and search.
//   node scripts/gaps.ts clips/<dir>          prints the report and writes <dir>/gaps.md
import { readFileSync, writeFileSync } from 'node:fs'
import { makeWorld, parseWorld, type Block } from '../viz/src/world.ts'

type Cluster = { names: Record<string, number>, min: number[], max: number[] }
const dir = process.argv[2]
const clip = JSON.parse(readFileSync(`${dir}/clip.json`, 'utf8'))
const trace = readFileSync(`traces/${clip.session}.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const world = makeWorld(parseWorld(readFileSync(`${dir}/world.jsonl`, 'utf8')))!
const t0 = clip.start
const sec = (t: number) => `${((t - t0) / 1000).toFixed(0)}s`
const out: string[] = []
const say = (s = '') => out.push(s)

// Truth as clusters, terrain left out (types with more than 512 in the box), like the seen map.
function truthClusters (t: number): Cluster[] {
  const all = world.allAt(t)
  const count: Record<string, number> = {}
  for (const b of all) count[b.name] = (count[b.name] ?? 0) + 1
  const keep = all.filter(b => count[b.name] <= 512)
  const key = (p: number[]) => p.join(',')
  const left = new Map(keep.map(b => [key(b.pos), b]))
  const clusters: Cluster[] = []
  for (const b of keep) {
    if (!left.has(key(b.pos))) continue
    left.delete(key(b.pos))
    const members: Block[] = [b]
    for (let i = 0; i < members.length; i++) {
      const [x, y, z] = members[i].pos
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const n = left.get(`${x + dx},${y + dy},${z + dz}`)
        if (n) { left.delete(key(n.pos)); members.push(n) }
      }
    }
    const names: Record<string, number> = {}
    for (const m of members) names[m.name] = (names[m.name] ?? 0) + 1
    const axis = (i: number, f: (...n: number[]) => number) => f(...members.map(m => m.pos[i]))
    clusters.push({ names, min: [axis(0, Math.min), axis(1, Math.min), axis(2, Math.min)], max: [axis(0, Math.max), axis(1, Math.max), axis(2, Math.max)] })
  }
  return clusters
}
const overlaps = (a: Cluster, b: Cluster) => [0, 1, 2].every(i => a.min[i] - 1 <= b.max[i] && b.min[i] - 1 <= a.max[i])
const total = (c: Cluster) => Object.values(c.names).reduce((n, v) => n + v, 0)
const label = (c: Cluster) => `${Object.entries(c.names).map(([k, v]) => `${v} ${k}`).join(' + ')} at x${c.min[0]}..${c.max[0]} z${c.min[2]}..${c.max[2]}`

say(`# Gaps: ${clip.scenario} (${clip.session})`)
say()
say('## What 2A believed vs. the world, at each 2A call')
for (const r of trace.filter(r => r.kind === 'system2' && r.input?.seen_map)) {
  const truth = truthClusters(r.t)
  const seen = r.input.seen_map as Cluster[]
  const unseen = truth.filter(c => !seen.some(s => overlaps(s, c)))
  const stale = seen.filter(s => !truth.some(c => overlaps(s, c)))
  // A canopy's hidden inside is expected under line of sight: flag only counts under half the truth, or above it.
  const off = truth.flatMap(c => { const s = seen.find(x => overlaps(x, c)); return s && (total(s) < total(c) / 2 || total(s) > total(c)) ? [`${label(c)} believed ${total(s)}`] : [] })
  const trig = r.attrs?.['jeeve.system2.trigger']
  if (!unseen.length && !stale.length && !off.length) { say(`- ${sec(r.t)} ${trig}: matches (${truth.length} clusters)`); continue }
  say(`- ${sec(r.t)} ${trig}:${unseen.length ? ` **unseen** ${unseen.map(label).join('; ')}.` : ''}${stale.length ? ` **stale** ${stale.map(label).join('; ')}.` : ''}${off.length ? ` **counts off** ${off.join('; ')}.` : ''}`)
}

// Search: when each object (a truth cluster at the start) first showed up in 2A's map.
say()
say('## Search: when each object first showed up in 2A\'s map')
{
  const calls = trace.filter(r => r.kind === 'system2' && r.input?.seen_map)
  for (const c of truthClusters(clip.start)) {
    const first = calls.find(r => (r.input.seen_map as Cluster[]).some(s => overlaps(s, c)))
    say(`- ${label(c)}: ${first ? `known at ${sec(first.t)}` : '**never seen**'}`)
  }
}

say()
say('## Goals closed vs. the world')
const pushed = new Map(trace.filter(r => r.kind === 'goal' && r.attrs?.['jeeve.goal.transition'] === 'pushed').map(r => [r.attrs['jeeve.goal.id'], r.input]))
for (const r of trace.filter(r => r.kind === 'goal' && r.attrs?.['jeeve.goal.transition'] === 'completed')) {
  const at = pushed.get(r.attrs['jeeve.goal.id'])?.place
  const module = pushed.get(r.attrs['jeeve.goal.id'])?.check?.module
  // Only a goal whose check says the spot is clear can be falsely done that way.
  if (!at || (module !== 'cleared' && module !== 'authored')) { say(`- ${sec(r.t)} ${r.attrs['jeeve.goal.id']} completed (${r.output?.summary ?? ''})`); continue }
  const left = world.allAt(r.t).filter(b => /_(log|leaves)$/.test(b.name) && Math.abs(b.pos[0] - at[0]) <= 2 && Math.abs(b.pos[2] - at[2]) <= 2).length
  say(`- ${sec(r.t)} ${r.attrs['jeeve.goal.id']} completed at [${at}]: ${left ? `**${left} logs/leaves still there (false done)**` : 'truly clear'}`)
}

say()
say('## Where the time went')
const start = trace.find(r => r.kind === 'goal' && r.input?.from)?.t ?? t0
const end = clip.end
const open = new Map<string, { name: string, t: number }>()
const busy: Record<string, number> = {}
const intervals: Array<[number, number]> = []
for (const r of trace) {
  if (r.kind === 'behavior_start') open.set(r.run_id, { name: r.name, t: r.t })
  if (r.kind === 'behavior_end' && open.has(r.run_id)) {
    const o = open.get(r.run_id)!
    busy[o.name] = (busy[o.name] ?? 0) + (r.t - o.t)
    intervals.push([o.t, r.t])
    open.delete(r.run_id)
  }
}
let covered = 0, cursor = start
for (const [a, b] of intervals.filter(([, b]) => b > start).sort((x, y) => x[0] - y[0])) {
  const lo = Math.max(a, cursor), hi = Math.min(b, end)
  if (hi > lo) { covered += hi - lo; cursor = hi }
}
const s2 = trace.filter(r => r.kind === 'system2').reduce((n, r) => n + (r.attrs?.['jeeve.system2.latency_ms'] ?? 0), 0)
const builds = trace.filter(r => r.kind === 'builder').reduce((n, r) => n + (r.attrs?.['jeeve.builder.latency_ms'] ?? 0), 0)
say(`- run: ${((end - start) / 1000).toFixed(0)} s. **Body idle (no behavior running): ${((end - start - covered) / 1000).toFixed(0)} s.**`)
say(`- behaviors: ${Object.entries(busy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / 1000).toFixed(0)} s`).join(', ')}`)
say(`- 2A thinking: ${(s2 / 1000).toFixed(0)} s over ${trace.filter(r => r.kind === 'system2').length} calls; builder: ${(builds / 1000).toFixed(0)} s`)
const ends: Record<string, number> = {}
for (const r of trace.filter(r => r.kind === 'behavior_end')) { const run = trace.find(x => x.kind === 'behavior_start' && x.run_id === r.run_id); const k = `${run?.name}:${r.reason}`; ends[k] = (ends[k] ?? 0) + 1 }
say(`- behavior endings: ${Object.entries(ends).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ')}`)

const report = out.join('\n')
writeFileSync(`${dir}/gaps.md`, report + '\n')
console.log(report)
