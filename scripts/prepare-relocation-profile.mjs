/** Run with the installation-owned Node/Electron runtime, with DSH fully closed. */
import { prepareProfile } from '../native/lib/relocation-cold.js'

const args = process.argv.slice(2), options = {}
let closed = false, remove = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--confirm-closed') { closed = true; continue }
  if (args[i] === '--remove') { remove = true; continue }
  const key = { '--profile': 'dir', '--home': 'home', '--install-anchor': 'installAnchor' }[args[i]]
  if (!key || !args[i + 1] || options[key]) throw Error('Invalid preparation arguments')
  options[key] = args[++i]
}
if (!options.dir || !options.home || !options.installAnchor) throw Error('Required: --profile <directory> --home <DSH home> --install-anchor <runtime package.json> --confirm-closed')
try { console.log(JSON.stringify(await prepareProfile(options, { closed, remove }))) }
catch (error) { console.error(error.message.startsWith('Relocation cold configuration:') ? error.message : 'Relocation preparation failed; configuration retained. Inspect local metadata.'); process.exitCode = 1 }
