import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import SharedSessions, { Session } from '@deepseek-ai/dsh-session'
import SharedPersistence from '@deepseek-ai/dsh-session-persistence'
import SharedAgents from '@deepseek-ai/dsh-agent'
import SharedPresets from '@deepseek-ai/dsh-agent-preset-registry'

export const inject = ['connection', 'workspaceRegistry', 'sessionController', 'typertGateway', 'agentPresets', 'sessions', 'agents', 'sessionPersistence', 'agentLoop', 'clientModules', 'relocationConfig']
export function apply(ctx) {
  const timer = setTimeout(() => void check(ctx), 500)
  ctx.effect(() => () => clearTimeout(timer))
}
async function check(ctx) {
  const root = process.env.DSH_DELIVERY_PROOF
  const report = { status: 'running', invocation: process.env.DSH_DELIVERY_INVOCATION, modelCalls: 0, checks: [] }
  // Observe the public native failure before the Remote boundary normalises its message; preserve the operation unchanged.
  const nativeRelocate = ctx.agentLoop.relocate.bind(ctx.agentLoop)
  ctx.agentLoop.relocate = (...args) => nativeRelocate(...args).catch(error => {
    report.nativeRefusal = { code: error.code, message: error.message }
    throw error
  })
  const run = async (name, callback) => { report.current = name; await callback(); report.checks.push(name) }
  const rpc = (method, request) => ctx.typertGateway.invoke({ namespace: 'session', method, args: { request }, peer: ctx.connection.browserPeer })
  ctx.on('llm/stream', () => { report.modelCalls++; throw new Error('No model calls are permitted by this proof') })
  try {
    await run('ordinary bundle keeps one installed SDK and original configuration', async () => {
      assert.ok(ctx.sessions instanceof SharedSessions)
      assert.ok(ctx.agents instanceof SharedAgents)
      assert.ok(ctx.sessionPersistence instanceof SharedPersistence)
      assert.ok(ctx.agentPresets instanceof SharedPresets)
      assert.equal(ctx.agentLoop.config.maxParallelToolCalls.get(), 7)
      const chat = [...ctx.loader.entries()].find(row => row.options.id === 'native-ui-chat')
      assert.equal(chat.fiber.config.transcriptView.get(), 'compact')
      assert.equal(chat.fiber.config.linkOpening.get(), 'new-tab')
    })
    await run('canonical browser modules are unique and match the packaged bytes', async () => {
      const graph = ctx.clientModules.graph()
      const inputs = JSON.parse(await readFile(process.env.DSH_DELIVERY_SOURCE, 'utf8'))
      for (const [id, component] of [
        ['@deepseek-ai/dsh-api-session-controller', 'session-controller'], ['@deepseek-ai/dsh-client-ui-chat', 'ui-chat'],
        ['@deepseek-ai/dsh-api-workspace-controller', 'workspace-controller'], ['@deepseek-ai/dsh-client-file-upload', 'file-upload'],
        ['@deepseek-ai/dsh-api-remotes', 'api-remotes'],
      ]) {
        assert.equal(graph.entries.filter(row => row.id === id).length, 1)
        const path = ctx.clientModules.clientPath(id)
        assert.ok(path.replaceAll('\\', '/').includes('/native/components/'))
        assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), inputs.outputs['components/' + component + '/lib/client.js'])
      }
      assert.equal(graph.entries.filter(row => row.id === '@alpacachen/dsh-simple-worktree').length, 1)
    })
    if (process.env.RELOCATION_COLD === '1') await run('global Schedule uses the compatible installed owner and original settings', async () => {
      const schedule = ctx.get('schedule')
      assert.ok(schedule)
      assert.equal(schedule[Symbol.for('dsh.chat-relocation.schedule')], true)
      const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'dsh-relocation-global-schedule')
      assert.ok(row?.fiber)
      assert.equal(row.fiber.config.deliveryHistoryDays, 17)
      assert.equal(row.fiber.config.deliveryHistoryRecords, 23)
      const seed = JSON.parse(await readFile(process.env.RELOCATION_OUTPUT + '/seed-schedule.json', 'utf8'))
      assert.deepEqual((await schedule.list({ sessionId: seed.sessionId })).find(record => record.id === seed.record.id), seed.record)
    })
    const id = 'delivery-relocation-' + randomUUID()
    await mkdir(join(root, 'a'), { recursive: true }); await mkdir(join(root, 'b'), { recursive: true })
    const a = await realpath(join(root, 'a')), b = await realpath(join(root, 'b'))
    await writeFile(join(a, 'control.txt'), 'A stays\n'); await writeFile(join(b, 'control.txt'), 'B stays\n')
    const wa = await ctx.workspaceRegistry.create(a), wb = await ctx.workspaceRegistry.create(b)
    await run('shipped standard preset mounts its normal tools and subagent producers', async () => {
      const standardId = 'delivery-standard-' + randomUUID()
      await rpc('create', { sessionId: standardId, workspaceId: wa.id, agentPreset: 'standard' })
      assert.ok(ctx.agents.get(standardId))
      assert.equal(ctx.agents.get(standardId).session.header.cwd, a)
    })
    await run('shipped minimal preset creates its actual isolated compatible terminal owner', async () => {
      await rpc('create', { sessionId: id, workspaceId: wa.id, agentPreset: 'minimal' })
      const agent = ctx.agents.get(id)
      assert.ok(agent.session instanceof Session)
      const terminals = ctx.agentPresets.serviceFor(agent, 'terminals')
      assert.ok(terminals)
      assert.equal(terminals[Symbol.for('dsh.chat-relocation.terminal')], true)
      const backend = { type: 'delivery-proof', spawn: async () => ({ motd: 'proof', pid: 1,
        startSend() { throw Error('unused') }, read() { throw Error('unused') }, signal() { throw Error('unused') },
        status: () => ({ kind: 'running' }), close: async () => {} }) }
      const unregister = terminals.registerBackend(backend)
      try {
        const terminal = await terminals.spawn(agent, { type: backend.type })
        const info = await rpc('relocationInfo', { sessionId: id })
        await assert.rejects(rpc('relocate', { sessionId: id, targetWorkspaceId: wb.id, operationId: randomUUID(), expectedCwd: info.cwd, expectedRevision: info.revision }), error => error.code === 'session/relocate-unsupported')
        assert.equal(ctx.agents.get(id), agent)
        await terminals.kill(agent, terminal.sessionId)
      } finally { unregister() }
    })
    const old = ctx.agents.get(id)
    old.session.append('turn/start', { turn: 1 })
    old.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessionPersistence.flush()
    let prefix
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try { prefix = (await reader.read()).events } finally { await reader.close() }
    await writeFile(join(root, 'facts.json'), JSON.stringify({ id, a, b, wa: wa.id, wb: wb.id, prefix }, null, 2) + '\n')
    await run('ordinary bundle moves A to B to A through the real Gateway and keeps its exact prefix', async () => {
      const info = await rpc('relocationInfo', { sessionId: id })
      const request = { sessionId: id, targetWorkspaceId: wb.id, operationId: randomUUID(), expectedCwd: info.cwd, expectedRevision: info.revision }
      const moved = await rpc('relocate', request)
      assert.equal(moved.sessionId, id); assert.equal(moved.cwd, b)
      assert.deepEqual(await rpc('relocate', request), moved)
      assert.notEqual(ctx.agents.get(id), old)
      assert.throws(() => old.runMaintenance(async () => {}), /retired/)
      const after = await rpc('relocationInfo', { sessionId: id })
      assert.deepEqual(after.directoryContexts, [{ fromEvent: 0, cwd: a }, { fromEvent: prefix.length, cwd: b }])
      const back = await rpc('relocate', { sessionId: id, targetWorkspaceId: wa.id, operationId: randomUUID(), expectedCwd: after.cwd, expectedRevision: after.revision })
      assert.equal(back.cwd, a)
      const stored = await ctx.sessionPersistence.open(id, 'read')
      try { assert.deepEqual((await stored.read()).events.slice(0, prefix.length), prefix) } finally { await stored.close() }
      assert.equal((await ctx.sessionPersistence.list()).filter(value => value.header.id === id).length, 1)
      assert.equal(await readFile(join(a, 'control.txt'), 'utf8'), 'A stays\n')
      assert.equal(await readFile(join(b, 'control.txt'), 'utf8'), 'B stays\n')
    })
    report.status = 'passed'
    assert.equal(report.modelCalls, 0)
  } catch (error) {
    report.status = 'failed'; report.error = { name: error.name, message: error.message, code: error.code }
  } finally { await writeFile(join(root, 'delivery-sdk-report.json'), JSON.stringify(report, null, 2) + '\n') }
}
