// System 2: a Claude call per instruction or escalation (brain/architecture/system-2.md).
// It reads the goal path, the program and recent events, may query its own traces with SQL,
// and ends by calling `submit_decision`. Code applies the decision.
import Anthropic from '@anthropic-ai/sdk'
import { BEHAVIORS } from './behaviors.ts'
import type { CheckSpec } from './goals.ts'

export const MODEL = process.env.JEEVE_SYSTEM2_MODEL ?? 'claude-opus-5-5'
const MAX_TURNS = 4

export type Decision = {
  note: string
  goal: { done_when: CheckSpec | null, escalate_if: CheckSpec[], budget_s: number | null, review_s: number | null } | null
  goal_action: 'none' | 'fail' | 'renew'
  push_child: { text: string, done_when: CheckSpec | null, budget_s: number | null } | null
  program: { guidance: string | null, allowed_behaviors: string[] | null, heartbeat_ms: number | null } | null
  message: string | null
}

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, 'null'], ...extra })
const CHECK = {
  type: 'object',
  additionalProperties: false,
  required: ['module', 'player', 'radius', 'match', 'count', 'negate', 'for_ms'],
  properties: {
    module: { type: 'string', enum: ['near_entity', 'inventory_delta', 'entity_alive'] },
    player: nullable('string', { description: 'near_entity, entity_alive: player name' }),
    radius: nullable('number', { description: 'near_entity: blocks' }),
    match: nullable('string', { description: 'inventory_delta: item name glob, e.g. "*_log"' }),
    count: nullable('integer', { description: 'inventory_delta: how many more than held when the goal was created' }),
    negate: { type: 'boolean', description: 'true: the check holds when the predicate is false' },
    for_ms: nullable('integer', { description: 'escalate_if only: fire after the condition has held this long' })
  }
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'submit_decision',
    description: 'Submit your decision. Call this exactly once, as your last action.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['note', 'goal', 'goal_action', 'push_child', 'program', 'message'],
      $defs: { check: CHECK },
      properties: {
        note: { type: 'string', description: 'One line for the goal log: what you decided and why.' },
        goal: {
          ...nullable('object'),
          description: "Set the active goal's success check. null leaves it unchanged. Required on a new instruction.",
          additionalProperties: false,
          required: ['done_when', 'escalate_if', 'budget_s', 'review_s'],
          properties: {
            done_when: { anyOf: [{ $ref: '#/$defs/check' }, { type: 'null' }], description: 'null for open-ended goals (they end only on a new instruction).' },
            escalate_if: { type: 'array', items: { $ref: '#/$defs/check' }, description: 'Conditions that should call you back, e.g. the protected player far away for 10 s.' },
            budget_s: nullable('integer', { description: 'Closed goals: time limit before you are called back.' }),
            review_s: nullable('integer', { description: 'Open-ended goals: how often you review them.' })
          }
        },
        goal_action: { type: 'string', enum: ['none', 'fail', 'renew'], description: 'fail: give up on the active goal (say why in message). renew: restart its budget or review timer.' },
        push_child: {
          ...nullable('object'),
          description: 'Push an interrupt sub-goal under the active goal (e.g. "get away from the creeper"). Usually null.',
          additionalProperties: false,
          required: ['text', 'done_when', 'budget_s'],
          properties: { text: { type: 'string' }, done_when: { anyOf: [{ $ref: '#/$defs/check' }, { type: 'null' }] }, budget_s: nullable('integer') }
        },
        program: {
          ...nullable('object'),
          description: "Change System 1's program for the active goal. null keeps it. Changes revert when the goal closes.",
          additionalProperties: false,
          required: ['guidance', 'allowed_behaviors', 'heartbeat_ms'],
          properties: {
            guidance: nullable('string', { description: 'Full replacement guidance for the fast model. Concrete and short.' }),
            allowed_behaviors: { anyOf: [{ type: 'array', items: { type: 'string', enum: Object.keys(BEHAVIORS) } }, { type: 'null' }] },
            heartbeat_ms: nullable('integer', { description: 'How often the fast model re-decides without an event (200–5000).' })
          }
        },
        message: nullable('string', { description: 'Whisper to the player who gave the instruction. Only for failures, refusals or clarifying questions.' })
      }
    }
  },
  {
    name: 'run_sql',
    description: 'Run one read-only SELECT over your own traces (tables telemetry.traces and telemetry.spans; span attributes are in attributes[\'jeeve.*\']). Use it when the escalation needs history beyond what you were given.',
    // Not strict: two strict tools compile to a grammar the API rejects as too large, and a single string needs none.
    input_schema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string' } } }
  }
]

const SYSTEM = `You are System 2 of Jeeve, a Minecraft bot that joins servers as a normal player and takes instructions from players.

You are the slow planner. A fast decision model (System 1, "Jev") picks a behavior per channel several times a second under a program you shape: guidance text, the allowed behaviors and how often it re-decides. Deterministic code runs the behaviors and safety guards. You are called when an instruction arrives or something escalates. The bot never waits for you: it keeps acting on the current program while you think.

Behaviors System 1 can choose from:
${Object.entries(BEHAVIORS).map(([n, b]) => `- ${n} (${b.channels.join('+')}): ${b.describe('<target>')}`).join('\n')}

Success checks are code you parameterize: near_entity(player, radius), inventory_delta(match glob, count), entity_alive(player). Code evaluates them every tick, marks a goal completed when its done_when passes, and tells the player. You never need to say "done".

On a new instruction: set the goal's done_when (or null if open-ended), escalate_if conditions, and a budget (closed goals) or review interval (open-ended goals). Adjust the program only if the default guidance is not enough. On an escalation: read what happened and decide whether to change the program, fail the goal (with a message saying why), push a sub-goal, or carry on (goal_action "none", everything else null).

Keep program changes small and concrete; they last only while the goal is active. Use your Minecraft knowledge to fill in check values (for example, any log is "*_log"). Only message the player for failures, refusals or clarifying questions. Always finish by calling submit_decision.`

// Jeeve's own span vocabulary (brain/architecture/trace-schema.md), so queries don't burn turns on discovery.
const TRACES = `Your traces (Judgment virtual SQL, project-scoped). One session per episode (session_id), one trace per window.
Span names: window, carry_over, system2, program, decide, goal, behavior.<name> (navigate, follow, track, attack_when_ready, collect).
Columns: span_name, session_id, trace_id, started_at, input, output, attributes (Map(String,String)), events_json.
Keys: jeeve.window_index, jeeve.prev_trace_id, jeeve.goal.path, jeeve.goal.id, jeeve.goal.transition, jeeve.program.version,
jeeve.program.because, jeeve.decide.trigger, jeeve.decide.changed, jeeve.decide.escalate, jeeve.decide.latency_ms, jeeve.decide.raw_state,
jeeve.behavior.name, jeeve.behavior.params, jeeve.behavior.run_id, jeeve.behavior.end_reason (done, stuck, none_found, target_dead,
target_lost, vetoed, replaced, stopped, cut, goal_closed, death), jeeve.behavior.decided_by, jeeve.system2.trigger.
Window events (events_json on window spans): death, damage, owner_damage, vetoed, chat.`

export type System2Result = { decision: Decision | null, model: string, usage: Anthropic.Beta.BetaUsage | null, turns: number, sql: string[], refusal: boolean }

export function makeSystem2 (opts: { sql?: (q: string) => Promise<unknown>, schema?: string, effort: (trigger: string) => 'low' | 'medium' | 'high' }) {
  const client = new Anthropic()
  // Stable for the whole run, so it stays in the cached prefix.
  const system = opts.sql ? `${SYSTEM}\n\n${TRACES}\n\n${opts.schema ?? ''}` : SYSTEM
  return async function call (trigger: string, context: Record<string, unknown>): Promise<System2Result> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: JSON.stringify({ trigger, ...context }) }]
    const sqls: string[] = []
    let usage: Anthropic.Beta.BetaUsage | null = null
    let model = MODEL
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const res = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: opts.effort(trigger) },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        // The last turn offers only submit_decision, so a call always ends in a decision.
        tools: opts.sql && turn < MAX_TURNS ? TOOLS : TOOLS.slice(0, 1),
        messages
      } as Anthropic.Beta.MessageCreateParamsNonStreaming)
      usage = res.usage
      model = res.model
      if (res.stop_reason === 'refusal') return { decision: null, model, usage, turns: turn, sql: sqls, refusal: true }
      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      const submit = calls.find(c => c.name === 'submit_decision')
      if (submit) return { decision: submit.input as Decision, model, usage, turns: turn, sql: sqls, refusal: false }
      if (!calls.length) break
      messages.push({ role: 'assistant', content: res.content })
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
      for (const c of calls) {
        const q = (c.input as { query: string }).query
        sqls.push(q)
        try {
          const out = JSON.stringify(await opts.sql!(q))
          results.push({ type: 'tool_result', tool_use_id: c.id, content: out.length > 20000 ? out.slice(0, 20000) + '…(truncated)' : out })
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: c.id, content: String(err), is_error: true })
        }
      }
      messages.push({ role: 'user', content: results })
    }
    return { decision: null, model, usage, turns: MAX_TURNS, sql: sqls, refusal: false }
  }
}
