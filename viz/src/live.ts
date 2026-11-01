// Trace rows live from an /events stream (the agent's own, or the relay's /api/<jeeve>/events), batched into state
// ten times a second, with the clock. Each (re)connect replays the session from its first row, so it replaces what
// was there. url null: not connected. up: null while connecting.
import { useEffect, useState } from 'react'
import { slim, type Row } from './timeline.ts'

export function useLiveRows (url: string | null) {
  const [rows, setRows] = useState<Row[]>([])
  const [up, setUp] = useState<boolean | null>(null)
  const [t, setT] = useState(Date.now())
  useEffect(() => {
    setRows([])
    setUp(null)
    if (!url) return
    const es = new EventSource(url)
    let buf: Row[] = []
    let fresh = true
    es.onopen = () => { setUp(true); buf = []; fresh = true }
    es.onerror = () => setUp(false)
    es.onmessage = e => { buf.push(slim(JSON.parse(e.data))) }
    const tick = setInterval(() => {
      if (buf.length) {
        const add = buf
        buf = []
        setRows(r => fresh ? add : [...r, ...add])
        fresh = false
      }
      setT(Date.now())
    }, 100)
    return () => { es.close(); clearInterval(tick) }
  }, [url])
  return { rows, up, t }
}
