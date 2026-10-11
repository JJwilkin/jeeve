// A System 1 program: a declarative manifest over registered modules (brain/architecture/system-1.md).
import { createHash } from 'node:crypto'
import { BEHAVIORS, STOP_DESC, type Channel } from './behaviors.ts'
import { makeEgocentric, type Encoded } from './encoder.ts'

export type Choice = { type: 'choice', claims: Channel[], instructions: string }
export type Program = {
  parent: string | null
  reason: string
  encoder: { module: string, params: Parameters<typeof makeEgocentric>[0] }
  questions: Record<string, Choice | { type: 'noul', instructions: string }>
  triggers: { events: string[], hostile_within: number, heartbeat_ms: number, watch?: string[] } // watch: authored watch modules
  escalate_when: { confidence_below: number, noul_above: number }
  allowed_behaviors: string[]
  guidance: string
}

// Fixed bounds System 2 can't change; starting values from brain/research/jev-measurements.md.
export const LIMITS = { questions: 32, options: 255, inputTokens: 8000, minIntervalMs: 200, deadlineMs: 1000, encodeMs: 20 }

// Registered modules. Built-ins are just modules registered in advance.
// ponytail: no authoring/sandbox pipeline yet; it lands with System 2 (same pipeline as behaviors).
export const ENCODERS: Record<string, typeof makeEgocentric> = { 'egocentric@1': makeEgocentric }

export const version = (p: Program) => 'v-' + createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 8)

const sameSet = (a: Channel[], b: Channel[]) => a.length === b.length && a.every(c => b.includes(c))
// A disabled authored behavior stays allowed (the program still validates) but is no longer offered.
export const behaviorsFor = (claims: Channel[], allowed: string[]) => allowed.filter(b => BEHAVIORS[b] && !BEHAVIORS[b].disabled && sameSet(BEHAVIORS[b].channels, claims))

// An entity target is a handle, resolved to a live entity when the answer arrives.
export type Option = { desc: string, behavior?: string, handle?: string, block?: { name: string, count: number } }

// Option generator `behaviors_x_targets`: behaviors whose channel set is the question's × encoded
// targets (entities, or block types with what's left of the goal's count), plus `keep_current` and `stop`.
// No two options may mean the same thing: Jev splits probability between them and confidence collapses.
// So `stop` is offered only while something runs, and the running option only as `keep_current`.
export function optionsFor (
  claims: Channel[], allowed: string[], enc: Pick<Encoded, 'entities' | 'blocks'>,
  running: string | null, remaining: (block: string) => number
): Record<string, Option> {
  const whole = claims.length > 1
  const opts: Record<string, Option> = running
    ? { keep_current: { desc: `Keep doing ${running}` }, stop: { desc: whole ? `Stop ${running}` : STOP_DESC[claims[0]] } }
    : { keep_current: { desc: whole ? 'Start no whole-body task now' : STOP_DESC[claims[0]] } }
  for (const name of behaviorsFor(claims, allowed)) {
    const spec = BEHAVIORS[name]
    const targets: Array<[string, Option]> = spec.targets === 'entity'
      ? enc.entities.map(e => [`${name}:${e.id}`, { desc: spec.describe(`${e.id} (${e.desc})`), behavior: name, handle: e.id }])
      : enc.blocks.flatMap(b => {
        const n = remaining(b.name)
        return n > 0 ? [[`${name}:${b.name}(${n})`, { desc: spec.describe(`${n} ${b.name} (${b.desc})`), behavior: name, block: { name: b.name, count: n } }]] : []
      })
    for (const [key, opt] of targets) if (key !== running) opts[key] = opt
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
  for (const b of p.allowed_behaviors) if (!BEHAVIORS[b]) throw new Error(`unknown behavior ${b} (an authored behavior can be allowed once its trial passes)`)
  const covered = new Set<string>()
  for (const q of Object.values(p.questions)) {
    if (q.type !== 'choice') continue
    // Worst case options: keep_current + stop + behaviors × target cap.
    const max = 2 + behaviorsFor(q.claims, p.allowed_behaviors).reduce((sum, b) =>
      sum + (BEHAVIORS[b].targets === 'entity' ? p.encoder.params.entity_cap : p.encoder.params.block_cap), 0)
    if (max > LIMITS.options) throw new Error(`${q.claims.join('+')}: up to ${max} options (max ${LIMITS.options})`)
    for (const b of behaviorsFor(q.claims, p.allowed_behaviors)) covered.add(b)
  }
  const unasked = p.allowed_behaviors.filter(b => !covered.has(b) && !BEHAVIORS[b].disabled)
  if (unasked.length) throw new Error(`allowed but no question offers them: ${unasked.join(', ')}`)
}

// The default program, also the pinned fallback. Scaffolding: the baseline every program has to beat.
// Whole-body behaviors (collect) get one joint `body` Choice; single-channel ones a Choice per channel.
export const DEFAULT_PROGRAM: Program = {
  parent: null,
  reason: 'default program (pinned fallback)',
  encoder: { module: 'egocentric@1', params: { entity_cap: 8, radius: 16, block_radius: 8, block_cap: 6, rare_max: 64 } },
  questions: {
    body: { type: 'choice', claims: ['legs', 'aim', 'hands'], instructions: 'Should the bot start or keep a whole-body task now?' },
    legs: { type: 'choice', claims: ['legs'], instructions: 'Which behavior should the legs (movement) run now?' },
    aim: { type: 'choice', claims: ['aim'], instructions: 'Which behavior should the aim (where the bot looks) run now?' },
    hands: { type: 'choice', claims: ['hands'], instructions: 'Which behavior should the hands (attacking) run now?' },
    escalate: { type: 'noul', instructions: 'Is this a situation the directive and the available behaviors cannot handle, so a slower planner should take over?' }
  },
  triggers: {
    events: ['done', 'stuck', 'vetoed', 'none_found', 'target_lost', 'target_dead', 'damage_taken', 'new_directive', 'hostile_near'],
    hostile_within: 6,
    heartbeat_ms: 1000
  },
  escalate_when: { confidence_below: 0.5, noul_above: 0.5 },
  allowed_behaviors: ['navigate', 'follow', 'track', 'attack_when_ready', 'collect'],
  guidance: [
    'You are the fast controller of a Minecraft bot. Carry out the directive from the player who gave it.',
    '"Come here" means walk to that player. "Follow me" means keep following that player. "Collect" means use the whole-body collect task.',
    'Hostile mobs near the bot or the player it is protecting should be attacked when the directive allows it or when they threaten the bot.',
    'Prefer keep_current while the current behavior is still the right one; switching too often wastes time.'
  ].join(' ')
}
