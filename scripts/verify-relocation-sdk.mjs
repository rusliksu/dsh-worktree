import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { globSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'))
const source = read('native/source.json')
assert.equal(source.revision, 'b531f5c249f5d900d9fe0f4685b5837efba1c452')
assert.equal(source.version, '0.2.0-rc.2')
assert.equal(read('native/package.json').dsh?.client, undefined, 'the enclosing Host package must not duplicate the worktree browser client')
const actual = globSync('native/**/*').filter(file => statSync(file).isFile() && file.replaceAll('\\', '/') !== 'native/source.json')
  .map(file => file.replaceAll('\\', '/').slice('native/'.length)).sort()
assert.deepEqual(actual, Object.keys(source.outputs).sort(), 'no undeclared native assets or nested SDK copies')
for (const [file, hash] of Object.entries(source.outputs)) {
  assert.equal(createHash('sha256').update(readFileSync(join(root, 'native', file))).digest('hex'), hash, file)
}
for (const [component, identity] of [
  ['session-controller', '@deepseek-ai/dsh-api-session-controller'], ['ui-chat', '@deepseek-ai/dsh-client-ui-chat'],
  ['workspace-controller', '@deepseek-ai/dsh-api-workspace-controller'], ['file-upload', '@deepseek-ai/dsh-client-file-upload'],
  ['api-remotes', '@deepseek-ai/dsh-api-remotes'],
]) {
  const pkg = read('native/components/' + component + '/package.json')
  assert.equal(pkg.name, identity)
  assert.equal(pkg.version, '0.2.0-rc.2')
  assert.equal(pkg.dependencies, undefined, 'components use the shared installed SDK')
  if (component !== 'terminal') {
    assert.equal(pkg.exports['./client'], './lib/client.js')
    assert.ok(pkg.dsh.client)
    if (['session-controller', 'ui-chat'].includes(component)) assert.match(readFileSync(join(root, 'native/components', component, 'lib/client.js'), 'utf8'), /directoryContexts/)
  }
}
assert.match(readFileSync(join(root, 'native/components/api-remotes/lib/client.js'), 'utf8'), /relocationInfo/)
const manifest = read('package.json')
assert.equal(manifest.dsh.compatibility.dsh, '0.2.0-rc.2')
for (const file of actual.filter(file => file.endsWith('.js'))) {
  const text = readFileSync(join(root, 'native', file), 'utf8')
  assert.ok(!/C:[\\/]Users[\\/]|\.codex[\\/]/i.test(text), 'private workstation path in ' + file)
  for (const match of text.matchAll(/(?:\bfrom\s*|\brequire\()(["'])([@a-zA-Z0-9][@a-zA-Z0-9/._-]*)\1/g)) {
    const specifier = match[2]
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
    assert.ok(manifest.peerDependencies[name] || manifest.dependencies?.[name], 'undeclared shared dependency: ' + name)
  }
}
console.log(JSON.stringify({ revision: source.revision, verifiedArtifacts: actual.length, sdkCopies: 0 }))
