// Restores the original manifest backed up by prepack.mjs.
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const bak = join(root, 'package.json.bak')
if (!existsSync(bak)) {
  console.log('[postpack] no backup found, nothing to restore')
  process.exit(0)
}
writeFileSync(join(root, 'package.json'), readFileSync(bak, 'utf8'))
unlinkSync(bak)
console.log('[postpack] original manifest restored')
