// The camera without a client: the recorded world (src/world.ts) drawn as flat-coloured blocks with three.js, from the
// scenario's camera spot. Goes inside a react-three-fiber canvas (Remotion's ThreeCanvas in clips).
import { useLayoutEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { colorFor, type Block, type Entity } from './world.ts'

const BODY: Record<string, { size: [number, number, number], color: string }> = {
  player: { size: [0.6, 1.8, 0.6], color: '#e0a040' },
  zombie: { size: [0.6, 1.9, 0.6], color: '#3f8f3f' },
  slime: { size: [1, 1, 1], color: '#7fdc5a' }
}

function Blocks ({ blocks }: { blocks: Block[] }) {
  // One instanced mesh per colour: a few draw calls for thousands of blocks.
  const groups = useMemo(() => {
    const by = new Map<string, Block[]>()
    for (const b of blocks) { const c = colorFor(b.name); const g = by.get(c); if (g) g.push(b); else by.set(c, [b]) }
    return [...by.entries()]
  }, [blocks])
  return <>{groups.map(([color, list]) => <Group key={color} color={color} list={list} />)}</>
}

function Group ({ color, list }: { color: string, list: Block[] }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    list.forEach((b, i) => ref.current!.setMatrixAt(i, m.makeTranslation(b.pos[0] + 0.5, b.pos[1] + 0.5, b.pos[2] + 0.5)))
    ref.current!.instanceMatrix.needsUpdate = true
  }, [list])
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, list.length]} key={list.length}>
      <boxGeometry args={[1, 1, 1]} />
      <meshLambertMaterial color={color} />
    </instancedMesh>
  )
}

function Body ({ e }: { e: Entity }) {
  const kind = BODY[e.name] ?? { size: [0.6, 0.9, 0.6] as [number, number, number], color: '#c05050' }
  const jeeve = e.username === 'Jeeve'
  const [w, h, d] = kind.size
  return (
    <group position={[e.pos[0], e.pos[1], e.pos[2]]} rotation={[0, e.yaw, 0]}>
      <mesh position={[0, h / 2, 0]}><boxGeometry args={[w, h, d]} /><meshLambertMaterial color={jeeve ? '#47c8ff' : kind.color} /></mesh>
      {/* a nose: which way it faces (yaw 0 looks toward -z) */}
      <mesh position={[0, h * 0.85, -d / 2 - 0.08]}><boxGeometry args={[0.18, 0.18, 0.16]} /><meshLambertMaterial color='#222' /></mesh>
    </group>
  )
}

// follow: a third-person camera behind and above Jeeve, for scenes too wide for one shot (forage).
function Camera ({ at, facing, follow }: { at: number[], facing: number[], follow?: number[] }) {
  const { camera } = useThree()
  useLayoutEffect(() => {
    const [p, f] = follow ? [[follow[0], follow[1] + 9, follow[2] + 13], [follow[0], follow[1] + 1, follow[2]]] : [at, facing]
    camera.position.set(p[0], p[1], p[2])
    camera.lookAt(f[0], f[1], f[2])
    camera.updateProjectionMatrix()
  }, [camera, at, facing, follow?.[0], follow?.[1], follow?.[2]])
  return null
}

export function WorldScene ({ blocks, entities, camera }: { blocks: Block[], entities: Entity[], camera: { at: number[], facing: number[], follow?: boolean } }) {
  const jeeve = camera.follow ? entities.find(e => e.username === 'Jeeve')?.pos : undefined
  return (
    <>
      <color attach='background' args={['#9cc8f0']} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[30, 60, 20]} intensity={1.1} />
      <Camera at={camera.at} facing={camera.facing} follow={jeeve} />
      <Blocks blocks={blocks} />
      {entities.map(e => <Body key={e.id} e={e} />)}
    </>
  )
}
