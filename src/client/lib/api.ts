import type { ConnectionService, CreateWorktreeResult, ReviewMode, ReviewSummary, WorktreeClassification, WorktreeList, WorktreeStatus } from "./types"
import type { SessionRelocationInfo, SessionRelocationRemote, SessionRelocationRequest, SessionRelocationResult } from "./types"

export const CHANNEL = "/api"

function classifyError(code: unknown, message: string): string | undefined {
  if (code === "not-git-repository" || /not a git repository/i.test(message)) return "not-git-repository"
  if (code === "worktree-unavailable" || /is not a working tree|No such file or directory/i.test(message)) return "worktree-unavailable"
  return undefined
}

export function createWorktreeApi(connection: ConnectionService, sessionRemote?: SessionRelocationRemote) {
  async function call<T>(endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const args = [CHANNEL, `dsh-simple-worktree/${endpoint}`, payload] as const
    const result = await (signal ? connection.rpc.call(...args, signal) : connection.rpc.call(...args)) as any
    if (!result?.ok) {
      const message = result?.error?.message ?? "worktree operation failed"
      const code = classifyError(result?.error?.code, message)
      const error = new Error(code ?? message)
      ;(error as Error & { code?: string }).code = code ?? result?.error?.code
      throw error
    }
    return result.value as T
  }

  // Bound read-only work. Mutating calls deliberately do not time out here:
  // a timeout must not encourage retrying a creation that may have succeeded.
  async function read<T>(endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const timeoutError = new Error('Worktree request timed out. Refresh or select a more specific Workspace.')
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: () => void = () => {}
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => { controller.abort(); reject(new Error('Worktree request cancelled.')) }
      timer = setTimeout(() => { controller.abort(); reject(timeoutError) }, 15000)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    try { return await Promise.race([call<T>(endpoint, payload, controller.signal), cancelled]) }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
  }

  return {
    relocation: createSessionRelocationApi(sessionRemote),
    reviewSummary: (path: string, mode: ReviewMode, baseRef?: string, signal?: AbortSignal) => read<ReviewSummary>("review.summary", { path, mode, baseRef }, signal),
    reviewDiff: (path: string, mode: ReviewMode, file: string, baseRef?: string, signal?: AbortSignal) => read<{ file: string; patch: string }>("review.diff", { path, mode, file, baseRef }, signal),
    list: (path: string) => read<WorktreeList>("worktree.list", { path }),
    scan: (paths: string[], signal?: AbortSignal) => read<WorktreeList[]>("worktree.scan", { paths }, signal),
    classify: (path: string) => read<WorktreeClassification>("worktree.classify", { path }),
    create: (payload: { repoPath: string; path: string; branch: string; baseRef: string }) => call<CreateWorktreeResult>("worktree.create", payload),
    remove: (payload: { repoPath: string; path: string }) => call<{ removed: boolean; path: string }>("worktree.remove", payload),
    status: (path: string, signal?: AbortSignal) => read<WorktreeStatus>("worktree.status", { path }, signal),
    prune: (path: string) => call<{ pruned: boolean }>("worktree.prune", { path }),
  }
}

export class SessionRelocationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "SessionRelocationError"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function relocationValue(result: unknown): unknown {
  if (!record(result) || typeof result.ok !== "boolean") throw new SessionRelocationError("session/relocate-invalid-response")
  if (!result.ok) {
    const code = record(result.error) && nonempty(result.error.code) ? result.error.code : "session/relocate-invalid-response"
    throw new SessionRelocationError(code)
  }
  return result.value
}

/** Calls the existing generated Remote face; never forks or writes storage from the client. */
export function createSessionRelocationApi(remote: SessionRelocationRemote | undefined) {
  return {
    async info(sessionId: string, signal?: AbortSignal): Promise<SessionRelocationInfo> {
      if (!nonempty(sessionId)) throw new SessionRelocationError("gateway/bad-request")
      if (typeof remote?.relocationInfo !== "function" || typeof remote.relocate !== "function") return { supported: false }
      let value: unknown
      try {
        value = relocationValue(await remote.relocationInfo({ sessionId }, signal))
      } catch (error) {
        if (error instanceof SessionRelocationError && ["gateway/method-unavailable", "gateway/invocation-unavailable", "session/relocate-unsupported"].includes(error.code)) return { supported: false }
        throw error
      }
      if (!record(value) || typeof value.supported !== "boolean"
        || value.supported && (!nonempty(value.cwd) || !nonempty(value.revision))) {
        throw new SessionRelocationError("session/relocate-invalid-response")
      }
      return value.supported ? { supported: true, cwd: value.cwd as string, revision: value.revision as string } : { supported: false }
    },
    async relocate(request: SessionRelocationRequest): Promise<SessionRelocationResult> {
      if (typeof remote?.relocate !== "function") throw new SessionRelocationError("session/relocate-unsupported")
      if (![request.sessionId, request.targetWorkspaceId, request.expectedCwd, request.expectedRevision].every(nonempty)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.operationId)) {
        throw new SessionRelocationError("gateway/bad-request")
      }
      // No timeout, retry, or fresh revision here: a disconnected mutation may already be committed.
      const value = relocationValue(await remote.relocate({ ...request }))
      if (!record(value) || value.sessionId !== request.sessionId || value.targetWorkspaceId !== request.targetWorkspaceId
        || value.operationId !== request.operationId || !nonempty(value.sourceWorkspaceId)
        || !nonempty(value.cwd) || !nonempty(value.revision)) {
        throw new SessionRelocationError("session/relocate-invalid-response")
      }
      return value as unknown as SessionRelocationResult
    },
  }
}

export type SessionRelocationApi = ReturnType<typeof createSessionRelocationApi>
