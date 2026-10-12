// The one visual (brain/architecture/brain-monitor.md): caption on top, the game on the left, System 2 / builder /
// System 1 on the right with the messages between them. Fixed pixel layouts (1920×1080 and 1080×1920); the
// monitor scales the stage to its window, Remotion renders it as is.
import type { CSSProperties, ReactNode } from 'react'
import { MESSAGE_MS, type Message, type Node, type Panels } from './timeline.ts'

export type Layout = 'wide' | 'tall'
export const SIZE: Record<Layout, { w: number, h: number }> = { wide: { w: 1920, h: 1080 }, tall: { w: 1080, h: 1920 } }

const C = { bg: '#0b0e14', card: '#131823', line: '#263042', text: '#e6e9ef', dim: '#8b93a6', s2: '#b18cff', builder: '#ffb547', s1: '#47c8ff', player: '#7ee787', ok: '#3fb950', bad: '#f85149' }
const MONO = "'SF Mono', Menlo, Consolas, monospace"
const SANS = "Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif"
const COLOR: Record<Node, string> = { player: C.player, s2: C.s2, builder: C.builder, s1: C.s1 }

const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`
const clamp = (x: number) => Math.max(0, Math.min(1, x))

// pulse: the time (ms) when the pill should pulse, from the trace clock so renders stay deterministic.
function Pill ({ color, children, pulse }: { color: string, children: ReactNode, pulse?: number }) {
  return <span style={{ border: `1.5px solid ${color}`, color, borderRadius: 999, padding: '2px 12px', fontSize: '0.8em', whiteSpace: 'nowrap', opacity: pulse ? 0.65 + 0.35 * Math.sin(pulse / 200) : 1 }}>{children}</span>
}

function Card ({ title, color, right, children, style, alert }: { title: string, color: string, right?: ReactNode, children: ReactNode, style?: CSSProperties, alert?: boolean }) {
  return (
    <div style={{ background: C.card, border: `2px solid ${alert ? C.bad : C.line}`, borderTop: `4px solid ${color}`, borderRadius: 12, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden', ...style }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span style={{ color, fontWeight: 700, letterSpacing: 1.5, fontSize: '0.85em' }}>{title}</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{right}</span>
      </div>
      {children}
    </div>
  )
}

const Lines = ({ n, children, style }: { n: number, children: ReactNode, style?: CSSProperties }) =>
  <div style={{ display: '-webkit-box', WebkitLineClamp: n, WebkitBoxOrient: 'vertical', overflow: 'hidden', ...style }}>{children}</div>

function System2 ({ p, style }: { p: Panels, style: CSSProperties }) {
  const s = p.system2
  const fresh = s.guidanceAt && p.t - s.guidanceAt < 4000
  return (
    <Card title='SYSTEM 2 · ORCHESTRATOR' color={C.s2} style={style}
      right={s.thinking ? <Pill color={C.s2} pulse={p.t}>thinking… {secs(p.t - s.since!)}</Pill> : s.latencyMs ? <Pill color={C.dim}>answered in {secs(s.latencyMs)}</Pill> : null}>
      {s.trigger && <div style={{ color: C.dim, fontSize: '0.8em' }}>{s.thinking ? 'reading' : 'last read'}: {s.trigger.replaceAll('escalation:', 'escalation · ')}</div>}
      {s.note && <Lines n={3}>{s.note}</Lines>}
      {s.guidance && <Lines n={2} style={{ color: fresh ? C.s2 : C.dim, fontSize: '0.75em' }}>{fresh ? 'new guidance → ' : 'guidance: '}{s.guidance}</Lines>}
    </Card>
  )
}

const STATUS: Record<string, string> = { idle: 'idle', queued: 'queued', thinking: 'writing…', waiting: 'waiting for a trial window', trialling: 'trialling on the body', registered: 'skill registered', failed: 'failed', cancelled: 'cancelled' }

function Code ({ code, rows }: { code: NonNullable<Panels['code']>, rows: number }) {
  const lines = code.code.split('\n')
  const at = code.running?.line ?? Math.max(0, ...Object.keys(code.marks).map(Number))
  // Long behaviors: a window of lines that keeps the running line a third of the way down.
  const start = Math.max(0, Math.min(lines.length - rows, (at || 1) - 1 - Math.floor(rows / 3)))
  return (
    <div style={{ fontFamily: MONO, fontSize: '0.62em', lineHeight: 1.45, background: '#0a0d13', borderRadius: 8, padding: '8px 0', flex: 1, overflow: 'hidden' }}>
      {lines.slice(start, start + rows).map((l, i) => {
        const n = start + i + 1
        const running = code.running?.line === n
        const mark = code.marks[n]
        return (
          <div key={n} style={{ display: 'flex', whiteSpace: 'pre', background: running ? 'rgba(255,181,71,0.18)' : 'transparent', borderLeft: `3px solid ${running ? C.builder : 'transparent'}` }}>
            <span style={{ width: 34, flexShrink: 0, textAlign: 'right', color: '#4b5466', paddingRight: 10 }}>{n}</span>
            <span style={{ width: 18, flexShrink: 0, color: running ? C.builder : mark ? C.ok : C.bad }}>{running ? '▶' : mark === undefined ? '' : mark ? '✓' : '✗'}</span>
            <span style={{ color: running ? C.text : '#c3cad8', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l}</span>
          </div>
        )
      })}
    </div>
  )
}

function Builder ({ p, style, codeRows }: { p: Panels, style: CSSProperties, codeRows: number }) {
  const b = p.builder
  const busy = b.status === 'thinking' || b.status === 'waiting' || b.status === 'trialling'
  return (
    <Card title='BUILDER · 2B' color={C.builder} style={style}
      right={<>{b.trial > 0 && <Pill color={C.dim}>trial {b.trial} of {b.maxTrials}</Pill>}<Pill color={b.status === 'failed' ? C.bad : b.status === 'registered' ? C.ok : C.builder} pulse={busy ? p.t : undefined}>{STATUS[b.status]}{busy && b.since ? ` ${secs(p.t - b.since)}` : ''}</Pill></>}>
      {b.request ? <Lines n={2} style={{ fontSize: '0.8em' }}><span style={{ color: C.builder }}>{b.request.id}</span> {b.request.need}</Lines> : <div style={{ color: C.dim, fontSize: '0.8em' }}>no request yet</div>}
      {b.status === 'thinking' && b.step && <Lines n={2} style={{ color: C.dim, fontStyle: 'italic', fontSize: '0.72em' }}>{b.step}</Lines>}
      {p.code && <>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72em', color: C.dim }}>
          <span style={{ fontFamily: MONO, color: C.text }}>{p.code.name}</span>
          <span>{p.code.live ? <span style={{ color: C.builder }}>● running</span> : 'draft'}</span>
        </div>
        <Code code={p.code} rows={codeRows} />
        {p.code.running && <div style={{ fontFamily: MONO, fontSize: '0.62em', color: C.builder, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>await api.{p.code.running.call}</div>}
      </>}
      {b.result && <div style={{ fontSize: '0.75em', color: /passed|registered/.test(b.result) ? C.ok : C.bad }}>{b.result}</div>}
    </Card>
  )
}

function System1 ({ p, style }: { p: Panels, style: CSSProperties }) {
  const s = p.system1
  return (
    <Card title='SYSTEM 1 · JEV' color={C.s1} style={style} alert={!!p.veto}
      right={<>{s.trigger && <span style={{ color: C.dim, fontSize: '0.7em' }}>{s.trigger.split(',')[0]}</span>}{s.latencyMs != null && <Pill color={C.s1}>{s.latencyMs} ms</Pill>}</>}>
      {p.veto && <div style={{ color: C.bad, fontWeight: 700, fontSize: '0.8em' }}>GUARD VETO · {p.veto.reason}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 150px auto', gap: '4px 12px', alignItems: 'center', fontSize: '0.75em' }}>
        {s.answers.map(a => (
          <div key={a.q} style={{ display: 'contents' }}>
            <span style={{ color: C.dim }}>{a.q}</span>
            <span style={{ fontFamily: MONO, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: a.choice === 'keep_current' ? C.dim : C.text }}>{a.choice}</span>
            <span style={{ height: 10, background: '#1d2433', borderRadius: 5, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${a.confidence * 100}%`, background: C.s1 }} /></span>
            <span style={{ fontFamily: MONO, color: C.dim }}>{a.confidence.toFixed(2)}</span>
          </div>
        ))}
        {s.escalate != null && <div style={{ display: 'contents' }}>
          <span style={{ color: C.dim }}>escalate?</span><span />
          <span style={{ height: 10, background: '#1d2433', borderRadius: 5, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${s.escalate * 100}%`, background: C.s2 }} /></span>
          <span style={{ fontFamily: MONO, color: C.dim }}>{s.escalate.toFixed(2)}</span>
        </div>}
      </div>
    </Card>
  )
}

// Where each system sits in the column (fractions of its height), for the message arrows.
const ROWS = { s2: [0, 0.22], builder: [0.27, 0.75], s1: [0.8, 1] } as const

function Arrows ({ messages, t, h }: { messages: Message[], t: number, h: number }) {
  const mid = (n: Node) => n === 'player' ? null : (ROWS[n][0] + ROWS[n][1]) / 2 * h
  const edge = (n: Node, toward: number) => { const [a, b] = ROWS[n as keyof typeof ROWS]; return (toward > (a + b) / 2 * h ? b : a) * h }
  return (
    <>
      {messages.map((m, i) => {
        const age = t - m.t
        const go = clamp(age / 700)
        const fade = 1 - clamp((age - MESSAGE_MS + 500) / 500)
        const color = COLOR[m.from]
        // A player's message comes in from the left (the game) to System 2; System 2's reply goes back out.
        if (m.from === 'player' || m.to === 'player') {
          const y = mid('s2')! - 20 + i * 4
          const inbound = m.from === 'player'
          const x = inbound ? -60 + 120 * go : 60 - 120 * go
          return <div key={`${m.t}${i}`} style={{ position: 'absolute', left: x, top: y, opacity: fade, transform: 'translateX(-50%)', zIndex: 5 }}>
            <span style={{ background: color, color: '#0b0e14', borderRadius: 8, padding: '4px 10px', fontSize: '0.75em', fontWeight: 600, whiteSpace: 'nowrap', boxShadow: `0 0 16px ${color}` }}>{inbound ? '▶ ' : '◀ '}{m.label}</span>
          </div>
        }
        const y0 = edge(m.from, mid(m.to)!), y1 = edge(m.to, mid(m.from)!)
        const y = y0 + (y1 - y0) * go
        const up = y1 < y0
        return (
          <div key={`${m.t}${i}`} style={{ position: 'absolute', inset: 0, opacity: fade, pointerEvents: 'none', zIndex: 5 }}>
            <div style={{ position: 'absolute', left: 22, width: 4, top: Math.min(y0, y), height: Math.abs(y - y0), background: color, borderRadius: 2, boxShadow: `0 0 12px ${color}` }} />
            <div style={{ position: 'absolute', left: 8, top: y - 16, color, fontSize: 26, lineHeight: '32px' }}>{up ? '▲' : '▼'}</div>
            <div style={{ position: 'absolute', left: 44, top: y - 14, background: color, color: '#0b0e14', borderRadius: 8, padding: '3px 10px', fontSize: '0.7em', fontWeight: 600, whiteSpace: 'nowrap', maxWidth: '85%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.label}</div>
          </div>
        )
      })}
    </>
  )
}

export function Column ({ p, w, h, fontSize, codeRows }: { p: Panels, w: number, h: number, fontSize: number, codeRows: number }) {
  const at = (n: keyof typeof ROWS): CSSProperties => ({ position: 'absolute', left: 56, right: 0, top: ROWS[n][0] * h, height: (ROWS[n][1] - ROWS[n][0]) * h })
  return (
    <div style={{ position: 'relative', width: w, height: h, fontSize }}>
      <div style={{ position: 'absolute', left: 23, top: 0, bottom: 0, width: 2, background: C.line }} />
      <System2 p={p} style={at('s2')} />
      <Builder p={p} style={at('builder')} codeRows={codeRows} />
      <System1 p={p} style={at('s1')} />
      <Arrows messages={p.messages} t={p.t} h={h} />
    </div>
  )
}

const NAME: Record<Node, string> = { player: 'player', s2: 'System 2', builder: 'builder', s1: 'System 1' }

function Strip ({ p, fontSize, log }: { p: Panels, fontSize: number, log: number }) {
  const hp = p.self.health ?? 0
  const ch = p.system1.channels
  // One behavior on all three channels is the whole body.
  const holders = ch.legs && ch.legs === ch.aim && ch.aim === ch.hands ? [['body', ch.legs]] : (['legs', 'aim', 'hands'] as const).map(c => [c, ch[c]])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize, padding: '14px 20px' }}>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
        <span style={{ color: C.dim, fontSize: '0.8em' }}>GOAL</span>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.goalPath ? p.goalPath.split(' > ').map(g => g.replace(/^g-\d+:/, '')).join('  ›  ') : '—'}</span>
      </div>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', fontSize: '0.8em' }}>
        <span style={{ color: C.dim }}>HEALTH</span>
        <span style={{ width: 200, height: 12, background: '#1d2433', borderRadius: 6, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${hp * 5}%`, background: hp > 6 ? C.ok : C.bad }} /></span>
        <span style={{ fontFamily: MONO }}>{hp.toFixed(0)}/20</span>
        {holders.map(([c, b]) => <span key={c} style={{ color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c} <span style={{ fontFamily: MONO, color: b ? C.text : C.dim }}>{b ?? 'idle'}</span></span>)}
      </div>
      {(log ? p.log.slice(-log) : []).map((m, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, fontSize: '0.7em', whiteSpace: 'nowrap', overflow: 'hidden', opacity: 0.55 + 0.45 * (i + 1) / log }}>
          <span style={{ fontFamily: MONO, color: C.dim, width: 70, flexShrink: 0 }}>-{secs(p.t - m.t)}</span>
          <span style={{ color: COLOR[m.from], flexShrink: 0 }}>{NAME[m.from]} → <span style={{ color: COLOR[m.to] }}>{NAME[m.to]}</span></span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.label}</span>
        </div>
      ))}
    </div>
  )
}

function Caption ({ text, badge, fontSize }: { text: string, badge?: string, fontSize: number }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '0 36px', fontSize, fontWeight: 600, borderBottom: `2px solid ${C.line}` }}>
      <Lines n={2}>{text}</Lines>
      {badge && <span style={{ background: C.builder, color: '#0b0e14', borderRadius: 10, padding: '6px 16px', fontSize: '0.7em', fontWeight: 800, whiteSpace: 'nowrap' }}>{badge}</span>}
    </div>
  )
}

// footage: the game view (a video in clips; empty in the live monitor, where OBS layers the game underneath).
export function Stage ({ p, caption, badge, footage, layout, transparent }: { p: Panels, caption: string, badge?: string, footage?: ReactNode, layout: Layout, transparent?: boolean }) {
  const { w, h } = SIZE[layout]
  const base: CSSProperties = { position: 'relative', width: w, height: h, background: transparent ? 'transparent' : C.bg, color: C.text, fontFamily: SANS, overflow: 'hidden' }
  const game = (style: CSSProperties) => <div style={{ position: 'absolute', overflow: 'hidden', background: transparent ? 'transparent' : '#000', ...style }}>{footage}</div>
  const panel: CSSProperties = { position: 'absolute', background: C.bg }
  if (layout === 'wide') {
    return (
      <div style={base}>
        <div style={{ ...panel, left: 0, top: 0, width: w, height: 110 }}><Caption text={caption} badge={badge} fontSize={36} /></div>
        {game({ left: 0, top: 110, width: 1280, height: 720 })}
        <div style={{ ...panel, left: 0, top: 830, width: 1280, height: 250 }}><Strip p={p} fontSize={28} log={4} /></div>
        <div style={{ ...panel, left: 1280, top: 110, width: 640, height: 970, padding: '16px 16px 16px 0' }}><Column p={p} w={624} h={938} fontSize={24} codeRows={13} /></div>
      </div>
    )
  }
  return (
    <div style={base}>
      <div style={{ ...panel, left: 0, top: 0, width: w, height: 220 }}><Caption text={caption} badge={badge} fontSize={46} /></div>
      {game({ left: 0, top: 220, width: 1080, height: 608 })}
      <div style={{ ...panel, left: 0, top: 828, width: w, height: 120 }}><Strip p={p} fontSize={28} log={0} /></div>
      <div style={{ ...panel, left: 0, top: 948, width: w, height: 972, padding: '8px 20px 20px 0' }}><Column p={p} w={1060} h={944} fontSize={28} codeRows={11} /></div>
    </div>
  )
}
