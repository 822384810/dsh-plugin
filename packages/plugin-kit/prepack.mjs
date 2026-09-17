// Prepares the manifest for packing: build-only fields (devDependencies, scripts)
// are stripped so that `pnpm add <tarball>` in a dsh profile does not attempt to
// install devDependencies — which would try cross-drive symlinks and fail with
// EPERM on Windows. The original manifest is backed up and restored by postpack.mjs.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

writeFileSync(join(root, 'package.json.bak'), JSON.stringify(pkg, null, 2))

const clean = { ...pkg }
delete clean.devDependencies
delete clean.scripts

writeFileSync(pkgPath, JSON.stringify(clean, null, 2))
console.log(`[prepack] ${pkg.name}: stripped devDependencies/scripts for packing`)
