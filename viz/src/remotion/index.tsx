// Clips rendered from a trace (brain/architecture/brain-monitor.md). One clip directory is Remotion's public dir:
// clip.json (from scripts/clip.ts: the trace rows, the clip's span, when the recording started), captions.json
// (editable before a re-render) and the footage. Render: npx remotion render src/remotion/index.tsx wide out.mp4 --public-dir <clip dir>
import { useMemo } from 'react'
import { ThreeCanvas } from '@remotion/three'
import { AbsoluteFill, Composition, OffthreadVideo, registerRoot, Sequence, staticFile, useCurrentFrame, useVideoConfig, type CalculateMetadataFunction } from 'remotion'
import { FOOTAGE, SIZE, Stage, type Layout } from '../Stage.tsx'
import { makeWorld, parseWorld, type WorldRow } from '../world.ts'
import { WorldScene } from '../WorldScene.tsx'
import { activity, captionAt, duration, speedups, stateAt, traceTime, type Beat, type Row, type Segment } from '../timeline.ts'

export type ClipData = { start: number, end: number, recordStart: number | null, footage: string | null, world?: string, captions: Beat[], rows: Row[], worldRows?: WorldRow[] }
// maxSeconds: speed the whole clip up evenly to fit (for posting); the badge shows the rate.
type Props = { layout: Layout, maxSeconds?: number, clip?: ClipData, segs?: Segment[] }
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

function Clip ({ layout, clip, segs }: Props) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const world = useMemo(() => clip?.worldRows ? makeWorld(clip.worldRows) : null, [clip])
  if (!clip || !segs) return <AbsoluteFill style={{ background: '#0b0e14' }} />
  const { t, rate } = traceTime(segs, frame / fps * 1000)
  // OBS footage if there is some, else the recorded world drawn from the scenario's camera spot.
  const footage = clip.footage && clip.recordStart != null
    ? <Footage clip={clip} segs={segs} />
    : world
      ? <ThreeCanvas width={FOOTAGE[layout].w} height={FOOTAGE[layout].h} camera={{ fov: 60, near: 0.1, far: 200 }}><WorldScene blocks={world.blocksAt(t)} entities={world.entitiesAt(t)} camera={world.camera} /></ThreeCanvas>
      : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#4b5466', fontSize: 32 }}>no footage</div>
  return <Stage p={stateAt(clip.rows, t)} caption={captionAt(clip.captions, t)} badge={rate > 1.05 ? `⏩ ${Math.round(rate)}×` : undefined} layout={layout} footage={footage} />
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

const Root = () => <>
  {(['wide', 'tall'] as const).map(layout =>
    <Composition key={layout} id={layout} component={Clip} width={SIZE[layout].w} height={SIZE[layout].h} fps={FPS} durationInFrames={1} defaultProps={{ layout }} calculateMetadata={metadata} />)}
</>

registerRoot(Root)
