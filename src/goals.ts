// The goal tree (brain/architecture/system-2.md). Only System 2 writes nodes and fails goals; code
// changes status only for `completed` (the check passed) and `abandoned` (a new instruction).
import type { Bot } from 'mineflayer'
import { inventoryCounts, rawSnapshot } from './encoder.ts'
import type { Module } from './modules.ts'
import type { Program } from './program.ts'

// A check is a generic predicate over raw state; System 2 picks the module and fills in the values.
export type CheckSpec = {
  module: 'near_entity' | 'inventory_delta' | 'entity_alive' | 'authored'
  name: string | null // authored: a check module System 2 registered (src/modules.ts)
  player: string | null // near_entity, entity_alive
  radius: number | null // near_entity
  match: string | null // inventory_delta: item name glob, e.g. "*_log"
  count: number | null // inventory_delta
  negate: boolean // escalate_if: fire when the predicate is false
  for_ms: number | null // escalate_if: only after it has held this long
}
export type Progress = { have: number, want: number }
type Compiled = { spec: CheckSpec, desc: string, test: (bot: Bot) => boolean, progress?: (bot: Bot) => Progress, since?: number, fired?: boolean }

export type Goal = {
  id: string
  parent: string | null
  text: string
  from: { player: string, via: 'whisper' | 'api' } | null
  status: 'active' | 'suspended' | 'completed' | 'failed' | 'abandoned'
  done_when: Compiled | null
  escalate_if: Compiled[]
  budget_ms: number | null // closed goals: time limit; open-ended goals use review_ms
  review_ms: number | null
  program: Program | null // pushed with this node; closing the node restores its parent's
  inventory: Record<string, number> // held when the node was created, for inventory_delta
  started: number // also reset when a budget or review is renewed
  log: string[]
  summary?: string
}

// Players seen dying recently: Mineflayer can't read other players' health, but it sees them die.
const deaths = new Map<string, number>()
export const noteDeath = (player: string) => deaths.set(player, Date.now())

export const glob = (pattern: string) => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
const playerEntity = (bot: Bot, name: string | null) => name ? bot.players[name]?.entity : undefined

// Authored checks run on the raw snapshot; the registry lookup is passed in by the runtime.
export type ModuleLookup = (name: string) => Module | undefined

export function compile (spec: CheckSpec, goal: Pick<Goal, 'inventory'>, modules?: ModuleLookup): Compiled {
  const base = (() => {
    switch (spec.module) {
      case 'near_entity': {
        const r = spec.radius ?? 3
        return {
          desc: `within ${r} blocks of ${spec.player}`,
          test: (bot: Bot) => { const e = playerEntity(bot, spec.player); return !!e && e.position.distanceTo(bot.entity.position) <= r }
        }
      }
      case 'inventory_delta': {
        const re = glob(spec.match ?? '*')
        const want = spec.count ?? 1
        const count = (inv: Record<string, number>) => Object.entries(inv).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0)
        const start = count(goal.inventory)
        const have = (bot: Bot) => Math.max(0, count(inventoryCounts(bot)) - start)
        return { desc: `${want} more ${spec.match}`, test: (bot: Bot) => have(bot) >= want, progress: (bot: Bot) => ({ have: Math.min(have(bot), want), want }) }
      }
      case 'authored': {
        const m = spec.name ? modules?.(spec.name) : undefined
        if (!m || m.kind !== 'check') throw new Error(`no registered check module named ${spec.name}`)
        return { desc: `${m.id}: ${m.description}`, test: (bot: Bot) => m.run(rawSnapshot(bot)) }
      }
      case 'entity_alive':
        return {
          desc: `${spec.player} alive`,
          test: (bot: Bot) => !!spec.player && !!bot.players[spec.player] && Date.now() - (deaths.get(spec.player) ?? 0) > 5000
        }
    }
  })()
  const test = spec.negate ? (bot: Bot) => !base.test(bot) : base.test
  return { spec, ...base, desc: spec.negate ? `not ${base.desc}` : base.desc, test }
}

export type GoalEvents = {
  completed: (goal: Goal) => void
  escalate: (reason: string, goal: Goal) => void
}

export class Goals {
  nodes: Goal[] = []
  past: string[] = [] // one-line summaries of closed instructions
  next = 1
  on: GoalEvents

  constructor (on: GoalEvents) { this.on = on }

  // Root to the active leaf. Suspended nodes sit on the path; closed ones don't.
  path (): Goal[] {
    const out: Goal[] = []
    let node = this.nodes.find(g => g.parent === null && (g.status === 'active' || g.status === 'suspended'))
    while (node) {
      out.push(node)
      node = this.nodes.find(g => g.parent === node!.id && (g.status === 'active' || g.status === 'suspended'))
    }
    return out
  }

  leaf () { return this.path().at(-1) ?? null }
  pathText () { return this.path().map(g => `${g.id}:${g.text}`).join(' > ') }

  // The program in effect: the deepest one pushed on the active path, or null for the default.
  program (): Program | null { return this.path().reverse().find(g => g.program)?.program ?? null }

  create (text: string, parent: string | null, from: Goal['from'], bot: Bot): Goal {
    const g: Goal = {
      id: `g-${this.next++}`, parent, text, from, status: 'active', done_when: null, escalate_if: [],
      budget_ms: null, review_ms: null, program: null, inventory: inventoryCounts(bot), started: Date.now(), log: []
    }
    if (parent) { const p = this.nodes.find(n => n.id === parent)!; p.status = 'suspended' }
    this.nodes.push(g)
    return g
  }

  // A new instruction replaces the root: the old root and everything under it is abandoned.
  instruction (text: string, from: Goal['from'], bot: Bot): { root: Goal, abandoned: Goal[] } {
    const abandoned = this.path().reverse()
    for (const g of abandoned) this.close(g, 'abandoned', 'replaced by a new instruction')
    return { root: this.create(text, null, from, bot), abandoned }
  }

  close (g: Goal, status: 'completed' | 'failed' | 'abandoned', summary: string) {
    g.status = status
    g.summary = summary
    const line = `${g.id} ${status}: ${g.text}${summary ? ` (${summary})` : ''}`
    const parent = g.parent ? this.nodes.find(n => n.id === g.parent) : null
    if (parent) {
      parent.log.push(line)
      if (parent.status === 'suspended' && status !== 'abandoned') parent.status = 'active'
    } else this.past.push(line)
  }

  progress (bot: Bot): Progress | null {
    const leaf = this.leaf()
    return leaf?.done_when?.progress?.(bot) ?? null
  }

  // Evaluated every few ticks, so no model is called to ask "am I done?".
  tick (bot: Bot) {
    const leaf = this.leaf()
    if (!leaf) return
    const now = Date.now()
    if (leaf.status === 'active' && leaf.done_when?.test(bot)) {
      const p = leaf.done_when.progress?.(bot)
      this.close(leaf, 'completed', p ? `${p.have}/${p.want}` : leaf.done_when.desc)
      this.on.completed(leaf)
      return
    }
    for (const g of this.path()) {
      for (const c of g.escalate_if) {
        const on = c.test(bot)
        if (!on) { c.since = undefined; c.fired = false; continue }
        c.since ??= now
        if (!c.fired && now - c.since >= (c.spec.for_ms ?? 0)) { c.fired = true; this.on.escalate(`escalate_if:${c.spec.module}`, g) }
      }
    }
    if (leaf.budget_ms && now - leaf.started > leaf.budget_ms) { leaf.started = now; this.on.escalate('budget_exceeded', leaf) }
    if (leaf.review_ms && now - leaf.started > leaf.review_ms) { leaf.started = now; this.on.escalate('review_due', leaf) }
  }

  status (bot: Bot) {
    return {
      path: this.path().map(g => ({
        id: g.id, text: g.text, status: g.status, done_when: g.done_when?.desc ?? null,
        progress: g.done_when?.progress?.(bot) ?? null, escalate_if: g.escalate_if.map(c => c.desc), log: g.log.slice(-10)
      })),
      past: this.past.slice(-5)
    }
  }
}
