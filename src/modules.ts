// Modules System 2 writes at runtime (brain/architecture/system-1.md → "Program format"): for now, success
// checks and watch conditions, written as pure predicates over a data-only snapshot of the world.
// Pipeline: write → compile in a sandbox → trial on recent real states → register as name@version.
//
// Sandbox: node:vm, a fresh realm per module with no require/process/network, string eval disabled, and a
// hard per-call timeout. ponytail: not a security boundary; fine while the only author is our own System 2
// on a local machine. Revisit (worker thread or SES compartment) before running anywhere else.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'

export type ModuleKind = 'check' | 'watch'
export type ModuleSource = { kind: ModuleKind, name: string, description: string, code: string }
export type Snapshot = Record<string, unknown>
export type Stats = { calls: number, errors: number, totalMs: number, maxMs: number, lastError?: string }
export type Origin = { session: string, goal: string, created_at: string }
export type Module = ModuleSource & { version: number, id: string, run: (s: Snapshot) => boolean, stats: Stats, disabled?: string, origin?: Origin, trial?: Trial }
// One library entry: the latest version of a module, as written to the library file.
type Stored = ModuleSource & { version: number, origin?: Origin, trial?: Trial, disabled?: string }
export type Trial = { states: number, trues: number, errors: number, maxMs: number, error?: string }

export const MODULE_LIMITS = {
  timeoutMs: 20, // hard stop for one call (the vm interrupts it)
  budgetMs: 2, // a trial fails if any call takes longer
  maxErrors: 3, // a live module is disabled after this many failed calls
  codeChars: 4000
}

// Helpers every module can use, defined inside the sandbox.
const PRELUDE = String.raw`
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const count = (s, glob) => { const re = new RegExp('^' + glob.split('*').map(p => p.replace(/\W/g, '\\$&')).join('.*') + '$'); return Object.entries(s.inventory || {}).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0) };
`

export function compileModule (src: ModuleSource, version: number, onDisable: (m: Module, reason: string) => void = () => {}): Module {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(src.name)) throw new Error(`name must be snake_case: ${src.name}`)
  if (src.code.length > MODULE_LIMITS.codeChars) throw new Error(`code longer than ${MODULE_LIMITS.codeChars} chars`)
  const ctx = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } })
  new vm.Script(`'use strict';${PRELUDE}\nglobalThis.__fn = (${src.code});\nif (typeof __fn !== 'function') throw new TypeError('code must be a function expression');`)
    .runInContext(ctx, { timeout: 50 })
  // The snapshot crosses into the sandbox as JSON, so the module never holds a reference to our objects.
  const call = new vm.Script('globalThis.__out = __fn(JSON.parse(globalThis.__in))')
  const stats: Stats = { calls: 0, errors: 0, totalMs: 0, maxMs: 0 }
  const m: Module = {
    ...src, version, id: `${src.name}@${version}`, stats,
    run: (s: Snapshot) => {
      if (m.disabled) return false
      const t0 = performance.now()
      try {
        ctx.__in = JSON.stringify(s)
        call.runInContext(ctx, { timeout: MODULE_LIMITS.timeoutMs })
        const out = ctx.__out
        if (typeof out !== 'boolean') throw new TypeError(`returned ${typeof out}, not a boolean`)
        return out
      } catch (err) {
        stats.errors++
        stats.lastError = String(err)
        if (stats.errors >= MODULE_LIMITS.maxErrors) { m.disabled = `${stats.errors} failed calls; last: ${stats.lastError}`; onDisable(m, m.disabled) }
        return false
      } finally {
        const ms = performance.now() - t0
        stats.calls++
        stats.totalMs += ms
        stats.maxMs = Math.max(stats.maxMs, ms)
      }
    }
  }
  return m
}

// The library persists across runs: a JSON file holding the latest version of each module. Commit the
// ones worth keeping; git history is the record of how the set was hillclimbed.
export class ModuleRegistry {
  modules = new Map<string, Module>() // name → latest version
  onDisable: (m: Module, reason: string) => void
  file: string | null

  constructor (onDisable: (m: Module, reason: string) => void = () => {}, file: string | null = null) {
    this.file = file
    this.onDisable = (m, reason) => { this.save(); onDisable(m, reason) }
  }

  // Modules were trialled when they were written; on load they're only compiled. Disabled ones stay off.
  load (): { loaded: string[], skipped: string[] } {
    const loaded: string[] = []
    const skipped: string[] = []
    if (!this.file || !existsSync(this.file)) return { loaded, skipped }
    for (const s of JSON.parse(readFileSync(this.file, 'utf8')).modules as Stored[]) {
      if (s.disabled) { skipped.push(`${s.name}@${s.version}: disabled (${s.disabled})`); continue }
      try {
        const m = compileModule(s, s.version, this.onDisable)
        Object.assign(m, { origin: s.origin, trial: s.trial })
        this.modules.set(s.name, m)
        loaded.push(m.id)
      } catch (err) { skipped.push(`${s.name}@${s.version}: ${String(err)}`) }
    }
    return { loaded, skipped }
  }

  save () {
    if (!this.file) return
    const modules: Stored[] = [...this.modules.values()].sort((a, b) => a.name.localeCompare(b.name)).map(m => ({
      kind: m.kind, name: m.name, description: m.description, code: m.code, version: m.version,
      ...(m.origin ? { origin: m.origin } : {}), ...(m.trial ? { trial: m.trial } : {}), ...(m.disabled ? { disabled: m.disabled } : {})
    }))
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ modules }, null, 2) + '\n')
    renameSync(`${this.file}.tmp`, this.file)
  }

  get (name: string) { return this.modules.get(name) }

  // Compile, then trial on recent real states: it must return a boolean every time, within budget.
  // Only a module that passes is registered (as the next version of its name).
  register (src: ModuleSource, trialStates: Snapshot[], origin?: Origin): { module?: Module, trial: Trial } {
    const version = (this.modules.get(src.name)?.version ?? 0) + 1
    let m: Module
    try { m = compileModule(src, version, this.onDisable) } catch (err) {
      return { trial: { states: 0, trues: 0, errors: 1, maxMs: 0, error: `compile: ${String(err)}` } }
    }
    const probe = compileModule(src, version) // trial on a copy, so trial errors don't count against the live module
    let trues = 0
    for (const s of trialStates) if (probe.run(s)) trues++
    const trial: Trial = { states: trialStates.length, trues, errors: probe.stats.errors, maxMs: +probe.stats.maxMs.toFixed(3) }
    if (probe.stats.errors) trial.error = probe.stats.lastError
    else if (probe.stats.maxMs > MODULE_LIMITS.budgetMs) trial.error = `too slow: ${trial.maxMs} ms > ${MODULE_LIMITS.budgetMs} ms`
    else if (!trialStates.length) trial.error = 'no recent states to trial on'
    if (trial.error) return { trial }
    Object.assign(m, { origin, trial })
    this.modules.set(src.name, m)
    this.save()
    return { module: m, trial }
  }

  list () {
    return [...this.modules.values()].map(m => ({
      id: m.id, kind: m.kind, description: m.description, disabled: m.disabled ?? null,
      calls: m.stats.calls, errors: m.stats.errors, avg_ms: m.stats.calls ? +(m.stats.totalMs / m.stats.calls).toFixed(3) : 0
    }))
  }
}
