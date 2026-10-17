import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
export const inject = ['workspaceRegistry', 'sessionPersistence', 'sessions', 'agents']
export function apply(ctx) {
  const timer = setTimeout(async () => {
    const root = process.env.DSH_DELIVERY_PROOF
    const report = { status: 'running', invocation: process.env.DSH_DELIVERY_INVOCATION, checks: [], modelCalls: 0 }
    ctx.on('llm/stream', () => { report.modelCalls++; throw Error('No model calls') })
    try {
      const facts = JSON.parse(await readFile(root + '/facts.json', 'utf8'))
      const prefix = facts.prefix ?? JSON.parse(await readFile(root + '/prefix.json', 'utf8'))
      assert.equal(ctx.sessionPersistence.supportsRelocation, undefined, 'this must be the original reader')
      assert.equal((await ctx.sessionPersistence.stat(facts.id)).header.cwd, facts.a)
      const reader = await ctx.sessionPersistence.open(facts.id, 'read')
      try { assert.deepEqual((await reader.read()).events.slice(0, prefix.length), prefix) } finally { await reader.close() }
      assert.equal((await ctx.sessionPersistence.list()).filter(row => row.header.id === facts.id).length, 1)
      assert.ok(ctx.workspaceRegistry.get(facts.wa).sessionIds.includes(facts.id))
      assert.ok(!ctx.workspaceRegistry.get(facts.wb).sessionIds.includes(facts.id))
      report.checks.push('original installed reader opens A after native return, keeps exact prefix and unique membership')
      report.status = 'passed'
    } catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message, code: error.code } }
    await writeFile(root + '/delivery-original-report.json', JSON.stringify(report, null, 2) + '\n')
  }, 500)
  ctx.effect(() => () => clearTimeout(timer))
}
