// Generates the collector's Docker Compose file (JSON, which Compose reads as YAML) for one round of the seed queue
// (deploy/collect/run.sh): a Paper server per seed (normal terrain, RCON on the Compose network only, the Chunky
// plugin) and a collector container per server running its bots (collect/main.ts): 60 bots in one Node process
// would need ~12 GB, past Node's default heap (smoke run, 2026-11-02). No ports are published.
//   node collect/compose.ts <bots per server> <seed,seed,…> > compose.collect.json
import { randomBytes } from 'node:crypto'

const [bots = '8', seedList = ''] = process.argv.slice(2)
const seeds = seedList.split(',').filter(Boolean)
if (!seeds.length) throw new Error('usage: node collect/compose.ts <bots per server> <seed,seed,…>')
const password = randomBytes(16).toString('hex') // RCON never leaves the Compose network; this only keeps it closed
const logging = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } }

const paper = (host: string, seed: string) => ({
  image: 'itzg/minecraft-server:java25@sha256:f7f2222512810f0f0e85133913622cf639be77a5dd1d4b11f24ab675da6ba742', // as docker-compose.yml
  environment: {
    EULA: '${MINECRAFT_EULA:-false}', // true accepts https://aka.ms/MinecraftEULA
    TYPE: 'PAPER',
    VERSION: '26.1.2',
    PAPER_BUILD: '74',
    MEMORY: '3G',
    SEED: seed,
    LEVEL: seed, // each seed its own world in the server's volume, so a re-run resumes on it
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

const n = seeds.map((_, i) => i + 1)
const compose = {
  name: 'jeeve-collect',
  services: Object.fromEntries(n.flatMap(i => [
    [`paper-${i}`, paper(`paper-${i}`, seeds[i - 1])],
    [`collector-${i}`, {
      build: '.',
      image: 'jeeve',
      command: ['node', 'collect/main.ts'],
      environment: {
        COLLECT_HOST: `paper-${i}`,
        COLLECT_SEED: seeds[i - 1],
        COLLECT_BOTS: bots,
        COLLECT_RCON_PASSWORD: password,
        COLLECT_OUT: '/app/episodes',
        COLLECT_SEED_STEPS: '${COLLECT_SEED_STEPS:-83000}',
        COLLECT_HELDOUT: '${COLLECT_HELDOUT:-}'
      },
      // The host's ./episodes must be writable by uid 1000 (the image's node user); deploy/collect/run.sh sets it up.
      volumes: ['./episodes:/app/episodes', './modules:/app/modules:ro'],
      depends_on: { [`paper-${i}`]: { condition: 'service_healthy' } },
      restart: 'no', // it exits when its seed has its steps
      logging
    }]
  ])),
  volumes: Object.fromEntries(n.map(i => [`paper-${i}`, {}]))
}
console.log(JSON.stringify(compose, null, 2))
