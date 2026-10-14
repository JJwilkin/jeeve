// Clips rendered from a trace (brain/architecture/brain-monitor.md). One clip directory is Remotion's public dir:
// clip.json (from scripts/clip.ts: the trace rows, the clip's span, when the recording started), captions.json
// (editable before a re-render) and the footage. Render: npx remotion render src/remotion/index.tsx wide out.mp4 --public-dir <clip dir>
import { useMemo, type CSSProperties, type ReactNode } from 'react'
import { ThreeCanvas } from '@remotion/three'
import { AbsoluteFill, Composition, OffthreadVideo, registerRoot, Sequence, staticFile, useCurrentFrame, useVideoConfig, type CalculateMetadataFunction } from 'remotion'
import { C, FOOTAGE, MONO, SANS, SIZE, Stage, type Layout } from '../Stage.tsx'
import { makeWorld, parseWorld, type WorldRow } from '../world.ts'
import { WorldScene } from '../WorldScene.tsx'
import { activity, captionAt, duration, speedups, stateAt, traceTime, type Beat, type Row, type Segment } from '../timeline.ts'

export type ClipData = { start: number, end: number, recordStart: number | null, footage: string | null, world?: string, captions: Beat[], rows: Row[], worldRows?: WorldRow[] }
// maxSeconds: speed the whole clip up evenly to fit (for posting); the badge shows the rate.
// chapter: in a longer video (scripts/reel.ts), a bar on top showing every scenario and which one this is.
export type Chapter = { steps: Array<{ name: string, what: string }>, at: number, title?: string }
type Props = { layout: Layout, maxSeconds?: number, chapter?: Chapter, clip?: ClipData, segs?: Segment[] }
const FPS = 30

// The footage, cut into the same segments as the trace: each plays from its own spot at its own rate.
function Footage ({ clip, segs }: { clip: ClipData, segs: Segment[] }) {
  const { fps } = useVideoConfig()
  let ms = 0
  return <>{segs.map((s, i) => {
    const from = Math.round(ms / 1000 * fps)
    ms += (s.t1 - s.t0) / s.rate
    const frames = Math.round(ms / 1000 * fps) - from
    if (frames <= 0) return null
    return (
      <Sequence key={i} from={from} durationInFrames={frames}>
        <OffthreadVideo src={staticFile(clip.footage!)} muted playbackRate={s.rate} trimBefore={Math.max(0, Math.round((s.t0 - clip.recordStart!) / 1000 * fps))}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </Sequence>
    )
  })}</>
}

// The chapter bar: done scenarios ticked, this one in the accent with what it shows, the rest grey. The stage shrinks
// under it, keeping its own layout.
const BAR: Record<Layout, number> = { wide: 76, tall: 150 }
function Chapters ({ chapter, layout, children }: { chapter: Chapter, layout: Layout, children: ReactNode }) {
  const { w, h } = SIZE[layout], bar = BAR[layout], k = (h - bar) / h, tall = layout === 'tall'
  const now = chapter.steps[chapter.at]
  const chip = (i: number): CSSProperties => ({ borderRadius: 4, padding: '6px 14px', whiteSpace: 'nowrap', ...(i === chapter.at ? { background: C.accent, color: '#FFFFFF', fontWeight: 500 } : { border: `1px solid ${C.line}`, color: i < chapter.at ? C.dim : C.faint }) })
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: SANS, color: C.text }}>
      <div style={{ height: bar, display: 'flex', flexDirection: tall ? 'column' : 'row', justifyContent: 'center', alignItems: tall ? 'flex-start' : 'center', gap: tall ? 14 : 12, padding: tall ? '0 28px' : '0 32px', background: C.card, borderBottom: `1px solid ${C.line}`, fontSize: tall ? 26 : 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: MONO, color: C.dim, letterSpacing: 1, marginRight: 8 }}>{chapter.title ?? 'JEEVE'}</span>
          {chapter.steps.map((s, i) => <span key={i} style={chip(i)}>{i < chapter.at ? '✓ ' : ''}{i + 1} · {s.name}{!tall && i === chapter.at ? `: ${s.what}` : ''}</span>)}
        </div>
        {tall && <div style={{ fontWeight: 500 }}><span style={{ color: C.accent }}>{now.name}:</span> {now.what}</div>}
      </div>
      <div style={{ position: 'absolute', top: bar, left: (w - w * k) / 2, width: w, height: h, transform: `scale(${k})`, transformOrigin: 'top left' }}>{children}</div>
    </AbsoluteFill>
  )
}

function Clip ({ layout, clip, segs, chapter }: Props) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const world = useMemo(() => clip?.worldRows ? makeWorld(clip.worldRows) : null, [clip])
  if (!clip || !segs) return <AbsoluteFill style={{ background: C.bg }} />
  const { t, rate } = traceTime(segs, frame / fps * 1000)
  // OBS footage if there is some, else the recorded world drawn from the scenario's camera spot.
  const footage = clip.footage && clip.recordStart != null
    ? <Footage clip={clip} segs={segs} />
    : world
      ? <ThreeCanvas width={FOOTAGE[layout].w} height={FOOTAGE[layout].h} camera={{ fov: 60, near: 0.1, far: 200 }}><WorldScene blocks={world.blocksAt(t)} entities={world.entitiesAt(t)} camera={world.camera} /></ThreeCanvas>
      : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: C.faint, fontSize: 32 }}>no footage</div>
  const stage = <Stage p={stateAt(clip.rows, t)} caption={captionAt(clip.captions, t)} badge={rate > 1.05 ? `${Math.round(rate)}× speed` : undefined} layout={layout} footage={footage} />
  return chapter ? <Chapters chapter={chapter} layout={layout}>{stage}</Chapters> : stage
}

const metadata: CalculateMetadataFunction<Props> = async ({ props }) => {
  const [data, captions] = await Promise.all(['clip.json', 'captions.json'].map(f => fetch(staticFile(f)).then(r => r.json())))
  const worldRows = data.world ? parseWorld(await fetch(staticFile(data.world)).then(r => r.text())) : undefined
  const clip: ClipData = { ...data, captions, worldRows }
  let segs = speedups(activity(clip.rows), clip.start, clip.end)
  const over = props.maxSeconds ? duration(segs) / 1000 / props.maxSeconds : 1
  if (over > 1) segs = segs.map(s => ({ ...s, rate: s.rate * over }))
  return { durationInFrames: Math.max(1, Math.ceil(duration(segs) / 1000 * FPS)), props: { ...props, clip, segs } }
}

// A title card between clips in a progress reel (scripts/reel.ts): what changed, in a line or two.
type CardProps = { title: string, subtitle: string, layout: Layout }
function Card ({ title, subtitle, layout }: CardProps) {
  const frame = useCurrentFrame()
  const tall = layout === 'tall'
  return (
    <AbsoluteFill style={{ background: C.bg, color: C.text, fontFamily: SANS, justifyContent: 'center', alignItems: 'center', padding: tall ? 80 : 160, opacity: Math.min(1, frame / 8) }}>
      <div style={{ width: 56, height: 4, background: C.accent, borderRadius: 2, marginBottom: 40 }} />
      <div style={{ fontSize: tall ? 84 : 76, fontWeight: 500, letterSpacing: -1.5, textAlign: 'center', lineHeight: 1.15 }}>{title}</div>
      <div style={{ fontSize: tall ? 44 : 38, color: C.dim, marginTop: 36, textAlign: 'center', lineHeight: 1.35, maxWidth: 1400 }}>{subtitle}</div>
    </AbsoluteFill>
  )
}

const Root = () => <>
  {(['wide', 'tall'] as const).map(layout =>
    <Composition key={layout} id={layout} component={Clip} width={SIZE[layout].w} height={SIZE[layout].h} fps={FPS} durationInFrames={1} defaultProps={{ layout }} calculateMetadata={metadata} />)}
  {(['wide', 'tall'] as const).map(layout =>
    <Composition key={`card-${layout}`} id={`card-${layout}`} component={Card} width={SIZE[layout].w} height={SIZE[layout].h} fps={FPS} durationInFrames={FPS * 3} defaultProps={{ layout, title: '', subtitle: '' }} />)}
</>

registerRoot(Root)
