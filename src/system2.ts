// System 2: a Claude call per instruction or escalation (brain/architecture/system-2.md).
// It reads the goal path, the program and recent events, may query its own traces with SQL,
// and ends by calling `submit_decision`. Code applies the decision.
import Anthropic from '@anthropic-ai/sdk'
import { API_ACTIONS, API_READS, BEHAVIORS } from './behaviors.ts'
import type { CheckSpec } from './goals.ts'
import { BEHAVIOR_ENDINGS, MODULE_LIMITS, type ModuleSource } from './modules.ts'

export const MODEL = process.env.JEEVE_SYSTEM2_MODEL ?? 'claude-opus-5-5'
const MAX_TURNS = 4

export type Decision = {
  note: string
  goal: { done_when: CheckSpec | null, escalate_if: CheckSpec[], budget_s: number | null, review_s: number | null, place: number[] | null } | null
  goal_action: 'none' | 'fail' | 'renew'
  push_child: { text: string, done_when: CheckSpec | null, budget_s: number | null } | null
  program: { guidance: string | null, allowed_behaviors: string[] | null, heartbeat_ms: number | null, watch: string[] | null } | null
  new_modules: ModuleSource[]
  message: string | null
  new_behaviors?: BehaviorDraft[] // from write_behavior calls, attached by code
}
// A behavior as written with write_behavior (not strict, so every field is checked when it's compiled).
export type BehaviorDraft = Omit<ModuleSource, 'kind'> & { trial?: { block?: string | null, count?: number | null, entity?: string | null, pass_when?: string | null } | null }

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, 'null'], ...extra })
const CHECK = {
  type: 'object',
  additionalProperties: false,
  required: ['module', 'name', 'player', 'radius', 'match', 'count', 'negate', 'for_ms'],
  properties: {
    module: { type: 'string', enum: ['near_entity', 'inventory_delta', 'entity_alive', 'authored'] },
    name: nullable('string', { description: 'authored: the name of a check module you registered (now or earlier)' }),
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
      required: ['note', 'goal', 'goal_action', 'push_child', 'program', 'new_modules', 'message'],
      $defs: { check: CHECK },
      properties: {
        note: { type: 'string', description: 'One line for the goal log: what you decided and why.' },
        goal: {
          ...nullable('object'),
          description: "Set the active goal's success check. null leaves it unchanged. Required on a new instruction.",
          additionalProperties: false,
          required: ['done_when', 'escalate_if', 'budget_s', 'review_s', 'place'],
          properties: {
            done_when: { anyOf: [{ $ref: '#/$defs/check' }, { type: 'null' }], description: 'null for open-ended goals (they end only on a new instruction).' },
            escalate_if: { type: 'array', items: { $ref: '#/$defs/check' }, description: 'Conditions that should call you back, e.g. the protected player far away for 10 s.' },
            budget_s: nullable('integer', { description: 'Closed goals: time limit before you are called back.' }),
            review_s: nullable('integer', { description: 'Open-ended goals: how often you review them.' }),
            place: { anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }], description: 'Where the goal happens, absolute [x, y, z] (e.g. a block of the tree from scan). null: nowhere in particular.' }
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
          required: ['guidance', 'allowed_behaviors', 'heartbeat_ms', 'watch'],
          properties: {
            watch: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }], description: 'Names of watch modules that wake the fast model when they turn true. null keeps the current list.' },
            guidance: nullable('string', { description: 'Full replacement guidance for the fast model. Concrete and short.' }),
            // No enum: behaviors you write join the list once their trial passes, and validation checks names.
            allowed_behaviors: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }], description: 'Seed behaviors, or ones you wrote whose trial passed.' },
            heartbeat_ms: nullable('integer', { description: 'How often the fast model re-decides without an event (200–5000).' })
          }
        },
        new_modules: {
          type: 'array',
          description: 'Modules to register before the rest of this decision is applied. Usually empty.',
          items: {
            type: 'object', additionalProperties: false, required: ['kind', 'name', 'description', 'code'],
            properties: {
              kind: { type: 'string', enum: ['check', 'watch'] },
              name: { type: 'string', description: 'snake_case; registering an existing name makes a new version' },
              description: { type: 'string' },
              code: { type: 'string', description: 'A JavaScript function expression (s) => boolean over the snapshot.' }
            }
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

// Perception tools (brain/architecture/perception.md): read-only world queries over src/world.ts. Not strict either.
const PERCEPTION: Anthropic.Tool[] = [
  {
    name: 'scan',
    description: 'Find blocks whose name matches a glob (e.g. "*_log", "oak_leaves", "*_ore") within a radius, grouped into connected clusters, nearest first. Each cluster gives its exact count, block names, nearest block, bounds (absolute [x, y, z]), its position relative to your feet (rel [dx, dy, dz]) and its height range relative to your feet (y_rel [min, max]). Use it for how many, where and how high.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['match'],
      properties: {
        match: { type: 'string' },
        radius: { type: 'integer', description: 'Blocks, 1-32. Default 16.' },
        los: { type: 'boolean', description: 'Only blocks in your line of sight. Default false: you see through walls.' }
      }
    }
  },
  {
    name: 'reachable',
    description: 'Can you walk to where a block is within arm\'s reach (about 4.5 blocks from your eyes), using the same pathfinder as collect: no placing blocks, and no breaking anything but logs and leaves? Judged on the world as it is now: a block behind others of the same tree may become reachable once those are broken. status timeout means no path was found within a second. Absolute position.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['position'],
      properties: { position: { type: 'array', items: { type: 'integer' }, minItems: 3, maxItems: 3 } }
    }
  }
]

const PERCEIVE = `You can look at the world with scan and reachable. Your context only has a coarse summary of nearby blocks (fast_model_view.blocks), so look before you set a count or a check that depends on blocks, or before you judge whether something can be reached. Each tool call costs a turn of a few seconds, so make every look you need in the same turn (several tool calls at once), then decide.`

// Its own tool, not a submit_decision field: one more strict object makes the grammar too large for the API.
const WRITE_BEHAVIOR: Anthropic.Tool = {
  name: 'write_behavior',
  description: 'Write a new behavior (or a new version of one you wrote). It is compiled when your decision is applied, then trialled live once on the trial target. Call it before or together with submit_decision.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'description', 'code', 'channels', 'targets', 'timeout_s', 'trial'],
    properties: {
      name: { type: 'string', description: 'snake_case' },
      description: { type: 'string', description: 'What it does, as the fast model will read it; the target is appended.' },
      code: { type: 'string', description: `async (api, target) => one of ${BEHAVIOR_ENDINGS.join(', ')}` },
      channels: { type: 'array', items: { type: 'string', enum: ['legs', 'aim', 'hands'] }, description: 'One channel, or all three.' },
      targets: { type: 'string', enum: ['block', 'entity'] },
      timeout_s: { type: 'integer', description: `Time limit per run, 1–${MODULE_LIMITS.behaviorTimeoutS}` },
      trial: {
        type: 'object', additionalProperties: false,
        properties: {
          block: { type: 'string', description: 'block name, for targets "block"' },
          count: { type: 'integer' },
          entity: { type: 'string', description: 'player name or mob type, for targets "entity"' },
          pass_when: { type: 'string', description: 'Name of a check module (registered earlier, or in new_modules of this decision) that must be true when the run returns "done". Without it, "done" alone passes.' }
        }
      }
    }
  }
}

const SYSTEM = `You are System 2 of Jeeve, a Minecraft bot that joins servers as a normal player and takes instructions from players.

You are the slow planner. A fast decision model (System 1, "Jev") picks a behavior per channel several times a second under a program you shape: guidance text, the allowed behaviors and how often it re-decides. Deterministic code runs the behaviors and safety guards. You are called when an instruction arrives or something escalates. The bot never waits for you: it keeps acting on the current program while you think.

Behaviors System 1 can choose from:
${Object.entries(BEHAVIORS).map(([n, b]) => `- ${n} (${b.channels.join('+')}): ${b.describe('<target>')}`).join('\n')}

Success checks are code you parameterize: near_entity(player, radius), inventory_delta(match glob, count), entity_alive(player). Under an inventory_delta check, the fast model is offered collect only for block types the check still needs, with the count still missing, so for a goal that gathers blocks use inventory_delta with the exact count. Under an authored check, it is offered the block types in view, with how many are within 8 blocks. Code evaluates them every tick, marks a goal completed when its done_when passes, and tells the player. You never need to say "done".

The fast model only sees targets near the bot. If a goal happens at a place (a tree to break, a spot to guard or build at), set goal.place to a block there, e.g. one scan found. The fast model is told either "you are at the goal's place" (within 3 blocks) or "you are not at the goal's place yet", and in the second case it is offered navigate to the place, so it can walk back after wandering off or out of view. Write guidance about the place in those words, not in blocks or distances (e.g. "if you are not at the goal's place yet, walk back to it"): it is weak with numbers, and stood still short of the place when told "within ~3 blocks" or "close". Setting goal again replaces the place too, so repeat it.

When no built-in check can express a goal, write one. Put a module in new_modules and reference it as {"module": "authored", "name": ...} in done_when or escalate_if. You can also write watch modules: list their names in program.watch, and the fast model is woken each time one turns true. A module is a JavaScript function expression \`(s) => boolean\` over a plain-data snapshot:
s = { t, self: { pos: [x, y, z], yaw, health, food, held, below }, entities: [{ id, name, type, username, pos, vel }], inventory: { item_name: count }, blocks: { block_name: [[x, y, z], ...nearest 8] /* only types that are rare (64 or fewer) within 8 blocks of the bot's feet in every direction */ }, world: { time_of_day /* 0-24000 ticks; night is about 13000-23000 */, is_day, raining } }
A type missing from s.blocks may just be out of that view (the bot walked off, or the canopy is more than 8 up), so a "none left" check must also require the bot to be within a few blocks of the place. Helpers: dist(a, b) for positions, count(s, "*_log") for inventory globs. Modules are pure: no I/O, no state between calls, no eval. They must finish in under ${MODULE_LIMITS.budgetMs} ms, and they run several times a second. Before registering, a module is trialled on recent real snapshots and refused if it throws or returns a non-boolean. A refusal comes back to you as an escalation. Modules you registered earlier are listed in your context, so reuse them by name.

When no behavior can do what a goal needs, write one with the write_behavior tool. Its code is an async function expression \`async (api, target) => ...\` that returns ${BEHAVIOR_ENDINGS.map(e => `"${e}"`).join(', ')} (or throws). It claims channels (one of legs, aim, hands, or all three), takes a "block" target ({ name, count }) or an "entity" target ({ id, name, type, username, pos }), and has a time limit. It never touches the bot directly; the api is all it has, and positions are absolute [x, y, z] (block coordinates, y up; the bot stands in the block above the one under its feet):
- reads, synchronous: ${API_READS.map(n => `api.${n}`).join(', ')}. api.self() → { pos, yaw, pitch, on_ground, health, food, held }; api.inventory() → { item: count }; api.entities(radius) → [{ id, name, type, username, pos }]; api.blockAt(x, y, z) → name or null.
- asynchronous (await them): ${API_ACTIONS.map(n => `api.${n}`).join(', ')}. api.scan({ match: glob, radius, los }) → { total, clusters: [{ count, names, nearest, rel, y_rel, min, max, positions }] }; api.reachable(x, y, z) → { reachable: boolean, status } (whether the pathfinder can get within reach of that block without building; status "timeout" means it gave up after 1 s, not that it's unreachable); api.control(name, on) for forward/back/left/right/jump/sneak/sprint (legs); api.look(x, y, z) at a point (aim); api.dig(x, y, z), api.place(x, y, z) (places the held block there, against any solid neighbour) and api.equip(glob) (hands); api.wait(ticks), 20 ticks a second; api.goto(x, y, z, range) walks there with the pathfinder (legs).
Each action that moves the bot needs its channel. Your code gets about 20 ms of computation between awaits; keep loops short and await between them. Scans and blockAt see blocks the bot placed itself, too. Safety guards check every action: a vetoed call rejects with "vetoed: <reason>". Catch it to try another way, or let it end the run as "vetoed". The bot can reach blocks about 4.5 blocks from its eyes (eyes are 1.6 above its feet).
A new behavior is tried once, live, on the trial target you give, and Jev can't interrupt it. A behavior's own "done" is only its claim: give the trial a pass_when check that tests the result in the world, or a run that did half the job passes. Make pass_when test what the behavior was asked to do to its trial target (e.g. no leaves left near the spot), not the whole goal: side effects such as the blocks it built with don't make it fail. Its result comes back to you as a behavior_trial escalation, with the error and its last actions if it failed. Only once its trial has passed can you add it to program.allowed_behaviors, so the fast model can pick it. Behaviors you wrote earlier are listed in your context; reuse them. Behaviors are plain code with no knowledge built in, so write general ones (e.g. "pillar up next to a block until it is in reach, then break it"), not ones tied to one spot.

On a new instruction: set the goal's done_when (or null if open-ended), escalate_if conditions, and a budget (closed goals) or review interval (open-ended goals). Adjust the program only if the default guidance is not enough. On an escalation: read what happened and decide whether to change the program, fail the goal (with a message saying why), push a sub-goal, or carry on (goal_action "none", everything else null).

Keep program changes small and concrete; they last only while the goal is active. Use your Minecraft knowledge to fill in check values (for example, any log is "*_log"). Only message the player for failures, refusals or clarifying questions. Always finish by calling submit_decision.`

// Jeeve's own span vocabulary (brain/architecture/trace-schema.md), so queries don't burn turns on discovery.
const TRACES = `Your traces (Judgment virtual SQL, project-scoped). One session per episode (session_id), one trace per window.
Span names: window, carry_over, system2, perceive (your scan/reachable calls, children of the system2 span), program, decide, goal, module, behavior.<name> (navigate, follow, track, attack_when_ready, collect, and behaviors you wrote).
Columns: span_name, session_id, trace_id, started_at, input, output, attributes (Map(String,String)), events_json.
Keys: jeeve.window_index, jeeve.prev_trace_id, jeeve.goal.path, jeeve.goal.id, jeeve.goal.transition, jeeve.program.version,
jeeve.program.because, jeeve.decide.trigger, jeeve.decide.changed, jeeve.decide.escalate, jeeve.decide.latency_ms, jeeve.decide.raw_state,
jeeve.behavior.name, jeeve.behavior.params, jeeve.behavior.run_id, jeeve.behavior.end_reason (done, stuck, none_found, target_dead,
target_lost, vetoed, replaced, stopped, cut, goal_closed, place_changed, death; authored behaviors also error, timeout), jeeve.behavior.decided_by
(a decide span, or system2:<span> for a trial), jeeve.behavior.version, jeeve.behavior.detail (authored: error and last actions),
jeeve.module.id, jeeve.module.kind, jeeve.module.activation (ok, failed_trial, trial_started, loaded, disabled), jeeve.system2.trigger, jeeve.perceive.tool, jeeve.perceive.query, jeeve.perceive.mode (xray, los).
Window events (events_json on window spans): death, damage, owner_damage, vetoed, chat.`

export type System2Result = { decision: Decision | null, model: string, usage: Anthropic.Beta.BetaUsage | null, turns: number, sql: string[], refusal: boolean }

export type Perceive = (tool: string, input: Record<string, unknown>) => Promise<unknown>

export function makeSystem2 (opts: { sql?: (q: string) => Promise<unknown>, schema?: string, perceive?: Perceive, effort: (trigger: string) => 'low' | 'medium' | 'high' }) {
  const client = new Anthropic()
  const tools = [TOOLS[0], ...(opts.sql ? [TOOLS[1]] : []), ...(opts.perceive ? PERCEPTION : [])]
  // Stable for the whole run, so it stays in the cached prefix.
  const system = [SYSTEM, opts.perceive ? PERCEIVE : '', opts.sql ? `${TRACES}\n\n${opts.schema ?? ''}` : ''].filter(Boolean).join('\n\n')
  return async function call (trigger: string, context: Record<string, unknown>): Promise<System2Result> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: JSON.stringify({ trigger, ...context }) }]
    const sqls: string[] = []
    const behaviors: BehaviorDraft[] = []
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
        tools: [...(turn < MAX_TURNS ? tools : TOOLS.slice(0, 1)), WRITE_BEHAVIOR],
        messages
      } as Anthropic.Beta.MessageCreateParamsNonStreaming)
      usage = res.usage
      model = res.model
      if (res.stop_reason === 'refusal') return { decision: null, model, usage, turns: turn, sql: sqls, refusal: true }
      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      for (const c of calls) if (c.name === 'write_behavior') behaviors.push(c.input as BehaviorDraft)
      const submit = calls.find(c => c.name === 'submit_decision')
      if (submit) return { decision: { ...submit.input as Decision, new_behaviors: behaviors }, model, usage, turns: turn, sql: sqls, refusal: false }
      if (!calls.length) break
      messages.push({ role: 'assistant', content: res.content })
      // Tool calls in one turn run in parallel: a turn costs seconds, a look costs milliseconds.
      const results = await Promise.all(calls.map(async (c): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        if (c.name === 'write_behavior') return { type: 'tool_result', tool_use_id: c.id, content: 'Queued: compiled and trialled when your decision is applied.' }
        try {
          let out: unknown
          if (c.name === 'run_sql') {
            const q = (c.input as { query: string }).query
            sqls.push(q)
            out = await opts.sql!(q)
          } else out = await opts.perceive!(c.name, c.input as Record<string, unknown>)
          const text = JSON.stringify(out)
          return { type: 'tool_result', tool_use_id: c.id, content: text.length > 20000 ? text.slice(0, 20000) + '…(truncated)' : text }
        } catch (err) {
          return { type: 'tool_result', tool_use_id: c.id, content: String(err), is_error: true }
        }
      }))
      messages.push({ role: 'user', content: results })
    }
    return { decision: null, model, usage, turns: MAX_TURNS, sql: sqls, refusal: false }
  }
}
