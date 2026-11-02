// Generates the collector's Docker Compose file (JSON, which Compose reads as YAML): N Paper servers, each with its
// own seed, normal terrain, RCON on the Compose network only and the Chunky plugin, plus one collector container
// running the bots (collect/main.ts). No ports are published.
//   node collect/compose.ts <servers> <bots per server> [seed,seed,…] > compose.collect.json
import { randomBytes } from 'node:crypto'

const [servers = '1', bots = '4', seedList = ''] = process.argv.slice(2)
const seeds = seedList ? seedList.split(',') : []
const password = randomBytes(16).toString('hex') // RCON never leaves the Compose network; this only keeps it closed
const logging = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } }
const names = Array.from({ length: Number(servers) }, (_, i) => `paper-${i + 1}`)
const seedOf = (i: number) => seeds[i] ?? String(randomBytes(6).readUIntBE(0, 6))

const paper = (host: string, seed: string) => ({
  image: 'itzg/minecraft-server:java25@sha256:f7f2222512810f0f0e85133913622cf639be77a5dd1d4b11f24ab675da6ba742', // as docker-compose.yml
  environment: {
    EULA: '${MINECRAFT_EULA:-false}', // true accepts https://aka.ms/MinecraftEULA
    TYPE: 'PAPER',
    VERSION: '26.1.2',
    PAPER_BUILD: '74',
    MEMORY: '3G',
    SEED: seed,
    LEVEL_TYPE: 'minecraft:normal',
    ONLINE_MODE: 'FALSE',
    ENFORCE_SECURE_PROFILE: 'FALSE',
    ALLOW_FLIGHT: 'TRUE', // random input and knockback can look like flying; a kick would end the bot's episode
    SPAWN_PROTECTION: '0',
    DIFFICULTY: 'easy',
    VIEW_DISTANCE: '6',
    SIMULATION_DISTANCE: '6',
    ENABLE_RCON: 'true',
    RCON_PASSWORD: password,
    MODRINTH_PROJECTS: 'chunky'
  },
  volumes: [`${host}:/data`],
  restart: 'unless-stopped',
  logging
})

const SERVERS = names.map((host, i) => ({ host, seed: seedOf(i) }))
const compose = {
  name: 'jeeve-collect',
  services: {
    ...Object.fromEntries(SERVERS.map(s => [s.host, paper(s.host, s.seed)])),
    collector: {
      build: '.',
      image: 'jeeve',
      command: ['node', 'collect/main.ts'],
      environment: {
        COLLECT_SERVERS: JSON.stringify(SERVERS),
        COLLECT_BOTS: bots,
        COLLECT_RCON_PASSWORD: password,
        COLLECT_OUT: '/app/episodes',
        COLLECT_TARGET_STEPS: '${COLLECT_TARGET_STEPS:-5000000}',
        COLLECT_HELDOUT: '${COLLECT_HELDOUT:-}'
      },
      // The host's ./episodes must be writable by uid 1000 (the image's node user); deploy/collect/run.sh sets it up.
      volumes: ['./episodes:/app/episodes', './modules:/app/modules:ro'],
      depends_on: Object.fromEntries(names.map(n => [n, { condition: 'service_healthy' }])),
      restart: 'no', // it exits at the step target
      logging
    }
  },
  volumes: Object.fromEntries(names.map(n => [n, {}]))
}
console.log(JSON.stringify(compose, null, 2))
