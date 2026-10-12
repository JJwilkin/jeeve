// The live monitor (brain/architecture/brain-monitor.md). Live: streams the agent's trace rows from its local API
// (GET /events) and shows the stage at the current time. Replay: open a traces/<session>.jsonl and scrub.
// Query: ?api=http://127.0.0.1:7777 (live source), ?trace=/@fs/<path>.jsonl (replay a file), &layout=tall, &obs=1
// (transparent game area, controls hidden: an OBS browser source over the game capture).
import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Stage, SIZE, type Layout } from '../Stage.tsx'
import { beats, captionAt, parse, slim, stateAt, type Row } from '../timeline.ts'

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
  const [rows, setRows] = useState<Row[]>([])
  const [mode, setMode] = useState<'live' | 'replay'>(q.has('trace') ? 'replay' : 'live')
  const [status, setStatus] = useState('connecting…')
  const [t, setT] = useState(Date.now())
  const [playing, setPlaying] = useState(false)
  const buf = useRef<Row[]>([])
  const scale = useScale()

  // Live: rows arrive one by one; batch them into state ten times a second.
  useEffect(() => {
    if (mode !== 'live') return
    const es = new EventSource(`${API}/events`)
    let fresh = true // each (re)connect replays the session from its first row
    es.onopen = () => { setStatus(`live · ${API}`); buf.current = []; fresh = true }
    es.onerror = () => setStatus(`no agent at ${API} (retrying)`)
    es.onmessage = e => { buf.current.push(slim(JSON.parse(e.data))) }
    const tick = setInterval(() => {
      if (buf.current.length) {
        const add = buf.current
        buf.current = []
        setRows(r => fresh ? add : [...r, ...add])
        fresh = false
      }
      setT(Date.now())
    }, 100)
    return () => { es.close(); clearInterval(tick) }
  }, [mode])

  // Replay: play forward at 1× from the slider.
  useEffect(() => {
    if (mode !== 'replay' || !playing) return
    const tick = setInterval(() => setT(x => x + 100), 100)
    return () => clearInterval(tick)
  }, [mode, playing])

  const open = async (f: { name: string, text: () => Promise<string> }) => {
    const r = parse(await f.text())
    setMode('replay'); setRows(r); setT(r[0]?.t ?? 0); setPlaying(false); setStatus(`replay · ${f.name.split("/").pop()}`)
  }
  useEffect(() => { const url = q.get('trace'); if (url) void open({ name: url, text: () => fetch(url).then(r => r.text()) }) }, [])
  const bs = useMemo(() => beats(rows), [rows])
  const p = stateAt(rows, t)
  const t0 = rows[0]?.t ?? 0, t1 = rows.at(-1)?.t ?? 0

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: OBS ? 'transparent' : undefined }}
      onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void open(f) }}>
      {!OBS && (
        <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', fontSize: 14, borderBottom: '1px solid #263042' }}>
          <strong>Jeeve monitor</strong>
          <span style={{ color: '#8b93a6' }}>{status}</span>
          {mode === 'replay' && <>
            <button onClick={() => setPlaying(x => !x)}>{playing ? 'pause' : 'play'}</button>
            <input type='range' min={t0} max={t1} step={100} value={t} onChange={e => setT(+e.target.value)} style={{ flex: 1 }} aria-label='time' />
            <span style={{ fontFamily: 'monospace' }}>{((t - t0) / 1000).toFixed(1)} s</span>
            <button onClick={() => { setMode('live'); setRows([]); setStatus('connecting…') }}>live</button>
          </>}
          <label style={{ marginLeft: mode === 'live' ? 'auto' : 0 }}>open trace <input type='file' accept='.jsonl' onChange={e => { const f = e.target.files?.[0]; if (f) void open(f) }} /></label>
        </div>
      )}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
        <div style={{ width: SIZE[LAYOUT].w * scale, height: SIZE[LAYOUT].h * scale }}>
          <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
            <Stage p={p} caption={captionAt(bs, t) || (rows.length ? 'Waiting for an instruction.' : 'Waiting for the agent.')} layout={LAYOUT} transparent={OBS}
              footage={OBS ? null : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#4b5466', fontSize: 28 }}>game view (OBS layers it here)</div>} />
          </div>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
