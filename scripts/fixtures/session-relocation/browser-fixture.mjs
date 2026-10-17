import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
export const inject = ['workspaceRegistry', 'sessionController', 'agents', 'sessionPersistence', 'llm']
class NoStreamAdapter extends LlmAdapter {
  providerInfo() { return { id: 'relocation-proof', name: 'Relocation proof (no requests)' } }
  async listModels() { return [{ provider: 'relocation-proof', id: 'no-stream', name: 'No requests' }] }
  async resolveModel() { return { provider: 'relocation-proof', id: 'no-stream', name: 'No requests', contextWindow: 128000 } }
  async *stream() { throw Error('Browser relocation proof forbids model requests') }
}
export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['relocation-proof'], new NoStreamAdapter()))
  let modelCalls = 0
  ctx.on('llm/stream', () => { modelCalls++; throw Error('No model requests permitted') })
  const timer = setTimeout(() => void prepare(ctx).catch(error => process.send?.({ type: 'proof-error', message: error.message })), 400)
  ctx.effect(() => () => clearTimeout(timer))
  async function prepare() {
    const root = process.env.DSH_DELIVERY_PROOF
    let facts, prefix
    if (process.env.DSH_BROWSER_PHASE === 'verify') {
      facts = JSON.parse(await readFile(join(root, 'facts.json'), 'utf8'))
      prefix = JSON.parse(await readFile(join(root, 'prefix.json'), 'utf8'))
    } else {
    await mkdir(join(root, 'a'), { recursive: true }); await mkdir(join(root, 'b'), { recursive: true })
    const a = await realpath(join(root, 'a')), b = await realpath(join(root, 'b'))
    await writeFile(join(a, 'same.txt'), 'Original A file\n'); await writeFile(join(b, 'same.txt'), 'Different B file\n')
    const wa = await ctx.workspaceRegistry.create(a), wb = await ctx.workspaceRegistry.create(b)
    const id = 'browser-relocation-' + randomUUID()
    await ctx.sessionController.create({ sessionId: id, workspaceId: wa.id, agentPreset: 'minimal' })
    await ctx.sessionController.selectModel({ sessionId: id, provider: 'relocation-proof', model: 'no-stream' })
    const agent = ctx.agents.get(id)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', { content: [{ type: 'text', text: 'RELOCATION_HISTORY_MARKER — keep [same.txt](same.txt)' }], source: { kind: 'user', rpcId: randomUUID() }, role: 'user', id: randomUUID() }, { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessionController.rename({ sessionId: id, title: 'Relocation browser proof' })
    await ctx.sessionPersistence.flush()
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try { prefix = (await reader.read()).events } finally { await reader.close() }
    facts = { id, a, b, wa: wa.id, wb: wb.id, title: 'Relocation browser proof' }
    await writeFile(join(root, 'facts.json'), JSON.stringify(facts, null, 2) + '\n')
    await writeFile(join(root, 'prefix.json'), JSON.stringify(prefix, null, 2) + '\n')
    }
    const { id } = facts
    process.on('message', message => {
      if (message.type !== 'proof-inspect') return
      void (async () => {
        const info = await ctx.sessionController.relocationInfo({ sessionId: id })
        const stored = await ctx.sessionPersistence.open(id, 'read')
        try { assert.deepEqual((await stored.read()).events.slice(0, prefix.length), prefix) } finally { await stored.close() }
        const copies = (await ctx.sessionPersistence.list()).filter(item => item.header.id === id).length
        process.send?.({ type: 'proof-inspection', requestId: message.requestId, info, copies, modelCalls, prefixPreserved: true })
      })().catch(error => process.send?.({ type: 'proof-error', message: error.message }))
    })
    process.send?.({ type: 'proof-fixture', facts })
  }
}
