import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
export const inject = ['schedule', 'sessionController', 'workspaceRegistry', 'sessionPersistence']
export function apply(ctx) {
  const timer = setTimeout(async () => {
    const report = { status: 'running', invocation: process.env.DSH_DELIVERY_INVOCATION, modelCalls: 0, checks: [] }
    ctx.on('llm/stream', () => { report.modelCalls++; throw Error('Seed proof forbids model calls') })
    try {
      assert.equal(ctx.schedule[Symbol.for('dsh.chat-relocation.schedule')], undefined)
      const root = process.env.DSH_DELIVERY_PROOF
      await mkdir(root + '/seed', { recursive: true })
      const workspace = await ctx.workspaceRegistry.create(await realpath(root + '/seed'))
      const sessionId = 'schedule-seed-' + randomUUID()
      await ctx.sessionController.create({ sessionId, workspaceId: workspace.id, agentPreset: 'minimal' })
      const record = await ctx.schedule.create(sessionId, { after_seconds: 86400, prompt: 'Synthetic proof only; never execute', title: 'Preserved original Schedule record' })
      await ctx.sessionPersistence.flush()
      await writeFile(process.env.RELOCATION_OUTPUT + '/seed-schedule.json', JSON.stringify({ sessionId, record }, null, 2) + '\n')
      report.checks.push('original installed Schedule durably stores a synthetic future task before replacement')
      assert.equal(report.modelCalls, 0)
      report.status = 'passed'
    } catch (error) { report.status = 'failed'; report.error = { code: error.code, message: error.message } }
    await writeFile(process.env.DSH_DELIVERY_PROOF + '/delivery-schedule-seed-report.json', JSON.stringify(report, null, 2) + '\n')
  }, 500)
  ctx.effect(() => () => clearTimeout(timer))
}
