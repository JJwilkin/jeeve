// The step recorder: 5 steps a second of self state, layered block views, nearby entities, the step's low-level
// controls and guard vetoes, and which scripted action was running (collect/format.ts has the layout).
// Blocks are read straight from the chunk columns (getBlockStateId), not blockAt, which builds an object per block.
import type { Bot } from 'mineflayer'
import { CONTROLS, ENTITIES, FAR, FAR_EVERY, NOISE, RecordWriter, STEP, STEPS_PER_S, UNLOADED, VIEWS, encodeEpisode, type ClassTable } from './format.ts'

type Index = { list: unknown[], at: Map<string, number> }
const index = (): Index => ({ list: [], at: new Map() })
const indexOf = (ix: Index, key: string, value: unknown = key) => {
  let i = ix.at.get(key)
  if (i === undefined) { i = ix.list.push(value) - 1; ix.at.set(key, i) }
  return i
}
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

export type ActionEntry = { name: string, params: Record<string, unknown>, start_step: number, end_step?: number, outcome?: string, ms?: number }

export class EpisodeRecorder {
  bot: Bot
  classes: ClassTable
  recording = false
  ticks = 0
  started = 0
  steps: Buffer[] = []
  far: Buffer[] = []
  step = new RecordWriter(STEP)
  farRec = new RecordWriter(FAR)
  items = index()
  entityTypes = index()
  vetoes = index()
  actions: ActionEntry[] = []
  current = -1 // the running action's index
  pressed = 0 // controls pressed since the last step
  noiseBits = 0
  vetoIndex = -1
  dig: number[] | null = null
  place: number[] | null = null
  lastLook: [number, number] = [0, 0]
  stepMs = 0 // time spent capturing, for the measurements
  cols = new Map<number, any>()
  p = { x: 0, y: 0, z: 0 }
  water: number
  waterPlant: number
  lava: number

  constructor (bot: Bot, classes: ClassTable) {
    this.bot = bot
    this.classes = classes
    this.water = classes.names.indexOf('water')
    this.waterPlant = classes.names.indexOf('water_plant')
    this.lava = classes.names.indexOf('lava')
    bot.on('physicsTick', () => { if (this.recording && ++this.ticks % (20 / STEPS_PER_S) === 0) this.capture() })
  }

  // On top of installGuards' wrappers (call after it): what the step actually did. A control counts only if the
  // guard let it through; dig and place targets count either way (a veto is recorded too).
  wrapControls () {
    const bot = this.bot
    const setControlState = bot.setControlState
    bot.setControlState = (control, state) => {
      setControlState(control, state)
      if (state && bot.controlState[control]) this.pressed |= 1 << CONTROLS.indexOf(control)
    }
    const dig = bot.dig
    bot.dig = ((block: any, ...rest: any[]) => {
      this.dig = [block.position.x, block.position.y, block.position.z]
      return (dig as any)(block, ...rest)
    }) as typeof bot.dig
    const placeBlock = bot.placeBlock
    bot.placeBlock = (ref, face) => {
      const t = ref.position.plus(face)
      this.place = [t.x, t.y, t.z]
      return placeBlock(ref, face)
    }
  }

  veto (reason: string) { this.vetoIndex = indexOf(this.vetoes, reason) }
  noise (bit: string) { this.noiseBits |= 1 << NOISE.indexOf(bit) }

  begin () {
    Object.assign(this, { recording: true, ticks: 0, started: Date.now(), steps: [], far: [], items: index(), entityTypes: index(), vetoes: index(), actions: [], current: -1, pressed: 0, noiseBits: 0, vetoIndex: -1, dig: null, place: null, stepMs: 0 })
    this.lastLook = [this.bot.entity.yaw, this.bot.entity.pitch]
    this.capture()
  }

  startAction (name: string, params: Record<string, unknown>) {
    this.current = this.actions.push({ name, params, start_step: this.steps.length }) - 1
    return this.current
  }

  endAction (i: number, outcome: string, ms: number) {
    Object.assign(this.actions[i], { end_step: this.steps.length, outcome, ms })
    if (this.current === i) this.current = -1
  }

  // Ends the episode: the gzipped file, ready to write.
  finish (header: Record<string, unknown>) {
    this.recording = false
    if (this.current >= 0) this.endAction(this.current, header.end as string, Date.now() - this.started)
    const meta = {
      ...header,
      items: this.items.list,
      entity_types: this.entityTypes.list,
      vetoes: this.vetoes.list,
      actions: this.actions,
      capture_ms_per_step: +(this.stepMs / Math.max(1, this.steps.length)).toFixed(2)
    }
    return { gz: encodeEpisode(meta, this.steps, this.far), steps: this.steps.length }
  }

  // The class at a block, from the chunk column (cached for one step).
  at (x: number, y: number, z: number) {
    const key = (x >> 4) * 65536 + (z >> 4)
    let c = this.cols.get(key)
    if (c === undefined) this.cols.set(key, c = (this.bot.world as any).getColumn(x >> 4, z >> 4) ?? null)
    if (!c) return UNLOADED
    this.p.x = x & 15; this.p.y = y; this.p.z = z & 15
    return this.classes.ofState[c.getBlockStateId(this.p)]
  }

  capture () {
    const t0 = performance.now()
    const bot = this.bot
    const e = bot.entity
    const s = this.step
    this.cols.clear()
    const feet = e.position.floored()
    s.set('t_ms', Date.now() - this.started)
    s.set('pos', e.position.x, e.position.y, e.position.z)
    s.set('vel', e.velocity.x, e.velocity.y, e.velocity.z)
    s.set('look', e.yaw, e.pitch)
    s.set('dlook', wrapAngle(e.yaw - this.lastLook[0]), e.pitch - this.lastLook[1])
    this.lastLook = [e.yaw, e.pitch]
    s.set('flags', (e.onGround ? 1 : 0) | ((e as any).isInWater ? 2 : 0) | ((e as any).isInLava ? 4 : 0) | (this.dig ? 8 : 0) | (this.place ? 16 : 0))
    s.set('health', bot.health)
    s.set('food', bot.food)
    s.set('held', bot.heldItem ? indexOf(this.items, bot.heldItem.name) : -1)
    s.set('controls', CONTROLS.reduce((m, c, i) => (bot.controlState as any)[c] ? m | 1 << i : m, this.pressed))
    s.set('noise', this.noiseBits)
    s.set('dig', ...(this.dig ?? [0, 0, 0]))
    s.set('place', ...(this.place ?? [0, 0, 0]))
    s.set('veto', this.vetoIndex)
    s.set('action', this.current)
    this.pressed = this.noiseBits = 0
    this.vetoIndex = -1
    this.dig = this.place = null

    const near = Object.values(bot.entities).filter(o => o !== e && o.position)
      .map(o => ({ o, d: o.position.distanceTo(e.position) })).filter(x => x.d <= 32)
      .sort((a, b) => a.d - b.d).slice(0, ENTITIES)
    const types: number[] = []
    const pos: number[] = []
    const vel: number[] = []
    for (let i = 0; i < ENTITIES; i++) {
      const o = near[i]?.o
      types.push(o ? indexOf(this.entityTypes, o.name ?? o.type) : -1)
      pos.push(...(o ? [o.position.x - e.position.x, o.position.y - e.position.y, o.position.z - e.position.z] : [0, 0, 0]))
      vel.push(...(o ? [o.velocity.x, o.velocity.y, o.velocity.z] : [0, 0, 0]))
    }
    s.set('ent_type', ...types)
    s.set('ent_pos', ...pos)
    s.set('ent_vel', ...vel)

    this.nearView(s.bytes('near'), feet)
    this.midView(s.bytes('mid'), s.bytes('mid_flags'), feet)
    if (this.steps.length % FAR_EVERY === 0) {
      this.farRec.set('step', this.steps.length)
      this.farView(this.farRec, feet)
      this.far.push(this.farRec.take())
    }
    this.steps.push(s.take())
    this.stepMs += performance.now() - t0
  }

  nearView (out: Uint8Array, f: { x: number, y: number, z: number }) {
    const [ox, oy, oz] = VIEWS.near.origin
    let i = 0
    for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) out[i++] = this.at(f.x + ox + x, f.y + oy + y, f.z + oz + z)
  }

  // Each 2×2×2 cell: its most common non-air class (air if it's all air), and whether it holds water, lava or air.
  midView (out: Uint8Array, flags: Uint8Array, f: { x: number, y: number, z: number }) {
    const [ox, oy, oz] = VIEWS.mid.origin
    const v = new Uint8Array(8)
    let i = 0
    for (let cx = 0; cx < 16; cx++) {
      for (let cy = 0; cy < 16; cy++) {
        for (let cz = 0; cz < 16; cz++, i++) {
          let k = 0
          let bits = 0
          for (let dx = 0; dx < 2; dx++) {
            for (let dy = 0; dy < 2; dy++) {
              for (let dz = 0; dz < 2; dz++) {
                const c = v[k++] = this.at(f.x + ox + cx * 2 + dx, f.y + oy + cy * 2 + dy, f.z + oz + cz * 2 + dz)
                bits |= c === this.water || c === this.waterPlant ? 1 : c === this.lava ? 2 : c === 0 ? 4 : 0
              }
            }
          }
          let best = 0
          let bestN = 0
          for (let a = 0; a < 8; a++) {
            if (v[a] === 0) continue
            let n = 0
            for (let b = 0; b < 8; b++) if (v[b] === v[a]) n++
            if (n > bestN) { best = v[a]; bestN = n }
          }
          out[i] = best
          flags[i] = bits
        }
      }
    }
  }

  // A height map: per column, the first non-air block scanning down from feet+48 to feet−48.
  farView (r: RecordWriter, f: { x: number, y: number, z: number }) {
    const height = new Int8Array(r.bytes('height').buffer, r.bytes('height').byteOffset, 4096)
    const top = r.bytes('top')
    const depth = r.bytes('depth')
    const { origin: [ox, oz], top: up, bottom: down } = VIEWS.far
    let i = 0
    for (let x = 0; x < 64; x++) {
      for (let z = 0; z < 64; z++, i++) {
        const wx = f.x + ox + x
        const wz = f.z + oz + z
        height[i] = -128
        top[i] = 0
        depth[i] = 0
        for (let y = f.y + up; y >= f.y + down; y--) {
          const c = this.at(wx, y, wz)
          if (c === 0) continue
          if (c === UNLOADED) { top[i] = UNLOADED; break }
          height[i] = y - f.y
          top[i] = c
          if (c === this.water) {
            let d = 0
            while (d < 255 && y - d >= f.y + down && this.at(wx, y - d, wz) === this.water) d++
            depth[i] = d
          }
          break
        }
      }
    }
  }
}
