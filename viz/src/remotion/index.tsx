// Clips rendered from a trace (brain/architecture/brain-monitor.md). One clip directory is Remotion's public dir:
// clip.json (from scripts/clip.ts: the trace rows, the clip's span, when the recording started), captions.json
// (editable before a re-render) and the footage. Render: npx remotion render src/remotion/index.tsx wide out.mp4 --public-dir <clip dir>
import { AbsoluteFill, Composition, OffthreadVideo, registerRoot, Sequence, staticFile, useCurrentFrame, useVideoConfig, type CalculateMetadataFunction } from 'remotion'
import { SIZE, Stage, type Layout } from '../Stage.tsx'
import { activity, captionAt, duration, speedups, stateAt, traceTime, type Beat, type Row, type Segment } from '../timeline.ts'

export type ClipData = { start: number, end: number, recordStart: number | null, footage: string | null, captions: Beat[], rows: Row[] }
type Props = { layout: Layout, clip?: ClipData, segs?: Segment[] }
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
  if (!clip || !segs) return <AbsoluteFill style={{ background: '#0b0e14' }} />
  const { t, rate } = traceTime(segs, frame / fps * 1000)
  const footage = clip.footage && clip.recordStart != null
    ? <Footage clip={clip} segs={segs} />
    : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#4b5466', fontSize: 32 }}>no footage</div>
  return <Stage p={stateAt(clip.rows, t)} caption={captionAt(clip.captions, t)} badge={rate > 1.05 ? `⏩ ${Math.round(rate)}×` : undefined} layout={layout} footage={footage} />
}

const metadata: CalculateMetadataFunction<Props> = async ({ props }) => {
  const [data, captions] = await Promise.all(['clip.json', 'captions.json'].map(f => fetch(staticFile(f)).then(r => r.json())))
  const clip: ClipData = { ...data, captions }
  const segs = speedups(activity(clip.rows), clip.start, clip.end)
  return { durationInFrames: Math.max(1, Math.ceil(duration(segs) / 1000 * FPS)), props: { ...props, clip, segs } }
}

const Root = () => <>
  {(['wide', 'tall'] as const).map(layout =>
    <Composition key={layout} id={layout} component={Clip} width={SIZE[layout].w} height={SIZE[layout].h} fps={FPS} durationInFrames={1} defaultProps={{ layout }} calculateMetadata={metadata} />)}
</>

registerRoot(Root)
