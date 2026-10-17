/** Small subclasses retain the installed SDK's service identities and scoped producer ownership. */
export const ownerSources = {
  schedule: `import Shared from '@deepseek-ai/dsh-schedule'
export default class RelocationSchedule extends Shared {
  get [Symbol.for('dsh.chat-relocation.schedule')]() { return true }
  async create(sessionId, request, signal) {
    const admission = this.ctx.bail('agent/admit-operation', {sessionId})
    try { return await super.create(sessionId, request, signal) } finally { admission?.[Symbol.dispose]() }
  }
  async delete(request, signal) {
    const admission = this.ctx.bail('agent/admit-operation', {sessionId: request.sessionId})
    try { return await super.delete(request, signal) } finally { admission?.[Symbol.dispose]() }
  }
  async update(request, signal) {
    const admission = this.ctx.bail('agent/admit-operation', {sessionId: request.sessionId})
    try { return await super.update(request, signal) } finally { admission?.[Symbol.dispose]() }
  }
}`,
  terminal: `import Shared from '@deepseek-ai/dsh-terminal'
export default class RelocationTerminal extends Shared {
  get [Symbol.for('dsh.chat-relocation.terminal')]() { return true }
  constructor(ctx) {
    super(ctx)
    ctx.on('agent/relocation-check', ({agent}) => {
      if (this.hasOwnerActivity(agent)) throw Object.assign(new Error('session has persistent terminal state'), {code:'session/relocate-unsupported'})
    })
  }
  async spawn(owner, request, signal) {
    const admission = this.ctx.bail('agent/admit-operation', {sessionId:owner.id, agent:owner})
    try { return await super.spawn(owner, request, signal) } finally { admission?.[Symbol.dispose]() }
  }
}`,
  approval: `import Shared from '@deepseek-ai/dsh-user-approval'
export default class RelocationApproval extends Shared {
  setPolicy(agent, policy) {
    const admission = this.ctx.bail('agent/admit-operation', {sessionId:agent.id, agent})
    try { return super.setPolicy(agent, policy) } finally { admission?.[Symbol.dispose]() }
  }
}`,
  presets: `import Shared from '@deepseek-ai/dsh-agent-preset-registry'
import { relocationPreset } from './relocation-config.js'
export default class RelocationPresets extends Shared {
  register(definition) {
    const modules = {
      '@deepseek-ai/dsh-terminal': new URL('./terminal.js', import.meta.url).href,
      '@deepseek-ai/dsh-subagent-spawn-in-process': new URL('./subagent.js', import.meta.url).href,
      '@deepseek-ai/dsh-schedule': new URL('./schedule.js', import.meta.url).href,
      '@deepseek-ai/dsh-user-approval': new URL('./approval.js', import.meta.url).href,
    }
    return super.register(relocationPreset(definition, modules))
  }
}`,
}
