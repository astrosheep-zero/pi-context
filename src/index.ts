import { Type, type TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "pi-context/state";
const NOTE_TYPE = "pi-context/note";
const HINT_TYPE = "pi-context/hint";
const RESET_MARKER_TYPE = "pi-context/reset-marker";
const CONTINUATION_TYPE = "pi-context/continuation";
const MAX_NOTE_BYTES = 1_000_000;
const CONTEXT_WINDOW_OPEN_TAG = "<context_window>";
const CONTEXT_WINDOW_CLOSE_TAG = "</context_window>";
const GUIDANCE_OPEN_TAG = "<context_window_guidance>";
const GUIDANCE_CLOSE_TAG = "</context_window_guidance>";
const REMINDER_THRESHOLD_TOKENS = 16_000;
const RESET_SUMMARY = "Context window reset. Prior session entries remain available only through the pi-context history tools.";
const CONTINUATION = "This is a fresh context window. Recover only the details needed to continue with history_* and notes_*; then continue the task.";

type NoteFile = { text: string; createdAt: number; updatedAt: number };
type NoteOperation = {
	op: "write" | "append";
	path: string;
	text: string;
	createdAt: number;
	updatedAt: number;
};
type HistoryItem = {
	windowId: string;
	itemId: string;
	role: "user" | "assistant" | "tool" | "system" | "developer";
	content: string;
	createdAt: string | undefined;
	toolName?: string;
	toolNamespace?: string;
};
type HistoryWindow = { windowId: string; createdAt?: string; items: HistoryItem[] };

type HistoryFilter = {
	agent_name?: string | null;
	window_id?: string | null;
	role?: HistoryItem["role"] | null;
	tool_namespace?: string | null;
	tool_name?: string | null;
	recent_first?: boolean;
};

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function output(value: unknown, details: unknown = value, terminate = false) {
	return { content: [{ type: "text" as const, text: json(value) }], details, terminate };
}

function unsupportedAgent(agentName: string | null | undefined) {
	return agentName !== undefined && agentName !== null
		? { error: "Pi 0.85.1 exposes no cross-agent session routing; agent_name is unsupported and was not aliased to this session." }
		: undefined;
}

function isTextContent(part: unknown): part is TextContent {
	return typeof part === "object" && part !== null && (part as TextContent).type === "text" && typeof (part as TextContent).text === "string";
}

function contentText(content: string | unknown[]): string {
	if (typeof content === "string") return content;
	return content.filter(isTextContent).map((part) => part.text).join("\n");
}

function mapRole(role: AgentMessage["role"]): HistoryItem["role"] | undefined {
	if (role === "user" || role === "assistant") return role;
	if (role === "toolResult" || role === "bashExecution") return "tool";
	if (role === "custom") return "user";
	if (role === "compactionSummary" || role === "branchSummary") return "system";
	return undefined;
}

function messageContent(message: AgentMessage): string {
	switch (message.role) {
		case "bashExecution":
			return message.output;
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default:
			return contentText(message.content);
	}
}

function toolInfo(message: AgentMessage): Pick<HistoryItem, "toolName" | "toolNamespace"> {
	if (message.role === "bashExecution") return { toolName: "bash", toolNamespace: undefined };
	if (message.role !== "toolResult") return {};
	const underscore = message.toolName.indexOf("_");
	return { toolName: message.toolName, toolNamespace: underscore > 0 ? message.toolName.slice(0, underscore) : undefined };
}

/** Build durable, on-demand history directly from every entry on the current session branch. */
export function historyFromSession(ctx: ExtensionContext): HistoryWindow[] {
	const sessionId = ctx.sessionManager.getSessionId();
	let window: HistoryWindow = { windowId: `pcw:${sessionId}:root`, items: [] };
	const windows = [window];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction") {
			window = { windowId: `pcw:${sessionId}:${entry.id}`, createdAt: entry.timestamp, items: [] };
			windows.push(window);
			window.items.push({
				windowId: window.windowId,
				itemId: entry.id,
				role: "system",
				content: entry.summary,
				createdAt: entry.timestamp,
			});
			continue;
		}
		if (entry.type === "message") {
			const role = mapRole(entry.message.role);
			if (!role) continue;
			window.items.push({
				windowId: window.windowId,
				itemId: entry.id,
				role,
				content: messageContent(entry.message),
				createdAt: entry.timestamp,
				...toolInfo(entry.message),
			});
			continue;
		}
		if (entry.type === "custom_message") {
			window.items.push({
				windowId: window.windowId,
				itemId: entry.id,
				role: "user",
				content: contentText(entry.content),
				createdAt: entry.timestamp,
			});
		}
	}
	return windows;
}

function visibleItem(item: HistoryItem, maxChars = 1200) {
	const characters = Array.from(item.content);
	return {
		window_id: item.windowId,
		item_id: item.itemId,
		role: item.role,
		tool_namespace: item.toolNamespace ?? null,
		tool_name: item.toolName ?? null,
		truncated_content: characters.length > maxChars ? `${characters.slice(0, maxChars).join("")}…` : item.content,
	};
}

function allItems(ctx: ExtensionContext) {
	return historyFromSession(ctx).flatMap((window) => window.items);
}

function filteredItems(ctx: ExtensionContext, params: HistoryFilter): HistoryItem[] | { error: string } {
	const agentError = unsupportedAgent(params.agent_name);
	if (agentError) return agentError;
	let items = allItems(ctx);
	if (typeof params.window_id === "string") items = items.filter((item) => item.windowId === params.window_id);
	if (typeof params.role === "string") items = items.filter((item) => item.role === params.role);
	if (typeof params.tool_namespace === "string") items = items.filter((item) => item.toolNamespace === params.tool_namespace);
	if (typeof params.tool_name === "string") items = items.filter((item) => item.toolName === params.tool_name);
	if (params.recent_first === true) items.reverse();
	return items;
}

function assertVirtualPath(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new Error("path must be a non-empty virtual relative path");
	if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) throw new Error("path must be a safe virtual relative path");
	const parts = value.split("/");
	if (parts.some((part) => part.length === 0 || part === "." || part === "..")) throw new Error("path contains an unsupported component");
	return value;
}

function assertVirtualPrefix(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return assertVirtualPath(value);
}

/** Replays only pi-context note operations from session custom entries. */
function isNoteOperation(data: unknown): data is NoteOperation {
	if (typeof data !== "object" || data === null) return false;
	const op = data as Partial<NoteOperation>;
	return (
		(op.op === "write" || op.op === "append") &&
		typeof op.path === "string" &&
		typeof op.text === "string" &&
		typeof op.createdAt === "number" &&
		typeof op.updatedAt === "number"
	);
}

export function notesFromSession(ctx: ExtensionContext): Map<string, NoteFile> {
	const files = new Map<string, NoteFile>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== NOTE_TYPE || !isNoteOperation(entry.data)) continue;
		const op = entry.data;
		try {
			assertVirtualPath(op.path);
		} catch {
			continue;
		}
		const previous = files.get(op.path);
		const text = op.op === "append" ? `${previous?.text ?? ""}${op.text}` : op.text;
		if (Buffer.byteLength(text, "utf8") <= MAX_NOTE_BYTES) {
			files.set(op.path, { text, createdAt: previous?.createdAt ?? op.createdAt, updatedAt: op.updatedAt });
		}
	}
	return files;
}

/** Codex-equivalent <context_window> hint: window identity plus recent-notes entry points. */
export function contextWindowHint(ctx: ExtensionContext): string {
	const windows = historyFromSession(ctx);
	const first = windows[0];
	const current = windows[windows.length - 1];
	const previous = windows.length > 1 ? windows[windows.length - 2] : undefined;
	const lines = [
		`Agent name: ${ctx.sessionManager.getSessionName() ?? "root"}`,
		`First context window id: ${first?.windowId ?? "unknown"}`,
		`Current context window id: ${current?.windowId ?? "unknown"}`,
	];
	if (previous) lines.push(`Previous context window id: ${previous.windowId}`);
	const recentNotes = [...notesFromSession(ctx)]
		.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
		.slice(0, 5);
	if (recentNotes.length > 0) {
		lines.push("Recent notes (up to 5, most-recent first):");
		for (const [path, file] of recentNotes) {
			lines.push(`- ${path} (${file.text.split("\n").length} lines, ${Buffer.byteLength(file.text, "utf8")} UTF-8 bytes)`);
		}
	}
	return `${CONTEXT_WINDOW_OPEN_TAG}\n${lines.join("\n")}\n${CONTEXT_WINDOW_CLOSE_TAG}`;
}

/** Codex-equivalent low-budget reminder: threshold-gated, claimed once per context window. */
function tokenBudgetGuidance(remaining: number): string {
	return `${GUIDANCE_OPEN_TAG}\nYou have ${remaining} tokens left in this context window. Write durable state with notes_write_file and call new_context before the window closes.\n${GUIDANCE_CLOSE_TAG}`;
}

function lineRange(text: string, startValue: unknown, stopValue: unknown) {
	const lines = text.split("\n");
	const resolve = (value: unknown, fallback: number) => {
		if (value === undefined || value === null) return fallback;
		if (!Number.isInteger(value) || value === 0) throw new Error("line numbers must be non-zero integers; negative values count from the end");
		const line = value as number;
		return line > 0 ? line : lines.length + line + 1;
	};
	const start = Math.max(1, resolve(startValue, 1));
	const stop = Math.min(lines.length, resolve(stopValue, lines.length));
	return { start_line: start, stop_line: stop, content: start > stop ? "" : lines.slice(start - 1, stop).join("\n") };
}

const nullableString = () => Type.Optional(Type.Union([Type.String(), Type.Null()]));
const nullableInteger = () => Type.Optional(Type.Union([Type.Integer(), Type.Null()]));
const positiveInteger = () => Type.Optional(Type.Integer({ minimum: 1 }));
const role = Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"), Type.Literal("system"), Type.Literal("developer"), Type.Null()]);

export default function piContext(pi: ExtensionAPI) {
	let rollover: "idle" | "requested" | "compacting" | "continued" = "idle";
	let enabled = true;

	/** Persist the context_window hint as a visible message (lands in history and the TUI), Codex-style. */
	const persistHint = (ctx: ExtensionContext) => {
		pi.sendMessage({ customType: HINT_TYPE, content: contextWindowHint(ctx), display: true }, { triggerTurn: false });
	};

	pi.on("session_start", (_event, ctx) => {
		if (!enabled) return;
		persistHint(ctx);
	});
	const saveNote = (op: NoteOperation) => {
		// pi.appendEntry writes a custom SessionManager entry. Custom entries are persistent but excluded from LLM context.
		// ExtensionContext deliberately exposes only a readonly SessionManager, so this is the public extension write path.
		pi.appendEntry(NOTE_TYPE, op);
	};

	pi.registerCommand("pi-context", {
		description: "Toggle pi-context: context_window hint, low-budget guidance, and reset-style compaction",
		getArgumentCompletions: (prefix) =>
			["on", "off"].filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
		handler: async (args, cmdCtx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			else if (arg !== "") {
				cmdCtx.ui.notify("Usage: /pi-context [on|off]", "error");
				return;
			}
			cmdCtx.ui.notify(`pi-context: ${enabled ? "on" : "off"}`, "info");
		},
	});

	pi.registerTool(defineTool({
		name: "history_list_windows",
		label: "History list windows",
		description: "List durable Pi session-history windows. agent_name is explicitly unsupported because Pi has no cross-agent session routing.",
		parameters: Type.Object({ limit: positiveInteger(), agent_name: nullableString(), recent_first: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const agentError = unsupportedAgent(params.agent_name);
			if (agentError) return output(agentError);
			let windows = historyFromSession(ctx);
			if (params.recent_first) windows = [...windows].reverse();
			const limit = params.limit ?? windows.length;
			return output({ windows: windows.slice(0, limit).map((window) => ({ window_id: window.windowId, item_count: window.items.length })) });
		},
	}));

	pi.registerTool(defineTool({
		name: "history_list_items",
		label: "History list items",
		description: "List durable session items, including items before compaction, using opaque item and window IDs.",
		parameters: Type.Object({ limit: positiveInteger(), recent_first: Type.Optional(Type.Boolean()), tool_namespace: nullableString(), role: Type.Optional(role), agent_name: nullableString(), tool_name: nullableString(), window_id: nullableString(), max_chars_per_item: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const items = filteredItems(ctx, params);
			if ("error" in items) return output(items);
			return output({ items: items.slice(0, params.limit ?? items.length).map((item) => visibleItem(item, params.max_chars_per_item ?? 1200)) });
		},
	}));

	pi.registerTool(defineTool({
		name: "history_read_item",
		label: "History read item",
		description: "Read a bounded character range from one durable session item.",
		parameters: Type.Object({ agent_name: nullableString(), item_id: Type.String(), offset_chars: Type.Optional(Type.Integer({ minimum: 0 })), limit_chars: positiveInteger(), window_id: Type.String() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const agentError = unsupportedAgent(params.agent_name);
			if (agentError) return output(agentError);
			const item = allItems(ctx).find((candidate) => candidate.windowId === params.window_id && candidate.itemId === params.item_id);
			if (!item) return output({ error: "unknown item_id or window_id" });
			const chars = Array.from(item.content);
			const offset = params.offset_chars ?? 0;
			const limit = params.limit_chars ?? chars.length;
			return output({ window_id: item.windowId, item_id: item.itemId, offset_chars: offset, content: chars.slice(offset, offset + limit).join("") });
		},
	}));

	pi.registerTool(defineTool({
		name: "history_search_contents",
		label: "History search",
		description: "Case-sensitive literal substring search over durable Pi session history; no semantic search.",
		parameters: Type.Object({ limit: positiveInteger(), query: Type.String(), recent_first: Type.Optional(Type.Boolean()), tool_namespace: nullableString(), role: Type.Optional(role), agent_name: nullableString(), tool_name: nullableString(), window_id: nullableString() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const items = filteredItems(ctx, params);
			if ("error" in items) return output(items);
			const matching = items.filter((item) => item.content.includes(params.query));
			return output({ items: matching.slice(0, params.limit ?? matching.length).map((item) => visibleItem(item)) });
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_list_files_by_prefix",
		label: "Notes list files",
		description: "List persistent, session-scoped virtual note files.",
		parameters: Type.Object({ prefix: nullableString(), max_results: positiveInteger(), file_order_by: Type.Optional(Type.Union([Type.Literal("name"), Type.Literal("created_at"), Type.Literal("updated_at")])), file_order: Type.Optional(Type.Union([Type.Literal("ascending"), Type.Literal("descending")])) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const prefix = assertVirtualPrefix(params.prefix);
			let files = [...notesFromSession(ctx)].filter(([path]) => !prefix || path.startsWith(prefix));
			const key = params.file_order_by ?? "name";
			files.sort(([aPath, a], [bPath, b]) => key === "name" ? aPath.localeCompare(bPath) : (key === "created_at" ? a.createdAt - b.createdAt : a.updatedAt - b.updatedAt));
			if (params.file_order === "descending") files.reverse();
			return output({ files: files.slice(0, params.max_results ?? files.length).map(([path, file]) => ({ path, size_bytes: Buffer.byteLength(file.text, "utf8"), created_at: file.createdAt, updated_at: file.updatedAt })) });
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_read_file",
		label: "Notes read file",
		description: "Read a virtual note file, optionally by inclusive 1-based line range; negative lines count from the end.",
		parameters: Type.Object({ path: Type.String(), start_line: nullableInteger(), stop_line: nullableInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const path = assertVirtualPath(params.path);
			const file = notesFromSession(ctx).get(path);
			if (!file) return output({ error: "note file not found", path });
			return output({ path, ...lineRange(file.text, params.start_line, params.stop_line) });
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_search_contents",
		label: "Notes search",
		description: "Case-sensitive literal substring search over virtual note lines; no semantic search.",
		parameters: Type.Object({ max_matches_per_file: positiveInteger(), query: Type.String(), recent_file_first: Type.Optional(Type.Boolean()), max_files: positiveInteger(), path_prefix: nullableString() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const prefix = assertVirtualPrefix(params.path_prefix);
			let files = [...notesFromSession(ctx)].filter(([path]) => !prefix || path.startsWith(prefix));
			if (params.recent_file_first) files.sort((a, b) => b[1].createdAt - a[1].createdAt);
			const maxPerFile = params.max_matches_per_file ?? Number.POSITIVE_INFINITY;
			const result = files.map(([path, file]) => ({ path, matches: file.text.split("\n").flatMap((line, index) => line.includes(params.query) ? [{ line: index + 1, text: line }] : []).slice(0, maxPerFile) })).filter((file) => file.matches.length > 0);
			return output({ files: result.slice(0, params.max_files ?? result.length) });
		},
	}));

	for (const [name, op] of [["notes_append_to_file", "append"], ["notes_write_file", "write"]] as const) {
		pi.registerTool(defineTool({
			name,
			label: name === "notes_append_to_file" ? "Notes append" : "Notes write",
			description: name === "notes_append_to_file" ? "Append exact text to a persistent virtual note file." : "Create or replace a persistent virtual note file.",
			parameters: Type.Object({ text: Type.String(), path: Type.String() }, { additionalProperties: false }),
			async execute(_id, params, _signal, _update, ctx) {
				const path = assertVirtualPath(params.path);
				const old = notesFromSession(ctx).get(path);
				const next = op === "append" ? `${old?.text ?? ""}${params.text}` : params.text;
				const bytes = Buffer.byteLength(next, "utf8");
				if (bytes > MAX_NOTE_BYTES) return output({ error: `note exceeds ${MAX_NOTE_BYTES} UTF-8 bytes`, path, size_bytes: bytes });
				const now = Date.now();
				saveNote({ op, path, text: params.text, createdAt: old?.createdAt ?? now, updatedAt: now });
				return output({ path, size_bytes: bytes, operation: op });
			},
		}));
	}

	pi.on("context", (event, ctx) => {
		if (!enabled) return undefined;
		// Transient per-request while below the threshold. Codex's reminder persists in
		// history and therefore stays visible; re-injecting while low is the effective parity.
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return undefined;
		const remaining = Math.max(0, usage.contextWindow - usage.tokens);
		if (remaining > REMINDER_THRESHOLD_TOKENS) return undefined;
		const guidance = {
			role: "user" as const,
			content: [{ type: "text" as const, text: tokenBudgetGuidance(remaining) }],
			timestamp: Date.now(),
		};
		return { messages: [guidance, ...event.messages] };
	});

	pi.registerTool(defineTool({
		name: "get_context_remaining",
		label: "Get context remaining",
		description: "Return remaining context tokens when Pi can estimate them, otherwise null.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _update, ctx) {
			const usage = ctx.getContextUsage();
			const remaining = usage?.tokens === null || usage === undefined ? null : Math.max(0, usage.contextWindow - usage.tokens);
			return output({ remaining_tokens: remaining });
		},
	}));

	pi.registerTool(defineTool({
		name: "new_context",
		label: "New context",
		description: "Request a reset-style context rollover after this tool result is safely recorded. Call alone in a tool batch.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			if (!enabled) return output({ error: "pi-context is off (/pi-context on to enable)" });
			if (rollover === "idle") rollover = "requested";
			return output({ status: rollover === "requested" ? "rollover_requested" : "rollover_already_pending" }, undefined, true);
		},
	}));

	pi.on("agent_end", (_event, ctx) => {
		if (!enabled) {
			if (rollover === "requested") rollover = "idle";
			return;
		}
		if (rollover !== "requested") return;
		rollover = "compacting";
		ctx.compact({ onError: () => { if (rollover === "compacting") rollover = "idle"; } });
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!enabled) return undefined; // Default Pi compaction applies; keepRecentTokens is honored again.
		// Never let an aborted or failed custom reset fall through to Pi's default summary.
		if (event.signal.aborted) return { cancel: true };
		try {
			pi.appendEntry(RESET_MARKER_TYPE, { version: 1, reason: event.reason, requested: rollover === "compacting" });
			const markerId = ctx.sessionManager.getLeafId();
			if (!markerId) return { cancel: true };
			return { compaction: { summary: RESET_SUMMARY, firstKeptEntryId: markerId, tokensBefore: event.preparation.tokensBefore, details: { piContext: "reset-v1" } } };
		} catch {
			return { cancel: true };
		}
	});

	pi.on("session_compact", (event, ctx) => {
		if (!enabled) return;
		// Overflow retry is already continued once by Pi core. Sending another turn would duplicate it.
		if (event.willRetry) return;
		if (rollover !== "compacting") return;
		rollover = "continued";
		pi.appendEntry(STATE_TYPE, { version: 1, lastResetEntryId: event.compactionEntry.id });
		persistHint(ctx);
		pi.sendMessage({ customType: CONTINUATION_TYPE, content: CONTINUATION, display: false }, { triggerTurn: true });
	});

	pi.on("session_compact_failed", () => {
		if (rollover === "compacting") rollover = "idle";
	});
}

export const internal = { MAX_NOTE_BYTES, NOTE_TYPE, HINT_TYPE, RESET_MARKER_TYPE, RESET_SUMMARY, CONTINUATION, CONTEXT_WINDOW_OPEN_TAG, GUIDANCE_OPEN_TAG, REMINDER_THRESHOLD_TOKENS, lineRange, assertVirtualPath };
