import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as cordis from '@deepseek-ai/cordis'

describe('packaged Client helper isolation', () => {
  // Another ordinary client bundle may use the same minified globals between registration and materialisation.
  it('still starts the real fileUpload service after another bundle declares colliding helpers', async () => {
    let factory!: (require: (name: string) => unknown) => Parameters<Context['plugin']>[0]
    const sandbox = createContext({ window: { __ModuleLoader__: { load: (entry: { factory: typeof factory }) => { factory = entry.factory } } } })
    runInContext(readFileSync(new URL('../native/components/file-upload/lib/client.js', import.meta.url), 'utf8'), sandbox)
    runInContext('var y = Object.defineProperty; var _ = Object.defineProperty; var x = Object.defineProperty;', sandbox)
    const plugin = factory(name => {
      if (name === '@deepseek-ai/cordis') return cordis
      throw Error('Unexpected dynamic dependency: ' + name)
    })
    const ctx = new Context()
    ctx.provide('remote', {})
    try {
      await ctx.plugin(plugin)
      const failures = await Promise.all([...ctx.registry.values()].flatMap(runtime => [...runtime.fibers]).map(fiber => fiber.await().then(() => undefined, error => error.message)))
      expect(failures.filter(Boolean)).toEqual([])
      expect(ctx.get('fileUpload')).toEqual(expect.objectContaining({ upload: expect.any(Function) }))
    } finally { await ctx.fiber.dispose() }
  })
})
