// The one visual (brain/architecture/brain-monitor.md): the game with its caption on it, the goal and log under it,
// and System 2 / System 1 / the async tool builder in a column with the messages between them. Fixed pixel layouts (1920×1080 and 1080×1920); the
// monitor scales the stage to its window, Remotion renders it as is.
import type { CSSProperties, ReactNode } from 'react'
import { loadFont as loadDMMono } from '@remotion/google-fonts/DMMono'
import { loadFont as loadInter } from '@remotion/google-fonts/Inter'
import { MESSAGE_MS, type Message, type Node, type Panels } from './timeline.ts'

export type Layout = 'wide' | 'tall'
export const SIZE: Record<Layout, { w: number, h: number }> = { wide: { w: 1920, h: 1080 }, tall: { w: 1080, h: 1920 } }
// The game view inside the stage.
export const FOOTAGE: Record<Layout, { w: number, h: number }> = { wide: { w: 1280, h: 720 }, tall: { w: 1080, h: 608 } }

// The Judgment Labs look (judgmentlabs.ai): light greys, one accent for whatever is active right now, green and red
// only where they mean pass or fail. Inter and DM Mono load the same way in Remotion and the monitor.
export const C = {
  bg: '#FAFAFA', panel: '#F5F5F5', card: '#FFFFFF', line: 'rgba(0,0,0,0.10)', fill: 'rgba(0,0,0,0.05)',
  text: 'rgba(0,0,0,0.85)', dim: 'rgba(0,0,0,0.6)', faint: 'rgba(0,0,0,0.35)', accent: '#FF4B2E', ok: '#1E9E5A', bad: '#D92D20'
}
export const MONO = "'DM Mono', 'SF Mono', Menlo, monospace"
export const SANS = "Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif"
loadInter('normal', { weights: ['400', '500'], subsets: ['latin'] })
loadDMMono('normal', { weights: ['400', '500'], subsets: ['latin'] })

const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`
const clamp = (x: number) => Math.max(0, Math.min(1, x))

// pulse: the time (ms) when the pill should pulse, from the trace clock so renders stay deterministic.
function Pill ({ color = C.dim, children, pulse }: { color?: string, children: ReactNode, pulse?: number }) {
  return <span style={{ border: `1px solid ${color === C.dim ? C.line : color}`, color, borderRadius: 4, padding: '2px 10px', fontFamily: MONO, fontSize: '0.7em', whiteSpace: 'nowrap', opacity: pulse ? 0.7 + 0.3 * Math.sin(pulse / 200) : 1 }}>{children}</span>
}

function Card ({ title, active, right, children, style, alert }: { title: string, active: boolean, right?: ReactNode, children: ReactNode, style?: CSSProperties, alert?: boolean }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${alert ? C.bad : C.line}`, borderRadius: 4, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden', ...style }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, whiteSpace: 'nowrap', fontFamily: MONO, color: C.dim, letterSpacing: 1, fontSize: '0.72em' }}>
          <span style={{ width: 9, height: 9, borderRadius: 9, flexShrink: 0, background: active ? C.accent : C.faint }} />{title}
        </span>
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
    <Card title='SYSTEM 2 · ORCHESTRATOR' active={!!s.thinking} style={style}
      right={s.thinking ? <Pill color={C.accent} pulse={p.t}>thinking… {secs(p.t - s.since!)}</Pill> : s.latencyMs ? <Pill>answered in {secs(s.latencyMs)}</Pill> : null}>
      {s.trigger && <div style={{ color: C.dim, fontSize: '0.8em' }}>{s.thinking ? 'reading' : 'last read'}: {s.trigger.replaceAll('escalation:', 'escalation · ')}</div>}
      {s.note && <Lines n={3}>{s.note}</Lines>}
      {s.guidance && <Lines n={2} style={{ color: C.dim, fontSize: '0.75em' }}>{fresh ? <span style={{ color: C.accent }}>new guidance → </span> : 'guidance: '}{s.guidance}</Lines>}
    </Card>
  )
}

const STATUS: Record<string, string> = { idle: 'idle', queued: 'queued', thinking: 'writing…', waiting: 'waiting for a trial window', trialling: 'trialling', registered: 'skill registered', failed: 'failed', cancelled: 'cancelled' }

function Code ({ code, rows }: { code: NonNullable<Panels['code']>, rows: number }) {
  const lines = code.code.split('\n')
  const at = code.running?.line ?? Math.max(0, ...Object.keys(code.marks).map(Number))
  // Long behaviors: a window of lines that keeps the running line a third of the way down.
  const start = Math.max(0, Math.min(lines.length - rows, (at || 1) - 1 - Math.floor(rows / 3)))
  return (
    <div style={{ fontFamily: MONO, fontSize: '0.62em', lineHeight: 1.45, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 4, padding: '8px 0', flex: 1, overflow: 'hidden' }}>
      {lines.slice(start, start + rows).map((l, i) => {
        const n = start + i + 1
        const running = code.running?.line === n
        const mark = code.marks[n]
        return (
          <div key={n} style={{ display: 'flex', whiteSpace: 'pre', background: running ? 'rgba(255,75,46,0.10)' : 'transparent', borderLeft: `3px solid ${running ? C.accent : 'transparent'}` }}>
            <span style={{ width: 34, flexShrink: 0, textAlign: 'right', color: C.faint, paddingRight: 10 }}>{n}</span>
            <span style={{ width: 18, flexShrink: 0, color: running ? C.accent : mark ? C.ok : C.bad }}>{running ? '▶' : mark === undefined ? '' : mark ? '✓' : '✗'}</span>
            <span style={{ color: running ? C.text : C.dim, overflow: 'hidden', textOverflow: 'ellipsis' }}>{l}</span>
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
    <Card title='ASYNC TOOL BUILDER' active={busy} style={style}
      right={<>{b.trial > 0 && <Pill>trial {b.trial} of {b.maxTrials}</Pill>}<Pill color={b.status === 'failed' ? C.bad : b.status === 'registered' ? C.ok : busy ? C.accent : C.dim} pulse={busy ? p.t : undefined}>{STATUS[b.status]}{busy && b.since ? ` ${secs(p.t - b.since)}` : ''}</Pill></>}>
      {b.request ? <Lines n={2} style={{ fontSize: '0.8em' }}><span style={{ fontFamily: MONO, color: C.dim }}>{b.request.id}</span> {b.request.need}</Lines> : <div style={{ color: C.dim, fontSize: '0.8em' }}>no request yet</div>}
      {b.status === 'thinking' && b.step && <Lines n={2} style={{ color: C.dim, fontStyle: 'italic', fontSize: '0.72em' }}>{b.step}</Lines>}
      {p.code && <>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72em', color: C.dim }}>
          <span style={{ fontFamily: MONO, color: C.text }}>{p.code.name}</span>
          <span style={{ fontFamily: MONO }}>{p.code.live ? <span style={{ color: C.accent }}>● running</span> : 'draft'}</span>
        </div>
        <Code code={p.code} rows={codeRows} />
        {p.code.running && <div style={{ fontFamily: MONO, fontSize: '0.62em', color: C.accent, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>await api.{p.code.running.call}</div>}
      </>}
      {b.result && <div style={{ fontSize: '0.75em', color: /passed|registered/.test(b.result) ? C.ok : C.bad }}>{b.result}</div>}
    </Card>
  )
}

function System1 ({ p, style, active }: { p: Panels, style: CSSProperties, active: boolean }) {
  const s = p.system1
  return (
    <Card title='SYSTEM 1 · JEV' active={active} style={style} alert={!!p.veto}
      right={<>{s.trigger && <span style={{ color: C.dim, fontSize: '0.7em' }}>{s.trigger.split(',')[0]}</span>}{s.latencyMs != null && <Pill>{s.latencyMs} ms</Pill>}</>}>
      {p.veto && <div style={{ color: C.bad, fontWeight: 500, fontSize: '0.8em' }}>GUARD VETO · {p.veto.reason}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 150px auto', gap: '4px 12px', alignItems: 'center', fontSize: '0.75em' }}>
        {s.answers.map(a => (
          <div key={a.q} style={{ display: 'contents' }}>
            <span style={{ color: C.dim }}>{a.q}</span>
            <span style={{ fontFamily: MONO, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: a.choice === 'keep_current' ? C.dim : C.text }}>{a.choice}</span>
            <span style={{ height: 8, background: C.fill, borderRadius: 2, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${a.confidence * 100}%`, background: a.choice === 'keep_current' ? C.faint : C.accent }} /></span>
            <span style={{ fontFamily: MONO, color: C.dim }}>{a.confidence.toFixed(2)}</span>
          </div>
        ))}
        {s.escalate != null && <div style={{ display: 'contents' }}>
          <span style={{ color: C.dim }}>escalate?</span><span />
          <span style={{ height: 8, background: C.fill, borderRadius: 2, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${s.escalate * 100}%`, background: C.faint }} /></span>
          <span style={{ fontFamily: MONO, color: C.dim }}>{s.escalate.toFixed(2)}</span>
        </div>}
      </div>
    </Card>
  )
}

// Where each system sits in the column (fractions of its height), for the message arrows.
const ROWS = { s2: [0, 0.22], s1: [0.26, 0.46], builder: [0.5, 1] } as const

function Arrows ({ messages, t, h }: { messages: Message[], t: number, h: number }) {
  const mid = (n: Node) => n === 'player' ? null : (ROWS[n][0] + ROWS[n][1]) / 2 * h
  const edge = (n: Node, toward: number) => { const [a, b] = ROWS[n as keyof typeof ROWS]; return (toward > (a + b) / 2 * h ? b : a) * h }
  return (
    <>
      {messages.map((m, i) => {
        const age = t - m.t
        const go = clamp(age / 700)
        const fade = 1 - clamp((age - MESSAGE_MS + 500) / 500)
        const color = C.accent
        // A player's message comes in from the left (the game) to System 2; System 2's reply goes back out.
        if (m.from === 'player' || m.to === 'player') {
          const y = mid('s2')! - 20 + i * 4
          const inbound = m.from === 'player'
          const x = inbound ? -60 + 120 * go : 60 - 120 * go
          return <div key={`${m.t}${i}`} style={{ position: 'absolute', left: x, top: y, opacity: fade, transform: 'translateX(-50%)', zIndex: 5 }}>
            <span style={{ background: color, color: '#FFFFFF', borderRadius: 4, padding: '4px 10px', fontSize: '0.75em', fontWeight: 500, whiteSpace: 'nowrap' }}>{inbound ? '▶ ' : '◀ '}{m.label}</span>
          </div>
        }
        const y0 = edge(m.from, mid(m.to)!), y1 = edge(m.to, mid(m.from)!)
        const y = y0 + (y1 - y0) * go
        const up = y1 < y0
        return (
          <div key={`${m.t}${i}`} style={{ position: 'absolute', inset: 0, opacity: fade, pointerEvents: 'none', zIndex: 5 }}>
            <div style={{ position: 'absolute', left: 22, width: 4, top: Math.min(y0, y), height: Math.abs(y - y0), background: color, borderRadius: 2 }} />
            <div style={{ position: 'absolute', left: 8, top: y - 16, color, fontSize: 26, lineHeight: '32px' }}>{up ? '▲' : '▼'}</div>
            <div style={{ position: 'absolute', left: 44, top: y - 14, background: color, color: '#FFFFFF', borderRadius: 4, padding: '3px 10px', fontSize: '0.7em', fontWeight: 500, whiteSpace: 'nowrap', maxWidth: '85%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.label}</div>
          </div>
        )
      })}
    </>
  )
}

export function Column ({ p, w, h, fontSize, codeRows }: { p: Panels, w: number, h: number, fontSize: number, codeRows: number }) {
  const sending = (n: Node) => p.messages.some(m => m.from === n && p.t - m.t < MESSAGE_MS)
  const at = (n: keyof typeof ROWS): CSSProperties => ({ position: 'absolute', left: 56, right: 0, top: ROWS[n][0] * h, height: (ROWS[n][1] - ROWS[n][0]) * h })
  return (
    <div style={{ position: 'relative', width: w, height: h, fontSize }}>
      <div style={{ position: 'absolute', left: 23, top: 0, bottom: 0, width: 2, background: C.line }} />
      <System2 p={p} style={at('s2')} />
      <Builder p={p} style={at('builder')} codeRows={codeRows} />
      <System1 p={p} style={at('s1')} active={sending('s1')} />
      <Arrows messages={p.messages} t={p.t} h={h} />
    </div>
  )
}

const NAME: Record<Node, string> = { player: 'player', s2: 'System 2', builder: 'tool builder', s1: 'System 1' }

function Strip ({ p, fontSize, log }: { p: Panels, fontSize: number, log: number }) {
  const hp = p.self.health ?? 0
  const ch = p.system1.channels
  // One behavior on all three channels is the whole body.
  const holders = ch.legs && ch.legs === ch.aim && ch.aim === ch.hands ? [['body', ch.legs]] : (['legs', 'aim', 'hands'] as const).map(c => [c, ch[c]])
  // The goal is what everything else serves, so it gets the one raised box: the step being worked on in full, the
  // goal it belongs to greyed (and cut short first) before it.
  const path = p.goalPath ? p.goalPath.split(' > ').map(g => g.replace(/^g-\d+:/, '')) : []
  const step = path.at(-1), parents = path.slice(0, -1).join('  ›  ')
  const cut: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize, padding: '12px 20px' }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', background: C.card, border: `1px solid ${C.line}`, borderLeft: `5px solid ${C.accent}`, borderRadius: 4, padding: '8px 16px', boxShadow: '0 1px 2px rgba(0,0,0,0.06), 0 6px 16px rgba(0,0,0,0.06)' }}>
        <span style={{ fontFamily: MONO, color: C.accent, fontSize: '0.7em', letterSpacing: 1, flexShrink: 0 }}>GOAL</span>
        {parents && <span style={{ ...cut, color: C.dim, flex: '0 100 auto', minWidth: 0, maxWidth: '35%' }}>{parents}</span>}
        {parents && <span style={{ color: C.faint, flexShrink: 0 }}>›</span>}
        <span style={{ ...cut, fontWeight: 500, flex: '0 1 auto', minWidth: 0 }}>{step ?? '—'}</span>
      </div>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', fontSize: '0.8em' }}>
        <span style={{ fontFamily: MONO, color: C.dim, fontSize: '0.875em', letterSpacing: 1 }}>HEALTH</span>
        <span style={{ width: 200, height: 10, background: C.fill, borderRadius: 2, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${hp * 5}%`, background: hp > 6 ? C.ok : C.bad }} /></span>
        <span style={{ fontFamily: MONO }}>{hp.toFixed(0)}/20</span>
        {holders.map(([c, b]) => <span key={c} style={{ color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c} <span style={{ fontFamily: MONO, color: b ? C.text : C.dim }}>{b ?? 'idle'}</span></span>)}
      </div>
      {(log ? p.log.slice(-log) : []).map((m, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, fontSize: '0.7em', whiteSpace: 'nowrap', overflow: 'hidden', opacity: 0.55 + 0.45 * (i + 1) / log }}>
          <span style={{ fontFamily: MONO, color: C.dim, width: 70, flexShrink: 0 }}>-{secs(p.t - m.t)}</span>
          <span style={{ color: i === log - 1 && p.t - m.t < MESSAGE_MS ? C.accent : C.dim, flexShrink: 0 }}>{NAME[m.from]} → {NAME[m.to]}</span>
          <span style={{ color: C.text, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.label}</span>
        </div>
      ))}
    </div>
  )
}

// The caption sits on the game itself, top left, with the speed badge top right.
function Caption ({ text, badge, fontSize }: { text: string, badge?: string, fontSize: number }) {
  const float: CSSProperties = { position: 'absolute', top: 20, zIndex: 4, borderRadius: 4, boxShadow: '0 1px 2px rgba(0,0,0,0.08), 0 6px 18px rgba(0,0,0,0.10)' }
  return <>
    {text && <div style={{ ...float, left: 20, maxWidth: '76%', padding: '10px 18px', fontSize, fontWeight: 500, letterSpacing: -0.3, lineHeight: 1.25, background: 'rgba(255,255,255,0.94)', border: `1px solid ${C.line}` }}><Lines n={2}>{text}</Lines></div>}
    {badge && <span style={{ ...float, right: 20, background: C.accent, color: '#FFFFFF', padding: '6px 14px', fontFamily: MONO, fontSize: fontSize * 0.62, fontWeight: 500, whiteSpace: 'nowrap' }}>{badge}</span>}
  </>
}

// footage: the game view (a video in clips; empty in the live monitor, where OBS layers the game underneath).
export function Stage ({ p, caption, badge, footage, layout, transparent }: { p: Panels, caption: string, badge?: string, footage?: ReactNode, layout: Layout, transparent?: boolean }) {
  const { w, h } = SIZE[layout]
  const base: CSSProperties = { position: 'relative', width: w, height: h, background: transparent ? 'transparent' : C.bg, color: C.text, fontFamily: SANS, overflow: 'hidden' }
  const game = (style: CSSProperties, fontSize: number) => <div style={{ position: 'absolute', overflow: 'hidden', background: transparent ? 'transparent' : C.panel, ...style }}>{footage}<Caption text={caption} badge={badge} fontSize={fontSize} /></div>
  const panel: CSSProperties = { position: 'absolute', background: C.bg }
  const column: CSSProperties = { ...panel, background: C.panel, borderLeft: `1px solid ${C.line}` }
  if (layout === 'wide') {
    return (
      <div style={base}>
        {game({ left: 0, top: 0, width: 1280, height: 720 }, 30)}
        <div style={{ ...panel, left: 0, top: 720, width: 1280, height: 360 }}><Strip p={p} fontSize={28} log={6} /></div>
        <div style={{ ...column, left: 1280, top: 0, width: 640, height: h, padding: '16px 16px 16px 0' }}><Column p={p} w={624} h={1048} fontSize={24} codeRows={15} /></div>
      </div>
    )
  }
  return (
    <div style={base}>
      {game({ left: 0, top: 0, width: 1080, height: 608 }, 36)}
      <div style={{ ...panel, left: 0, top: 608, width: w, height: 120 }}><Strip p={p} fontSize={28} log={0} /></div>
      <div style={{ ...column, borderLeft: 'none', borderTop: `1px solid ${C.line}`, left: 0, top: 728, width: w, height: h - 728, padding: '8px 20px 20px 0' }}><Column p={p} w={1060} h={h - 756} fontSize={28} codeRows={14} /></div>
    </div>
  )
}
