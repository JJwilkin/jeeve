// The live monitor (brain/architecture/brain-monitor.md). Live: streams the agent's trace rows from its local API
// (GET /events) and shows the stage at the current time. Replay: open a traces/<session>.jsonl and scrub.
// Query: ?api=http://127.0.0.1:7777 (live source), ?trace=/@fs/<path>.jsonl (replay a file), &layout=tall, &obs=1
// (transparent game area, controls hidden: an OBS browser source over the game capture).
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { C, MONO, Stage, SIZE, type Layout } from '../Stage.tsx'
import { useLiveRows } from '../live.ts'
import { beats, captionAt, parse, stateAt, type Row } from '../timeline.ts'

const q = new URLSearchParams(location.search)
const API = q.get('api') ?? 'http://127.0.0.1:7777'
const LAYOUT = (q.get('layout') ?? 'wide') as Layout
const OBS = q.has('obs')

function useScale () {
  const { w, h } = SIZE[LAYOUT]
  const fit = () => Math.min(innerWidth / w, (innerHeight - (OBS ? 0 : 56)) / h)
  const [s, set] = useState(fit)
  useEffect(() => { const on = () => set(fit()); addEventListener('resize', on); return () => removeEventListener('resize', on) }, [])
  return s
}

function App () {
  const [mode, setMode] = useState<'live' | 'replay'>(q.has('trace') ? 'replay' : 'live')
  const live = useLiveRows(mode === 'live' ? `${API}/events` : null)
  const [replay, setReplay] = useState<{ rows: Row[], name: string, t: number }>({ rows: [], name: '', t: 0 })
  const [playing, setPlaying] = useState(false)
  const scale = useScale()
  const setT = (t: (t: number) => number) => setReplay(r => ({ ...r, t: t(r.t) }))

  // Replay: play forward at 1× from the slider.
  useEffect(() => {
    if (mode !== 'replay' || !playing) return
    const tick = setInterval(() => setT(x => x + 100), 100)
    return () => clearInterval(tick)
  }, [mode, playing])

  const open = async (f: { name: string, text: () => Promise<string> }) => {
    const r = parse(await f.text())
    setMode('replay'); setReplay({ rows: r, name: f.name.split("/").pop()!, t: r[0]?.t ?? 0 }); setPlaying(false)
  }
  useEffect(() => { const url = q.get('trace'); if (url) void open({ name: url, text: () => fetch(url).then(r => r.text()) }) }, [])
  const { rows, t } = mode === 'live' ? live : replay
  const status = mode === 'replay' ? `replay · ${replay.name}` : live.up === null ? 'connecting…' : live.up ? `live · ${API}` : `no agent at ${API} (retrying)`
  const bs = useMemo(() => beats(rows), [rows])
  const p = stateAt(rows, t)
  const t0 = rows[0]?.t ?? 0, t1 = rows.at(-1)?.t ?? 0

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: OBS ? 'transparent' : undefined }}
      onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void open(f) }}>
      {!OBS && (
        <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', fontSize: 14, background: C.card, color: C.text, borderBottom: `1px solid ${C.line}` }}>
          <strong>Jeeve monitor</strong>
          <span style={{ color: C.dim }}>{status}</span>
          {mode === 'replay' && <>
            <button onClick={() => setPlaying(x => !x)}>{playing ? 'pause' : 'play'}</button>
            <input type='range' min={t0} max={t1} step={100} value={t} onChange={e => setT(() => +e.target.value)} style={{ flex: 1 }} aria-label='time' />
            <span style={{ fontFamily: MONO }}>{((t - t0) / 1000).toFixed(1)} s</span>
            <button onClick={() => setMode('live')}>live</button>
          </>}
          <label style={{ marginLeft: mode === 'live' ? 'auto' : 0 }}>open trace <input type='file' accept='.jsonl' onChange={e => { const f = e.target.files?.[0]; if (f) void open(f) }} /></label>
        </div>
      )}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
        <div style={{ width: SIZE[LAYOUT].w * scale, height: SIZE[LAYOUT].h * scale }}>
          <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
            <Stage p={p} caption={captionAt(bs, t) || (rows.length ? 'Waiting for an instruction.' : 'Waiting for the agent.')} layout={LAYOUT} transparent={OBS}
              footage={OBS ? null : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: C.faint, fontSize: 28 }}>game view (OBS layers it here)</div>} />
          </div>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
