// Modules System 2 writes at runtime (brain/architecture/system-1.md → "Program format"): success checks and
// watch conditions, written as pure predicates over a data-only snapshot of the world, and behaviors, written
// as async functions over a guarded action API (brain/architecture/behaviors-and-guards.md).
// Pipeline: write → compile in a sandbox → trial (predicates: on recent real states; behaviors: one live run)
// → register as name@version.
//
// Sandbox: node:vm, a fresh realm per module with no require/process/network, string eval disabled, and a
// hard per-call timeout. ponytail: not a security boundary; fine while the only author is our own System 2
// on a local machine. Revisit (worker thread or SES compartment) before running anywhere else.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'

export type ModuleKind = 'check' | 'watch' | 'behavior'
// Behaviors also declare the channels they claim, their target type and a time limit.
export type ModuleSource = { kind: ModuleKind, name: string, description: string, code: string, channels?: string[], targets?: 'block' | 'entity', timeout_s?: number }
export type Snapshot = Record<string, unknown>
export type Stats = { calls: number, errors: number, totalMs: number, maxMs: number, lastError?: string }
export type Origin = { session: string, goal: string, created_at: string }
// run is the predicate; a behavior module never runs as one (it starts through src/behaviors.ts).
export type Module = ModuleSource & { version: number, id: string, run: (s: Snapshot) => boolean, stats: Stats, disabled?: string, origin?: Origin, trial?: Trial | BehaviorTrial }
// One library entry: the latest version of a module, as written to the library file.
type Stored = ModuleSource & { version: number, origin?: Origin, trial?: Trial | BehaviorTrial, disabled?: string }
export type Trial = { states: number, trues: number, errors: number, maxMs: number, error?: string }
export type BehaviorTrial = { target: unknown, end: string, ms: number, error?: string }

export const MODULE_LIMITS = {
  timeoutMs: 20, // hard stop for one call (the vm interrupts it)
  budgetMs: 2, // a trial fails if any call takes longer
  maxErrors: 3, // a live module is disabled after this many failed calls (behaviors: failed runs in a row)
  codeChars: 4000,
  behaviorTimeoutS: 120, // the longest time limit a behavior may declare
  behaviorCodeChars: 8000 // behaviors are longer than predicates; 4000 refused a working first draft
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
        const m = s.kind === 'behavior' ? behaviorModule(s, s.version) : compileModule(s, s.version, this.onDisable)
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
      ...(m.kind === 'behavior' ? { channels: m.channels, targets: m.targets, timeout_s: m.timeout_s } : {}),
      ...(m.origin ? { origin: m.origin } : {}), ...(m.trial ? { trial: m.trial } : {}), ...(m.disabled ? { disabled: m.disabled } : {})
    }))
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ modules }, null, 2) + '\n')
    renameSync(`${this.file}.tmp`, this.file)
  }

  get (name: string) { return this.modules.get(name) }
  nextVersion (name: string) { return (this.modules.get(name)?.version ?? 0) + 1 }

  // Behaviors are trialled live by the runtime (src/main.ts); only one that passed is added here.
  addBehavior (src: ModuleSource, version: number, trial: BehaviorTrial, origin?: Origin): Module {
    const m = behaviorModule(src, version)
    Object.assign(m, { origin, trial })
    this.modules.set(src.name, m)
    this.save()
    return m
  }

  disable (m: Module, reason: string) {
    m.disabled = reason
    this.onDisable(m, reason)
  }

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
      ...(m.kind === 'behavior' ? { channels: m.channels, targets: m.targets } : {}),
      calls: m.stats.calls, errors: m.stats.errors, avg_ms: m.stats.calls ? +(m.stats.totalMs / m.stats.calls).toFixed(3) : 0
    }))
  }
}

// ---- behaviors: async code that acts, in the same kind of realm ----
// The realm gets one host function (the bridge), captured in a closure and deleted from its globals.
// Everything crossing it is a string: no host function, object or Promise ever enters the realm, so the
// `.constructor` route back to host Function is closed. Promises are made inside the realm; the host settles
// them by running a script, and every entry into the realm is timed (microtaskMode 'afterEvaluate' puts the
// realm's promise jobs inside the timeout), so a busy loop is killed instead of freezing the bot.
// ponytail: still not a hardened boundary (V8 bugs); fine for our own System 2 on a local machine.
export const BEHAVIOR_ENDINGS = ['done', 'stuck', 'none_found']
const LAYOUTS = [['legs'], ['aim'], ['hands'], ['legs', 'aim', 'hands']] // the question layouts that exist

export type BehaviorHost = {
  reads: string[] // synchronous: return a value, or throw
  actions: string[] // asynchronous
  read: (name: string, args: unknown[]) => unknown
  act: (name: string, args: unknown[]) => Promise<unknown>
  end: (r: { value?: unknown, error?: string }) => void // called once, unless cancelled first
}

const realmPrelude = (reads: string[], actions: string[]) => String.raw`(() => {
  const bridge = globalThis.__bridge; delete globalThis.__bridge;
  const pending = new Map(); let next = 0;
  const read = name => (...args) => { const r = JSON.parse(bridge(0, name, JSON.stringify(args))); if ('e' in r) throw new Error(r.e); return r.v };
  const act = name => (...args) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); bridge(id, name, JSON.stringify(args)) });
  const api = {};
  for (const n of ${JSON.stringify(reads)}) api[n] = read(n);
  for (const n of ${JSON.stringify(actions)}) api[n] = act(n);
  Object.freeze(api);
  globalThis.__settle = s => { const [id, ok, v] = JSON.parse(s); const p = pending.get(id); pending.delete(id); if (p) ok ? p.resolve(v) : p.reject(new Error(v)) };
  globalThis.__start = s => {
    Promise.resolve().then(() => __fn(api, JSON.parse(s))).then(
      v => bridge(0, '__end', JSON.stringify({ value: v === undefined ? null : v })),
      e => bridge(0, '__end', JSON.stringify({ error: String(e && e.message || e) })));
  };
})();`

const SETTLE = new vm.Script('__settle(__arg)')
const START = new vm.Script('__start(__arg)')

function behaviorRealm (code: string, reads: string[], actions: string[], bridge: (id: number, name: string, args: string) => string | undefined) {
  const ctx = vm.createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' })
  ctx.__bridge = bridge
  new vm.Script(`'use strict';${PRELUDE}\n${realmPrelude(reads, actions)}\nglobalThis.__fn = (${code});\nif (typeof __fn !== 'function') throw new TypeError('code must be a function expression');`)
    .runInContext(ctx, { timeout: 50 })
  return ctx
}

// Shape checks, and the code must compile to a function. Throws on the first problem.
export function compileBehavior (src: ModuleSource) {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(src.name)) throw new Error(`name must be snake_case: ${src.name}`)
  if (src.code.length > MODULE_LIMITS.behaviorCodeChars) throw new Error(`code longer than ${MODULE_LIMITS.behaviorCodeChars} chars`)
  if (!LAYOUTS.some(l => l.join('+') === [...(src.channels ?? [])].sort((a, b) => ['legs', 'aim', 'hands'].indexOf(a) - ['legs', 'aim', 'hands'].indexOf(b)).join('+'))) {
    throw new Error(`channels must be one of ${LAYOUTS.map(l => l.join('+')).join(', ')}`)
  }
  if (src.targets !== 'block' && src.targets !== 'entity') throw new Error('targets must be "block" or "entity"')
  const t = src.timeout_s ?? 0
  if (!(t >= 1 && t <= MODULE_LIMITS.behaviorTimeoutS)) throw new Error(`timeout_s must be 1–${MODULE_LIMITS.behaviorTimeoutS}`)
  behaviorRealm(src.code, [], [], () => undefined)
}

function behaviorModule (src: ModuleSource, version: number): Module {
  compileBehavior(src)
  const order = ['legs', 'aim', 'hands']
  return {
    ...src, channels: [...src.channels!].sort((a, b) => order.indexOf(a) - order.indexOf(b)), version, id: `${src.name}@${version}`,
    run: () => false, stats: { calls: 0, errors: 0, totalMs: 0, maxMs: 0 }
  }
}

// Start one run in a fresh realm (no state survives between runs). cancel() means the realm is never
// entered again: pending calls are dropped and no end is reported.
export function startBehavior (code: string, target: unknown, host: BehaviorHost): { cancel: () => void } {
  let live = true
  const finish = (r: { value?: unknown, error?: string }) => { if (live) { live = false; host.end(r) } }
  const enter = (script: vm.Script, arg: string) => {
    if (!live) return
    ctx.__arg = arg
    try { script.runInContext(ctx, { timeout: MODULE_LIMITS.timeoutMs }) } catch (err) { finish({ error: String((err as Error).message ?? err) }) }
  }
  const ctx = behaviorRealm(code, host.reads, host.actions, (id, name, args) => {
    if (!live) return JSON.stringify({ e: 'cancelled' })
    if (name === '__end') { finish(JSON.parse(args)); return undefined }
    const parsed = JSON.parse(args) as unknown[]
    if (id === 0) {
      try { return JSON.stringify({ v: host.read(name, parsed) ?? null }) } catch (err) { return JSON.stringify({ e: String((err as Error).message ?? err) }) }
    }
    Promise.resolve().then(() => host.act(name, parsed)).then(
      v => enter(SETTLE, JSON.stringify([id, true, v ?? null])),
      err => enter(SETTLE, JSON.stringify([id, false, String((err as Error)?.message ?? err)])))
    return undefined
  })
  enter(START, JSON.stringify(target))
  return { cancel: () => { live = false } }
}
