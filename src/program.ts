// A System 1 program: a declarative manifest over registered modules (brain/architecture/system-1.md).
import { createHash } from 'node:crypto'
import { BEHAVIORS, STOP_DESC, type Channel } from './behaviors.ts'
import { makeEgocentric } from './encoder.ts'

export type Program = {
  parent: string | null
  reason: string
  encoder: { module: string, params: { entity_cap: number, radius: number } }
  questions: Record<string, { type: 'choice', channel: Channel, instructions: string } | { type: 'noul', instructions: string }>
  triggers: { events: string[], hostile_within: number, heartbeat_ms: number }
  escalate_when: { confidence_below: number, noul_above: number }
  allowed_behaviors: string[]
  guidance: string
}

// Fixed bounds System 2 can't change; starting values from brain/research/jev-measurements.md.
export const LIMITS = { questions: 32, options: 255, inputTokens: 8000, minIntervalMs: 200, deadlineMs: 1000 }

// Registered modules. Built-ins are just modules registered in advance.
// ponytail: no authoring/sandbox pipeline yet; it lands with System 2 (same pipeline as behaviors).
export const ENCODERS: Record<string, typeof makeEgocentric> = { 'egocentric@1': makeEgocentric }

export const version = (p: Program) => 'v-' + createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 8)

// Option generator `behaviors_x_targets`: allowed behaviors on this channel × encoded entities,
// plus `keep_current` and `stop`. Returns option key → description, for a Jev Choice's criteria.
// No two options may mean the same thing: Jev splits probability between them and confidence collapses.
// So `stop` is offered only while something runs, and the running option only as `keep_current`.
export function optionsFor (channel: Channel, allowed: string[], entities: Array<{ id: string, desc: string }>, running: string | null): Record<string, string> {
  const opts: Record<string, string> = running
    ? { keep_current: `Keep doing ${running}`, stop: STOP_DESC[channel] }
    : { keep_current: STOP_DESC[channel] }
  for (const name of allowed) {
    if (BEHAVIORS[name]?.channel !== channel) continue
    for (const e of entities) {
      const key = `${name}:${e.id}`
      if (key !== running) opts[key] = BEHAVIORS[name].describe(`${e.id} (${e.desc})`)
    }
  }
  return opts
}

export function shuffled<T> (xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// The mechanical check before activation: shape and caps. Throws on the first violation.
export function validate (p: Program) {
  const n = Object.keys(p.questions).length
  if (n === 0 || n > LIMITS.questions) throw new Error(`questions: ${n} (max ${LIMITS.questions})`)
  if (!ENCODERS[p.encoder.module]) throw new Error(`unknown encoder ${p.encoder.module}`)
  for (const b of p.allowed_behaviors) if (!BEHAVIORS[b]) throw new Error(`unknown behavior ${b}`)
  // Worst case options per Choice: 2 + behaviors on the channel × entity cap.
  for (const q of Object.values(p.questions)) {
    if (q.type !== 'choice') continue
    const per = p.allowed_behaviors.filter(b => BEHAVIORS[b].channel === q.channel).length
    const max = 2 + per * p.encoder.params.entity_cap
    if (max > LIMITS.options) throw new Error(`${q.channel}: up to ${max} options (max ${LIMITS.options})`)
  }
}

// The default program, also the pinned fallback. Scaffolding: the baseline every program has to beat.
export const DEFAULT_PROGRAM: Program = {
  parent: null,
  reason: 'default program (pinned fallback)',
  encoder: { module: 'egocentric@1', params: { entity_cap: 8, radius: 16 } },
  questions: {
    legs: { type: 'choice', channel: 'legs', instructions: 'Which behavior should the legs (movement) run now?' },
    aim: { type: 'choice', channel: 'aim', instructions: 'Which behavior should the aim (where the bot looks) run now?' },
    hands: { type: 'choice', channel: 'hands', instructions: 'Which behavior should the hands (attacking) run now?' },
    escalate: { type: 'noul', instructions: 'Is this a situation the directive and the available behaviors cannot handle, so a slower planner should take over?' }
  },
  triggers: {
    events: ['done', 'stuck', 'target_lost', 'target_dead', 'damage_taken', 'new_directive', 'hostile_near'],
    hostile_within: 6,
    heartbeat_ms: 1000
  },
  escalate_when: { confidence_below: 0.5, noul_above: 0.5 },
  allowed_behaviors: ['navigate', 'follow', 'track', 'attack_when_ready'],
  guidance: [
    'You are the fast controller of a Minecraft bot. Carry out the directive from the player who gave it.',
    '"Come here" means walk to that player. "Follow me" means keep following that player.',
    'Hostile mobs near the bot or the player it is protecting should be attacked when the directive allows it or when they threaten the bot.',
    'Prefer keep_current while the current behavior is still the right one; switching too often wastes time.'
  ].join(' ')
}
