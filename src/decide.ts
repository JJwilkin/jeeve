// decide(): calls Jev with at most one call in flight; the latest state wins (brain/architecture/system-1.md).
import type { Bot } from 'mineflayer'
import { BEHAVIORS, type Channels, type Channel } from './behaviors.ts'
import { rawSnapshot, type Directive, type Handles } from './encoder.ts'
import { ENCODERS, LIMITS, optionsFor, shuffled, version, type Program } from './program.ts'

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
    const state = { guidance: ctx.program.guidance, ...enc.state }

    const questions: Record<string, unknown> = {}
    const optionOrder: Record<string, string[]> = {}
    for (const [id, q] of Object.entries(ctx.program.questions)) {
      if (q.type === 'noul') { questions[id] = { type: 'noul', instructions: q.instructions }; continue }
      const slot = ctx.channels.slots[q.channel]
      const opts = optionsFor(q.channel, ctx.program.allowed_behaviors, enc.entities, slot?.status === 'running' ? slot.key : null)
      // Shuffled per call and traced: Jev leans toward early options on close calls.
      optionOrder[id] = shuffled(Object.keys(opts)).slice(0, LIMITS.options)
      questions[id] = { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(optionOrder[id].map(k => [k, opts[k]])) }
    }

    let res: any
    let error: string | undefined
    try { res = await (ctx.ask ?? askJev)(state, questions) } catch (err) { error = String(err) }
    const latencyMs = Date.now() - t0

    const applied: Record<string, string> = {}
    let escalate = false
    for (const [id, q] of Object.entries(ctx.program.questions)) {
      const a = res?.answers?.[id]
      if (!a) continue
      if (q.type === 'noul') { escalate ||= a.noul > ctx.program.escalate_when.noul_above; continue }
      escalate ||= a.confidence < ctx.program.escalate_when.confidence_below
      applied[q.channel] = apply(ctx, q.channel, a.choice)
    }

    ctx.trace({
      kind: 'decide', t: t0, program: programVersion, reasons, latency_ms: latencyMs, error,
      raw, state, option_order: optionOrder, answers: res?.answers, model: res?.model, usage: res?.usage, applied, escalate
    })
    // ponytail: no System 2 yet, so an escalation is only traced.
    if (escalate) console.log('[escalate]', JSON.stringify(res?.answers))
  }
}

// Apply one channel's choice, checking it still binds to a live entity (Jev answers ~200 ms late).
function apply (ctx: DecideCtx, channel: Channel, choice: string): string {
  if (choice === 'keep_current') return 'kept'
  if (choice === 'stop') { ctx.channels.set(channel, 'stop', null); return 'stopped' }
  if (ctx.channels.slots[channel]?.key === choice && ctx.channels.slots[channel]?.status === 'running') return 'kept'
  const [behavior, handle] = choice.split(':')
  const id = ctx.handles.byHandle.get(handle)
  const target = id === undefined ? undefined : ctx.bot.entities[id]
  if (!BEHAVIORS[behavior] || !target) return 'stale_target'
  ctx.channels.set(channel, choice, behavior, target)
  return 'started'
}
