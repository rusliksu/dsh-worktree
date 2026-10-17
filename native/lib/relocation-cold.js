/** Offline composition plus a fail-closed startup guard; never mounts or replaces a live owner. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const BEGIN = '# dsh-relocation-cold:begin\n'
const END = '# dsh-relocation-cold:end\n'
const SCHEDULE = '@deepseek-ai/dsh-schedule'
const GUARD = 'dsh-relocation-cold-guard'
const OWNER = 'dsh-relocation-global-schedule'
const fail = message => { throw Object.assign(new Error('Relocation cold configuration: ' + message), { code: 'session/relocate-unsupported' }) }
const hash = value => createHash('sha256').update(value).digest('hex')
const serial = value => JSON.stringify(value)
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
function overlayHash(patches) {
  const copy = structuredClone(patches)
  delete copy[0].insert[0].config.overlayHash
  return hash(serial(canonical(copy)))
}

export function splitPreparation(text) {
  const start = text.indexOf(BEGIN)
  if (start < 0) {
    if (text.includes('dsh-relocation-cold:')) fail('malformed preparation marker')
    return { original: text, generated: undefined }
  }
  if (!text.endsWith(END) || text.indexOf(BEGIN, start + BEGIN.length) >= 0) fail('malformed preparation suffix')
  return { original: text.slice(0, start), generated: text.slice(start + BEGIN.length, -END.length) }
}

function withGuard(inject) {
  if (inject == null) return ['relocationColdConfig']
  if (Array.isArray(inject) && inject.every(item => typeof item === 'string')) return [...new Set([...inject, 'relocationColdConfig'])]
  if (typeof inject === 'object' && !('__jsExpr' in inject)) return { ...inject, relocationColdConfig: { required: true } }
  fail('dynamic injection cannot be preserved safely')
}

export function scheduleOverlay(rows, options) {
  const all = [], schedules = []
  const walk = (entries, ancestors = []) => {
    for (const row of entries) {
      if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') fail('invalid entry')
      if (row.name === 'cordis:include' || row.name === '@deepseek-ai/cordis-plugin-include') fail('included configuration requires explicit preparation support')
      all.push(row)
      if (row.id === 'schedule' || row.name === SCHEDULE) schedules.push({ row, ancestors })
      if (row.group) {
        if (!Array.isArray(row.config)) fail('dynamic group cannot be inspected')
        walk(row.config, [...ancestors, row])
      }
    }
  }
  walk(rows)
  const unique = id => all.filter(row => row.id === id).length === 1
  if (all.some(row => [GUARD, OWNER].includes(row.id))) fail('reserved preparation ID already exists')
  const loops = all.filter(row => row.id === 'native-agent-loop')
  if (loops.length !== 1) fail('native agent-loop is missing or ambiguous')
  const result = [
    { insert: [{ id: GUARD, name: options.guardModule, config: { ...options } }] },
    { id: loops[0].id, inject: withGuard(loops[0].inject) },
  ]
  const finish = () => {
    result[0].insert[0].config.patchCount = result.length
    result[0].insert[0].config.overlayHash = overlayHash(result)
    return result
  }
  if (!schedules.length) return finish()
  if (schedules.length !== 1) fail('Schedule owner is ambiguous')
  const { row, ancestors } = schedules[0]
  if (row.name !== SCHEDULE || !unique(row.id)) fail('foreign or ambiguous Schedule owner')
  for (const entry of [...ancestors, row]) {
    if (!unique(entry.id) || ['isolate', 'intercept'].some(key => entry[key] && Object.keys(entry[key]).length)) fail('Schedule scope is isolated, intercepted or ambiguous')
  }
  const replacement = { ...structuredClone(row), id: OWNER, name: options.scheduleModule, inject: withGuard(row.inject) }
  result.push({ id: row.id, name: SCHEDULE, disabled: true })
  result.push({ ...(ancestors.length ? { id: ancestors.at(-1).id } : {}), insert: [replacement] })
  return finish()
}

/** Import only the installed composition/parser APIs, not plugins or account/environment files. */
async function installedTools(installAnchor) {
  const req = createRequire(resolve(installAnchor))
  const boot = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href)
  const include = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis-plugin-include')).href)
  const yaml = await import(pathToFileURL(req.resolve('js-yaml')).href)
  return { boot, yaml, schema: include.entryListSchema }
}

function optional(file) {
  try { return readFileSync(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return ''; throw error }
}

function parsed(text, tools) {
  let value
  try { value = tools.yaml.load(text, { schema: tools.schema }) ?? [] } catch { fail('invalid YAML; values omitted from diagnostics') }
  if (!Array.isArray(value)) fail('patches must be a literal list')
  return value
}

async function composition(context) {
  const tools = await installedTools(context.installAnchor)
  const dir = resolve(context.dir), home = resolve(context.home)
  const patchFile = join(dir, 'cordis.patch.yml')
  const raw = optional(patchFile), parts = splitPreparation(raw)
  const profile = tools.boot.loadProfileDirectory('relocation-cold', dir, context.installAnchor, { userLayer: false })
  if (profile.skippedBundles?.length) fail('profile contains an unreadable or incompatible bundle')
  let owned = [], trailing = []
  if (parts.generated !== undefined) {
    const entries = parsed(parts.generated, tools)
    const guard = entries[0]?.insert?.[0]
    const count = guard?.config?.patchCount
    if (guard?.id !== GUARD || ![2, 4].includes(count) || entries.length < count) fail('preparation ownership metadata is invalid; files retained')
    owned = entries.slice(0, count)
    if (overlayHash(owned) !== guard.config.overlayHash) fail('owned preparation was edited; files retained')
    trailing = entries.slice(count)
  }
  // DSH appends normal model/general settings before the trailing comment. Those are user overrides.
  const original = [...parsed(parts.original, tools), ...trailing]
  const homeText = home === dir ? '' : optional(join(home, 'cordis.patch.yml'))
  if (homeText.includes('dsh-relocation-cold:')) fail('home-level generated preparations are unsupported')
  const patches = [...profile.layers.flatMap(layer => layer.patches), ...original, ...parsed(homeText, tools)]
  const rootRows = parsed(optional(join(dir, 'cordis.yml')), tools)
  const rows = tools.boot.composeEntries([[{ insert: rootRows }, ...patches]])
  // Composition structure preserves lazy !!js nodes; JSON serialisation never evaluates their content.
  const inputs = { rows,
    manifest: optional(join(dir, 'package.json')), lock: optional(join(dir, 'pnpm-lock.yaml')),
    workspace: optional(join(dir, 'pnpm-workspace.yaml')),
    layers: profile.layers.map(layer => [layer.packageName, layer.patchPaths.map(file => [file, hash(readFileSync(file))])]),
  }
  const sources = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, hash(serial(value))]))
  const fingerprint = hash(serial(inputs))
  return { tools, dir, patchFile, raw, parts, original, rows, fingerprint, sources, owned, trailing }
}

function optionsFor(state, moduleURL = import.meta.url) {
  return { scheduleModule: new URL('./schedule.js', moduleURL).href, guardModule: moduleURL, fingerprint: state.fingerprint, sources: state.sources }
}

function expectedPreparation(state, moduleURL) {
  return scheduleOverlay(state.rows, optionsFor(state, moduleURL))
}

export async function prepareProfile(context, { closed = false, remove = false, moduleURL } = {}) {
  if (!closed) fail('fully close this profile and explicitly confirm the cold-launch requirement')
  const state = await composition(context)
  if (remove) {
    if (state.parts.generated === undefined) return { prepared: false, changed: false }
    // Never silently discard edits to the generated part during rollback.
    if (!isDeepStrictEqual(state.owned, expectedPreparation(state, moduleURL))) fail('stale preparation; preserve files and re-prepare before removal')
    const temp = state.patchFile + '.relocation-' + randomUUID()
    try {
      const restored = state.trailing.length ? state.tools.yaml.dump(state.original, { schema: state.tools.schema, noRefs: true, lineWidth: -1 }) : state.parts.original
      writeFileSync(temp, restored, { encoding: 'utf8', flag: 'wx' })
      if (optional(state.patchFile) !== state.raw) fail('configuration changed during removal')
      renameSync(temp, state.patchFile)
    } finally { if (existsSync(temp)) unlinkSync(temp) }
    return { prepared: false, changed: true }
  }
  const overlay = expectedPreparation(state, moduleURL)
  // Verify the actual patch algorithm can reach the parent before writing anything.
  const warnings = []
  const applied = state.tools.boot.composeEntries([[{ insert: state.rows }, ...overlay]], message => warnings.push(message))
  if (warnings.length) fail('generated patch cannot target the composed tree')
  if (applied.filter(row => row.id === GUARD).length !== 1) fail('preparation guard is not reachable')
  const dump = value => state.tools.yaml.dump(value, { schema: state.tools.schema, noRefs: true, lineWidth: -1 })
  const prefix = state.original.length ? dump(state.original) : '# No profile-local overrides.\n'
  const prepared = prefix + BEGIN + dump(overlay) + END
  const backup = join(state.dir, 'cordis.relocation-cold.original.yml')
  if (!existsSync(backup)) writeFileSync(backup, state.parts.original, { encoding: 'utf8', flag: 'wx' })
  const temp = state.patchFile + '.relocation-' + randomUUID()
  try {
    writeFileSync(temp, prepared, { encoding: 'utf8', flag: 'wx' })
    // Recheck the observed inputs immediately before replacing this metadata file.
    const current = await composition(context)
    if (current.raw !== state.raw || current.fingerprint !== state.fingerprint) fail('configuration changed during preparation; original file retained')
    renameSync(temp, state.patchFile)
  } finally { if (existsSync(temp)) unlinkSync(temp) }
  return { prepared: true, changed: prepared !== state.raw, fingerprint: state.fingerprint, schedule: overlay.length > 2 }
}

export const inject = ['profileContext', 'loader']

export async function apply(ctx, config) {
  const context = ctx.profileContext
  if (!context) fail('launcher does not provide its profile context')
  const verify = async () => {
    const state = await composition(context)
    if (state.fingerprint !== config.fingerprint) {
      const changed = Object.keys(state.sources).filter(key => state.sources[key] !== config.sources?.[key])
      fail('configuration changed (' + changed.join(', ') + '); close DSH and prepare again')
    }
    if (state.parts.generated === undefined
      || !isDeepStrictEqual(state.owned, expectedPreparation(state, config.guardModule))) fail('generated configuration changed; close DSH and prepare again')
    // Additional launch overlays may not change the Schedule/guard owner or its parent.
    if (context.overlays?.length) {
      const expected = state.tools.boot.composeEntries([[{ insert: state.rows }, ...expectedPreparation(state, config.guardModule)]])
      const actual = state.tools.boot.composeEntries([[{ insert: expected }, ...context.overlays]])
      if (serial(actual) !== serial(expected)) fail('launch overlays require their own explicit cold preparation')
    }
  }
  await verify()
  let ownerChanged = false
  // Unrelated initial profile reconciliation is ordinary boot. A live Schedule disposal is not.
  ctx.on('loader/partial-dispose', (entry, legacy, active) => {
    if (entry.options.id === OWNER && (!active || !isDeepStrictEqual(legacy, entry.options))) ownerChanged = true
  }, { global: true })
  ctx.on('agent/relocation-check', async () => {
    try {
      if (ownerChanged) fail('hot Schedule replacement is not supported; close DSH and prepare again')
      await verify()
    } catch (error) {
      ctx.logger?.warn(error.message.startsWith('Relocation cold configuration:') ? error.message : 'Relocation configuration could not be verified')
      throw error
    }
  }, { global: true })
  ctx.provide('relocationColdConfig', Object.freeze({ fingerprint: config.fingerprint }))
}
