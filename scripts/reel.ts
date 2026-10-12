// A progress reel or a highlight cut (brain/architecture/bench-hill-climb.md): rendered clips in order, with title
// cards. Every clip dir must already have clip-16x9.mp4 and clip-9x16.mp4 (npm run clip -- --render).
//   node scripts/reel.ts bench/reel-2026-10-12.json clips/reel      → clips/reel-16x9.mp4, clips/reel-9x16.mp4
// Each entry is a card ("title", "subtitle", "card" seconds, default 3), a clip ("dir", optionally cut to "seconds"
// from "from"), or both: the card, then the clip.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Item = { dir?: string, from?: number, seconds?: number, title?: string, subtitle?: string, card?: number }
const FPS = 30
const [listFile, out] = process.argv.slice(2)
const items: Item[] = JSON.parse(readFileSync(listFile, 'utf8'))
const tmp = resolve(`${out}-parts`)
mkdirSync(tmp, { recursive: true })
const run = (cmd: string, args: string[], cwd = '.') => {
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] })
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed`)
}

for (const [layout, file, suffix] of [['wide', 'clip-16x9.mp4', '16x9'], ['tall', 'clip-9x16.mp4', '9x16']] as const) {
  const inputs: string[] = []
  items.forEach((it, i) => {
    if (it.title) {
      const card = `${tmp}/card-${layout}-${i}.mp4`, seconds = it.card ?? 3
      run('npx', ['remotion', 'render', 'src/remotion/index.tsx', `card-${layout}`, card, `--frames=0-${Math.round(seconds * FPS) - 1}`, '--props', JSON.stringify({ layout, title: it.title, subtitle: it.subtitle ?? '' })], 'viz')
      inputs.push('-t', String(seconds), '-i', card)
    }
    if (it.dir) inputs.push(...(it.from ? ['-ss', String(it.from)] : []), ...(it.seconds ? ['-t', String(it.seconds)] : []), '-i', resolve(it.dir, file))
  })
  // One concat filter, re-encoded, so cards, cuts and clips join cleanly whatever their encoder settings.
  const n = inputs.filter(a => a === '-i').length
  const graph = Array.from({ length: n }, (_, k) => `[${k}:v]fps=${FPS},setsar=1,setpts=PTS-STARTPTS[v${k}];`).join('') +
    Array.from({ length: n }, (_, k) => `[v${k}]`).join('') + `concat=n=${n}:v=1:a=0[out]`
  const target = resolve(`${out}-${suffix}.mp4`)
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', '[out]', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', target])
  console.log(`[reel] ${target}`)
}
