// What a public viewer gets of a trace row (the spectate page, via web/server.ts). Rows keep their shape, so the
// page runs them through viz's slim() and stateAt() as the monitor does. Players' names stay (Joshua: "Show them").
import { MODULE_LIMITS } from '../src/modules.ts'

export type Row = { t: number, kind: string, [k: string]: any }

// The longest behavior code a Jeeve accepts, so the Stage code panel shows it whole.
export const MAX_STRING = MODULE_LIMITS.behaviorCodeChars

const json = (s: unknown) => { try { return typeof s === 'string' ? JSON.parse(s) : undefined } catch { return undefined } }

function cap (v: unknown): unknown {
  if (typeof v === 'string') return v.length > MAX_STRING ? v.slice(0, MAX_STRING - 1) + '…' : v
  if (Array.isArray(v)) return v.map(cap)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cap(x)]))
  return v
}

// Drops the raw snapshot (all but `self`, which the strip reads) and Jev's input from decide rows, and 2A's full
// input and SQL from system2 rows; caps every string.
export function publicRow (r: Row): Row {
  const { input, ...rest } = r
  if (r.kind === 'decide') {
    const raw = json(r.attrs?.['jeeve.decide.raw_state'])
    return cap({ ...rest, attrs: { ...r.attrs, 'jeeve.decide.raw_state': JSON.stringify({ self: raw?.self }) } }) as Row
  }
  if (r.kind === 'system2') return cap({ ...rest, output: { decision: r.output?.decision, error: r.output?.error } }) as Row
  return cap(r) as Row
}
