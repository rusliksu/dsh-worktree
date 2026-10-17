import { describe, expect, it } from 'vitest'
// @ts-expect-error Host implementation is intentionally plain JavaScript.
import { scheduleOverlay, splitPreparation } from '../src/host/relocation-cold.mjs'

const canonical = '@deepseek-ai/dsh-schedule'
const options = { scheduleModule: 'file:///addon/native/lib/schedule.js', guardModule: 'file:///addon/native/lib/relocation-cold.js', fingerprint: 'fixture-hash' }
const loop = { id: 'native-agent-loop', name: '/native/agent-loop.js', inject: ['relocationConfig', 'workspaceRegistry'] }

describe('cold Schedule preparation preserves optional ownership', () => {
  // A missing provider must not be enabled, even though the relocation runtime is present.
  it('does not insert a Schedule when the composition contains none', () => {
    expect(scheduleOverlay([loop], options)).toEqual([
      { insert: [{ id: 'dsh-relocation-cold-guard', name: options.guardModule, config: { ...options, patchCount: 2, overlayHash: expect.any(String) } }] },
      { id: 'native-agent-loop', inject: ['relocationConfig', 'workspaceRegistry', 'relocationColdConfig'] },
    ])
  })

  // Expressions must remain raw and use the same parent; evaluating them offline changes semantics.
  it.each([true, false, { __jsExpr: 'process.env.SCHEDULE_DISABLED === "1"' }])('preserves disabled=%j and raw config/inject under its original parent', disabled => {
    const schedule = { id: 'schedule', name: canonical, disabled, inject: { custom: { required: false } }, config: { maxPending: 17, path: { __jsExpr: 'ctx.custom.path' } } }
    const parent = { id: 'parent', name: 'cordis:group', group: true, disabled: true, config: [schedule] }
    const input = [loop, parent]
    const before = structuredClone(input)
    expect(scheduleOverlay(input, options).slice(-2)).toEqual([
      { id: 'schedule', name: canonical, disabled: true },
      { id: 'parent', insert: [{ ...schedule, id: 'dsh-relocation-global-schedule', name: options.scheduleModule, inject: { custom: { required: false }, relocationColdConfig: { required: true } } }] },
    ])
    expect(input).toEqual(before)
  })

  it('preserves an enabled root provider and its optional injection list', () => {
    const row = { id: 'schedule', name: canonical, inject: ['custom'], config: { maxPending: 23 } }
    expect(scheduleOverlay([loop, row], options).at(-1)).toEqual({ insert: [{ ...row, id: 'dsh-relocation-global-schedule', name: options.scheduleModule, inject: ['custom', 'relocationColdConfig'] }] })
  })

  // An ambiguous or scoped owner cannot be safely transformed by this delivery mechanism.
  it.each([
    [{ id: 'schedule', name: '@foreign/provider' }],
    [{ id: 'schedule', name: canonical }, { id: 'second', name: canonical }],
    [{ id: 'schedule', name: canonical }, { id: 'schedule', name: '@unrelated' }],
    [{ id: 'schedule', name: canonical, isolate: { schedule: true } }],
    [{ id: 'parent', name: 'cordis:group', group: true, intercept: { schedule: true }, config: [{ id: 'schedule', name: canonical }] }],
    [{ id: 'nested', name: 'cordis:include', config: { path: 'unknown.yml' } }],
  ].map(rows => ({ rows })))('rejects foreign, duplicate, isolated, intercepted or unresolved included ownership: $rows', ({ rows }) => {
    expect(() => scheduleOverlay([loop, ...rows], options)).toThrow(/foreign|ambiguous|scope|included/)
  })

  it('separates the exact original user bytes from the generated suffix, refusing malformed markers', () => {
    const original = '# personal\r\n[]\r\n'
    expect(splitPreparation(original)).toEqual({ original, generated: undefined })
    expect(splitPreparation(original + '# dsh-relocation-cold:begin\n- insert: []\n# dsh-relocation-cold:end\n')).toEqual({ original, generated: '- insert: []\n' })
    expect(() => splitPreparation(original + '# dsh-relocation-cold:begin\n- insert: []\n')).toThrow()
  })
})
