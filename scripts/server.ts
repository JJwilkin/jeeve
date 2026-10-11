// Local Paper server for development and evaluation: offline mode, superflat.
// The agent must not depend on anything here (no op, no RCON): this is only our own test server.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIR = '.server'
const JAR = 'paper-1.21.4-232.jar' // Mineflayer-tested version; needs Java 21
const JAVA = process.env.JAVA ?? '/opt/homebrew/opt/openjdk@21/bin/java'

const PROPERTIES = `online-mode=false
enforce-secure-profile=false
level-type=minecraft\\:flat
generate-structures=false
spawn-protection=0
difficulty=easy
view-distance=6
simulation-distance=6
server-port=25565
motd=jeeve dev
`

export function startServer (onLine?: (line: string) => void) {
  const eula = `${DIR}/eula.txt`
  if (!existsSync(eula) || !readFileSync(eula, 'utf8').includes('eula=true')) {
    if (process.env.MINECRAFT_EULA !== 'true') {
      throw new Error('Paper needs the Minecraft EULA (https://aka.ms/MinecraftEULA) accepted. Re-run with MINECRAFT_EULA=true to accept it.')
    }
    writeFileSync(eula, 'eula=true\n')
  }
  if (!existsSync(`${DIR}/server.properties`)) writeFileSync(`${DIR}/server.properties`, PROPERTIES)

  const child = spawn(JAVA, ['-Xms1G', '-Xmx2G', '-jar', JAR, '--nogui'], { cwd: DIR, stdio: ['pipe', 'pipe', 'inherit'] })
  const command = (cmd: string) => child.stdin.write(cmd + '\n')
  const ready = new Promise<void>((resolve, reject) => {
    let buf = ''
    child.stdout.on('data', chunk => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop()!
      for (const line of lines) {
        if (/Done \(/.test(line)) resolve()
        onLine ? onLine(line) : console.log(line)
      }
    })
    child.on('exit', code => reject(new Error(`server exited (${code})`)))
  })
  return { child, command, ready, stop: () => { command('stop'); return new Promise(r => child.on('exit', r)) } }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = startServer()
  process.stdin.on('data', d => s.command(String(d).trim())) // type server commands here
  process.on('SIGINT', () => { void s.stop().then(() => process.exit(0)) })
}
