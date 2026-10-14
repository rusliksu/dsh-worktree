// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitReviewDialog } from '../src/client/components/GitReviewDialog'
import { WorktreesSettings } from '../src/client/components/WorktreesSettings'
import { t } from '../src/client/lib/i18n'

afterEach(cleanup)
const summary = (mode: string) => ({ path: '/fixture', mode, branch: 'codex/task', files: [{ path: `${mode}.txt`, status: 'M', protected: false }] })
const services = () => ({
  reviewSummary: vi.fn(async (_path: string, mode: string) => summary(mode)),
  reviewDiff: vi.fn(async (_path: string, _mode: string, file: string) => ({ file, patch: `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-before\n+after ${file}\n` })),
})

describe('Git review UI', () => {
  it('shows a file diff and switches comparisons without mutating the repository', async () => {
    const api = services()
    const user = userEvent.setup()
    render(<GitReviewDialog path="/fixture" api={api as any} onClose={vi.fn()} />)
    await screen.findByText('+after working.txt', { exact: false })
    expect(screen.getByRole('dialog', { name: t('reviewChanges') })).toBeTruthy()
    expect(screen.getByRole('button', { name: /working\.txt/ }).getAttribute('aria-pressed')).toBe('true')
    await user.click(screen.getByRole('button', { name: t('review_staged') }))
    await screen.findByText('+after staged.txt', { exact: false })
    expect(screen.queryByText('+after working.txt', { exact: false })).toBeNull()
    await user.click(screen.getByRole('button', { name: t('review_branch') }))
    await screen.findByText('+after branch.txt', { exact: false })
    await user.type(screen.getByRole('textbox', { name: t('reviewBase') }), 'main')
    await user.click(screen.getByRole('button', { name: t('reviewCompare') }))
    await waitFor(() => expect(api.reviewSummary).toHaveBeenLastCalledWith('/fixture', 'branch', 'main', expect.any(AbortSignal)))
  })

  it('ignores a late diff response from a comparison the user left', async () => {
    const api = services()
    let finish: (value: { file: string; patch: string }) => void = () => {}
    api.reviewDiff.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const user = userEvent.setup()
    render(<GitReviewDialog path="/fixture" api={api as any} onClose={vi.fn()} />)
    await waitFor(() => expect(api.reviewDiff).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: t('review_staged') }))
    await screen.findByText('+after staged.txt', { exact: false })
    finish({ file: 'working.txt', patch: '+stale working result' })
    await waitFor(() => expect(screen.queryByText('+stale working result')).toBeNull())
    expect(screen.getByText('+after staged.txt', { exact: false })).toBeTruthy()
  })

  it('keeps credentials path-only and never asks for their contents', async () => {
    const api = services()
    api.reviewSummary.mockResolvedValue({ ...summary('working'), files: [{ path: 'auth.json', status: 'M', protected: true }] })
    render(<GitReviewDialog path="/fixture" api={api as any} onClose={vi.fn()} />)
    const button = await screen.findByRole('button', { name: /auth\.json/ })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(t('reviewProtected'))).toBeTruthy()
    expect(api.reviewDiff).not.toHaveBeenCalled()
  })

  it('opens review for the chosen worktree from the existing settings page', async () => {
    const api = { ...services(), scan: vi.fn().mockResolvedValue([{ repoPath: '/fixture', policy: { canRemove: false }, worktrees: [{ path: '/fixture', branch: 'main', isMain: true }, { path: '/fixture/task', branch: 'codex/task', isMain: false }] }]), status: vi.fn().mockResolvedValue({ changedFiles: 1 }) }
    const user = userEvent.setup()
    render(<WorktreesSettings api={api} workspaces={{ list: { getSnapshot: () => ({ items: [] }) } } as any} sessions={{} as any} />)
    const button = await screen.findByRole('button', { name: `${t('reviewChanges')} · codex/task` })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    await user.click(button)
    await screen.findByRole('dialog', { name: t('reviewChanges') })
    expect(api.reviewSummary).toHaveBeenCalledWith('/fixture/task', 'working', undefined, expect.any(AbortSignal))
  })
})
