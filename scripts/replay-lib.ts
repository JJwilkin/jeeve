// Shared by the replay experiments (brain/architecture/stateful-system-1.md): recorded bench traces, Jev calls,
// the doubtful states 2A answered (with labels), and scoring forward/reversed answers.
import { readFileSync, existsSync } from 'node:fs'

export type Row = Record<string, any>

// Inlined from src/decide.ts and src/program.ts, so replays run without installing the agent's dependencies.
export const optionTarget = (key: string) => key.replace(/\(\d+\)$/, '')
export async function askJev (state: unknown, questions: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'jev-1.13.0', state, questions }),
        signal: AbortSignal.timeout(5000)
      })
      if (!res.ok) throw new Error(`jev ${res.status}: ${await res.text()}`)
      return (await res.json()).answers
    } catch (err) {
      if (attempt === 2) throw err
      await new Promise(r => setTimeout(r, 500))
    }
  }
}

export const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }

export function loadSessions (traces = arg('traces', '../jeeve-monitor/traces'), runs = Number(arg('runs', '59'))) {
  const results = readFileSync('bench/results.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l)).slice(-runs)
  return results.filter(r => existsSync(`${traces}/${r.session}.jsonl`)).map(r => ({
    scenario: r.scenario as string,
    rows: readFileSync(`${traces}/${r.session}.jsonl`, 'utf8').split('\n').flatMap(l => { try { return l ? [JSON.parse(l) as Row] : [] } catch { return [] } })
  }))
}
export type Session = ReturnType<typeof loadSessions>[number]

export const CHOICES = ['body', 'legs', 'aim', 'hands']
export const MOOT = new Set(['overridden', 'pinned', 'held', 'dwell']) // the answer couldn't change anything this call
export const changedNothing = (x: Row) => !x.goal && !x.program && !x.push_child && x.goal_action === 'none' && !x.new_modules?.length && !x.requests?.length && !x.plan?.length && !x.message

// The 2A call that answered a decide span's low_confidence escalation.
export const answeredBy = (rows: Row[], span: string, after: number) =>
  rows.find(r => r.kind === 'system2' && r.t > after && r.input?.triggers?.some((t: Row) => t.detail?.decide_span === span))

// Doubtful questions whose escalation 2A answered, labelled with Jev's pick after the answer (its own pick if 2A
// changed nothing). Moot answers are left out.
export type Doubt = { scenario: string, sess: number, i: number, q: string, state: Row, question: Row, label: string, original: Row }
export function labelledDoubts (sessions: Session[], conf = 0.5): Doubt[] {
  const pool: Doubt[] = []
  sessions.forEach((s, sess) => {
    const sent = new Map(s.rows.filter(r => r.kind === 'escalation_sent' && r.reason === 'low_confidence' && r.detail?.decide_span).map(r => [r.detail.decide_span, r.t]))
    s.rows.forEach((d, i) => {
      if (d.kind !== 'decide' || !sent.has(d.span_id)) return
      const call = answeredBy(s.rows, d.span_id, sent.get(d.span_id)!)
      if (!call?.output?.decision) return
      const after = s.rows.find(r => r.kind === 'decide' && r.t > call.t)
      for (const q of CHOICES) {
        if (!(d.output.answers?.[q]?.confidence < conf) || MOOT.has(d.output.applied?.[q])) continue
        const options = Object.keys(d.input.questions[q].criteria).map(optionTarget)
        const label = changedNothing(call.output.decision) ? optionTarget(d.output.answers[q].choice) : optionTarget(after?.output?.answers?.[q]?.choice ?? '')
        if (!options.includes(label)) continue // the next call offered something else: no label
        pool.push({ scenario: s.scenario, sess, i, q, state: d.input.state, question: d.input.questions[q], label, original: d.output.answers[q] })
      }
    })
  })
  return pool
}

// Seeded, so reruns pick the same states.
export function seeded (seed = 7) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647 }

// Round-robin over groups (e.g. scene/question) until n are taken.
export function stratified<T> (xs: T[], key: (x: T) => string, n: number, rand = seeded()): T[] {
  const groups = new Map<string, T[]>()
  for (const x of xs) groups.set(key(x), [...(groups.get(key(x)) ?? []), x])
  for (const g of groups.values()) g.sort(() => rand() - 0.5)
  const out: T[] = []
  while (out.length < n && [...groups.values()].some(g => g.length)) for (const g of groups.values()) if (g.length && out.length < n) out.push(g.pop()!)
  return out
}

export const reorder = (q: Row, reverse: boolean) => q.type !== 'choice' ? q : { ...q, criteria: Object.fromEntries(reverse ? Object.entries(q.criteria).reverse() : Object.entries(q.criteria)) }
export type Cell = { fwd: Row, rev: Row } // answers by question id, asked in the recorded order and reversed

export async function askBoth (state: Row, questions: Record<string, Row>): Promise<Cell> {
  const re = (rev: boolean) => Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, reorder(q, rev)]))
  const [fwd, rev] = await Promise.all([askJev(state, re(false)), askJev(state, re(true))])
  return { fwd, rev }
}

// Runs jobs with a few in flight (well under the account's 80 req/s).
export async function pool<T, R> (items: T[], run: (x: T) => Promise<R>, width = 6): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: width }, async () => { while (next < items.length) { const i = next++; out[i] = await run(items[i]) } }))
  return out
}

const pct = (x: number, d: number) => d ? +(100 * x / d).toFixed(1) : null
// Doubt, agreement with the label, and flips under reversal for one Choice question; "debiased" averages the orders.
export function score (cells: Cell[], q: string | ((i: number) => string), labels: string[], conf = 0.5) {
  let doubt = 0; let agree = 0; let flips = 0; let dbDoubt = 0; let dbAgree = 0
  cells.forEach((c, i) => {
    const id = typeof q === 'string' ? q : q(i)
    const [f, r] = [c.fwd[id], c.rev[id]]
    for (const a of [f, r]) { if (a.confidence < conf) doubt++; if (optionTarget(a.choice) === labels[i]) agree++ }
    if (optionTarget(f.choice) !== optionTarget(r.choice)) flips++
    const p: Record<string, number> = {}
    for (const a of [f, r]) for (const [k, v] of Object.entries(a.probabilities as Record<string, number>)) p[k] = (p[k] ?? 0) + v / 2
    if ((f.confidence + r.confidence) / 2 < conf) dbDoubt++
    if (optionTarget(Object.entries(p).sort((x, y) => y[1] - x[1])[0][0]) === labels[i]) dbAgree++
  })
  const n = cells.length
  return { n, doubt_pct: pct(doubt, 2 * n), agree_pct: pct(agree, 2 * n), flip_pct: pct(flips, n), debiased_doubt_pct: pct(dbDoubt, n), debiased_agree_pct: pct(dbAgree, n) }
}

// Same names as the encoder's buckets (src/encoder.ts), copied so replays don't load Mineflayer.
export const distanceBucket = (d: number) => d < 3 ? 'very close' : d < 8 ? 'close' : d < 16 ? 'medium' : 'far'
export function direction (dx: number, dz: number, yaw: number): string {
  let rel = (Math.atan2(-dx, -dz) - yaw) * 180 / Math.PI
  rel = ((rel % 360) + 540) % 360 - 180
  const side = rel > 0 ? 'left' : 'right'
  const a = Math.abs(rel)
  return a < 22.5 ? 'ahead' : a < 67.5 ? `ahead-${side}` : a < 112.5 ? side : a < 157.5 ? `behind-${side}` : 'behind'
}
// North is -z in Minecraft.
export function compass (dx: number, dz: number): string {
  const deg = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(deg / 45) % 8]
}
export const ago = (ms: number) => ms < 3000 ? 'just now' : ms < 10_000 ? 'a few seconds ago' : ms < 30_000 ? 'under half a minute ago' : 'a while ago'
