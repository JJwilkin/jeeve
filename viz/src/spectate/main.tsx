// The spectate page (spectate.html): pick a Jeeve, or the god view of all of them, and watch its world and its three
// systems on the monitor's Stage; with the operator's password, give it a goal or wake it. It talks only to the web
// relay (web/server.ts) on its own origin: /api/... (Caddy in production; `npm run monitor` proxies it in dev, to
// JEEVE_WEB or http://127.0.0.1:8080). The tab is in the hash: spectate.html#Jeeve_2, #god.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { useLiveRows } from '../live.ts'
import { C, FOOTAGE, MONO, SANS, SIZE, Stage } from '../Stage.tsx'
import { beats, captionAt, recentGoals, stateAt } from '../timeline.ts'
import { Game } from './Game.tsx'

const GOD = 'god'
const POLL_MS = 3000
const SIDE = 360 // the sidebar's width; below NARROW it goes under the view
const NARROW = 900

type Status = { asleep: string | null, spent_usd: { hour: number, day: number }, caps_usd: { hour: number, day: number } }
const ASLEEP: Record<string, string> = { start: 'asleep since it started', operator: 'asleep: someone put it to sleep', budget: 'asleep: it hit its spend cap' }
const asleepText = (s: Status) => ASLEEP[s.asleep!] ?? `asleep (${s.asleep})`

// The relay's Jeeves and each one's /status (null: unreachable), every few seconds; `refresh` polls now.
function useJeeves () {
  const [names, setNames] = useState<string[] | null>() // undefined until the first answer, null if the relay is down
  const [status, setStatus] = useState<Record<string, Status | null>>({})
  const [n, setN] = useState(0)
  useEffect(() => {
    const poll = async () => {
      const list: string[] | null = await fetch('/api/jeeves').then(r => r.json()).then(js => js.map((j: { name: string }) => j.name), () => null)
      setNames(list)
      const got = await Promise.all((list ?? []).map(name => fetch(`/api/${name}/status`).then(r => r.ok ? r.json() : null, () => null)))
      setStatus(Object.fromEntries((list ?? []).map((name, i) => [name, got[i]])))
    }
    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [n])
  return { names, status, refresh: () => setN(x => x + 1) }
}

function useWindow () {
  const [size, set] = useState({ w: innerWidth, h: innerHeight })
  useEffect(() => { const on = () => set({ w: innerWidth, h: innerHeight }); addEventListener('resize', on); return () => removeEventListener('resize', on) }, [])
  return size
}

// The authed POSTs. Caddy's basic auth answers 401 when the browser has no password (or the prompt was cancelled).
async function post (jeeve: string, what: 'instructions' | 'wake' | 'sleep', body: object = {}): Promise<{ ok: boolean, text: string }> {
  const r = await fetch(`/api/${jeeve}/${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
  if (!r) return { ok: false, text: 'The relay is unreachable.' }
  if (r.status === 401) return { ok: false, text: 'Sign-in needed: goals, wake and sleep take the operator password.' }
  const j = await r.json().catch(() => ({}))
  if (r.status === 409 && what === 'instructions') return { ok: false, text: `${jeeve} is asleep: wake it first.` }
  if (!r.ok) return { ok: false, text: j.error ?? `Failed (${r.status}).` }
  return { ok: true, text: what === 'instructions' ? `Sent: ${jeeve} has it as ${j.goal}.` : j.asleep ? `${jeeve} is asleep.` : `${jeeve} is awake.` }
}

const card: CSSProperties = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 4, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14 }
const label: CSSProperties = { fontFamily: MONO, color: C.dim, letterSpacing: 1, fontSize: 11 }
const button = (primary?: boolean): CSSProperties => ({ font: 'inherit', fontSize: 13, padding: '6px 12px', borderRadius: 4, cursor: 'pointer', border: `1px solid ${primary ? C.accent : C.line}`, background: primary ? C.accent : C.card, color: primary ? '#FFFFFF' : C.text })
const Card = ({ title, children }: { title: string, children: ReactNode }) => <div style={card}><span style={label}>{title}</span>{children}</div>

function Blurb () {
  return (
    <Card title='WHAT THIS IS'>
      <span style={{ color: C.dim, lineHeight: 1.45 }}>
        Jeeves are AI agents playing Minecraft together on one server. Each thinks on two levels: System 1 (Jev) picks what to
        do several times a second, and System 2 (Claude) plans, answers System 1 when it's unsure, and asks an async tool
        builder to write new skills as code. Pick a Jeeve to watch it think, or the god view to see them all.
      </span>
    </Card>
  )
}

const money = (x: number) => `$${x.toFixed(2)}`

function State ({ name, s }: { name: string, s: Status | null | undefined }) {
  if (s === undefined) return <Card title='STATE'><span style={{ color: C.dim }}>checking…</span></Card>
  if (s === null) return <Card title='STATE'><span style={{ color: C.bad }}>{name} is offline (the relay can't reach it).</span></Card>
  return (
    <Card title='STATE'>
      <span style={{ fontWeight: 500, color: s.asleep ? C.dim : C.ok }}>{s.asleep ? `${name} is ${asleepText(s)}` : `${name} is awake`}</span>
      {s.asleep === 'budget' && <span style={{ color: C.bad }}>It wakes only once it's back under its cap.</span>}
      <span style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>spent {money(s.spent_usd.hour)} of {money(s.caps_usd.hour)} this hour · {money(s.spent_usd.day)} of {money(s.caps_usd.day)} today</span>
    </Card>
  )
}

function GoalBox ({ name, s, sent }: { name: string, s: Status | null | undefined, sent: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean, text: string } | null>(null)
  useEffect(() => setResult(null), [name])
  const run = async (what: 'instructions' | 'wake' | 'sleep') => {
    setBusy(true)
    const r = await post(name, what, what === 'instructions' ? { from: 'web', text } : {})
    setBusy(false)
    setResult(r)
    if (r.ok && what === 'instructions') setText('')
    sent()
  }
  const asleep = !!s?.asleep
  return (
    <Card title='GIVE IT A GOAL'>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={3} placeholder={asleep ? `${name} is asleep: wake it first` : `Tell ${name} what to do`}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && text.trim() && !busy) { e.preventDefault(); void run('instructions') } }}
        style={{ font: 'inherit', fontSize: 14, padding: 8, border: `1px solid ${C.line}`, borderRadius: 4, resize: 'vertical' }} aria-label={`goal for ${name}`} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={button(true)} disabled={busy || !text.trim()} onClick={() => void run('instructions')}>Send</button>
        <button style={{ ...button(), marginLeft: 'auto' }} disabled={busy} onClick={() => void run('wake')}>Wake</button>
        <button style={button()} disabled={busy} onClick={() => void run('sleep')}>Sleep</button>
      </div>
      {result && <span style={{ color: result.ok ? C.ok : C.bad, fontSize: 13 }}>{result.text}</span>}
    </Card>
  )
}

const OUTCOME: Record<string, string> = { open: C.accent, completed: C.ok, failed: C.bad, abandoned: C.faint }

function Goals ({ goals }: { goals: ReturnType<typeof recentGoals> }) {
  return (
    <Card title='RECENT GOALS'>
      {goals.length ? goals.map(g => (
        <div key={g.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ fontFamily: MONO, fontSize: 11, color: OUTCOME[g.outcome] ?? C.dim, width: 72, flexShrink: 0 }}>{g.outcome === 'open' ? 'working' : g.outcome}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.text} <span style={{ color: C.faint }}>· {g.from}</span></span>
        </div>
      )) : <span style={{ color: C.dim }}>none yet</span>}
    </Card>
  )
}

// A Jeeve's tab: its world under the monitor's Stage panels, and the sidebar.
function JeeveView ({ name, names, s, refresh, viewW, narrow }: { name: string, names: string[], s: Status | null | undefined, refresh: () => void, viewW: number, narrow: boolean }) {
  const { rows, up, t } = useLiveRows(`/api/${name}/events`)
  const bs = useMemo(() => beats(rows), [rows])
  const goals = useMemo(() => recentGoals(rows), [rows])
  const layout = narrow ? 'tall' : 'wide' // the monitor's phone layout: game on top, panels under it
  const scale = viewW / SIZE[layout].w
  const caption = s?.asleep ? `${name} is ${asleepText(s)}.` : captionAt(bs, t) || (up === false ? `Can't reach ${name}'s trace.` : rows.length ? 'Waiting for an instruction.' : 'Connecting…')
  return <>
    <div style={{ width: viewW, height: SIZE[layout].h * scale, flexShrink: 0 }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <Stage p={stateAt(rows, t)} caption={caption} layout={layout} footage={<Game source={name} focus={name} names={names} {...FOOTAGE[layout]} />} />
      </div>
    </div>
    <Side narrow={narrow}><State name={name} s={s} /><GoalBox name={name} s={s} sent={refresh} /><Goals goals={goals} /><Blurb /></Side>
  </>
}

const Side = ({ narrow, children }: { narrow: boolean, children: ReactNode }) =>
  <div style={{ width: narrow ? '100%' : SIDE, display: 'flex', flexDirection: 'column', gap: 12, boxSizing: 'border-box', padding: narrow ? '0 16px 16px' : 0 }}>{children}</div>

function GodView ({ names, status, pick, viewW, narrow }: { names: string[], status: Record<string, Status | null>, pick: (n: string) => void, viewW: number, narrow: boolean }) {
  return <>
    <Game source={GOD} focus={null} names={names} w={viewW} h={Math.round(viewW * 9 / 16)} />
    <Side narrow={narrow}>
      <Card title='JEEVES'>
        {names.map(n => (
          <button key={n} onClick={() => pick(n)} style={{ ...button(), display: 'flex', justifyContent: 'space-between', textAlign: 'left' }}>
            <span>{n}</span><span style={{ color: C.dim }}>{status[n] === null ? 'offline' : status[n]?.asleep ? 'asleep' : status[n] ? 'awake' : '…'}</span>
          </button>
        ))}
      </Card>
      <Blurb />
    </Side>
  </>
}

function App () {
  const { names, status, refresh } = useJeeves()
  const hash = () => decodeURIComponent(location.hash.slice(1))
  const [tab, setTab] = useState(hash)
  useEffect(() => { const on = () => setTab(hash()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on) }, [])
  const { w } = useWindow()
  const pick = (n: string) => { location.hash = n }
  useEffect(() => { if (names?.length && tab !== GOD && !names.includes(tab)) setTab(names[0]) }, [names, tab])
  const narrow = w < NARROW
  const viewW = narrow ? w : w - SIDE - 48
  const dot = (n: string) => status[n] === null ? C.bad : status[n]?.asleep ? C.faint : status[n] ? C.ok : C.line
  return (
    <div style={{ minHeight: '100%', fontFamily: SANS, color: C.text, background: C.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', background: C.card, borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap' }}>
        <strong style={{ marginRight: 12 }}>Jeeve live</strong>
        {(names ?? []).map(n => (
          <button key={n} onClick={() => pick(n)} style={{ ...button(tab === n), display: 'flex', alignItems: 'center', gap: 6 }} aria-pressed={tab === n}>
            <span style={{ width: 8, height: 8, borderRadius: 8, background: tab === n ? '#FFFFFF' : dot(n) }} />{n}
          </button>
        ))}
        {names && <button onClick={() => pick(GOD)} style={button(tab === GOD)} aria-pressed={tab === GOD}>God view</button>}
        {names === null && <span style={{ color: C.bad, fontSize: 14 }}>Can't reach the relay (retrying).</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: narrow ? 12 : 16, padding: narrow ? 0 : 16, alignItems: 'flex-start' }}>
        {names && tab === GOD && <GodView names={names} status={status} pick={pick} viewW={viewW} narrow={narrow} />}
        {names?.includes(tab) && <JeeveView key='jeeve' name={tab} names={names} s={status[tab]} refresh={refresh} viewW={viewW} narrow={narrow} />}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
