import type { On, ProcessRunResult, ToolCallResult, ToolSpec } from "claude-code"

const PREFIX = "mcp__pi-context__"
const TOOL_NAMES = ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search"] as const
const HELPER = `${import.meta.dir}/../dist/claude/helper.js`
const TIMEOUT_MS = 10_000
const OUTPUT_LIMIT = 1024 * 1024

type Identity = { home: string; sessionId: string; cwd: string; agent: string; model: string }
type SchemaRow = { name: string; description: string; inputSchema: Record<string, unknown> }

function errorResult(message: string): ToolCallResult { return { result: `pi-context: ${message}`, isError: true } }
/** The helper's tool result: the shared text the model reads, plus whether that outcome refused. */
function toolResultOf(value: unknown): { text: string; ok: boolean } | undefined {
	if (typeof value !== "object" || value === null) return undefined
	const { text, outcome } = value as { text?: unknown; outcome?: unknown }
	if (typeof text !== "string" || typeof outcome !== "object" || outcome === null) return undefined
	const ok = (outcome as { ok?: unknown }).ok
	if (typeof ok !== "boolean") return undefined
	return { text, ok }
}
function decode(result: ProcessRunResult): { ok: true; result: unknown } | { ok: false; error: string } {
  if (result.exitCode !== 0) return { ok: false, error: "helper exited unsuccessfully" }
  if (result.stdout.length > OUTPUT_LIMIT) return { ok: false, error: "helper output exceeded the limit" }
  try {
    const value = JSON.parse(result.stdout.trim()) as { ok?: unknown; result?: unknown; error?: unknown }
    if (value.ok === true) return { ok: true, result: value.result }
    return { ok: false, error: typeof value.error === "string" ? value.error : "helper returned an invalid error" }
  } catch { return { ok: false, error: "helper returned invalid JSON" } }
}
async function run($: { process: { run: (argv: readonly string[], init?: { cwd?: string; stdin?: string; timeoutMs?: number }) => Promise<ProcessRunResult> } }, request: unknown, cwd: string) {
  try { return decode(await $.process.run(["node", HELPER], { cwd, stdin: `${JSON.stringify(request)}\n`, timeoutMs: TIMEOUT_MS })) }
  catch { return { ok: false as const, error: "helper execution failed" } }
}
function identityOf(e: { cwd: string }, sessionId: string, home: string, model: string): Identity {
  return { home, sessionId, cwd: e.cwd, agent: "claude", model: model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "claude" }
}

export function register(on: On) {
  let identity: Identity | undefined
  const registered = new Set<string>()
  on("session.start", async ($, e, next) => {
    const home = await $.env.get("PI_NOTES_HOME") ?? `${await $.env.get("HOME") ?? await $.env.get("USERPROFILE") ?? ""}/.agents/notes`
    identity = identityOf(e, await $.session.id(), home, "claude")
    const schemas = await run($, { op: "schemas" }, e.cwd)
    if (!schemas.ok || !Array.isArray(schemas.result)) return next(e)
    for (const row of schemas.result as SchemaRow[]) {
      if (!TOOL_NAMES.includes(row.name as typeof TOOL_NAMES[number])) continue
      const full = await $.tool.register({ name: row.name, description: row.description, inputSchema: row.inputSchema } satisfies ToolSpec)
      registered.add(full.tool)
    }
    return next(e)
  })
  on("tool.call", async ($, e, next) => {
    if (!registered.has(e.tool) || e.agentId !== undefined || !identity) return next(e)
    const { tool, tool_use_id: _toolUseId, agentId: _agentId, ...params } = e
    const result = await run($, { op: "tool", tool: tool.slice(PREFIX.length), params, identity }, identity.cwd)
    if (!result.ok) return errorResult(result.error)
    // The outcome already decided success or refusal; Claude requires isError: true on errors and no discriminator on success.
    const outcome = toolResultOf(result.result)
    if (!outcome) return errorResult("helper returned an invalid tool result")
    return outcome.ok ? { result: outcome.text } : { result: outcome.text, isError: true }
  })
  on("prompt.context", async ($, e, next) => {
    const result = await next(e)
    if (result.blocks.some((block) => block.name === "pi-context:boot")) return result
    if (!identity) return result
    const boot = await run($, { op: "boot", identity, tools: {
      notes: `${PREFIX}notes_*`, notesList: `${PREFIX}notes_list`,
      history: "history_* (unavailable in Claude)", historyWindows: "history_windows (unavailable in Claude)", historyList: "history_list (unavailable in Claude)",
      historySearch: "history_search (unavailable in Claude)", historyRead: "history_read (unavailable in Claude)",
      remaining: "get_context_remaining (unavailable in Claude)", wipe: "clear_memory (unavailable in Claude)",
    } }, identity.cwd)
    const block = { name: "pi-context:boot", text: boot.ok ? String(boot.result) : `# pi-context\n${boot.error}` }
    return { ...result, blocks: [...result.blocks, block] }
  })
}
