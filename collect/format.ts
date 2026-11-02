// The world-model episode format (brain/tasks/world-model-data.md → "What one recorded step holds").
// One file per episode: gzip( u32 LE header length | header JSON | steps × STEP | far × FAR ). The header is
// written last (when the episode ends), so it also holds the episode's tables: the scripted actions that ran,
// the veto reasons, held items and entity types the records index into. Records are packed little-endian;
// the header lists every field with its numpy dtype and shape, so a reader needs nothing else
// (collect/read_episode.py).
import { gunzipSync, gzipSync } from 'node:zlib'

// ---- the block-class table: every block state → one of ~64 classes ----
// Named classes first (first match wins), then a generic fallback by collision box and the tool that mines it, so
// a block no rule names still lands somewhere physical. Generated from the registry, so a new version needs no edit.
const NAMED: Array<[string, RegExp]> = [
  ['air', /^(air|cave_air|void_air)$/],
  ['water', /^water$/],
  ['lava', /^lava$/],
  ['water_plant', /^(seagrass|tall_seagrass|kelp|kelp_plant|bubble_column)$/],
  ['fire', /^(soul_)?fire$|campfire$/],
  ['magma', /^magma_block$/],
  ['powder_snow', /^powder_snow$/],
  ['cobweb', /^cobweb$/],
  ['hazard_plant', /^(cactus|sweet_berry_bush|wither_rose|pointed_dripstone)$/],
  ['ore_coal', /coal_ore$/],
  ['ore_iron', /iron_ore$/],
  ['ore_copper', /copper_ore$/],
  ['ore_gold', /^(deepslate_)?gold_ore$/],
  ['ore_redstone', /redstone_ore$/],
  ['ore_lapis', /lapis_ore$/],
  ['ore_diamond', /diamond_ore$/],
  ['ore_emerald', /emerald_ore$/],
  ['ore_other', /_ore$|^ancient_debris$/],
  ['leaves', /_leaves$/],
  ['log', /_(log|wood|stem|hyphae)$|^bamboo_block$/],
  ['slab', /_slab$/],
  ['stairs', /_stairs$/],
  ['fence_wall', /_(fence|wall|fence_gate|pane)$|^iron_bars$/],
  ['door', /_door$/],
  ['trapdoor', /_trapdoor$/],
  ['climbable', /^(ladder|vine|scaffolding|twisting_vines(_plant)?|weeping_vines(_plant)?|cave_vines(_plant)?)$/],
  ['planks', /_planks$/],
  ['grass_block', /^grass_block$/],
  ['dirt', /^(dirt|coarse_dirt|rooted_dirt|podzol|mycelium|dirt_path|farmland|(pale_)?moss_block)$/],
  ['mud', /^(mud|muddy_mangrove_roots)$/],
  ['sand', /^(red_|suspicious_)?sand$/],
  ['gravel', /gravel$/],
  ['clay', /^clay$/],
  ['sandstone', /^(cut_|chiseled_|smooth_)?(red_)?sandstone$/],
  ['stone', /^(stone|granite|diorite|andesite|tuff|calcite|infested_stone)$/],
  ['deepslate', /^(cobbled_|infested_)?deepslate$/],
  ['cobblestone', /^(mossy_)?cobblestone$/],
  ['bedrock', /^bedrock$/],
  ['obsidian', /obsidian$/],
  ['terracotta', /terracotta$/],
  ['snow_layer', /^snow$/],
  ['snow_block', /^snow_block$/],
  ['ice', /^(packed_|blue_|frosted_)?ice$/],
  ['glass', /glass$/],
  ['bed', /_bed$/],
  ['container', /(chest|barrel|shulker_box|furnace|smoker|hopper|crafting_table|dispenser|dropper)$/],
  ['light', /torch$|lantern$|candle$|^glowstone$|^sea_lantern$|^shroomlight$/],
  ['rail', /rail$/],
  ['crop', /^(wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_\w+_stem|cocoa|nether_wart|torchflower_crop|pitcher_crop)$/],
  ['sugar_cane_bamboo', /^(sugar_cane|bamboo|bamboo_sapling)$/],
  ['gourd', /^(pumpkin|carved_pumpkin|jack_o_lantern|melon)$/],
  ['mushroom', /mushroom(_block)?$|^mushroom_stem$|fungus$/],
  ['dripstone_amethyst', /^dripstone_block$|amethyst/],
  ['sculk', /sculk/],
  ['nether', /^(netherrack|soul_sand|soul_soil|basalt|smooth_basalt|polished_basalt|blackstone|crimson_nylium|warped_nylium|nether_bricks|nether_wart_block|warped_wart_block)$/],
  ['end', /^(end_stone|purpur_block|purpur_pillar|end_stone_bricks)$/]
]
const FALLBACK = ['solid_pickaxe', 'solid_shovel', 'solid_axe', 'solid_hoe', 'solid_other', 'plant', 'passable_other']
export const UNLOADED = 255 // a chunk not loaded (or no ground found in the far view's window)

type RegistryBlock = { name: string, minStateId: number, maxStateId: number, boundingBox: string, material?: string }
export type ClassTable = { names: string[], ofState: Uint8Array, blocks: Record<string, string[]> }

// potted: blocks that have a flower-pot form (potted_poppy…), which is most small plants.
function fallback (b: RegistryBlock, potted: Set<string>) {
  const m = b.material ?? ''
  if (b.boundingBox === 'empty') return potted.has(b.name) || /plant|leaves|vine/.test(m) || /(grass|fern|bush|flower|petals|roots|sprouts|litter|coral|dripleaf|moss|propagule|lilac|peony|pitcher|blossom)/.test(b.name) ? 'plant' : 'passable_other'
  if (m.includes('pickaxe') || m.startsWith('incorrect_for')) return 'solid_pickaxe'
  for (const tool of ['shovel', 'axe', 'hoe']) if (m.includes(`mineable/${tool}`)) return `solid_${tool}`
  return 'solid_other'
}

export function classTable (blocks: RegistryBlock[]): ClassTable {
  const names = [...NAMED.map(([n]) => n), ...FALLBACK]
  const ofState = new Uint8Array(Math.max(...blocks.map(b => b.maxStateId)) + 1).fill(names.indexOf('solid_other'))
  const members: Record<string, string[]> = {}
  const potted = new Set(blocks.filter(b => b.name.startsWith('potted_')).map(b => b.name.slice(7)))
  for (const b of blocks) {
    const name = NAMED.find(([, re]) => re.test(b.name))?.[0] ?? fallback(b, potted)
    ofState.fill(names.indexOf(name), b.minStateId, b.maxStateId + 1)
    ;(members[name] ??= []).push(b.name)
  }
  return { names, ofState, blocks: members }
}

// ---- the views, relative to the block at the feet ----
export const VIEWS = {
  near: { origin: [-8, -6, -8], size: [16, 16, 16], cell: 1 }, // every block, [x][y][z]
  mid: { origin: [-16, -12, -16], size: [16, 16, 16], cell: 2 }, // 32³ blocks in 2×2×2 cells: main class + flags
  far: { origin: [-32, -32], size: [64, 64], top: 48, bottom: -48 } // top-down columns [x][z], scanned from feet+48 down to feet−48
} as const
export const MID_FLAGS = ['water', 'lava', 'air'] // bit 0, 1, 2
export const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] // bit order in `controls`
export const STATE_FLAGS = ['on_ground', 'in_water', 'in_lava', 'dig', 'place'] // dig/place: that target field is set this step
export const NOISE = ['wobble', 'jump', 'release', 'pause'] // bit order in `noise`
export const STEPS_PER_S = 5
export const FAR_EVERY = 5 // steps between far views (1/s)
export const ENTITIES = 8

// [name, numpy dtype, shape]. Packed, little-endian, in this order.
export type Field = [string, string, number[]]
export const STEP_FIELDS: Field[] = [
  ['t_ms', '<u4', []], // since the episode started
  ['pos', '<f8', [3]],
  ['vel', '<f4', [3]],
  ['look', '<f4', [2]], // yaw, pitch (radians; Mineflayer: yaw 0 = north, + turns left)
  ['dlook', '<f4', [2]], // change since the previous step, yaw wrapped to ±π
  ['flags', 'u1', []], // STATE_FLAGS bits
  ['health', '<f4', []],
  ['food', 'u1', []],
  ['held', '<i2', []], // index into header.items, −1 empty hand
  ['controls', 'u1', []], // CONTROLS held at the step, or pressed (and not vetoed) since the previous one
  ['noise', 'u1', []], // NOISE bits injected since the previous step
  ['dig', '<i4', [3]], // last dig target since the previous step (if flags.dig)
  ['place', '<i4', [3]], // last place target since the previous step (if flags.place)
  ['veto', '<i2', []], // index into header.vetoes, −1 none
  ['action', '<i2', []], // index into header.actions, −1 between actions
  ['ent_type', '<i2', [ENTITIES]], // index into header.entity_types, −1 empty slot; nearest first
  ['ent_pos', '<f4', [ENTITIES, 3]], // relative to the bot
  ['ent_vel', '<f4', [ENTITIES, 3]],
  ['near', 'u1', [16, 16, 16]],
  ['mid', 'u1', [16, 16, 16]],
  ['mid_flags', 'u1', [16, 16, 16]]
]
export const FAR_FIELDS: Field[] = [
  ['step', '<u4', []], // the step it was taken at
  ['height', 'i1', [64, 64]], // top non-air block's y − feet y; −128 none in the window
  ['top', 'u1', [64, 64]], // its class
  ['depth', 'u1', [64, 64]] // water below the top, if the top is water
]

const SIZES: Record<string, number> = { u1: 1, i1: 1, '<i2': 2, '<u4': 4, '<i4': 4, '<f4': 4, '<f8': 8 }
export type Layout = { size: number, at: Record<string, { offset: number, dtype: string, count: number }> }
export function layout (fields: Field[]): Layout {
  let offset = 0
  const at: Layout['at'] = {}
  for (const [name, dtype, shape] of fields) {
    const count = shape.reduce((a, b) => a * b, 1)
    at[name] = { offset, dtype, count }
    offset += SIZES[dtype] * count
  }
  return { size: offset, at }
}
export const STEP = layout(STEP_FIELDS)
export const FAR = layout(FAR_FIELDS)

// Writes values into one record. Byte views (u1/i1) take a Uint8Array/Int8Array via `bytes`.
export class RecordWriter {
  buf: Buffer
  view: DataView
  l: Layout
  constructor (l: Layout) {
    this.l = l
    this.buf = Buffer.alloc(l.size)
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, l.size)
  }

  set (name: string, ...values: number[]) {
    const f = this.l.at[name]
    const w = SIZES[f.dtype]
    values.forEach((v, i) => {
      const o = f.offset + i * w
      switch (f.dtype) {
        case 'u1': this.view.setUint8(o, v); break
        case 'i1': this.view.setInt8(o, v); break
        case '<i2': this.view.setInt16(o, v, true); break
        case '<u4': this.view.setUint32(o, v, true); break
        case '<i4': this.view.setInt32(o, v, true); break
        case '<f4': this.view.setFloat32(o, v, true); break
        case '<f8': this.view.setFloat64(o, v, true); break
      }
    })
  }

  bytes (name: string): Uint8Array { const f = this.l.at[name]; return this.buf.subarray(f.offset, f.offset + f.count) }
  take () { const out = this.buf; this.buf = Buffer.alloc(this.l.size); this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.l.size); return out }
}

export function encodeEpisode (header: Record<string, unknown>, steps: Buffer[], far: Buffer[]) {
  const json = Buffer.from(JSON.stringify({
    ...header,
    steps: { count: steps.length, record_bytes: STEP.size, fields: STEP_FIELDS },
    far: { count: far.length, record_bytes: FAR.size, fields: FAR_FIELDS }
  }))
  const len = Buffer.alloc(4)
  len.writeUInt32LE(json.length)
  return gzipSync(Buffer.concat([len, json, ...steps, ...far]), { level: 6 })
}

// For checks: the header, and a reader of one field of one record.
export function decodeEpisode (gz: Buffer) {
  const raw = gunzipSync(gz)
  const n = raw.readUInt32LE(0)
  const header = JSON.parse(raw.toString('utf8', 4, 4 + n))
  const stepsAt = 4 + n
  const farAt = stepsAt + header.steps.count * STEP.size
  if (farAt + header.far.count * FAR.size !== raw.length) throw new Error('episode length does not match its header')
  const field = (l: Layout, base: number) => (i: number, name: string) => {
    const f = l.at[name]
    const o = base + i * l.size + f.offset
    const w = SIZES[f.dtype]
    return Array.from({ length: f.count }, (_, k) => {
      const p = o + k * w
      switch (f.dtype) {
        case 'u1': return raw.readUInt8(p)
        case 'i1': return raw.readInt8(p)
        case '<i2': return raw.readInt16LE(p)
        case '<u4': return raw.readUInt32LE(p)
        case '<i4': return raw.readInt32LE(p)
        case '<f4': return raw.readFloatLE(p)
        default: return raw.readDoubleLE(p)
      }
    })
  }
  return { header, step: field(STEP, stepsAt), far: field(FAR, farAt), bytes: raw.length }
}
