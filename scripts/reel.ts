// A progress reel (brain/architecture/bench-hill-climb.md): rendered clips in order, each after a title card that
// says what changed. Every clip dir must already have clip-16x9.mp4 and clip-9x16.mp4 (npm run clip -- --render).
//   node scripts/reel.ts reel.json clips/reel      → clips/reel-16x9.mp4, clips/reel-9x16.mp4
// reel.json: [{ "dir": "clips/orchard-…", "title": "Run 1: from nothing", "subtitle": "…" }, …]
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [listFile, out] = process.argv.slice(2)
const items: Array<{ dir: string, title: string, subtitle: string }> = JSON.parse(readFileSync(listFile, 'utf8'))
const tmp = resolve(`${out}-parts`)
mkdirSync(tmp, { recursive: true })
const run = (cmd: string, args: string[], cwd = '.') => {
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] })
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed`)
}

for (const [layout, file] of [['wide', 'clip-16x9.mp4'], ['tall', 'clip-9x16.mp4']] as const) {
  const parts: string[] = []
  items.forEach((it, i) => {
    const card = `${tmp}/card-${layout}-${i}.mp4`
    run('npx', ['remotion', 'render', 'src/remotion/index.tsx', `card-${layout}`, card, '--props', JSON.stringify({ layout, title: it.title, subtitle: it.subtitle })], 'viz')
    parts.push(card, resolve(it.dir, file))
  })
  writeFileSync(`${tmp}/${layout}.txt`, parts.map(p => `file '${p}'`).join('\n') + '\n')
  // Re-encoded, so cards and clips join cleanly whatever their encoder settings.
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${tmp}/${layout}.txt`, '-an', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', resolve(`${out}-${layout === 'wide' ? '16x9' : '9x16'}.mp4`)])
  console.log(`[reel] ${out}-${layout === 'wide' ? '16x9' : '9x16'}.mp4`)
}
