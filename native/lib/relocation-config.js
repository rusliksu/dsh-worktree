import { interpolate } from '@deepseek-ai/cordis-plugin-loader'

export const TERMINAL_RELOCATION = Symbol.for('dsh.chat-relocation.terminal')

/** Resolve only the replaced row, using the Loader's own expression evaluator. */
export function originalConfig(ctx, id, packageName) {
  const rows = [...ctx.loader.entries()].filter(entry => entry.options.id === id)
  if (rows.length !== 1 || rows[0].options.name !== packageName) throw new Error(`Relocation configuration owner is ambiguous: ${id}`)
  const entry = rows[0]
  if (entry.options.isolate && Object.keys(entry.options.isolate).length
    || entry.options.intercept && Object.keys(entry.options.intercept).length) {
    throw new Error(`Relocation requires an unmodified owner scope: ${id}`)
  }
  return interpolate(entry.context, entry.options.config ?? {})
}

/** Preserve the preset definition and its scoped rows, replacing only the known terminal provider. */
export function relocationPreset(definition, modules) {
  const copy = structuredClone(definition)
  const rewrite = rows => rows.map(row => ({
    ...row,
    ...(modules[row.name] ? { name: modules[row.name] } : {}),
    ...(row.group && Array.isArray(row.config) ? { config: rewrite(row.config) } : {}),
  }))
  copy.plugins = rewrite(copy.plugins)
  return copy
}

export const inject = ['loader']

/** Configuration bridge for ordinary bundle rows; no profile file is rewritten. */
export function apply(ctx) {
  ctx.provide('relocationConfig', { get: (id, name) => originalConfig(ctx, id, name) })
  ctx.on('agent/relocation-check', ({ agent }) => {
    const terminals = ctx.get('agentPresets')?.serviceFor(agent, 'terminals')
    // A custom terminal provider cannot silently lose state through an uninstrumented spawn path.
    if (terminals && terminals[TERMINAL_RELOCATION] !== true) {
      throw Object.assign(new Error('custom terminal provider does not support relocation'), { code: 'session/relocate-unsupported' })
    }
    const schedule = ctx.get('schedule')
    if (schedule && schedule[Symbol.for('dsh.chat-relocation.schedule')] !== true) {
      throw Object.assign(new Error('schedule provider does not support relocation'), { code: 'session/relocate-unsupported' })
    }
  }, { global: true })
}
