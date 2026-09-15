import { randomUUID } from "node:crypto";
import { Type, type TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defineTool, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "pi-context/state";
const NOTE_TYPE = "pi-context/note";
const BOOT_TYPE = "pi-context/boot";
const GUIDANCE_TYPE = "pi-context/guidance";
const FALLBACK_TYPE = "pi-context/fallback";
const RESET_MARKER_TYPE = "pi-context/reset-marker";
const CONTINUATION_TYPE = "pi-context/continuation";
const RESET_V2 = "reset-v2";
const MAX_NOTE_BYTES = 1_000_000;
const CONTEXT_WINDOW_OPEN_TAG = "<context_window>";
const CONTEXT_WINDOW_CLOSE_TAG = "</context_window>";
const CONTEXT_WINDOW_PROTOCOL_OPEN_TAG = "<context_window_protocol>";
const CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG = "</context_window_protocol>";
const GUIDANCE_OPEN_TAG = "<context_window_guidance>";
const GUIDANCE_CLOSE_TAG = "</context_window_guidance>";
const PI_CONTEXT_SETTINGS_KEY = "pi-context";
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_REMINDER_MARGIN_TOKENS = 24_576;
const DEFAULT_FALLBACK_MARGIN_TOKENS = 8_192;
const RESET_SUMMARY = "Context window reset. No summary was generated. Retrieve prior details through history_* and notes_*.";
const CONTINUATION = "This is a fresh context window. Recover only the details needed to continue with history_* and notes_*; then continue the task.";

/**
 * Static protocol teaching adapted from Codex's token_budget.guidance_message to
 * pi-context's tool names. It lives once per window in the persisted boot block;
 * it is never re-injected, so it stays cache-stable at the head of the window.
 */
const PROTOCOL_BLOCK = `${CONTEXT_WINDOW_PROTOCOL_OPEN_TAG}
For tasks that may span context windows, use notes_write_file and notes_append_to_file to maintain a concise checkpoint of the goal, decisions, progress, learnings, and next steps. Include the window ID and item ID of every relevant user request you are currently solving, plus important actions and tool calls. The read-only history_* tools can look up details from those references later. Every non-assistant item (user, tool result) has an item ID returned by history_list_items.

Take incremental notes while you work so you do not lose important information. Use get_context_remaining to check the live remaining token budget for planning. Once the token budget is exhausted you lose access to the current window and continue in a fresh context window; you can recover only through notes_* and history_*. Do not over-run the context window without documentation.

If a Previous context window id is present in <context_window>, a context reset occurred and this is a fresh window. The old conversation is not automatically included. After a reset, read your note checkpoint and use the read-only history_* tools to recover missing details. When a window ID and item ID are known, prefer history_read_item directly; when they are missing or uncertain, use history_list_items, or history_search_contents to locate the item first.

Notes are session-scoped virtual files. Treat notes and history as internal bookkeeping; never mention them in user-facing messages.
${CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG}`;

const FALLBACK_PROMPT =
	"Context budget is almost exhausted. This is the final fallback turn before the window resets automatically. Write task state, decisions, open issues, and next steps with notes_write_file now. Do not start new work; old conversation remains searchable through history_*.";

type ResolvedThresholds = { reminder: number; fallback: number };
type PiContextMargins = { reminderMarginTokens: unknown; fallbackMarginTokens: unknown };

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

/** The extension-owned window id baked onto a reset-v2 compaction entry, if present. */
function resetV2WindowId(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = details as { piContext?: unknown; windowId?: unknown };
	if (candidate.piContext !== RESET_V2 || typeof candidate.windowId !== "string") return undefined;
	return candidate.windowId;
}

/** A compaction entry's window id: the extension-minted id for reset-v2, else Pi's entry id. */
function windowIdOf(sessionId: string, entry: { id: string; details?: unknown }): string {
	return resetV2WindowId(entry.details) ?? `pcw:${sessionId}:${entry.id}`;
}

/** Build durable, on-demand history directly from every entry on the current session branch. */
export function historyFromSession(ctx: ExtensionContext): HistoryWindow[] {
	const sessionId = ctx.sessionManager.getSessionId();
	let window: HistoryWindow = { windowId: `pcw:${sessionId}:root`, items: [] };
	const windows = [window];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction") {
			window = { windowId: windowIdOf(sessionId, entry), createdAt: entry.timestamp, items: [] };
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

function filteredItems(ctx: ExtensionContext, params: HistoryFilter): HistoryItem[] {
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

/** Codex-style <context_window> identity block: agent name and first/current/previous window ids only. */
function identityBlock(agentName: string, firstWindowId: string, currentWindowId: string, previousWindowId?: string): string {
	const lines = [
		`Agent name: ${agentName}`,
		`First context window id: ${firstWindowId}`,
		`Current context window id: ${currentWindowId}`,
	];
	if (previousWindowId) lines.push(`Previous context window id: ${previousWindowId}`);
	return `${CONTEXT_WINDOW_OPEN_TAG}\n${lines.join("\n")}\n${CONTEXT_WINDOW_CLOSE_TAG}`;
}

/** Recent-notes index with the existing wording; empty when the session has no notes. */
function notesIndex(ctx: ExtensionContext): string {
	const recentNotes = [...notesFromSession(ctx)]
		.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
		.slice(0, 5);
	if (recentNotes.length === 0) return "";
	const lines = ["Recent notes (up to 5, most-recent first):"];
	for (const [path, file] of recentNotes) {
		lines.push(`- ${path} (${file.text.split("\n").length} lines, ${Buffer.byteLength(file.text, "utf8")} UTF-8 bytes)`);
	}
	return lines.join("\n");
}

/**
 * Assemble the static, once-per-window boot block: the reset line for resets, the
 * <context_window> identity block, the recent-notes index at window-open time, and
 * the <context_window_protocol> teaching block. Nothing here is re-injected, so the
 * head of the window stays cache-stable.
 */
function bootBlock(ctx: ExtensionContext, currentId: string, previousId: string | undefined, resetLine: boolean): string {
	const firstId = historyFromSession(ctx)[0]?.windowId ?? currentId;
	const parts: string[] = [];
	if (resetLine) parts.push(RESET_SUMMARY);
	parts.push(identityBlock(ctx.sessionManager.getSessionName() ?? "root", firstId, currentId, previousId));
	const index = notesIndex(ctx);
	if (index) parts.push(index);
	parts.push(PROTOCOL_BLOCK);
	return parts.join("\n\n");
}

/**
 * Codex-equivalent low-budget reminder. The measured remaining count is frozen into
 * the text at the crossing that fires it, so each persisted copy is a snapshot true
 * at write time; get_context_remaining remains the live source for the current figure.
 */
function tokenBudgetGuidance(remaining: number): string {
	return `${GUIDANCE_OPEN_TAG}\nContext budget is running low: only ${remaining} tokens remained when this reminder was recorded. Persist task state, decisions, open issues, and next steps with notes_write_file, including the window ID and item ID of relevant user requests for history_* lookups; call new_context when ready to continue in a fresh window. Automatic reset does not guarantee another note-taking turn. get_context_remaining reports the current remaining tokens.\n${GUIDANCE_CLOSE_TAG}`;
}

/** Cheap current-window lookup: scan the branch tail for the latest compaction entry. */
function currentWindowId(ctx: ExtensionContext): string {
	const sessionId = ctx.sessionManager.getSessionId();
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "compaction") return windowIdOf(sessionId, entry);
	}
	return `pcw:${sessionId}:root`;
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

function isSettingsObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the raw "pi-context" object from one parsed settings scope. */
function piContextSettings(settings: unknown): Record<string, unknown> {
	if (!isSettingsObject(settings)) return {};
	const value = settings[PI_CONTEXT_SETTINGS_KEY];
	return isSettingsObject(value) ? value : {};
}

/** Merge the global and project "pi-context" objects per key; project wins, mirroring Pi's deep merge. */
export function mergePiContextSettings(globalSettings: unknown, projectSettings: unknown): PiContextMargins {
	const merged = { ...piContextSettings(globalSettings), ...piContextSettings(projectSettings) };
	return { reminderMarginTokens: merged.reminderMarginTokens, fallbackMarginTokens: merged.fallbackMarginTokens };
}

/** A margin is usable only as a positive integer; anything else is ignored. */
function validMargin(raw: unknown): number | undefined {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) return undefined;
	return raw;
}

/**
 * Pure derivation of the effective thresholds from Pi's reserve plus the pi-context
 * margins. Invalid margins and a reminder that does not clear the fallback degrade
 * to defaults per offending key and report one warning each.
 */
export function deriveThresholds(reserveTokens: number, margins: PiContextMargins): { thresholds: ResolvedThresholds; warnings: string[] } {
	const warnings: string[] = [];
	const reminderKey = `${PI_CONTEXT_SETTINGS_KEY}.reminderMarginTokens`;
	const fallbackKey = `${PI_CONTEXT_SETTINGS_KEY}.fallbackMarginTokens`;
	const parsedReminder = validMargin(margins.reminderMarginTokens);
	const parsedFallback = validMargin(margins.fallbackMarginTokens);

	let reminderMargin: number;
	if (margins.reminderMarginTokens === undefined) reminderMargin = DEFAULT_REMINDER_MARGIN_TOKENS;
	else if (parsedReminder === undefined) {
		warnings.push(`pi-context: ${reminderKey} must be a positive integer; using default ${DEFAULT_REMINDER_MARGIN_TOKENS}.`);
		reminderMargin = DEFAULT_REMINDER_MARGIN_TOKENS;
	} else reminderMargin = parsedReminder;

	let fallbackMargin: number;
	if (margins.fallbackMarginTokens === undefined) fallbackMargin = DEFAULT_FALLBACK_MARGIN_TOKENS;
	else if (parsedFallback === undefined) {
		warnings.push(`pi-context: ${fallbackKey} must be a positive integer; using default ${DEFAULT_FALLBACK_MARGIN_TOKENS}.`);
		fallbackMargin = DEFAULT_FALLBACK_MARGIN_TOKENS;
	} else fallbackMargin = parsedFallback;

	if (reminderMargin <= fallbackMargin) {
		warnings.push(`pi-context: ${reminderKey} must exceed ${fallbackKey}; using default ${DEFAULT_REMINDER_MARGIN_TOKENS}.`);
		reminderMargin = DEFAULT_REMINDER_MARGIN_TOKENS;
		if (reminderMargin <= fallbackMargin) {
			warnings.push(`pi-context: ${fallbackKey} must be below ${reminderKey}; using default ${DEFAULT_FALLBACK_MARGIN_TOKENS}.`);
			fallbackMargin = DEFAULT_FALLBACK_MARGIN_TOKENS;
		}
	}

	return { thresholds: { reminder: reserveTokens + reminderMargin, fallback: reserveTokens + fallbackMargin }, warnings };
}

export default function piContext(pi: ExtensionAPI) {
	let rollover: "idle" | "requested" | "compacting" = "idle";
	let enabled = true;
	let guidancePersistedInWindow: string | undefined;
	let fallbackPersistedInWindow: string | undefined;
	let handledCompactionId: string | undefined;
	let thresholds: ResolvedThresholds | undefined;

	/**
	 * Resolve the thresholds for this session from Pi's compaction reserve plus the
	 * settings.json "pi-context" margins. The file-backed read is cached until the next
	 * session_start; invalid configuration degrades per offending key with one warning
	 * and never throws during session operation.
	 */
	const resolveThresholds = (ctx: ExtensionContext): ResolvedThresholds => {
		if (thresholds) return thresholds;
		try {
			const settingsManager = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
			const derived = deriveThresholds(
				settingsManager.getCompactionSettings().reserveTokens,
				mergePiContextSettings(settingsManager.getGlobalSettings(), settingsManager.getProjectSettings()),
			);
			for (const warning of derived.warnings) ctx.ui.notify(warning, "warning");
			thresholds = derived.thresholds;
		} catch (error) {
			ctx.ui.notify(`pi-context: could not read settings; using defaults (${String(error)}).`, "warning");
			thresholds = {
				reminder: DEFAULT_RESERVE_TOKENS + DEFAULT_REMINDER_MARGIN_TOKENS,
				fallback: DEFAULT_RESERVE_TOKENS + DEFAULT_FALLBACK_MARGIN_TOKENS,
			};
		}
		return thresholds;
	};

	pi.on("session_start", (_event, ctx) => {
		// Re-read settings.json on every session start; the resolved values are cached for the session.
		thresholds = undefined;
		resolveThresholds(ctx);
		if (!enabled) return;
		// The root window has no compaction entry to carry the boot block, so persist
		// it once as a visible custom message. Reset windows already carry theirs at
		// position 0 in the compaction summary, so a resumed session adds nothing.
		const sessionId = ctx.sessionManager.getSessionId();
		const rootId = `pcw:${sessionId}:root`;
		if (currentWindowId(ctx) !== rootId) return;
		pi.sendMessage({ customType: BOOT_TYPE, content: bootBlock(ctx, rootId, undefined, false), display: true }, { triggerTurn: false });
	});
	const saveNote = (op: NoteOperation) => {
		// pi.appendEntry writes a custom SessionManager entry. Custom entries are persistent but excluded from LLM context.
		// ExtensionContext deliberately exposes only a readonly SessionManager, so this is the public extension write path.
		pi.appendEntry(NOTE_TYPE, op);
	};

	pi.registerCommand("pi-context", {
		description: "Toggle pi-context: context_window boot block, low-budget guidance, and reset-style compaction",
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
		description: "List durable Pi session-history windows.",
		parameters: Type.Object({ limit: positiveInteger(), recent_first: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
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
		parameters: Type.Object({ limit: positiveInteger(), recent_first: Type.Optional(Type.Boolean()), tool_namespace: nullableString(), role: Type.Optional(role), tool_name: nullableString(), window_id: nullableString(), max_chars_per_item: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const items = filteredItems(ctx, params);
			return output({ items: items.slice(0, params.limit ?? items.length).map((item) => visibleItem(item, params.max_chars_per_item ?? 1200)) });
		},
	}));

	pi.registerTool(defineTool({
		name: "history_read_item",
		label: "History read item",
		description: "Read a bounded character range from one durable session item.",
		parameters: Type.Object({ item_id: Type.String(), offset_chars: Type.Optional(Type.Integer({ minimum: 0 })), limit_chars: positiveInteger(), window_id: Type.String() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
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
		parameters: Type.Object({ limit: positiveInteger(), query: Type.String(), recent_first: Type.Optional(Type.Boolean()), tool_namespace: nullableString(), role: Type.Optional(role), tool_name: nullableString(), window_id: nullableString() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const items = filteredItems(ctx, params);
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

	const fallbackGuidance = () => `${GUIDANCE_OPEN_TAG}\n${FALLBACK_PROMPT}\n${GUIDANCE_CLOSE_TAG}`;

	pi.on("context", (_event, ctx) => {
		if (!enabled) return undefined;
		// This hook does exactly one thing: persist the once-per-window low-budget
		// reminder the first time remaining context crosses the reminder threshold.
		// It never injects messages into the request.
		const usage = ctx.getContextUsage();
		if (usage && usage.tokens !== null) {
			const remaining = Math.max(0, usage.contextWindow - usage.tokens);
			const windowId = currentWindowId(ctx);
			if (remaining <= resolveThresholds(ctx).reminder && guidancePersistedInWindow !== windowId) {
				guidancePersistedInWindow = windowId;
				// Persist once per window — no transient copy. A transient bridge would
				// cover the crossing request, but history would record the reminder after
				// that request's assistant reply, so across the boundary the model would
				// meet the same text twice at shifted positions. The reminder is an early
				// warning, not a per-request instruction: arriving from the next request
				// on (sendMessage defers safely to end of turn while streaming, queueing
				// instead of splitting a tool call/result pair) costs nothing, and the
				// model's view stays identical to recorded history, Codex-style.
				pi.sendMessage({ customType: GUIDANCE_TYPE, content: tokenBudgetGuidance(remaining), display: true }, { triggerTurn: false });
			}
		}
		return undefined;
	});

	// Graceful fallback without intercepting user input: before a fresh prompt, if
	// remaining context has entered the buffer between this threshold and Pi's
	// reserve line, append a persistent user-level final-call instruction. Pi then
	// runs that turn with the user's queued prompt still present and runs its own
	// automatic compaction before the following prompt. Overflow is excluded: Pi
	// already owns its one-shot compact-and-retry recovery.
	pi.on("before_agent_start", (event, ctx) => {
		if (!enabled) return undefined;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return undefined;
		const remaining = Math.max(0, usage.contextWindow - usage.tokens);
		if (remaining > resolveThresholds(ctx).fallback) return undefined;
		const windowId = currentWindowId(ctx);
		if (fallbackPersistedInWindow === windowId) return undefined;
		fallbackPersistedInWindow = windowId;
		return { message: { customType: FALLBACK_TYPE, content: FALLBACK_PROMPT, display: true } };
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!enabled) return undefined;
		// Streaming case only: while the agent is streaming, triggerTurn:true routes
		// to agent.steer() — Pi drains the steering queue after this turn_end and
		// injects the message before the next LLM call, extending the current run by
		// one note-taking turn. A queued user prompt (follow-up) drains only when the
		// agent would stop, so it is processed after the notes turn. (Defensive: in
		// v0.85.1 turn_end always fires inside an active run, so isIdle is never
		// true here; the idle pre-prompt case is owned by before_agent_start above.)
		if (ctx.isIdle()) return undefined;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;
		const remaining = Math.max(0, usage.contextWindow - usage.tokens);
		if (remaining > resolveThresholds(ctx).fallback) return;
		const windowId = currentWindowId(ctx);
		if (fallbackPersistedInWindow === windowId) return;
		if (rollover !== "idle") return;
		fallbackPersistedInWindow = windowId;
		// The steered message reaches the model before the pending user input and no
		// input text/images are copied or replayed.
		pi.sendMessage({ customType: FALLBACK_TYPE, content: fallbackGuidance(), display: true }, { triggerTurn: true });
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
		// Every compaction uses the same reset path. Never cancel to borrow a
		// note-taking turn: Pi owns user input, queued work, and overflow recovery.
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			// Pi mints the compaction entry id only after this hook returns, so the
			// extension mints and owns the window id now, avoiding collisions with any
			// existing entry id, and bakes it into the summary and details.
			let minted = randomUUID().slice(0, 8);
			while (ctx.sessionManager.getEntry(minted)) minted = randomUUID().slice(0, 8);
			const windowId = `pcw:${sessionId}:${minted}`;
			const windows = historyFromSession(ctx);
			const previousId = windows[windows.length - 1]?.windowId ?? `pcw:${sessionId}:root`;
			// The reset marker stays as firstKeptEntryId; it no longer names the window.
			pi.appendEntry(RESET_MARKER_TYPE, { version: 1, reason: event.reason, requested: rollover === "compacting" });
			const markerId = ctx.sessionManager.getLeafId();
			if (!markerId) return { cancel: true };
			return {
				compaction: {
					summary: bootBlock(ctx, windowId, previousId, true),
					firstKeptEntryId: markerId,
					tokensBefore: event.preparation.tokensBefore,
					details: { piContext: RESET_V2, windowId },
				},
			};
		} catch {
			return { cancel: true };
		}
	});

	pi.on("session_compact", (event, ctx) => {
		if (!enabled) {
			rollover = "idle";
			return;
		}
		const entry = ctx.sessionManager.getEntry(event.compactionEntry.id);
		if (entry?.type !== "compaction" || resetV2WindowId(entry.details) === undefined) return;
		if (handledCompactionId === entry.id) return;
		handledCompactionId = entry.id;
		// Only explicit new_context needs an extension-owned continuation.
		// Automatic resets/retries and user /compact keep Pi's native scheduling.
		const shouldContinue = rollover === "compacting" && !event.willRetry;
		rollover = "idle";
		pi.appendEntry(STATE_TYPE, { version: 1, lastResetEntryId: entry.id });
		if (shouldContinue) {
			pi.sendMessage({ customType: CONTINUATION_TYPE, content: CONTINUATION, display: false }, { triggerTurn: true });
		}
	});

	pi.on("session_compact_failed", () => {
		if (rollover === "compacting") rollover = "idle";
	});
}

export const internal = { MAX_NOTE_BYTES, NOTE_TYPE, BOOT_TYPE, GUIDANCE_TYPE, FALLBACK_TYPE, FALLBACK_PROMPT, RESET_MARKER_TYPE, RESET_SUMMARY, CONTINUATION, CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, CONTEXT_WINDOW_PROTOCOL_OPEN_TAG, CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG, GUIDANCE_OPEN_TAG, PI_CONTEXT_SETTINGS_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, DEFAULT_FALLBACK_MARGIN_TOKENS, deriveThresholds, mergePiContextSettings, lineRange, assertVirtualPath };
