// The recorded world (world.jsonl) drawn the way a Minecraft client draws it: real block models, textures and mob
// models via prismarine-viewer, rendered headless to <clip dir>/world.mp4 in trace time. clip.json then points its
// footage at it, so the clip plays it like OBS footage: cut and sped up by the same segments.
//   node viz/src/world-video.ts clips/<dir>
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { makeWorld, parseWorld, type WorldRow } from './world.ts'

const require = createRequire(import.meta.url)
const viewerRequire = createRequire(require.resolve('prismarine-viewer'))
const THREE = viewerRequire('three') // the viewer pins its own three (0.128), and reads it from the global
Object.assign(globalThis, { THREE, Worker: require('node:worker_threads').Worker })
const { createCanvas, loadImage } = require('node-canvas-webgl/lib')
const { Viewer, WorldView } = require('prismarine-viewer').viewer
const { Vec3 } = viewerRequire('vec3')

// The viewer's zombie and husk models render as a crumpled head. Their skins use the player layout, so they're drawn
// as players with arms out. The 64×64 files leave the left limbs blank; cropped to the old 64×32 layout, the viewer
// mirrors the right limbs over them.
// Skin paths are joined onto the viewer's public/, so the cropped file is named relative to it.
const PUBLIC = join(dirname(require.resolve('prismarine-viewer')), 'public')
const SKINS: Record<string, string> = {}
for (const name of ['zombie', 'husk']) {
  const image = await loadImage(join(PUBLIC, `textures/1.16.4/entity/zombie/${name}.png`))
  const legacy = createCanvas(64, 32)
  legacy.getContext('2d').drawImage(image, 0, 0)
  const file = join(tmpdir(), `jeeve-${name}-skin.png`)
  writeFileSync(file, legacy.toBuffer('image/png'))
  SKINS[name] = relative(PUBLIC, file)
}

const VERSION = '26.1'
const FPS = 30
const [W, H] = [1280, 720]
const APRON = 64 // grass beyond the recorded box, so the world doesn't end at a cliff

const dir = process.argv[2]
const clip = JSON.parse(readFileSync(join(dir, 'clip.json'), 'utf8'))
if (clip.footage && clip.footage !== 'world.mp4') throw new Error(`${dir} has real footage (${clip.footage})`)
const rows: WorldRow[] = parseWorld(readFileSync(join(dir, clip.world ?? 'world.jsonl'), 'utf8'))
const base = rows.find(r => r.kind === 'blocks') as Extract<WorldRow, { kind: 'blocks' }>
const changes = rows.filter(r => r.kind === 'block') as Array<Extract<WorldRow, { kind: 'block' }>>
const replay = makeWorld(rows)!

const registry = viewerRequire('prismarine-registry')(VERSION)
const World = viewerRequire('prismarine-world')(registry)
const Chunk = viewerRequire('prismarine-chunk')(registry)
const world = new World(() => new Chunk())
const state = (name: string) => registry.blocksByName[name]?.defaultState as number | undefined

const [x0, y0, z0] = base.min, [x1, y1, z1] = base.max
const ny = y1 - y0 + 1, nz = z1 - z0 + 1
for (let i = 0; i < base.cells.length; i++) {
  const s = state(base.palette[base.cells[i]])
  if (s) await world.setBlockStateId(new Vec3(x0 + Math.floor(i / (ny * nz)), y0 + Math.floor(i / nz) % ny, z0 + i % nz), s)
}
const [grass, dirt, plains] = [state('grass_block')!, state('dirt')!, registry.biomesByName.plains.id]
for (let x = x0 - APRON; x <= x1 + APRON; x++) for (let z = z0 - APRON; z <= z1 + APRON; z++) {
  for (let y = y0 - 3; y < y0; y++) await world.setBlockStateId(new Vec3(x, y, z), dirt) // dug holes get a bottom
  if (x < x0 || x > x1 || z < z0 || z > z1) await world.setBlockStateId(new Vec3(x, y0, z), grass)
}
// Grass and oak leaves take their tint from the biome (one per 4×4×4 cell); none reads as brown.
for (let x = x0 - APRON; x <= x1 + APRON; x += 4) for (let z = z0 - APRON; z <= z1 + APRON; z += 4) for (let y = y0 - 4; y <= y1 + 4; y += 4) await world.setBiome(new Vec3(x, y, z), plains)

const canvas = createCanvas(W, H)
const renderer = new THREE.WebGLRenderer({ canvas })
const viewer = new Viewer(renderer)
viewer.setVersion(VERSION)
viewer.scene.background = new THREE.Color('#78a7ff')
viewer.scene.fog = new THREE.Fog('#b9d1ff', 48, 110)
const camera = viewer.camera
camera.fov = 60
camera.aspect = W / H
camera.updateProjectionMatrix()
const middle = new Vec3((x0 + x1) / 2, y0, (z0 + z1) / 2)
const view = new WorldView(world, Math.ceil((Math.max(x1 - x0, z1 - z0) / 2 + APRON) / 16) + 1, middle)
viewer.listen(view)
await view.init(middle)
await viewer.waitForChunksToRender()

const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
  '-vf', 'vflip', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', join(dir, 'world.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] })
const done = new Promise(resolve => ffmpeg.on('close', resolve))
const gl = renderer.getContext()
const pixels = new Uint8Array(W * H * 4)
const meshes = viewer.entities.entities as Record<number, any>
const frameMs = 1000 / FPS
let applied = 0

for (let t = clip.start, n = 0; t <= clip.end; t = clip.start + ++n * frameMs) {
  let dirty = false
  for (; applied < changes.length && changes[applied].t <= t; applied++) {
    const c = changes[applied], s = state(c.name)
    if (s === undefined) continue
    const pos = new Vec3(c.pos[0], c.pos[1], c.pos[2])
    await world.setBlockStateId(pos, s)
    viewer.setBlockStateId(pos, s)
    dirty = true
  }
  if (dirty) await viewer.waitForChunksToRender()

  // Entities placed directly each frame: the viewer's 50 ms tweens would run on wall time, not trace time.
  const here = replay.entitiesAt(t)
  for (const id of Object.keys(meshes).map(Number)) if (!here.some(e => e.id === id)) viewer.updateEntity({ id, delete: true })
  for (const e of here) {
    if (!meshes[e.id]) {
      const kind = registry.entitiesByName[e.name]
      // No username: the viewer's name tag is small black text that reads as a smudge at clip size.
      const skin = SKINS[e.name]
      viewer.updateEntity({ id: e.id, name: skin ? 'player' : e.name, skin, width: kind?.width ?? 0.6, height: kind?.height ?? 1.8, pos: new Vec3(e.pos[0], e.pos[1], e.pos[2]) })
      if (skin && meshes[e.id]?.walk) meshes[e.id].walk.zombieArms = true
    }
    const mesh = meshes[e.id]
    if (!mesh) continue
    mesh.position.set(e.pos[0], e.pos[1], e.pos[2])
    mesh.rotation.y = e.yaw
  }
  viewer.entities.lastAnimate = performance.now() - frameMs // walk cycles advance one trace frame
  viewer.entities.animate()

  // The scenario's camera spot, or behind and above Jeeve for scenes too wide for one shot (as WorldScene does).
  const jeeve = base.camera.follow ? here.find(e => e.username === 'Jeeve')?.pos : undefined
  const [at, look] = jeeve ? [[jeeve[0], jeeve[1] + 9, jeeve[2] + 13], [jeeve[0], jeeve[1] + 1, jeeve[2]]] : [base.camera.at, base.camera.facing]
  camera.position.set(at[0], at[1], at[2])
  camera.lookAt(look[0], look[1], look[2])

  renderer.render(viewer.scene, camera)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  if (!ffmpeg.stdin.write(pixels)) await new Promise(r => ffmpeg.stdin.once('drain', r))
  if (n % (FPS * 10) === 0) console.log(`[world-video] ${dir} ${Math.round((t - clip.start) / 1000)}/${Math.round((clip.end - clip.start) / 1000)} s`)
}
ffmpeg.stdin.end()
await done
writeFileSync(join(dir, 'clip.json'), JSON.stringify({ ...clip, footage: 'world.mp4', recordStart: clip.start }))
console.log(`[world-video] ${join(dir, 'world.mp4')}`)
process.exit(0) // the viewer's mesher workers keep the process alive
