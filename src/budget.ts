// Sleep and spend caps, one per Jeeve. Asleep means no model calls at any tier (Jev, 2A, 2B); spend over a rolling
// hour or day past its cap puts the Jeeve to sleep with reason "budget". The Anthropic workspace limit is the hard cap.
// ponytail: spend lives in memory, so a restart forgets it; a restarted Jeeve starts asleep (JEEVE_START_ASLEEP),
// so it spends nothing until someone wakes it.

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

// USD per million tokens. ponytail: list prices for Opus 5.5 (2A and 2B) and Jev; a model priced otherwise
// (JEEVE_SYSTEM2_MODEL, JEEVE_BUILDER_MODEL) is costed at these until it's added here.
export const PRICES = {
  anthropic: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  typesafe: { input: 0.042, output: 0, cache_read: 0, cache_write: 0 }
}

// Tokens as trace rows carry them (the `llm` field of a recorded span).
export type Tokens = { non_cached_input_tokens?: number, output_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number }

export const usd = (price: typeof PRICES.anthropic, t: Tokens) => ((t.non_cached_input_tokens ?? 0) * price.input + (t.output_tokens ?? 0) * price.output +
  (t.cache_read_input_tokens ?? 0) * price.cache_read + (t.cache_creation_input_tokens ?? 0) * price.cache_write) / 1e6

export class Budget {
  caps: { hour: number, day: number }
  asleep: string | null // why it's asleep (start, operator, budget), or null when awake
  private onSleep: (reason: string) => void // runs once each time it falls asleep
  private spends: Array<{ t: number, usd: number }> = []

  constructor (caps: Budget['caps'], asleep: string | null, onSleep: (reason: string) => void) {
    this.caps = caps
    this.asleep = asleep
    this.onSleep = onSleep
  }

  spend (usd: number, now = Date.now()) {
    this.spends.push({ t: now, usd })
    while (now - this.spends[0].t > DAY_MS) this.spends.shift()
    if (this.over(now)) this.sleep('budget')
  }

  spent (window: 'hour' | 'day', now = Date.now()) {
    const ms = window === 'hour' ? HOUR_MS : DAY_MS
    return this.spends.filter(s => now - s.t <= ms).reduce((sum, s) => sum + s.usd, 0)
  }

  over (now = Date.now()): 'hour' | 'day' | null {
    return this.spent('hour', now) >= this.caps.hour ? 'hour' : this.spent('day', now) >= this.caps.day ? 'day' : null
  }

  sleep (reason: string) {
    if (this.asleep) return
    this.asleep = reason
    this.onSleep(reason)
  }

  // Returns why it can't wake (a cap is still over), or null once awake.
  wake (now = Date.now()): string | null {
    const cap = this.over(now)
    if (cap) return `over the ${cap} cap: $${this.spent(cap, now).toFixed(2)} of $${this.caps[cap]}`
    this.asleep = null
    return null
  }

  // run, skipped while asleep: wraps each tier's entry point so no call starts during sleep.
  gate<A extends unknown[]> (run: (...args: A) => Promise<void>) {
    return async (...args: A) => { if (!this.asleep) await run(...args) }
  }
}
