// decide(): calls Jev with at most one call in flight; the latest state wins (brain/architecture/system-1.md).
import type { Bot } from 'mineflayer'
import type { Channels, Channel } from './behaviors.ts'
import { rawSnapshot, type Directive, type Handles } from './encoder.ts'
import { ENCODERS, LIMITS, optionsFor, shuffled, version, type Choice, type Option, type Program } from './program.ts'

const MODEL = 'jev-1.13.0' // pinned: thresholds are tuned against a version, aliases move

export type Ask = (state: unknown, questions: Record<string, unknown>) => Promise<any>

export const askJev: Ask = async (state, questions) => {
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state, questions }),
    signal: AbortSignal.timeout(LIMITS.deadlineMs)
  })
  if (!res.ok) throw new Error(`jev ${res.status}: ${await res.text()}`)
  return res.json()
}

// Triggers that fire while a call is in flight merge into the next call, which reads the newest state.
export function coalescing (run: (reasons: string[]) => Promise<void>, minIntervalMs: number) {
  let inflight = false
  let pending: string[] = []
  let last = 0
  async function loop () {
    inflight = true
    while (pending.length) {
      const wait = last + minIntervalMs - Date.now()
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      const reasons = pending
      pending = []
      last = Date.now()
      try { await run(reasons) } catch (err) { console.error('[decide]', err) }
    }
    inflight = false
  }
  return (reason: string) => {
    pending.push(reason)
    if (!inflight) void loop()
  }
}

export type DecideCtx = {
  bot: Bot
  program: Program
  handles: Handles
  channels: Channels
  directive: () => Directive | null
  events: () => string[]
  remaining: (block: string) => number // what's left of the goal's count for a block type
  trace: (record: Record<string, unknown>) => void
  ask?: Ask
}

export function makeDecider (ctx: DecideCtx) {
  const encode = ENCODERS[ctx.program.encoder.module](ctx.program.encoder.params)
  const programVersion = version(ctx.program)

  return async function decideOnce (reasons: string[]) {
    const t0 = Date.now()
    const raw = rawSnapshot(ctx.bot)
    const enc = encode(ctx.bot, { handles: ctx.handles, directive: ctx.directive(), channels: ctx.channels.describe(), events: ctx.events() })
    const encodeMs = Date.now() - t0
    if (encodeMs > LIMITS.encodeMs) console.warn(`[decide] encoder took ${encodeMs} ms (budget ${LIMITS.encodeMs})`)
    const state = { guidance: ctx.program.guidance, ...enc.state }

    const questions: Record<string, unknown> = {}
    const options: Record<string, Record<string, Option>> = {}
    const optionOrder: Record<string, string[]> = {}
    for (const [id, q] of Object.entries(ctx.program.questions)) {
      if (q.type === 'noul') { questions[id] = { type: 'noul', instructions: q.instructions }; continue }
      options[id] = optionsFor(q.claims, ctx.program.allowed_behaviors, enc, running(ctx, q), ctx.remaining)
      // Shuffled per call and traced: Jev leans toward early options on close calls.
      optionOrder[id] = shuffled(Object.keys(options[id])).slice(0, LIMITS.options)
      questions[id] = { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(optionOrder[id].map(k => [k, options[id][k].desc])) }
    }

    let res: any
    let error: string | undefined
    try { res = await (ctx.ask ?? askJev)(state, questions) } catch (err) { error = String(err) }
    const latencyMs = Date.now() - t0

    // Whole-body questions first: a whole-body start wins its channels for this call.
    const choices = Object.entries(ctx.program.questions)
      .filter((e): e is [string, Choice] => e[1].type === 'choice')
      .sort((a, b) => b[1].claims.length - a[1].claims.length)
    const claimed = new Set<Channel>()
    const applied: Record<string, string> = {}
    let escalate = Object.keys(ctx.program.questions).some(id => res?.answers?.[id]?.noul > ctx.program.escalate_when.noul_above)
    for (const [id, q] of choices) {
      const a = res?.answers?.[id]
      if (!a) continue
      escalate ||= a.confidence < ctx.program.escalate_when.confidence_below
      if (q.claims.some(c => claimed.has(c))) { applied[id] = 'overridden'; continue }
      applied[id] = apply(ctx, q, a.choice, options[id][a.choice])
      if (applied[id] === 'started') q.claims.forEach(c => claimed.add(c))
    }

    ctx.trace({
      kind: 'decide', t: t0, program: programVersion, reasons, latency_ms: latencyMs, encode_ms: encodeMs, error,
      raw, state, option_order: optionOrder, answers: res?.answers, model: res?.model, usage: res?.usage, applied, escalate
    })
    // ponytail: no System 2 yet, so an escalation is only traced.
    if (escalate) console.log('[escalate]', JSON.stringify(res?.answers))
  }
}

// The option a question counts as running: its channels' holder, if that's one of its own behaviors
// (a single-channel question also counts a whole-body holder, so `stop` there ends it).
function running (ctx: DecideCtx, q: Choice): string | null {
  const holder = ctx.channels.slots[q.claims[0]]
  if (holder?.status !== 'running') return null
  return q.claims.length === 1 || q.claims.every(c => holder.channels.includes(c)) ? holder.key : null
}

// Apply one answer, checking an entity target is still live (Jev answers ~100–300 ms late).
function apply (ctx: DecideCtx, q: Choice, choice: string, opt: Option | undefined): string {
  if (choice === 'keep_current') return 'kept'
  if (choice === 'stop') { ctx.channels.stop(q.claims); return 'stopped' }
  if (!opt?.behavior) return 'unknown_option'
  if (opt.block) { ctx.channels.set(choice, opt.behavior, opt.block); return 'started' }
  const id = ctx.handles.byHandle.get(opt.handle!)
  const target = id === undefined ? undefined : ctx.bot.entities[id]
  if (!target) return 'stale_target'
  ctx.channels.set(choice, opt.behavior, target)
  return 'started'
}
