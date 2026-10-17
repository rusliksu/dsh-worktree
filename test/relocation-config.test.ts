import { describe, expect, it, vi } from 'vitest'
// Host helper is intentionally JavaScript, matching the existing Host entry.
// @ts-expect-error no declaration for the plain Host module
import { apply, originalConfig, relocationPreset, TERMINAL_RELOCATION } from '../src/host/relocation-config.js'

describe('native bundle preserves existing configuration and scoped owners', () => {
  it('keeps configured values and evaluates original expressions with the original context', () => {
    const entry = { options: { id: 'owner', name: '@owner', config: { compression: 'none', nested: { value: { __jsExpr: 'ctx.answer' } } } }, context: { answer: 17 } }
    const ctx = { loader: { entries: () => [entry] } }
    expect(originalConfig(ctx, 'owner', '@owner')).toEqual({ compression: 'none', nested: { value: 17 } })
    expect(entry.options.config.nested.value).toEqual({ __jsExpr: 'ctx.answer' })
    entry.options.config.compression = 'zstd'
    expect(originalConfig(ctx, 'owner', '@owner').compression).toBe('zstd')
  })

  it('refuses missing, ambiguous, foreign or isolated configuration owners', () => {
    const row = { options: { id: 'owner', name: '@owner' }, context: {} }
    for (const entries of [[], [row, row], [{ ...row, options: { ...row.options, name: '@foreign' } }], [{ ...row, options: { ...row.options, isolate: { sessions: true } } }]]) {
      expect(() => originalConfig({ loader: { entries: () => entries } }, 'owner', '@owner')).toThrow()
    }
  })

  it('preserves preset fields, realm and deferred expressions while replacing only known scoped providers', () => {
    const definition = { id: 'minimal', description: 'personal', plugins: [{ id: 'scope', name: 'cordis:group', group: true, isolate: { terminals: true }, config: [
      { id: 'pty', name: '@deepseek-ai/dsh-terminal' },
      { id: 'shell', name: '@custom/shell', disabled: { __jsExpr: 'process.platform !== "win32"' }, config: { timeout: 90 } },
    ] }] }
    const transformed = relocationPreset(definition, { '@deepseek-ai/dsh-terminal': 'file:///native/terminal.js' })
    expect(transformed).toEqual({ ...definition, plugins: [{ ...definition.plugins[0], config: [{ id: 'pty', name: 'file:///native/terminal.js' }, definition.plugins[0].config[1]] }] })
    expect(definition.plugins[0].config[0].name).toBe('@deepseek-ai/dsh-terminal')
  })

  it('rejects an uninstrumented terminal even while idle, and accepts the compatible scoped provider', () => {
    let check!: (request: unknown) => void
    let terminals: object = {}
    const ctx = { provide: vi.fn(), get: (name: string) => name === 'agentPresets' ? { serviceFor: () => terminals } : undefined,
      on: (_event: string, listener: typeof check) => { check = listener } }
    apply(ctx)
    expect(() => check({ agent: {} })).toThrow('custom terminal')
    terminals = { [TERMINAL_RELOCATION]: true }
    expect(() => check({ agent: {} })).not.toThrow()
    expect(ctx.provide).toHaveBeenCalledWith('relocationConfig', { get: expect.any(Function) })
  })
})
