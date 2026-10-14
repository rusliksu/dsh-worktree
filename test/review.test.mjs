import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { apply } from '../src/host/index.js'

const execute = promisify(execFile)
let repo
const calls = []
const routes = new Map()
const subprocess = {
  spawn({ argv, signal }) {
    calls.push(argv)
    let stdout = ''
    const done = execute(argv[0], argv.slice(1), { signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
      .then(result => { stdout = result.stdout; return { exitCode: 0, signal: null } })
      .catch(error => ({ exitCode: typeof error.code === 'number' ? error.code : 1, signal: error.signal ?? null }))
    return { done, collected: { stdout: { readFrom: () => ({ text: stdout }) } } }
  },
}
const git = async (...args) => (await execute('git', ['-C', repo, ...args], { windowsHide: true })).stdout
const request = async (endpoint, payload) => {
  const path = `/api/dsh-simple-worktree/${endpoint}`
  const route = routes.get(path)
  if (!route) return { ok: false, error: { message: 'Review endpoint is unavailable' } }
  const response = await route.fetch(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'review-test', method: `dsh-simple-worktree/${endpoint}`, payload }),
  }))
  return (await response.json()).result
}

describe('read-only Git review with real repositories', () => {
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'dsh-review-'))
    await git('init', '-b', 'main')
    await git('config', 'user.name', 'Synthetic Review Test')
    await git('config', 'user.email', 'review@example.invalid')
    await git('config', 'core.autocrlf', 'false')
    await git('config', 'diff.external', 'dsh-synthetic-command-must-not-run')
    for (const name of ['branch.txt', 'working.txt', 'staged.txt', 'deleted.txt', 'literal [name].txt']) {
      await writeFile(join(repo, name), `${name}: before\n`)
    }
    await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 1, 2]))
    await git('add', '.')
    await git('commit', '-m', 'Synthetic baseline')
    await git('switch', '-c', 'codex/review-proof')
    await writeFile(join(repo, 'branch.txt'), 'branch.txt: committed\n')
    await git('add', 'branch.txt')
    await git('commit', '-m', 'Synthetic branch change')
    await git('switch', 'main')
    await writeFile(join(repo, 'main-only.txt'), 'Only the base branch advanced\n')
    await git('add', 'main-only.txt')
    await git('commit', '-m', 'Synthetic base branch advancement')
    await git('switch', 'codex/review-proof')
    await writeFile(join(repo, 'staged.txt'), 'staged.txt: staged\n')
    await git('add', 'staged.txt')
    await writeFile(join(repo, 'working.txt'), 'working.txt: working\n')
    await writeFile(join(repo, 'literal [name].txt'), 'literal file: working\n')
    await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 3, 4]))
    await rm(join(repo, 'deleted.txt'))
    await writeFile(join(repo, 'untracked.txt'), 'Not in a Git diff\n')
    apply({ subprocess, connection: { fetch: { register(route) { routes.set(route.path, route) } } }, effect: effect => effect() })
  }, 15000)
  afterAll(async () => { if (repo) await rm(repo, { recursive: true, force: true }) })

  it('keeps unstaged, staged and committed branch changes in their own views', async () => {
    const working = await request('review.summary', { path: repo, mode: 'working' })
    expect(working).toMatchObject({ ok: true, value: { branch: 'codex/review-proof' } })
    expect(working.value.files.map(file => file.path).sort()).toEqual(['binary.bin', 'deleted.txt', 'literal [name].txt', 'working.txt'])
    const staged = await request('review.summary', { path: repo, mode: 'staged' })
    expect(staged).toMatchObject({ ok: true })
    expect(staged.value.files.map(file => file.path)).toEqual(['staged.txt'])
    const branch = await request('review.summary', { path: repo, mode: 'branch', baseRef: 'main' })
    expect(branch).toMatchObject({ ok: true })
    expect(branch.value.files.map(file => file.path)).toEqual(['branch.txt'])
  })

  it.each([
    ['working', 'working.txt', '-working.txt: before', '+working.txt: working'],
    ['staged', 'staged.txt', '-staged.txt: before', '+staged.txt: staged'],
    ['branch', 'branch.txt', '-branch.txt: before', '+branch.txt: committed'],
    ['working', 'deleted.txt', '-deleted.txt: before', 'deleted file mode'],
    ['working', 'literal [name].txt', '-literal [name].txt: before', '+literal file: working'],
  ])('shows the exact %s patch for %s without changing Git or files', async (mode, file, before, after) => {
    const status = await git('status', '--porcelain=v1', '-z')
    const head = await git('rev-parse', 'HEAD')
    const index = await readFile(join(repo, '.git', 'index'))
    const result = await request('review.diff', { path: repo, mode, baseRef: 'main', file })
    expect(result).toMatchObject({ ok: true })
    expect(result.value.patch).toContain(before)
    expect(result.value.patch).toContain(after)
    expect(await git('rev-parse', 'HEAD')).toBe(head)
    expect(await git('status', '--porcelain=v1', '-z')).toBe(status)
    expect(await readFile(join(repo, '.git', 'index'))).toEqual(index)
    expect(await readFile(join(repo, 'working.txt'), 'utf8')).toBe('working.txt: working\n')
  })

  it('shows a binary difference without exposing binary bytes', async () => {
    const result = await request('review.diff', { path: repo, mode: 'working', file: 'binary.bin' })
    expect(result).toMatchObject({ ok: true })
    expect(result.value.patch).toContain('Binary files')
    expect(result.value.patch).not.toContain('GIT binary patch')
  })

  it.each([
    { mode: 'reset' },
    { mode: 'branch', baseRef: '--output=outside' },
    { mode: 'working', file: '../outside.txt' },
    { mode: 'working', file: ':(glob)*' },
    { mode: 'working', file: 'untracked.txt' },
  ])('rejects unsupported or out-of-scope review requests', async payload => {
    expect(await request(payload.file ? 'review.diff' : 'review.summary', { path: repo, ...payload })).toMatchObject({ ok: false })
  })

  it('disables repository diff helpers and does not read unchanged credentials', async () => {
    const callCount = calls.length
    const result = await request('review.diff', { path: repo, mode: 'working', file: 'auth.json' })
    expect(result).toMatchObject({ ok: false })
    expect(calls.length).toBe(callCount)
    const diffCalls = calls.filter(args => args.includes('diff'))
    expect(diffCalls.length).toBeGreaterThan(0)
    expect(diffCalls.every(args => args.includes('--no-ext-diff') && args.includes('--no-textconv'))).toBe(true)
    expect(diffCalls.every(args => args.includes('--no-optional-locks') && args.includes('--literal-pathspecs'))).toBe(true)
  })

  it('reports oversized patches instead of presenting a partial diff', async () => {
    try {
      await writeFile(join(repo, 'working.txt'), 'large synthetic line\n'.repeat(16000))
      expect(await request('review.diff', { path: repo, mode: 'working', file: 'working.txt' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('too large') } })
    } finally { await writeFile(join(repo, 'working.txt'), 'working.txt: working\n') }
  })

  it('uses the repository main branch when no base is entered', async () => {
    const result = await request('review.summary', { path: repo, mode: 'branch' })
    expect(result).toMatchObject({ ok: true })
    expect(result.value.files.map(file => file.path)).toEqual(['branch.txt'])
  })
})
