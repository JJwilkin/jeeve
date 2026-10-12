// npm run curate [-- --days 7 --sessions 'jeeve-2026-10-12*,…' --library modules/library.json --out curation]: System 2B's
// between-episode loop (src/curate.ts). Run it per use case: --sessions picks the episodes, --library the library. Writes <out>/<stamp>/{library.json, library.diff, review.md, lessons.md}; changes nothing else.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import { parseArgs } from 'node:util'
import { anthropic } from '@ai-sdk/anthropic'
import { Judgeval } from 'judgeval'
import { BUILDER_MODEL } from '../src/builder.ts'
import { curate, gather, newEvidence, propose } from '../src/curate.ts'
import type { Stored } from '../src/modules.ts'
import { judgmentOrg, Recorder } from '../src/trace.ts'

const { values: o } = parseArgs({ options: {
  days: { type: 'string', default: '7' },
  sessions: { type: 'string' }, // comma-separated globs over session ids; default: every session in the window
  library: { type: 'string', default: process.env.JEEVE_MODULE_LIBRARY ?? 'modules/library.json' },
  out: { type: 'string', default: 'curation' }
} })
const library = (JSON.parse(readFileSync(o.library, 'utf8')).modules as Stored[])
if (!library.some(m => m.kind === 'behavior')) { console.log(`[curate] ${o.library} has no behaviors: nothing to curate`); process.exit(0) }

const now = new Date().toISOString()
const session = `curate-${now.replace(/[:.]/g, '-')}`
const project = process.env.JEEVE_PROJECT ?? 'jeeve-dev'
const recorder = await Recorder.init(project, session)
const client = await Judgeval.create({ projectName: project, organizationId: judgmentOrg() })
const sql = (q: string) => client.sql(q) as Promise<{ rows: Record<string, string>[] }>

const ev = newEvidence()
const facts = await gather(sql, library, { days: Number(o.days), sessions: o.sessions?.split(',') }, ev)
console.log(`[curate] ${facts.length} behaviors over the last ${o.days} days: ${facts.map(f => `${f.id} (${f.sessions.length} sessions in ${f.contexts.join(' / ')}, ${Object.values(f.picked).reduce((a, b) => a + b, 0)} picked runs)`).join('; ')}`)
const span = recorder.openTrace('curate', { 'jeeve.builder.model': BUILDER_MODEL, 'jeeve.curate.library': o.library, 'jeeve.curate.days': Number(o.days), 'jeeve.curate.sessions': o.sessions })
const t0 = Date.now()
const proposal = await curate(library, facts, sql, ev, span, session, anthropic(BUILDER_MODEL))
recorder.finish(span, 'curate', { attrs: { 'jeeve.curate.latency_ms': Date.now() - t0 }, input: { library: o.library, facts }, output: proposal ?? { error: 'no proposal submitted' } })
await recorder.shutdown()
if (!proposal) { console.error('[curate] 2B stopped without submitting a proposal'); process.exit(1) }

const dir = `${o.out}/${session.slice('curate-'.length)}`
mkdirSync(dir, { recursive: true })
const files = propose(library, proposal, { session, ev, facts, now })
writeFileSync(`${dir}/library.json`, files.library)
writeFileSync(`${dir}/review.md`, files.review)
writeFileSync(`${dir}/lessons.md`, files.lessons)
// A patch on the library's own path, so `git apply <dir>/library.diff` applies it after review.
const path = relative(process.cwd(), o.library)
writeFileSync(`${dir}/library.diff`, spawnSync('diff', ['-u', '--label', `a/${path}`, '--label', `b/${path}`, o.library, `${dir}/library.json`], { encoding: 'utf8' }).stdout)
console.log(`[curate] ${proposal.summary}\n[curate] proposal in ${dir}/ (review.md, lessons.md, library.diff); nothing applied`)
