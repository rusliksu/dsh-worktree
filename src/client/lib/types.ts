import type { WorkspaceView, IWorkspaces } from "@deepseek-ai/dsh-api-workspace-controller/client"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"
import type { UiWorkspace } from "@deepseek-ai/dsh-client-ui-workspace/client"

/** Workspace row projected by the Host Workspace Controller. */
export type Workspace = WorkspaceView

export interface Worktree {
  path: string
  branch?: string
  head?: string
  isMain: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
  changedFiles?: number
  statusError?: string
}

export interface WorktreeStatus {
  branchLine: string
  changedFiles: number
  output: string
}

export type ReviewMode = 'working' | 'staged' | 'branch'
export interface ReviewSummary {
  path: string
  mode: ReviewMode
  branch: string
  baseCommit?: string
  files: { path: string; status: string; protected: boolean }[]
}

export interface WorktreeList {
  repoPath: string
  commonDir: string
  defaultBranch?: string
  defaultRef?: string
  currentBranch?: string
  worktrees: Worktree[]
  policy?: {
    managed: boolean
    branchPrefix: string
    worktreeRoot: string
    canRemove: boolean
  }
}

export interface WorktreeClassification {
  path: string
  isGit: boolean
  isWorktree: boolean
  repoPath?: string
}

export interface CreateWorktreeResult {
  path: string
  branch: string
  baseRef: string
}

/** Session creation plus navigation, supplied by separate DSH services. */
export type SessionsService = Pick<ISessions, "create"> & {
  open: UiWorkspace["openSession"]
}

/** Minimal connection face the worktree API needs from `ctx.connection`. */
export interface ConnectionService {
  rpc: {
    call(channel: string, endpoint: string, payload?: unknown, signal?: AbortSignal): Promise<unknown>
  }
}

/** The workspace service face (`ctx.workspaces`). */
export type WorkspacesService = IWorkspaces

/** Browser wire contract supplied by the native relocation API on the pinned Host. */
export interface SessionRelocationRequest {
  readonly sessionId: string
  readonly targetWorkspaceId: string
  readonly operationId: string
  readonly expectedCwd: string
  readonly expectedRevision: string
}

export interface SessionRelocationResult {
  readonly sessionId: string
  readonly sourceWorkspaceId: string
  readonly targetWorkspaceId: string
  readonly operationId: string
  readonly cwd: string
  readonly revision: string
}

export type SessionRelocationInfo =
  | { readonly supported: false }
  | { readonly supported: true; readonly cwd: string; readonly revision: string }

/** Supplied by ctx.remote.session, which owns authentication and transport. */
export interface SessionRelocationRemote {
  relocationInfo?(request: { readonly sessionId: string }, signal?: AbortSignal): Promise<unknown>
  relocate?(request: SessionRelocationRequest): Promise<unknown>
}
