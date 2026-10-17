import { build, transform } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { globSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ownerSources } from '../src/host/relocation-owners.mjs'

const revision = 'b531f5c249f5d900d9fe0f4685b5837efba1c452'
const source = resolve(process.argv[2] ?? (() => { throw new Error('Usage: node scripts/build-native-relocation.mjs <verified-native-source>') })())
const root = process.cwd()
const destination = join(root, 'native')
const generated = join(root, 'dist/native-sources')
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim()
if (git('rev-parse', 'HEAD') !== revision) throw new Error('Native source must match the reviewed integration revision')
git('diff', '--quiet', 'HEAD')
const manifests = await Promise.all(globSync(['packages/*/*/package.json', 'vendor/*/package.json', 'native/system/package.json', 'native/system/packages/*/package.json'], { cwd: source })
  .map(async file => JSON.parse(await readFile(join(source, file), 'utf8'))))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const versionOf = name => {
  const known = manifests.find(pkg => pkg.name === name)?.version
    ?? manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]
  if (known && !known.startsWith('workspace:')) return known
  for (const pkg of manifests) {
    const version = pkg.dependencies?.[name] ?? pkg.peerDependencies?.[name]
    if (version && !version.startsWith('workspace:')) return version
  }
  throw new Error('Unresolved shared dependency: ' + name)
}
const entries = {
  index: 'packages/session/session-persistence-jsonl/lib/types/index.js',
  'agent-loop': 'packages/core/agent-loop/lib/types/index.js',
  workspace: 'packages/workspace/workspace/lib/types/index.js',
  session: 'packages/api/session-controller/lib/types/index.js',
  'workspace-api': 'packages/api/workspace-controller/lib/types/index.js',
  jobs: 'packages/jobs/jobs-local/lib/types/index.js',
  subagent: 'packages/subagent/subagent-spawn-in-process/lib/types/index.js',
  uploads: 'packages/client/file-upload/lib/types/index.js',
}
const errors = ['WorkspaceUnknownSessionError', 'WorkspaceActiveSessionError', 'WorkspaceArchivedSessionPinError', 'WorkspaceOrderInvalidError', 'WorkspaceMoveInvalidError']
const peers = new Set()
const inputs = {}
await mkdir(join(destination, 'lib'), { recursive: true })
await writeFile(join(destination, 'package.json'), JSON.stringify({ name: '@rusliksu/dsh-chat-relocation-runtime', version: '0.2.0-rc.2-relocation.22', type: 'module' }, null, 2) + '\n')
// The terminal shim imports the installed canonical package; placing it inside a same-name component causes a self import.
for (const file of ['components/terminal/lib/index.js', 'components/terminal/package.json']) {
  await unlink(join(destination, file)).catch(error => { if (error.code !== 'ENOENT') throw error })
}
await mkdir(generated, { recursive: true })
const configSource = (await readFile(join(root, 'src/host/relocation-config.js'), 'utf8')).replace(/\r\n/g, '\n')
await writeFile(join(destination, 'lib/relocation-config.js'), configSource)
await writeFile(join(generated, 'relocation-config.js'), configSource)
for (const [name, contents] of Object.entries(ownerSources)) {
  await writeFile(join(generated, name + '.mjs'), contents + '\n')
}
const collect = specifier => {
  if (specifier.startsWith('.') || specifier.startsWith('node:')) return
  peers.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])
}
for (const [name, input] of [...Object.entries(entries), ...Object.keys(ownerSources).map(name => [name, join(generated, name + '.mjs')])]) {
  const artifact = await build({
    absWorkingDir: source, entryPoints: [input], outfile: join(destination, 'lib', name + '.js'),
    bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external',
    external: ['@deepseek-ai/*'],
    // Typert binds argument names from the Host function. Keep identifiers while removing debug comments.
    minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, legalComments: 'none', metafile: true,
    plugins: [{ name: 'shared-workspace-errors', setup(builder) {
      builder.onResolve({ filter: /^\.\/errors\.js$/ }, args => args.resolveDir.replaceAll('\\', '/').endsWith('/packages/workspace/workspace/lib/types')
        ? { path: 'shared-errors', namespace: 'shared-errors' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'shared-errors' }, () => ({ contents: `export {${errors.join(',')}} from '@deepseek-ai/dsh-workspace'`, loader: 'js' }))
    } }],
  })
  for (const output of Object.values(artifact.metafile.outputs)) for (const item of output.imports) if (item.external) collect(item.path)
  inputs['lib/' + name + '.js'] = entries[name] ?? 'src/host/relocation-owners.mjs#' + name
}
for (const [name, directory, host] of [
  ['session-controller', 'packages/api/session-controller', join(destination, 'lib/session.js')],
  ['workspace-controller', 'packages/api/workspace-controller', join(destination, 'lib/workspace-api.js')],
  ['file-upload', 'packages/client/file-upload', join(destination, 'lib/uploads.js')],
  ['api-remotes', 'packages/api/remotes', join(source, 'packages/api/remotes/lib/index.js')],
  ['ui-chat', 'packages/client/ui-chat', join(source, 'packages/client/ui-chat/lib/index.js')],
]) {
  const original = JSON.parse(await readFile(join(source, directory, 'package.json'), 'utf8'))
  const component = join(destination, 'components', name)
  await mkdir(join(component, 'lib'), { recursive: true })
  const exports = { '.': './lib/index.js', './package.json': './package.json' }
  if (name !== 'terminal') {
    const originalClient = await readFile(join(source, directory, 'lib/client.js'), 'utf8')
    for (const item of originalClient.matchAll(/\brequire\(["']([^"']+)["']\)/g)) collect(item[1])
    // Normal client output includes CSS source-path comments. Remove debugging comments without shipping workstation paths.
    const client = await transform(originalClient, { loader: 'js', minify: true, legalComments: 'none', target: 'es2020' })
    await writeFile(join(component, 'lib/client.js'), client.code)
    await unlink(join(component, 'lib/client.js.map')).catch(error => { if (error.code !== 'ENOENT') throw error })
    inputs['components/' + name + '/lib/client.js'] = { source: directory + '/lib/client.js', sha256: createHash('sha256').update(originalClient).digest('hex') }
    exports['./client'] = './lib/client.js'
    const bytes = await readFile(join(component, 'lib/client.js'), 'utf8')
    if (['session-controller', 'ui-chat'].includes(name) && !bytes.includes('directoryContexts')) throw new Error('Native client lacks historical directory contexts: ' + name)
    for (const item of bytes.matchAll(/\brequire\(["']([^"']+)["']\)/g)) collect(item[1])
  }
  await cp(host, join(component, 'lib/index.js'))
  await writeFile(join(component, 'package.json'), JSON.stringify({
    name: original.name, version: original.version, type: 'module', main: './lib/index.js', exports,
    ...(name === 'terminal' ? {} : { dsh: original.dsh }),
  }, null, 2) + '\n')
}
collect('@deepseek-ai/cordis-plugin-loader')
for (const name of [...peers].sort()) {
  if (manifest.dependencies?.[name]) continue
  manifest.peerDependencies[name] ??= versionOf(name)
  if (!['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/schemastery'].includes(name)) {
    (manifest.peerDependenciesMeta ??= {})[name] = { optional: true }
  }
}
await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
const outputs = {}
for (const file of globSync('**/*', { cwd: destination, exclude: ['source.json'] })) {
  if (!statSync(join(destination, file)).isFile()) continue
  const bytes = await readFile(join(destination, file))
  outputs[file.replaceAll('\\', '/')] = createHash('sha256').update(bytes).digest('hex')
}
await writeFile(join(destination, 'source.json'), JSON.stringify({ repository: 'https://github.com/rusliksu/deepseek-harness', revision, version: '0.2.0-rc.2', inputs, outputs }, null, 2) + '\n')
console.log(JSON.stringify({ revision, artifacts: Object.keys(outputs).length, sharedPeers: peers.size }))
