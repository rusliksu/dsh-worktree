/** Reproduce the installed Desktop Host/browser roundtrip in a new isolated home. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const options = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  assert.ok(['--resources', '--executable', '--package', '--playwright', '--browser', '--output'].includes(key) && value && !options.has(key), 'Invalid or duplicate proof option')
  options.set(key, resolve(value))
}
for (const key of ['--resources', '--executable', '--package', '--playwright']) assert.ok(options.has(key), 'Required: ' + key)
const resources = options.get('--resources'), executable = options.get('--executable')
const archive = options.get('--package')
const output = options.get('--output') ?? resolve('.artifacts/session-relocation/' + randomUUID())
// Refuse an existing output/home. This runner cannot target a user's existing profile.
await mkdir(dirname(output), { recursive: true })
await mkdir(output)
const sourceRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtures = fileURLToPath(new URL('./fixtures/session-relocation/', import.meta.url))
const expected = JSON.parse(await readFile(join(fixtures, 'fixture.json'), 'utf8'))
const native = JSON.parse(await readFile(join(sourceRoot, 'native/source.json'), 'utf8'))
assert.equal(native.revision, expected.nativeRevision)
await cp(join(sourceRoot, 'native/source.json'), join(output, 'delivery-native-source.json'))
const environment = { ...process.env, RELOCATION_OUTPUT: output.replaceAll('\\', '/'), RELOCATION_RESOURCES: resources.replaceAll('\\', '/'),
  RELOCATION_EXECUTABLE: executable, RELOCATION_PLAYWRIGHT: options.get('--playwright'),
  ...(options.has('--browser') ? { RELOCATION_BROWSER: options.get('--browser') } : {}) }
const home = join(output, 'home')
const helper = join(output, 'installed-cli.mjs')
await writeFile(helper, `import { delimiter } from 'node:path'\nimport { pathToFileURL } from 'node:url'\nconst resources = ${JSON.stringify(resources)}\nconst { runCli } = await import(pathToFileURL(resources + '/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js').href)\nawait runCli({ packageManager: { command: process.execPath, args: ['--expose-internals', resources + '/runtime/pnpm/bin/pnpm.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: process.execPath, PATH: resources + '/runtime/bin' + delimiter + process.env.PATH } } })\n`)
async function run(command, args, env = environment) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { windowsHide: true, cwd: sourceRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { tail = (tail + bytes).slice(-16000) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolveRun()
      else reject(Error('Proof child failed (' + code + '): ' + tail.split(/\r?\n/).filter(line => !/token|authorization|credential|secret|bearer/i.test(line)).join('\n')))
    })
  })
}
const cli = (...args) => run(executable, ['--expose-internals', helper, 'plugin', '--profile', 'web', ...args], {
  ...environment, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
})
const restart = join(output, 'delivery-runs/restart').replaceAll('\\', '/')
const report = { status: 'running', nativeRevision: native.revision, packageSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), checks: [] }
let removed = false
try {
  await cli('add', archive)
  await run(process.execPath, [join(fixtures, 'host-runner.mjs')])
  report.checks.push('shared SDK, exact five browser modules, real Gateway A-B-A and busy refusal')
  await run(process.execPath, [join(fixtures, 'browser-runner.mjs'), restart, 'prepare'])
  await run(process.execPath, [join(fixtures, 'browser-runner.mjs'), restart, 'verify'])
  report.checks.push('real authenticated UI, cancel, unchanged draft, same-ID A-B, fresh restart B and UI return A')
  await cli('remove', '@alpacachen/dsh-simple-worktree'); removed = true
  await run(process.execPath, [join(fixtures, 'host-runner.mjs'), 'original', restart])
  report.checks.push('original installed reader after return A preserves prefix and unique membership')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error.message
  process.exitCode = 1
} finally {
  if (removed) await cli('add', archive).catch(error => { report.status = 'failed'; report.restoreError = error.message; process.exitCode = 1 })
  await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, output }))
}
