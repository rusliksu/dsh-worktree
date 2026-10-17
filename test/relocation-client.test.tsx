// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRelocationDialog } from '../src/client/components/SessionRelocationDialog'
import { SessionRelocationError } from '../src/client/lib/api'
import { t } from '../src/client/lib/i18n'
import { WorktreePlugin } from '../src/client/plugin'

afterEach(cleanup)
const result = { sessionId: 'kept-id', sourceWorkspaceId: 'a', targetWorkspaceId: 'b', operationId: 'op', cwd: '/b', revision: 'r2' }
function setup() {
  const api = { info: vi.fn().mockResolvedValue({ supported: true, cwd: '/a', revision: 'r1' }),
    relocate: vi.fn().mockImplementation(async request => ({ ...result, operationId: request.operationId })) }
  let snapshot = { phase: 'ready', items: [{ workspaceId: 'a', title: 'A', path: '/a' }, { workspaceId: 'b', title: 'B', path: '/b' }], archivedSessionIds: [] }
  const listeners = new Set<() => void>()
  const workspaces = { list: { getSnapshot: () => snapshot, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) } } }
  const beforeMove = vi.fn(), onMoved = vi.fn().mockResolvedValue(undefined), onClose = vi.fn()
  const mount = () => render(<SessionRelocationDialog target={{ sessionId: 'kept-id', title: 'Existing chat' }} api={api} workspaces={workspaces as never}
    beforeMove={beforeMove} onMoved={onMoved} onClose={onClose} />)
  const update = (items: typeof snapshot.items) => { snapshot = { ...snapshot, items }; for (const fn of listeners) fn() }
  return { api, beforeMove, onMoved, onClose, mount, update }
}
async function choose() {
  const select = await screen.findByRole('combobox', { name: t('moveDestination') })
  await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false))
  fireEvent.change(select, { target: { value: 'b' } })
}
const submit = () => screen.getByRole('button', { name: t('moveConfirm') })

describe('existing chat relocation dialog', () => {
  it('requires explicit destination, shows its full path, and sends one stable existing-ID intent', async () => {
    const flow = setup(); flow.mount()
    expect((submit() as HTMLButtonElement).disabled).toBe(true)
    await choose()
    expect(screen.queryByRole('option', { name: 'A — /a' })).toBeNull()
    expect(flow.api.relocate).not.toHaveBeenCalled()
  })

  it('moves through the supplied API and navigates using the same ID', async () => {
    const flow = setup(); flow.mount(); await choose()
    fireEvent.click(submit())
    await waitFor(() => expect(flow.onMoved).toHaveBeenCalledTimes(1))
    expect(flow.beforeMove).toHaveBeenCalledTimes(1)
    expect(flow.api.relocate).toHaveBeenCalledWith({ sessionId: 'kept-id', targetWorkspaceId: 'b', expectedCwd: '/a', expectedRevision: 'r1', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/i) })
    expect(flow.onMoved.mock.calls[0][0].sessionId).toBe('kept-id')
    expect(screen.getAllByText('/b').length).toBeGreaterThan(0)
  })

  it('cancels without sending a mutation', async () => {
    const flow = setup(); flow.mount(); await choose()
    fireEvent.click(screen.getByRole('button', { name: t('cancel') }))
    expect(flow.onClose).toHaveBeenCalledTimes(1)
    expect(flow.api.relocate).not.toHaveBeenCalled()
  })

  it('ignores a second confirmation while the first request is unresolved', async () => {
    const flow = setup()
    let resolve: (value: typeof result) => void = () => {}
    flow.api.relocate.mockImplementation(() => new Promise(done => { resolve = done }))
    flow.mount(); await choose()
    const button = submit()
    fireEvent.click(button); fireEvent.click(button)
    expect(flow.api.relocate).toHaveBeenCalledTimes(1)
    await act(async () => resolve(result))
    await waitFor(() => expect(flow.onMoved).toHaveBeenCalledTimes(1))
  })

  it('does not move on an unsupported Host', async () => {
    const flow = setup(); flow.api.info.mockResolvedValue({ supported: false } as never); flow.mount()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('moveUnsupported'))
    expect((submit() as HTMLButtonElement).disabled).toBe(true)
    expect(flow.api.relocate).not.toHaveBeenCalled()
  })

  it.each(['busy', 'conflict', 'target-invalid', 'unsupported'])('keeps the dialog open after a native %s refusal', async code => {
    const flow = setup(); flow.api.relocate.mockRejectedValue(new SessionRelocationError('session/relocate-' + code)); flow.mount(); await choose()
    fireEvent.click(submit())
    await screen.findByRole('alert')
    expect(flow.onMoved).not.toHaveBeenCalled()
    expect(flow.onClose).not.toHaveBeenCalled()
    expect(flow.api.relocate).toHaveBeenCalledTimes(1)
  })

  it('refuses unique local draft state before mutation and never clears it', async () => {
    const flow = setup(); flow.beforeMove.mockImplementation(() => { throw new SessionRelocationError('session/relocate-draft-state') }); flow.mount(); await choose()
    fireEvent.click(submit())
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('moveDraftState'))
    expect(flow.api.relocate).not.toHaveBeenCalled()
  })

  it('disables a target removed after the dialog opens', async () => {
    const flow = setup(); flow.mount(); await choose()
    act(() => flow.update([{ workspaceId: 'a', title: 'A', path: '/a' }]))
    expect((submit() as HTMLButtonElement).disabled).toBe(true)
    expect(flow.api.relocate).not.toHaveBeenCalled()
  })

  it('does not auto-retry an unconfirmed result and reuses the exact intent for explicit verification', async () => {
    const flow = setup(); flow.api.relocate.mockRejectedValueOnce(new Error('disconnected')); flow.mount(); await choose()
    fireEvent.click(submit())
    const retry = await screen.findByRole('button', { name: t('moveCheckResult') })
    expect(flow.api.relocate).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: t('cancel') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(retry)
    await waitFor(() => expect(flow.onMoved).toHaveBeenCalledTimes(1))
    expect(flow.api.relocate.mock.calls[1][0]).toEqual(flow.api.relocate.mock.calls[0][0])
  })

  it('retries only navigation when the server already confirmed the move', async () => {
    const flow = setup(); flow.onMoved.mockRejectedValueOnce(new Error('list disconnected')); flow.mount(); await choose()
    fireEvent.click(submit())
    const open = await screen.findByRole('button', { name: t('moveOpen') })
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(open)
    await waitFor(() => expect(flow.onMoved).toHaveBeenCalledTimes(2))
    expect(flow.api.relocate).toHaveBeenCalledTimes(1)
  })
})

describe('production plugin relocation callbacks', () => {
  it.each([false, true])('preserves a plain draft and respects archived=%s on completion', async archived => {
    const slots = new Map<string, React.ComponentType<any>>()
    const snapshot = { phase: 'ready', items: [{ workspaceId: 'a', title: 'A', path: '/a' }, { workspaceId: 'b', title: 'B', path: '/b' }], archivedSessionIds: archived ? ['kept-id'] : [] }
    const input = { phase: 'plain', text: 'untouched draft', attachmentIds: [], occurrences: [], queue: [] }
    const remote = { relocationInfo: vi.fn().mockResolvedValue({ ok: true, value: { supported: true, cwd: '/a', revision: 'r1' } }),
      relocate: vi.fn().mockImplementation(async request => ({ ok: true, value: { ...result, operationId: request.operationId } })) }
    const refresh = vi.fn().mockResolvedValue(undefined), openSession = vi.fn(), scope = {}
    const services: Record<string, unknown> = { remote: { session: remote }, conversation: { input: { for: () => ({ state: { getSnapshot: () => input } }) } } }
    WorktreePlugin.apply({ get: (name: string) => services[name], effect: (fn: () => unknown) => fn(),
      connection: { rpc: { call: vi.fn().mockRejectedValue(Error('not a Git fixture')) } },
      workspaces: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } },
      sessions: { create: vi.fn(), refresh, scope: () => scope, binding: () => ({ session: { getSnapshot: () => ({ pendingSubmissions: [] }) } }) },
      uiWorkspace: { openSession },
      slots: { inject: (_: string, fn: () => void) => fn(), register: (meta: { id: string }, component: React.ComponentType<any>) => slots.set(meta.id, component) },
    } as never)
    const Overlay = slots.get('dsh-simple-worktree-relocate-dialog')!, Menu = slots.get('dsh-simple-worktree-relocate')!
    render(<><Overlay /><Menu sessionId="kept-id" displayTitle="Existing chat" useMenuOpenState={() => [true, () => {}]} /></>)
    fireEvent.click(screen.getByRole('menuitem', { name: t('moveChat') }))
    await choose(); fireEvent.click(submit())
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(remote.relocate).toHaveBeenCalledTimes(1)
    expect(input.text).toBe('untouched draft')
    expect(openSession.mock.calls).toEqual(archived ? [] : [['kept-id']])
  })
})
