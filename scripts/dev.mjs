// Desarrollo: compila en modo watch (tsc emite los metadatos de decoradores que Nest necesita) y reinicia la API al cambiar.
import { spawn, spawnSync } from 'node:child_process'

const first = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit', shell: true })
if (first.status !== 0) process.exit(first.status ?? 1)
const tsc = spawn('npx', ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], { stdio: 'inherit', shell: true })
const api = spawn(process.execPath, ['--watch', '--watch-preserve-output', 'dist/main.js'], { stdio: 'inherit' })
const stop = () => {
  tsc.kill()
  api.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
