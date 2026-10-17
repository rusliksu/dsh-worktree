import { afterEach, describe, expect, it, vi } from "vitest"
import { createSessionRelocationApi, createWorktreeApi } from "../src/client/lib/api"

describe("worktree client API routing", () => {
  const createPayload = { repoPath: "/repo", path: "/repo.worktrees/task", branch: "task", baseRef: "main" }
  const removePayload = { repoPath: "/repo", path: "/repo.worktrees/task" }

  afterEach(() => vi.useRealTimers())

  it.each(["list", "scan", "classify", "status"] as const)("bounds never-resolving %s reads to 15 seconds and aborts transport", async operation => {
    vi.useFakeTimers()
    const call = vi.fn().mockImplementation(() => new Promise<never>(() => {}))
    const api = createWorktreeApi({ rpc: { call } })
    const invoke = api[operation] as (argument: any) => Promise<unknown>
    const request = invoke(operation === "scan" ? ["/repo"] : "/repo")
    const rejected = expect(request).rejects.toThrow(/timed out/)
    const signal = call.mock.calls[0][3] as AbortSignal
    expect(signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(14999)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(signal.aborted).toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["scan", "status"] as const)("cancels %s reads when the caller aborts", async operation => {
    vi.useFakeTimers()
    const call = vi.fn().mockImplementation(() => new Promise<never>(() => {}))
    const api = createWorktreeApi({ rpc: { call } })
    const controller = new AbortController()
    const request = operation === "scan" ? api.scan(["/repo"], controller.signal) : api.status("/repo", controller.signal)
    const rejected = expect(request).rejects.toThrow(/cancelled/)
    controller.abort()
    await rejected
    expect(call.mock.calls[0][3].aborted).toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["list", "scan", "classify", "status"] as const)("clears the %s read timer after a successful response", async operation => {
    vi.useFakeTimers()
    const call = vi.fn().mockResolvedValue({ ok: true, value: [] })
    const api = createWorktreeApi({ rpc: { call } })
    const invoke = api[operation] as (argument: any) => Promise<unknown>
    await invoke(operation === "scan" ? ["/repo"] : "/repo")
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30000)
    expect(call.mock.calls[0][3].aborted).toBe(false)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it.each([
    { operation: "create", argument: createPayload },
    { operation: "remove", argument: removePayload },
    { operation: "prune", argument: "/repo" },
  ] as const)("does not time out or automatically retry $operation mutations", async ({ operation, argument }) => {
    vi.useFakeTimers()
    let reject!: (reason: Error) => void
    const call = vi.fn().mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    const api = createWorktreeApi({ rpc: { call } })
    const invoke = api[operation] as (argument: any) => Promise<unknown>
    const request = invoke(argument)
    const failure = new Error("connection closed after mutation")
    const rejected = expect(request).rejects.toBe(failure)
    expect(call.mock.calls[0]).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60000)
    expect(call).toHaveBeenCalledTimes(1)
    reject(failure)
    await rejected
    await vi.advanceTimersByTimeAsync(60000)
    expect(call).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { operation: "list", endpoint: "worktree.list", argument: "/repo", payload: { path: "/repo" } },
    { operation: "scan", endpoint: "worktree.scan", argument: ["/repo"], payload: { paths: ["/repo"] } },
    { operation: "classify", endpoint: "worktree.classify", argument: "/repo", payload: { path: "/repo" } },
    { operation: "create", endpoint: "worktree.create", argument: createPayload, payload: createPayload },
    { operation: "remove", endpoint: "worktree.remove", argument: removePayload, payload: removePayload },
    { operation: "status", endpoint: "worktree.status", argument: "/repo", payload: { path: "/repo" } },
    { operation: "prune", endpoint: "worktree.prune", argument: "/repo", payload: { path: "/repo" } },
  ] as const)("routes $operation through the shared /api channel", async ({ operation, endpoint, argument, payload }) => {
    const value = { response: endpoint }
    const call = vi.fn().mockResolvedValue({ ok: true, value })
    const api = createWorktreeApi({ rpc: { call } })
    const invoke = api[operation] as (argument: unknown) => Promise<unknown>

    await expect(invoke(argument)).resolves.toBe(value)
    const args = ["/api", `dsh-simple-worktree/${endpoint}`, payload]
    if (["list", "scan", "classify", "status"].includes(operation)) args.push(expect.any(AbortSignal))
    expect(call.mock.calls).toEqual([args])
  })

  it.each([
    { result: { ok: false, error: { code: "bad-request", message: "fatal: not a git repository" } }, message: "not-git-repository", code: "not-git-repository" },
    { result: { ok: false, error: { code: "bad-request", message: "No such file or directory" } }, message: "worktree-unavailable", code: "worktree-unavailable" },
    { result: { ok: false, error: { code: "cancelled", message: "The request was cancelled." } }, message: "The request was cancelled.", code: "cancelled" },
    { result: { ok: false, error: { code: "bad-request", message: "Invalid path" } }, message: "Invalid path", code: "bad-request" },
    { result: undefined, message: "worktree operation failed", code: undefined },
  ])("rejects unsuccessful results with $message", async ({ result, message, code }) => {
    const call = vi.fn().mockResolvedValue(result)
    const api = createWorktreeApi({ rpc: { call } })

    await expect(api.list("/repo")).rejects.toMatchObject({ message, code })
    expect(call.mock.calls).toEqual([["/api", "dsh-simple-worktree/worktree.list", { path: "/repo" }, expect.any(AbortSignal)]])
  })

  it("propagates transport failures without wrapping or retrying them", async () => {
    const error = new Error("connection closed")
    const call = vi.fn().mockRejectedValue(error)
    const api = createWorktreeApi({ rpc: { call } })

    await expect(api.list("/repo")).rejects.toBe(error)
    expect(call.mock.calls).toEqual([["/api", "dsh-simple-worktree/worktree.list", { path: "/repo" }, expect.any(AbortSignal)]])
  })
})

describe("native same-ID relocation client", () => {
  const request = Object.freeze({ sessionId: "existing-chat", targetWorkspaceId: "project-b", expectedCwd: "/a", expectedRevision: "observed-7", operationId: "7b38006a-69f3-419f-928d-d486a441e9dc" })
  const result = { sessionId: "existing-chat", sourceWorkspaceId: "project-a", targetWorkspaceId: "project-b", operationId: request.operationId, cwd: "/b", revision: "committed-8" }

  it("provides the native companion through the production worktree API factory without using worktree RPC", async () => {
    const call = vi.fn()
    const relocate = vi.fn().mockResolvedValue({ ok: true, value: result })
    const api = createWorktreeApi({ rpc: { call } }, { relocate })
    await expect(api.relocation.relocate(request)).resolves.toEqual(result)
    expect(call).not.toHaveBeenCalled()
    expect(relocate).toHaveBeenCalledTimes(1)
  })

  afterEach(() => vi.useRealTimers())

  it("uses the authenticated Remote service and forwards the exact source observation", async () => {
    const remote = {
      relocationInfo: vi.fn().mockResolvedValue({ ok: true, value: { supported: true, cwd: "/a", revision: "observed-7", directoryContexts: [{ from: 0, cwd: "/a" }] } }),
      relocate: vi.fn().mockResolvedValue({ ok: true, value: result }),
    }
    const api = createSessionRelocationApi(remote)
    const signal = new AbortController().signal
    await expect(api.info("existing-chat", signal)).resolves.toEqual({ supported: true, cwd: "/a", revision: "observed-7" })
    await expect(api.relocate(request)).resolves.toEqual(result)
    expect(remote.relocationInfo.mock.calls).toEqual([[{ sessionId: "existing-chat" }, signal]])
    expect(remote.relocate.mock.calls).toEqual([[request]])
  })

  it.each([undefined, {}, { relocate: vi.fn() }, { relocationInfo: vi.fn() }])("reports unsupported without any mutation for an older client %j", async remote => {
    const api = createSessionRelocationApi(remote)
    await expect(api.info("existing-chat")).resolves.toEqual({ supported: false })
    if (remote && "relocate" in remote) expect(remote.relocate).not.toHaveBeenCalled()
  })

  it.each(["gateway/method-unavailable", "gateway/invocation-unavailable", "session/relocate-unsupported"])("recognizes an older Host's %s response", async code => {
    const api = createSessionRelocationApi({ relocationInfo: vi.fn().mockResolvedValue({ ok: false, error: { code } }), relocate: vi.fn() })
    await expect(api.info("existing-chat")).resolves.toEqual({ supported: false })
  })

  it.each(["busy", "conflict", "target-invalid", "unsupported", "recovery-required"])("keeps the native %s refusal without exposing a stack or claiming success", async suffix => {
    const code = `session/relocate-${suffix}`
    const relocate = vi.fn().mockResolvedValue({ ok: false, error: { code, message: "private host details", stack: "private stack" } })
    await expect(createSessionRelocationApi({ relocate }).relocate(request)).rejects.toMatchObject({ code, message: code })
    expect(relocate).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, { ok: true }, { ok: true, value: { ...result, sessionId: "new-fork" } }, { ok: true, value: { ...result, targetWorkspaceId: "foreign-project" } }, { ok: true, value: { ...result, operationId: "different-operation" } }, { ok: true, value: { ...result, revision: "" } }])("rejects an incomplete or foreign success %j", async value => {
    const api = createSessionRelocationApi({ relocate: vi.fn().mockResolvedValue(value) })
    await expect(api.relocate(request)).rejects.toMatchObject({ code: "session/relocate-invalid-response" })
  })

  it.each([{ supported: true }, { supported: true, cwd: "/a", revision: "" }, { supported: "true", cwd: "/a", revision: "r" }])("rejects a malformed support observation %j", async value => {
    const api = createSessionRelocationApi({ relocationInfo: vi.fn().mockResolvedValue({ ok: true, value }), relocate: vi.fn() })
    await expect(api.info("existing-chat")).rejects.toMatchObject({ code: "session/relocate-invalid-response" })
  })

  it.each([{ ...request, targetWorkspaceId: " " }, { ...request, expectedRevision: "" }, { ...request, expectedCwd: "" }, { ...request, operationId: "not-a-uuid" }])("refuses incomplete intent before sending it %j", async value => {
    const relocate = vi.fn()
    await expect(createSessionRelocationApi({ relocate }).relocate(value)).rejects.toMatchObject({ code: "gateway/bad-request" })
    expect(relocate).not.toHaveBeenCalled()
  })

  it("never retries a disconnected mutation and preserves the caller's operation for explicit retry", async () => {
    vi.useFakeTimers()
    const failure = new Error("connection closed after commit")
    const relocate = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ ok: true, value: result })
    const api = createSessionRelocationApi({ relocate })
    await expect(api.relocate(request)).rejects.toBe(failure)
    await vi.advanceTimersByTimeAsync(60000)
    expect(relocate).toHaveBeenCalledTimes(1)
    await expect(api.relocate(request)).resolves.toEqual(result)
    expect(relocate.mock.calls).toEqual([[request], [request]])
    expect(vi.getTimerCount()).toBe(0)
  })
})
