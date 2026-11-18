import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
rmSync(path.join(root, 'dist'), { recursive: true, force: true })

const rspackBin = path.join(root, 'node_modules', '@rspack', 'cli', 'bin', 'rspack.js')
const result = spawnSync(process.execPath, [rspackBin, 'build', '-c', 'rspack.config.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
  },
})

process.exit(result.status ?? 1)
