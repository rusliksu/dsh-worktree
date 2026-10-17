import { spawn } from 'node:child_process'

/** Installation-owned runtime supplies the canonical composition libraries, including inside app.asar. */
export async function prepareCold(profile, { remove = false } = {}) {
  const resources = process.env.RELOCATION_RESOURCES
  const args = ['--expose-internals', profile + '/node_modules/@alpacachen/dsh-simple-worktree/scripts/prepare-relocation-profile.mjs',
    '--profile', profile, '--home', process.env.RELOCATION_HOME ?? process.env.RELOCATION_OUTPUT + '/home', '--install-anchor', resources + '/app.asar/dsh/package.json', '--confirm-closed',
    ...(remove ? ['--remove'] : [])]
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.RELOCATION_EXECUTABLE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    let text = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { text = (text + data).slice(-8000) })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Cold preparation failed (' + code + '): ' + text)))
  })
}
