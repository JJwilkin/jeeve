// The spectate page's 3D view: the relay's world feed (GET /api/<jeeve>/world, or /api/god/world for the union)
// emitted into prismarine-viewer's Viewer.listen as it comes, with an orbit camera that follows the Jeeve, or a free
// one over the god view (drag to orbit, right-drag to pan, scroll to zoom).
import { EventEmitter } from 'events'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'prismarine-viewer/node_modules/three/examples/jsm/controls/OrbitControls.js'
import { Viewer } from 'prismarine-viewer/viewer'
import skin from '../../assets/jeeve-skin.png'

const VERSION = '26.1'
const FOLLOW = 0.15 // of the way to the Jeeve per frame

// The viewer's entity models read three from the global, as in world-video.ts.
Object.assign(globalThis, { THREE })

// One renderer, viewer and emitter for the page: switching swaps the feed, not the WebGL context or the mesher workers.
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(devicePixelRatio)
const viewer = new Viewer(renderer)
viewer.setVersion(VERSION)
viewer.scene.background = new THREE.Color('#78a7ff')
viewer.scene.fog = new THREE.Fog('#b9d1ff', 64, 160)
const feed = new EventEmitter()
viewer.listen(feed)
const controls = new OrbitControls(viewer.camera, renderer.domElement)
controls.enableDamping = true

// The camera's subject: the followed Jeeve's position (or, in the god view, the first Jeeve's, once).
const cam: { follow: boolean, at?: THREE.Vector3, placed: boolean } = { follow: false, placed: false }
let jeeves = new Set<string>() // the relay's Jeeves: they wear the robot, and the god view starts on one

function frame () {
  requestAnimationFrame(frame)
  if (cam.at && !cam.placed) {
    controls.target.copy(cam.at)
    viewer.camera.position.copy(cam.at).add(cam.follow ? new THREE.Vector3(0, 8, 12) : new THREE.Vector3(0, 40, 40))
    cam.placed = true
  } else if (cam.at && cam.follow) {
    const step = cam.at.clone().sub(controls.target).multiplyScalar(FOLLOW)
    controls.target.add(step)
    viewer.camera.position.add(step)
  }
  controls.update()
  viewer.update()
  renderer.render(viewer.scene, viewer.camera)
}
frame()

// Streams `source`'s world into the viewer until the returned function is called. focus: the Jeeve to follow.
function connect (source: string, focus: string | null) {
  Object.assign(cam, { follow: !!focus, at: undefined, placed: false })
  const names = new Map<number, string>() // entity id → username, from spawns (moves carry only the id)
  const es = new EventSource(`/api/${source}/world`)
  // Each (re)connect starts with the whole world, so the last one's columns go. Not resetAll: it leaves the mesher
  // workers without a world, and setVersion would fetch the 13 MB of block states again.
  es.onopen = () => {
    for (const key of Object.keys(viewer.world.loadedChunks)) { const [x, z] = key.split(',').map(Number); viewer.removeColumn(x, z) }
    viewer.entities.clear()
    names.clear()
  }
  es.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.type === 'entity') {
      if (m.username) names.set(m.id, m.username)
      const who = names.get(m.id)
      if (jeeves.has(m.username)) m.skin = skin // the Judgment Labs robot, as in clips
      if (m.pos && who && (focus ? who === focus : !cam.at && jeeves.has(who))) cam.at = new THREE.Vector3(m.pos.x, m.pos.y + 1, m.pos.z)
    }
    feed.emit(m.type, m)
  }
  return () => es.close()
}

export function Game ({ source, focus, names, w, h }: { source: string, focus: string | null, names: string[], w: number, h: number }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { jeeves = new Set(names) }, [names])
  useEffect(() => { box.current!.appendChild(renderer.domElement) }, [])
  useEffect(() => {
    renderer.setSize(w, h)
    viewer.camera.aspect = w / h
    viewer.camera.updateProjectionMatrix()
  }, [w, h])
  useEffect(() => connect(source, focus), [source, focus])
  return <div ref={box} style={{ width: w, height: h }} />
}
