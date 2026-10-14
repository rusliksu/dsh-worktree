import { isAbsolute } from 'node:path'

const MAX_OUTPUT = 256 * 1024
// shortcut: renames appear as deletion plus addition; add paired paths when reviewing file history is needed.
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames']

async function git(subprocess, path, args, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const handle = subprocess.spawn({
      argv: ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '--literal-pathspecs', '-C', path, ...args],
      cwd: path,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_OUTPUT * 2 }, stderr: { maxBytes: 4096 } },
      graceMs: 1000,
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0 || outcome.signal !== null) throw new Error('Cannot read this Git comparison. Check the repository and base branch.')
    const output = handle.collected.stdout?.readFrom(0).text ?? ''
    if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT) throw new Error('This comparison is too large to display. Review a smaller change.')
    return output
  } finally { clearTimeout(timer) }
}

// Credential files remain path-only in this review surface.
const protectedFile = path => /(^|\/)(\.env($|[.-])|\.credentials\.json$|auth[^/]*(\.json|\.dpapi)$)|\.(pem|key)$/i.test(path)

function parseFiles(output) {
  const fields = output.split('\0')
  if (fields.at(-1) === '') fields.pop()
  if (fields.length % 2) throw new Error('Git returned an incomplete file list.')
  const files = []
  for (let i = 0; i < fields.length; i += 2) {
    const [status, path] = [fields[i], fields[i + 1]]
    if (!/^[AMDTUXB]$/.test(status) || !path) throw new Error('Git returned an unsupported file status.')
    files.push({ path, status, protected: protectedFile(path) })
  }
  if (files.length > 500) throw new Error('This comparison has more than 500 files. Review a smaller change.')
  return files
}

async function comparison(subprocess, payload, signal) {
  const path = typeof payload.path === 'string' ? payload.path.trim() : ''
  const mode = payload.mode ?? 'working'
  if (!path || !isAbsolute(path) || path.includes('\0') || !['working', 'staged', 'branch'].includes(mode)) {
    throw new Error('Select a Git workspace and a supported comparison.')
  }
  const root = (await git(subprocess, path, ['rev-parse', '--show-toplevel'], signal)).trim()
  const branch = (await git(subprocess, root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)).trim()
  let revisions = mode === 'staged' ? ['--cached'] : []
  let baseCommit
  if (mode === 'branch') {
    const baseRef = payload.baseRef
    if (typeof baseRef !== 'string' || !baseRef.trim() || baseRef.length > 512 || baseRef.startsWith('-') || baseRef.includes('\0')) {
      throw new Error('Select a valid base branch.')
    }
    baseCommit = (await git(subprocess, root, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], signal)).trim()
    const mergeBase = (await git(subprocess, root, ['merge-base', baseCommit, 'HEAD'], signal)).trim()
    revisions = [mergeBase, 'HEAD']
  }
  return { root, mode, branch, baseCommit, revisions }
}

export async function reviewSummary(subprocess, payload, signal) {
  const { root, mode, branch, baseCommit, revisions } = await comparison(subprocess, payload, signal)
  const output = await git(subprocess, root, ['diff', ...DIFF_OPTIONS, '--name-status', '-z', ...revisions, '--'], signal)
  return { path: root, mode, branch, baseCommit, files: parseFiles(output) }
}

export async function reviewDiff(subprocess, payload, signal) {
  const file = payload.file
  if (typeof file !== 'string' || !file || isAbsolute(file) || file.includes('\0') || file.split(/[\\/]/).includes('..') || protectedFile(file)) {
    throw new Error('This file cannot be opened in Git review.')
  }
  const { root, revisions } = await comparison(subprocess, payload, signal)
  const files = parseFiles(await git(subprocess, root, ['diff', ...DIFF_OPTIONS, '--name-status', '-z', ...revisions, '--'], signal))
  if (!files.some(row => row.path === file)) throw new Error('This file is not part of the selected comparison. Refresh the list.')
  const patch = await git(subprocess, root, ['diff', ...DIFF_OPTIONS, '--unified=3', ...revisions, '--', file], signal)
  return { file, patch }
}
