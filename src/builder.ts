// System 2B, the builder (brain/architecture/system-2.md → "2A and 2B"). It takes one capability request from
// 2A (the orchestrator, src/system2.ts), writes a behavior, trials it in a window the runtime grants, reads the
// evidence and fixes it. It never sees a player's words: only 2A's structured request.
// Built on the Vercel AI SDK, so the model is a config value. Its whole contract with the runtime is build()'s
// arguments and result, so moving it to Luna (durable runs, a waiting state for trial windows) swaps this file.
import { anthropic } from '@ai-sdk/anthropic'
import { OpenTelemetry } from '@ai-sdk/otel'
import { generateText, jsonSchema, stepCountIs, tool, type LanguageModel } from 'ai'
import { trace, type Span } from '@opentelemetry/api'
import { JudgmentTracerProvider, Tracer } from 'judgeval'
import { API_DOC } from './behaviors.ts'
import { BEHAVIOR_ENDINGS, MODULE_LIMITS, type ModuleSource } from './modules.ts'

export const BUILDER_MODEL = process.env.JEEVE_BUILDER_MODEL ?? 'claude-opus-5-5'
const EFFORT = (process.env.JEEVE_BUILDER_EFFORT ?? 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const BUILDER_LIMITS = { trials: 4, steps: 16 }

export type TrialTarget = { block?: string | null, item?: string | null, count?: number | null, entity?: string | null }
// What 2A asks for. pass_when is a check module 2A registered: the builder can't grade its own work.
export type CapabilityRequest = { id: string, need: string, constraints: string[], targets: 'block' | 'entity' | 'item', trial: TrialTarget, pass_when: string }
// A behavior as the builder writes it. usage: its proposed guidance for the fast model; 2A decides.
// trial: only the e2e's fixture, which trials outside any request.
export type BehaviorDraft = Omit<ModuleSource, 'kind'> & { usage?: string, trial?: TrialTarget & { pass_when?: string | null } }
export type TrialReport = { behavior: string, run_id?: string, passed: boolean, end: string, ms: number, error?: string, actions?: unknown[], self?: unknown, preempted: number }
export type BuildResult =
  | { request: string, status: 'registered', behavior: string, usage: string | null, attempts: TrialReport[] }
  | { request: string, status: 'failed', reason: string, attempts: TrialReport[] }

// What the runtime gives the builder. trial() waits for a window, runs the draft on the request's trial target
// and judges it with the request's pass_when; a passing behavior is registered by the runtime.
export type BuilderPorts = {
  trial: (draft: BehaviorDraft, req: CapabilityRequest, signal: AbortSignal) => Promise<TrialReport>
  perceive: (tool: string, input: Record<string, unknown>) => Promise<unknown>
}

const WRITE_BEHAVIOR = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'code', 'channels', 'targets', 'timeout_s', 'usage'],
  properties: {
    name: { type: 'string', description: 'snake_case; an existing name makes a new version' },
    description: { type: 'string', description: 'What it does, as the fast model will read it; the target is appended.' },
    code: { type: 'string', description: `async (api, target) => one of ${BEHAVIOR_ENDINGS.join(', ')}; at most ${MODULE_LIMITS.behaviorCodeChars} characters` },
    channels: { type: 'array', items: { type: 'string', enum: ['legs', 'aim', 'hands'] }, description: 'One channel, or all three.' },
    targets: { type: 'string', enum: ['block', 'entity', 'item'], description: "Must match the request's targets." },
    timeout_s: { type: 'integer', description: `Time limit per run, 1–${MODULE_LIMITS.behaviorTimeoutS}` },
    usage: { type: 'string', description: 'One or two sentences of guidance for the fast model on when to pick it. A proposal: the orchestrator decides.' }
  }
}

const SYSTEM = `You are System 2B, the builder of Jeeve, a Minecraft bot. The orchestrator (System 2A) runs the game and sends you capability requests: a behavior the bot needs and can't do yet. You write that behavior as code, trial it live, read what happened, and fix it until it passes. You never talk to players.

A behavior is an async function expression \`async (api, target) => ...\` that returns ${BEHAVIOR_ENDINGS.map(e => `"${e}"`).join(', ')} (or throws). It claims channels (one of legs, aim, hands, or all three), and takes a "block" target ({ name, count }), an "item" target ({ name, count }: something to make or fetch; the fast model is offered it for the item an inventory_delta goal still needs) or an "entity" target ({ id, name, type, username, pos }), as the request says. It has a time limit (at most ${MODULE_LIMITS.behaviorTimeoutS} s). It never touches the bot directly: the api has every action a player has, and is all it has. Positions are absolute [x, y, z] (block coordinates, y up; the bot stands in the block above the one under its feet), and names are Minecraft ids (oak_planks, crafting_table).
${API_DOC}
Each action needs the channel it drives. A window (chest, crafting table, furnace…) belongs to the hands: it stays open across awaits until close() or the run ends. Your code gets about 20 ms of computation between awaits; keep loops short and await between them. Scans and blockAt see blocks the bot placed itself, too. Safety guards check movement, digging and placing: a vetoed call rejects with "vetoed: <reason>". Catch it to try another way, or let it end the run as "vetoed". Other refusals reject with their reason too. The bot can reach blocks about 4.5 blocks from its eyes (eyes are 1.6 above its feet).

Write it with write_behavior. That call compiles it, waits until the runtime grants a trial window (the body is shared: the orchestrator keeps the bot safe first, so this can take a while), then runs it once on the request's trial target, and returns the result. A trial passes only if the code returns "done" and the request's pass_when check (written by the orchestrator, shown in the request) is true a few ticks later, or the goal it serves completes while it runs. A failed trial returns the end reason, the error, the last 30 actions with their results or vetoes, and the bot's state: that is your evidence. Name the cause before you rewrite. A trial pre-empted by a threat is retried by the runtime and doesn't count. You have ${BUILDER_LIMITS.trials} trials; when one passes, the behavior is registered and you are done. If the request can't be met with this api, stop calling tools and say why in one paragraph.

Before writing, look with scan and reachable if the code depends on where things are. Write general behaviors (e.g. "pillar up next to a block until it is in reach, then break it"), not ones tied to one spot or one trial target. Behaviors written earlier are in the library you're given: reuse their ideas, or write a new version of one by its name.`

// brief: the request plus what the runtime knows that the builder may need (the pass_when check's code, the
// library of authored behaviors, the bot's state). parent: the `builder` span; the AI SDK's spans go under it.
export async function build (req: CapabilityRequest, brief: Record<string, unknown>, ports: BuilderPorts, signal: AbortSignal, parent: Span, session: string, model: LanguageModel = anthropic(BUILDER_MODEL)): Promise<BuildResult> {
  const attempts: TrialReport[] = []
  let passed: { behavior: string, usage: string | null } | null = null
  let inflight: Promise<TrialReport> | null = null // the trial running now, if any
  const perceive = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => tool({
    description,
    inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object', additionalProperties: false, required, properties }),
    execute: input => ports.perceive(name, input)
  })
  const tools = {
    write_behavior: tool({
      description: 'Write a behavior (or a new version of one) and trial it on the request\'s trial target. Returns the trial result.',
      inputSchema: jsonSchema<BehaviorDraft>(WRITE_BEHAVIOR),
      execute: async draft => {
        if (attempts.length >= BUILDER_LIMITS.trials) return { error: 'no trials left' }
        inflight = ports.trial(draft, req, signal).then(r => {
          attempts.push(r)
          if (r.passed) passed = { behavior: r.behavior, usage: draft.usage ?? null }
          return r
        })
        return await inflight
      }
    }),
    scan: perceive('scan', 'Find blocks matching a glob (e.g. "*_log", "oak_leaves") within a radius (1-32, default 16), grouped into connected clusters with exact counts, bounds (absolute [x, y, z]), position relative to the feet (rel) and height range (y_rel). los: only blocks in line of sight.',
      { match: { type: 'string' }, radius: { type: 'integer' }, los: { type: 'boolean' } }, ['match']),
    reachable: perceive('reachable', 'Can the bot walk to within arm\'s reach of this block with the pathfinder, without placing blocks? Absolute position.',
      { position: { type: 'array', items: { type: 'integer' } } }, ['position'])
  }
  let res
  try {
    // judgeval's tracer takes parents from its own context, not OTel's global one.
    const judgment = JudgmentTracerProvider.getInstance()
    res = await judgment.withContext(trace.setSpan(judgment.getCurrentContext(), parent), () => generateText({
    model,
    system: SYSTEM,
    prompt: JSON.stringify(brief),
    tools,
    stopWhen: [stepCountIs(BUILDER_LIMITS.steps), () => !!passed || attempts.length >= BUILDER_LIMITS.trials],
    abortSignal: signal,
    providerOptions: { anthropic: { effort: EFFORT } },
    telemetry: {
      functionId: 'builder',
      integrations: [new OpenTelemetry({ tracer: Tracer.getOTELTracer(), enrichSpan: () => ({ 'judgment.session_id': session, 'jeeve.request.id': req.id }) })]
    }
  }))
  } catch (err) {
    if (!signal.aborted) throw err
    // Cancelled (its goal closed). A trial already running finishes first: if the goal completed during it, it passed.
    await (inflight as Promise<TrialReport> | null)?.catch(() => {}) // assigned in a tool callback, so TS sees null
    if (passed) return { request: req.id, status: 'registered', ...(passed as { behavior: string, usage: string | null }), attempts }
    return { request: req.id, status: 'failed', reason: `cancelled: ${signal.reason}`, attempts }
  }
  if (passed) return { request: req.id, status: 'registered', ...(passed as { behavior: string, usage: string | null }), attempts }
  const reason = res.text.trim() || (attempts.length >= BUILDER_LIMITS.trials ? `no trial passed in ${attempts.length}` : `stopped after ${res.steps.length} steps`)
  return { request: req.id, status: 'failed', reason, attempts }
}
