import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type RegisteredCommand,
	AgentSession,
	SessionManager,
	SettingsManager,
	type SessionCompactEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import piContext, { historyFromSession, internal, notesFromSession } from "../src/index.js";
import { middleTruncate, page, TOOL_OUTPUT_MAX_BYTES } from "../src/tool-output.js";
import { NOTE_TYPE, MAX_NOTE_PATH_BYTES } from "../src/protocol.js";

// Settings fixtures live in temp directories. PI_CODING_AGENT_DIR is redirected for the
// whole test process so the extension's SettingsManager.create(ctx.cwd, undefined, ...)
// never reads the user's real ~/.pi. beforeEach points it back at an empty fixture.
const DEFAULT_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-context-agent-"));
const DEFAULT_CWD = mkdtempSync(join(tmpdir(), "pi-context-cwd-"));
process.env.PI_CODING_AGENT_DIR = DEFAULT_AGENT_DIR;

type Notice = { message: string; type?: "info" | "warning" | "error" };

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

type SettingsFixture = { cwd: string; agentDir: string };

/**
 * Materialize global (agentDir/settings.json) and project (cwd/.pi/settings.json)
 * settings in temp directories, then read them back through the same public
 * SettingsManager.create the extension uses. Never touches the real ~/.pi.
 */
function settingsFixture(options: {
	global?: Record<string, unknown>;
	project?: Record<string, unknown>;
	reserveTokens?: number;
} = {}): SettingsFixture {
	const cwd = mkdtempSync(join(tmpdir(), "pi-context-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi-context-agent-"));
	const global = { ...(options.global ?? {}) };
	if (options.reserveTokens !== undefined) global.compaction = { reserveTokens: options.reserveTokens };
	writeJson(join(agentDir, "settings.json"), global);
	if (options.project) writeJson(join(cwd, ".pi", "settings.json"), options.project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// The fixture itself must parse through SettingsManager.create with these temp dirs.
	const fixtureManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const projectReserve = (options.project?.compaction as { reserveTokens?: number } | undefined)?.reserveTokens;
	assert.equal(fixtureManager.getCompactionSettings().reserveTokens, projectReserve ?? options.reserveTokens ?? 16_384, "fixture reserve reads back");
	return { cwd, agentDir };
}

test.beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = DEFAULT_AGENT_DIR;
});

type EventHandler = (event: never, ctx: ExtensionContext) => unknown;

type SendMessageArg = Parameters<ExtensionAPI["sendMessage"]>[0];

type SentMessage = {
	message: SendMessageArg;
	options: { triggerTurn?: boolean } | undefined;
};

export type Captured = {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, EventHandler[]>;
	commands: Map<string, CommandOptions>;
	sent: SentMessage[];
	flags: string[];
};

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

type CompactionHookResult =
	| { cancel: true }
	| { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown } }
	| undefined;

/** TypeBox's TSchema does not expose `type`/`required` statically; read them structurally. */
function objectSchema(tool: ToolDefinition | undefined): { type?: string; required?: string[] } | undefined {
	return tool?.parameters as { type?: string; required?: string[] } | undefined;
}

export function manager(persisted = false): SessionManager {
	if (!persisted) return SessionManager.inMemory("/private/tmp/pi-context-test");
	const dir = mkdtempSync(join(tmpdir(), "pi-context-session-"));
	return SessionManager.create("/private/tmp/pi-context-test", dir);
}

export function makeExtension(sessionManager: SessionManager): Captured {
	const captured: Captured = { tools: new Map(), handlers: new Map(), commands: new Map(), sent: [], flags: [] };
	const api = {
		registerFlag(name: string) {
			captured.flags.push(name);
		},
		registerTool(tool: ToolDefinition) {
			captured.tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: CommandOptions) {
			captured.commands.set(name, options);
		},
		on(name: string, handler: EventHandler) {
			const handlers = captured.handlers.get(name) ?? [];
			handlers.push(handler);
			captured.handlers.set(name, handlers);
		},
		appendEntry(customType: string, data?: unknown) {
			sessionManager.appendCustomEntry(customType, data);
		},
		sendMessage(message: SendMessageArg, options?: { triggerTurn?: boolean }) {
			captured.sent.push({ message, options });
			sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
	};
	// The harness implements only the ExtensionAPI members this extension uses.
	piContext(api as unknown as ExtensionAPI);
	return captured;
}

export function context(
	sessionManager: SessionManager,
	compact?: ExtensionContext["compact"],
	usage?: ContextUsage,
	idle = true,
	cwd = DEFAULT_CWD,
	projectTrusted = true,
): ExtensionContext {
	const notices: Notice[] = [];
	const compactionRequests: Array<Parameters<ExtensionContext["compact"]>[0]> = [];
	const fake: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "compact" | "isIdle" | "hasPendingMessages" | "cwd" | "isProjectTrusted" | "ui"> = {
		sessionManager,
		getContextUsage: () => usage,
		compact: (options) => { compactionRequests.push(options); compact?.(options); },
		isIdle: () => idle,
		hasPendingMessages: () => false,
		cwd,
		isProjectTrusted: () => projectTrusted,
		ui: { notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }) } as unknown as ExtensionContext["ui"],
	};
	// Only the members the extension reads; the rest of the ExtensionContext surface is unused.
	return Object.assign(fake as unknown as ExtensionContext, { notices, compactionRequests });
}

function noticesOf(ctx: ExtensionContext): Notice[] {
	return (ctx as ExtensionContext & { notices: Notice[] }).notices;
}

export async function call(
	captured: Captured,
	name: string,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const tool = captured.tools.get(name);
	assert.ok(tool, `registered ${name}`);
	return tool.execute("call-1", params, new AbortController().signal, () => {}, ctx) as Promise<AgentToolResult<unknown>>;
}

export function resultJson<T>(result: AgentToolResult<unknown>): T {
	const text = result.content[0];
	assert.ok(text && text.type === "text", "tool result carries text");
	return JSON.parse(text.text) as T;
}

/**
 * Assert a value is a local-time ISO 8601 string with an explicit numeric offset (never "Z")
 * and that Date.parse restores the stored epoch milliseconds. No time zone is assumed.
 */
function assertLocalIso(value: unknown, epochMs: number, message: string): void {
	assert.equal(typeof value, "string", message);
	assert.match(value as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/, message);
	assert.equal(Date.parse(value as string), epochMs, `${message}: Date.parse restores the stored epoch ms`);
}

/** Assert the text contains a well-formed local ISO timestamp and return it, without pinning surrounding wording. */
function assertIsoTimestamp(text: string, message: string): string {
	const match = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/);
	assert.ok(match, message);
	assert.equal(Number.isNaN(Date.parse(match[0])), false, `${message}: timestamp parses`);
	return match[0];
}

/** Assert `actual` is a middle-truncation of `original`: same head, same tail, strictly fewer characters. */
function assertTruncationOf(original: string, actual: string): void {
	const match = actual.match(/^([\s\S]*)…\[truncated \d+ chars\]…([\s\S]*)$/);
	assert.ok(match, "truncated value carries the middle-truncation marker");
	const head = match[1] as string;
	const tail = match[2] as string;
	assert.ok(original.startsWith(head), "truncation keeps the original head");
	assert.ok(original.endsWith(tail), "truncation keeps the original tail");
	assert.ok(head.length + tail.length < original.length, "truncation actually removes characters");
}

async function runBeforeCompact(
	captured: Captured,
	ctx: ExtensionContext,
	tokensBefore: number,
	reason: "manual" | "threshold" | "overflow" = "manual",
): Promise<CompactionHookResult> {
	const handler = captured.handlers.get("session_before_compact")?.[0];
	assert.ok(handler, "session_before_compact handler registered");
	const event = { reason, willRetry: reason === "overflow", signal: new AbortController().signal, preparation: { tokensBefore } };
	return (await handler(event as never, ctx)) as CompactionHookResult;
}

function runHandlers(captured: Captured, name: string, event: unknown, ctx: ExtensionContext): void {
	const isIdle = ctx.isIdle;
	if (name === "agent_settled") ctx.isIdle = () => true;
	try {
		for (const handler of captured.handlers.get(name) ?? []) handler(event as never, ctx);
	} finally { ctx.isIdle = isIdle; }
}

function completeRequestedCompaction(ctx: ExtensionContext): void {
	const requests = (ctx as ExtensionContext & { compactionRequests: Array<Parameters<ExtensionContext["compact"]>[0]> }).compactionRequests;
	const options = requests.shift();
	assert.ok(options?.onComplete, "a reset request has a completion callback");
	const isIdle = ctx.isIdle;
	ctx.isIdle = () => true;
	try { options.onComplete({} as Parameters<NonNullable<typeof options.onComplete>>[0]); }
	finally { ctx.isIdle = isIdle; }
}

async function runCommand(captured: Captured, name: string, args: string, ctx: ExtensionContext): Promise<Notice[]> {
	const command = captured.commands.get(name);
	assert.ok(command, `${name} command registered`);
	const notices: Notice[] = [];
	const cmdCtx = Object.assign({}, ctx, {
		ui: { notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }) },
	}) as unknown as ExtensionCommandContext;
	await command.handler(args, cmdCtx);
	return notices;
}

type ContextHookResult = { messages: unknown[] } | undefined;

async function runContextHook(captured: Captured, ctx: ExtensionContext, eventOverride: Record<string, unknown> = {}): Promise<ContextHookResult> {
	const handler = captured.handlers.get("context")?.[0];
	assert.ok(handler, "context handler registered");
	return (await handler({ type: "context", messages: [], ...eventOverride } as never, ctx)) as ContextHookResult;
}

export function appendText(sessionManager: SessionManager, role: "user" | "assistant" | "toolResult", text: string, toolName = "bash"): string {
	const base = {
		role,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
		...(role === "assistant" ? { stopReason: "stop" } : {}),
		...(role === "toolResult" ? { toolCallId: "call-1", toolName, isError: false } : {}),
	};
	// Assistant/toolResult messages carry provider metadata (usage, stopReason, ids)
	// that SessionManager persists opaquely and the extension never reads, so the
	// harness stores the minimal shape.
	type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];
	return sessionManager.appendMessage(base as unknown as AppendableMessage);
}

test("schemas cover the nine History/Notes actions plus reset controls", () => {
	const captured = makeExtension(manager());
	for (const name of [
		"history_list_windows", "history_list_items", "history_read_item", "history_search_contents",
		"notes_list_files", "notes_read_file", "notes_search_contents", "notes_append_to_file", "notes_write_file",
		"new_context", "get_context_remaining",
	]) {
		const tool = captured.tools.get(name);
		assert.equal(objectSchema(tool)?.type, "object", name);
	}
	assert.equal(objectSchema(captured.tools.get("history_read_item"))?.required?.includes("item_id"), true);
	// text is optional so mark_stale-only calls reach the handler; each write/append tool accepts the stale flag.
	for (const name of ["notes_write_file", "notes_append_to_file"]) {
		const schema = captured.tools.get(name)?.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined;
		assert.ok(schema?.properties?.text, `${name} exposes text`);
		assert.ok(schema?.properties?.mark_stale, `${name} exposes mark_stale`);
		assert.equal(schema?.required?.includes("text"), false, `${name} makes text optional for mark-only calls`);
	}
	// The history ordering switch is documented as newest-first by default.
	for (const name of ["history_list_windows", "history_list_items", "history_search_contents"]) {
		const schema = captured.tools.get(name)?.parameters as { properties?: Record<string, { description?: string }> } | undefined;
		assert.equal(schema?.properties?.recent_first?.description?.includes("Defaults to true."), true, `${name} documents the recent_first default`);
	}
});

test("persisted note operations restore, are Unicode byte-limited, and use safe virtual paths", async () => {
	const original = manager(true);
	const captured = makeExtension(original);
	const ctx = context(original);
	await call(captured, "notes_write_file", { path: "checkpoint/进度.txt", text: "第一行\nneedle Café" }, ctx);
	await call(captured, "notes_append_to_file", { path: "checkpoint/进度.txt", text: "\n最后一行" }, ctx);
	assert.equal(notesFromSession(ctx).get("checkpoint/进度.txt")?.text, "第一行\nneedle Café\n最后一行");
	// SessionManager intentionally delays writing a brand-new session until its first assistant entry.
	appendText(original, "assistant", "persist the append-only session");

	const file = original.getSessionFile();
	assert.ok(file);
	const restored = SessionManager.create("/private/tmp/pi-context-test", mkdtempSync(join(tmpdir(), "pi-context-restore-")));
	restored.setSessionFile(file);
	const restoredCtx = context(restored);
	assert.equal(notesFromSession(restoredCtx).get("checkpoint/进度.txt")?.text, "第一行\nneedle Café\n最后一行");
	const noteMeta = notesFromSession(ctx).get("checkpoint/进度.txt");
	assert.ok(noteMeta);
	const read = resultJson<{ path: string; start_line: number; stop_line: number; content: string; created_at: unknown; updated_at: unknown }>(
		await call(captured, "notes_read_file", { path: "checkpoint/进度.txt", start_line: -1, stop_line: -1 }, ctx),
	);
	assert.equal(read.path, "checkpoint/进度.txt");
	assert.equal(read.start_line, 3);
	assert.equal(read.stop_line, 3);
	assert.equal(read.content, "最后一行");
	assertLocalIso(read.created_at, noteMeta.createdAt, "notes_read_file created_at");
	assertLocalIso(read.updated_at, noteMeta.updatedAt, "notes_read_file updated_at");
	const searched = resultJson<{ files: Array<{ path: string; matches: Array<{ line: number }>; created_at: unknown; updated_at: unknown }> }>(
		await call(captured, "notes_search_contents", { query: "Café" }, ctx),
	);
	assert.equal(searched.files[0]?.matches[0]?.line, 2);
	// Every notes tool reports the persisted note metadata with the same local-time formatting.
	assertLocalIso(searched.files[0]?.created_at, noteMeta.createdAt, "notes_search_contents created_at");
	assertLocalIso(searched.files[0]?.updated_at, noteMeta.updatedAt, "notes_search_contents updated_at");
	const listedFiles = resultJson<{ files: Array<{ path: string; created_at: unknown; updated_at: unknown }> }>(
		await call(captured, "notes_list_files", { pattern: "checkpoint/**" }, ctx),
	);
	assert.equal(listedFiles.files.length, 1, "glob ** crosses into the checkpoint directory");
	assert.equal(listedFiles.files[0]?.path, "checkpoint/进度.txt");
	assertLocalIso(listedFiles.files[0]?.created_at, noteMeta.createdAt, "notes_list_files created_at");
	assertLocalIso(listedFiles.files[0]?.updated_at, noteMeta.updatedAt, "notes_list_files updated_at");
	// A single-segment * never crosses `/`, so a nested-only store matches nothing at the root.
	const rootOnly = resultJson<{ files: Array<{ path: string }> }>(
		await call(captured, "notes_list_files", { pattern: "*" }, ctx),
	);
	assert.equal(rootOnly.files.length, 0, "glob * stays within one segment");
	assert.equal(searched.files[0]?.created_at, listedFiles.files[0]?.created_at, "note tools agree on the timestamp format");
	assert.equal(searched.files[0]?.updated_at, listedFiles.files[0]?.updated_at);
	await assert.rejects(() => call(captured, "notes_write_file", { path: "../escape", text: "x" }, ctx), /unsupported component/);
	const tooLarge = resultJson<{ error: string }>(
		await call(captured, "notes_write_file", { path: "large", text: "é".repeat(500_001) }, ctx),
	);
	assert.match(tooLarge.error, /1000000/);
});

test("stale lifecycle: mark-only, closure, revive, and validation errors", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm);

	await call(captured, "notes_write_file", { path: "journal.md", text: "log line" }, ctx);
	assert.equal(notesFromSession(ctx).get("journal.md")?.stale, false, "a fresh write starts not stale");

	// mark-only: content unchanged, flag set
	const markOnly = resultJson<{ stale: boolean }>(await call(captured, "notes_write_file", { path: "journal.md", mark_stale: true }, ctx));
	assert.equal(markOnly.stale, true);
	assert.equal(notesFromSession(ctx).get("journal.md")?.stale, true);
	assert.equal(notesFromSession(ctx).get("journal.md")?.text, "log line", "mark-only leaves content unchanged");

	// explicit revive without content
	await call(captured, "notes_write_file", { path: "journal.md", mark_stale: false }, ctx);
	assert.equal(notesFromSession(ctx).get("journal.md")?.stale, false, "mark_stale:false revives");
	assert.equal(notesFromSession(ctx).get("journal.md")?.text, "log line", "explicit revive leaves content unchanged");

	// write+mark closure: replace content and flag stale in one call
	await call(captured, "notes_write_file", { path: "journal.md", text: "final", mark_stale: true }, ctx);
	assert.equal(notesFromSession(ctx).get("journal.md")?.text, "final");
	assert.equal(notesFromSession(ctx).get("journal.md")?.stale, true);

	// revive on plain write
	await call(captured, "notes_write_file", { path: "journal.md", text: "reopened" }, ctx);
	assert.equal(notesFromSession(ctx).get("journal.md")?.stale, false, "writing without mark_stale revives");

	// append+mark closure, then append mark-only
	await call(captured, "notes_append_to_file", { path: "journal.md", text: "\nclosed", mark_stale: true }, ctx);
	const closed = notesFromSession(ctx).get("journal.md");
	assert.equal(closed?.text, "reopened\nclosed");
	assert.equal(closed?.stale, true);
	await call(captured, "notes_append_to_file", { path: "journal.md", mark_stale: false }, ctx);
	assert.equal(notesFromSession(ctx).get("journal.md")?.stale, false, "append mark_stale:false revives");

	// neither text nor mark_stale is an error on both tools
	for (const name of ["notes_write_file", "notes_append_to_file"]) {
		const neither = resultJson<{ error?: string }>(await call(captured, name, { path: "journal.md" }, ctx));
		assert.equal(typeof neither.error, "string", `${name} rejects a call with neither text nor mark_stale`);
		// marking a nonexistent path is an error and persists nothing
		const missing = resultJson<{ error?: string }>(await call(captured, name, { path: "missing.md", mark_stale: true }, ctx));
		assert.equal(typeof missing.error, "string", `${name} rejects marking a nonexistent path`);
	}
	assert.equal(notesFromSession(ctx).has("missing.md"), false, "failed marks leave no phantom note");
});

test("the boot notes index excludes stale notes while list, read, and search still see them", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm);

	await call(captured, "notes_write_file", { path: "fresh.md", text: "fresh content" }, ctx);
	await call(captured, "notes_write_file", { path: "old.md", text: "stale content" }, ctx);
	await call(captured, "notes_write_file", { path: "old.md", mark_stale: true }, ctx);

	runHandlers(captured, "session_start", {}, ctx);
	const boot = captured.sent[0];
	const text = typeof boot?.message.content === "string" ? boot.message.content : "";
	assert.ok(text.includes("fresh.md"), "the fresh note is indexed");
	assert.equal(text.includes("old.md"), false, "the stale note leaves the boot index");
	assert.equal(text.includes("stale content"), false, "the stale preview is not rendered");

	const listed = resultJson<{ files: Array<{ path: string; stale: boolean }> }>(await call(captured, "notes_list_files", {}, ctx));
	assert.equal(listed.files.find((file) => file.path === "old.md")?.stale, true, "list carries the stale flag");
	assert.equal(listed.files.find((file) => file.path === "fresh.md")?.stale, false);

	// stale notes are still readable and searchable, unannotated
	const read = resultJson<{ content: string }>(await call(captured, "notes_read_file", { path: "old.md" }, ctx));
	assert.equal(read.content, "stale content");
	const searched = resultJson<{ files: Array<{ path: string }> }>(await call(captured, "notes_search_contents", { query: "stale content" }, ctx));
	assert.equal(searched.files[0]?.path, "old.md");
});

test("the boot notes index omits itself when every note is stale", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm);

	await call(captured, "notes_write_file", { path: "done.md", text: "finished", mark_stale: true }, ctx);
	runHandlers(captured, "session_start", {}, ctx);
	const text = typeof captured.sent[0]?.message.content === "string" ? captured.sent[0].message.content : "";
	assert.equal(text.includes("done.md"), false, "no stale note is indexed");
	assert.equal(text.includes("finished"), false, "no stale preview is rendered");
	assert.ok(text.includes(internal.CONTEXT_WINDOW_PROTOCOL_OPEN_TAG), "the rest of the boot block still renders");
});

test("JSONL reload preserves the stale flag", async () => {
	const sm = manager(true);
	const captured = makeExtension(sm);
	const ctx = context(sm);

	await call(captured, "notes_write_file", { path: "archived.md", text: "keep" }, ctx);
	await call(captured, "notes_write_file", { path: "archived.md", mark_stale: true }, ctx);
	// SessionManager intentionally delays writing a brand-new session until its first assistant entry.
	appendText(sm, "assistant", "persist the append-only session");
	const file = sm.getSessionFile();
	assert.ok(file);
	const restored = manager();
	restored.setSessionFile(file);
	const files = notesFromSession(context(restored));
	assert.equal(files.get("archived.md")?.stale, true, "the stale flag survives JSONL reload");
	assert.equal(files.get("archived.md")?.text, "keep");
});

test("paged tool outputs stay bounded and cursors reconstruct history and notes", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const historyText = "历史内容-" + "x".repeat(50_000);
	const historyIds = [appendText(session, "user", historyText), appendText(session, "user", historyText), appendText(session, "user", historyText)];
	for (let index = 0; index < 10; index++) appendText(session, "user", historyText);
	const historyPages: Array<{ item_id: string; truncated_content: string }> = [];
	let cursor = 0;
	let next: number | null = 0;
	while (next !== null) {
		const result = resultJson<{ items: Array<{ item_id: string; truncated_content: string }>; next_cursor: number | null }>(await call(captured, "history_list_items", { recent_first: false, max_chars_per_item: 1200, cursor }, ctx));
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
		historyPages.push(...result.items); next = result.next_cursor; if (next !== null) cursor = next;
	}
	assert.deepEqual(historyPages.filter((item) => historyIds.includes(item.item_id)).map((item) => item.item_id), historyIds);
	const search = resultJson<{ items: Array<unknown>; next_cursor: number | null }>(await call(captured, "history_search_contents", { query: "历史内容", recent_first: false, max_chars_per_item: 50_000 }, ctx));
	assert.ok(Buffer.byteLength(JSON.stringify(search), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
	assert.notEqual(search.next_cursor, null);
	const searchPages: Array<{ item_id: string }> = [];
	let searchOffset = 0;
	let searchNext: number | null = 0;
	while (searchNext !== null) {
		const result = resultJson<{ items: Array<{ item_id: string }>; next_cursor: number | null }>(await call(captured, "history_search_contents", { query: "历史内容", recent_first: false, max_chars_per_item: 1200, cursor: searchOffset }, ctx));
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
		searchPages.push(...result.items); searchNext = result.next_cursor; if (searchNext !== null) searchOffset = searchNext;
	}
	assert.equal(searchPages.length, 13);
	assert.equal(searchNext, null);
	const readParts: string[] = [];
	let readOffset = 0;
	let readNext: number | null = 0;
	while (readNext !== null) {
		const result = resultJson<{ content: string; total_chars: number; next_offset_chars: number | null }>(await call(captured, "history_read_item", { window_id: historyFromSession(ctx)[0]!.windowId, item_id: historyIds[0], offset_chars: readOffset, limit_chars: 12000 }, ctx));
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
		readParts.push(result.content); readNext = result.next_offset_chars; if (readNext !== null) readOffset = readNext;
	}
	assert.equal(readParts.join(""), historyText);

	for (let index = 0; index < 100; index++) session.appendCustomEntry(NOTE_TYPE, { op: "write", path: `page-${"x".repeat(300)}-${index}.md`, text: Array.from({ length: 1000 }, (_, line) => `needle ${line} ${"z".repeat(30)}`).join("\n"), createdAt: Date.now(), updatedAt: Date.now() });
	const listPages: string[] = [];
	let listOffset = 0;
	let listNext: number | null = 0;
	while (listNext !== null) {
		const result = resultJson<{ files: Array<{ path: string }>; next_cursor: number | null }>(await call(captured, "notes_list_files", { pattern: null, max_results: 300, cursor: listOffset }, ctx));
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
		listPages.push(...result.files.map((file) => file.path)); listNext = result.next_cursor; if (listNext !== null) listOffset = listNext;
	}
	assert.deepEqual(listPages, Array.from({ length: 100 }, (_, index) => `page-${"x".repeat(300)}-${index}.md`).sort((a, b) => a.localeCompare(b)));
	assert.equal(listNext, null);
	const searchFiles: Array<{ path: string; matches: Array<{ line: number; text: string }> }> = [];
	let notesSearchOffset = 0;
	let notesSearchNext: number | null = 0;
	while (notesSearchNext !== null) {
		const result = resultJson<{ files: Array<{ path: string; matches: Array<{ line: number; text: string }> }>; next_cursor: number | null }>(await call(captured, "notes_search_contents", { query: "needle", max_matches_per_file: 100, max_files: 300, cursor: notesSearchOffset }, ctx));
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
		searchFiles.push(...result.files); notesSearchNext = result.next_cursor; if (notesSearchNext !== null) notesSearchOffset = notesSearchNext;
	}
	assert.equal(searchFiles.length, 100); assert.equal(notesSearchNext, null);
	const noteParts: string[] = [];
	let noteStart: number | null = 1;
	let noteChar = 0;
	while (noteStart !== null) {
		const result: { content: string; total_lines: number; next_start_line: number | null; next_start_char: number } = resultJson<{ content: string; total_lines: number; next_start_line: number | null; next_start_char: number }>(await call(captured, "notes_read_file", { path: `page-${"x".repeat(300)}-0.md`, start_line: noteStart, start_char: noteChar }, ctx));
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
		// A page at offset 0 starts a new line, so the pages join with a newline there and only there.
		if (noteParts.length > 0 && noteChar === 0) noteParts.push("\n");
		noteParts.push(result.content); noteStart = result.next_start_line; noteChar = result.next_start_char;
	}
	assert.equal(noteParts.join(""), Array.from({ length: 1000 }, (_, line) => `needle ${line} ${"z".repeat(30)}`).join("\n"));
	assert.equal(noteStart, null);
});

test("a page cap limits the page, not the enumerable set: cursors stay truthful past the cap", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	for (let index = 0; index < 60; index++) {
		appendText(session, "user", `entry-${index}`);
		appendText(session, "assistant", `reply-${index}`);
	}

	// history_list_items: 120 items with limit 50 page as 50/50/20, null only at the true end.
	const windows = resultJson<{ windows: Array<{ item_count: number }> }>(await call(captured, "history_list_windows", {}, ctx));
	assert.equal(windows.windows[0]?.item_count, 120);
	const list = async (params: Record<string, unknown>) => resultJson<{ items: unknown[]; next_cursor: number | null }>(await call(captured, "history_list_items", params, ctx));
	const first = await list({ limit: 50, recent_first: false, max_chars_per_item: 100 });
	assert.equal(first.items.length, 50);
	assert.equal(first.next_cursor, 50, "limit caps the page, not the enumerable set");
	const second = await list({ limit: 50, cursor: 50, recent_first: false, max_chars_per_item: 100 });
	assert.equal(second.items.length, 50);
	assert.equal(second.next_cursor, 100);
	const third = await list({ limit: 50, cursor: 100, recent_first: false, max_chars_per_item: 100 });
	assert.equal(third.items.length, 20);
	assert.equal(third.next_cursor, null, "null only at the true end");

	// history_search_contents: the same contract holds over the matching set.
	const search = async (params: Record<string, unknown>) => resultJson<{ items: unknown[]; next_cursor: number | null }>(await call(captured, "history_search_contents", params, ctx));
	const searchFirst = await search({ query: "entry-", limit: 50, recent_first: false, max_chars_per_item: 100 });
	assert.equal(searchFirst.items.length, 50);
	assert.equal(searchFirst.next_cursor, 50);
	const searchTail = await search({ query: "entry-", limit: 50, cursor: 50, recent_first: false, max_chars_per_item: 100 });
	assert.equal(searchTail.items.length, 10);
	assert.equal(searchTail.next_cursor, null);

	// notes_search_contents: max_files caps the page, not the matched files.
	for (let index = 0; index < 7; index++) await call(captured, "notes_write_file", { path: `needle-${index}.md`, text: "needle" }, ctx);
	const notes = async (params: Record<string, unknown>) => resultJson<{ files: unknown[]; next_cursor: number | null }>(await call(captured, "notes_search_contents", params, ctx));
	const notesFirst = await notes({ query: "needle", max_files: 3 });
	assert.equal(notesFirst.files.length, 3);
	assert.equal(notesFirst.next_cursor, 3);
	const notesSecond = await notes({ query: "needle", max_files: 3, cursor: 3 });
	assert.equal(notesSecond.files.length, 3);
	assert.equal(notesSecond.next_cursor, 6);
	const notesTail = await notes({ query: "needle", max_files: 3, cursor: 6 });
	assert.equal(notesTail.files.length, 1);
	assert.equal(notesTail.next_cursor, null);
});

test("multi-query search: OR semantics, dedupe, and bare-string backward compatibility", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	// One item matches both queries, one only the first, one only the second, one neither.
	const bothId = appendText(session, "user", "alpha beta together");
	const alphaId = appendText(session, "user", "alpha only");
	const betaId = appendText(session, "assistant", "beta only");
	const noneId = appendText(session, "user", "gamma only");
	const historyIds = async (params: Record<string, unknown>) =>
		resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_search_contents", { recent_first: false, ...params }, ctx)).items.map((item) => item.item_id);
	const orIds = await historyIds({ query: ["alpha", "beta"] });
	assert.deepEqual(orIds, [bothId, alphaId, betaId], "history: an item matching any query is returned once");
	assert.equal(orIds.includes(noneId), false, "history: an item matching no query is not returned");
	assert.deepEqual(await historyIds({ query: ["alpha"] }), [bothId, alphaId], "history: a one-element array searches that literal");
	assert.deepEqual(await historyIds({ query: "alpha" }), orIds.filter((id) => id !== betaId), "history: a bare string still behaves exactly as before");
	assert.deepEqual(await historyIds({ query: "alpha" }), await historyIds({ query: ["alpha"] }), "history: bare string equals the single-element list");

	await call(captured, "notes_write_file", { path: "both.md", text: "alpha beta\nunrelated" }, ctx);
	await call(captured, "notes_write_file", { path: "alpha.md", text: "alpha only" }, ctx);
	await call(captured, "notes_write_file", { path: "beta.md", text: "beta only" }, ctx);
	await call(captured, "notes_write_file", { path: "gamma.md", text: "gamma only" }, ctx);
	const notesSearch = async (params: Record<string, unknown>) =>
		resultJson<{ files: Array<{ path: string; matches: Array<{ line: number; text: string }> }> }>(await call(captured, "notes_search_contents", params, ctx)).files;
	const orFiles = await notesSearch({ query: ["alpha", "beta"] });
	assert.deepEqual(orFiles.map((file) => file.path), ["both.md", "alpha.md", "beta.md"], "notes: a file matching any query is returned once");
	assert.equal(orFiles[0]?.matches.length, 1, "notes: one line containing both queries is reported once");
	assert.deepEqual((await notesSearch({ query: ["alpha"] })).map((file) => file.path), ["both.md", "alpha.md"], "notes: a one-element array searches that literal");
	assert.deepEqual((await notesSearch({ query: "alpha" })).map((file) => file.path), ["both.md", "alpha.md"], "notes: a bare string still behaves exactly as before");
	assert.deepEqual((await notesSearch({ query: "alpha" })).map((file) => file.path), (await notesSearch({ query: ["alpha"] })).map((file) => file.path), "notes: bare string equals the single-element list");
	assert.deepEqual((await notesSearch({ query: ["gamma"] })).map((file) => file.path), ["gamma.md"]);

	// An empty array is an argument error, not a silently empty result set.
	await assert.rejects(() => call(captured, "history_search_contents", { query: [] }, ctx), /non-empty array of strings/, "history: empty query array is refused");
	await assert.rejects(() => call(captured, "notes_search_contents", { query: [] }, ctx), /non-empty array of strings/, "notes: empty query array is refused");
	await assert.rejects(() => call(captured, "history_search_contents", { query: ["alpha", 7] }, ctx), /elements must be strings/, "history: non-string query element is refused");
	await assert.rejects(() => call(captured, "notes_search_contents", { query: ["alpha", 7] }, ctx), /elements must be strings/, "notes: non-string query element is refused");
});

test("multi-query search paginates over the OR set with no cross-page duplicates", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	for (let index = 0; index < 12; index++) {
		appendText(session, "user", index % 3 === 0 ? `alpha ${index}` : index % 3 === 1 ? `beta ${index}` : `gamma ${index}`);
	}
	const historyPage = async (cursor: number) =>
		resultJson<{ items: Array<{ item_id: string }>; next_cursor: number | null }>(
			await call(captured, "history_search_contents", { query: ["alpha", "beta"], recent_first: false, max_chars_per_item: 100, limit: 3, cursor }, ctx),
		);
	const historyIds: string[] = [];
	let historyNext: number | null = 0;
	let historyCursor = 0;
	let historyPages = 0;
	while (historyNext !== null) {
		const result = await historyPage(historyCursor);
		assert.ok(result.items.length > 0, "history: a page is never empty");
		historyIds.push(...result.items.map((item) => item.item_id));
		historyNext = result.next_cursor;
		if (historyNext !== null) historyCursor = historyNext;
		assert.ok(++historyPages < 20, "history: pagination terminates");
	}
	assert.equal(historyIds.length, 8, "history: every OR match is reached exactly once across pages");
	assert.equal(new Set(historyIds).size, historyIds.length, "history: no item repeats across pages");
	assert.equal(historyNext, null, "history: null only at the true end");
	assert.equal((await historyPage(0)).next_cursor, 3, "history: next_cursor echoes the next page start");
	const historyTail = await historyPage(6);
	assert.equal(historyTail.items.length, 2);
	assert.equal(historyTail.next_cursor, null, "history: the last page terminates the cursor");

	for (let index = 0; index < 12; index++) {
		const text = index % 3 === 0 ? `alpha ${index}` : index % 3 === 1 ? `beta ${index}` : `gamma ${index}`;
		await call(captured, "notes_write_file", { path: `f${index}.md`, text }, ctx);
	}
	const notesPage = async (cursor: number) =>
		resultJson<{ files: Array<{ path: string }>; next_cursor: number | null }>(
			await call(captured, "notes_search_contents", { query: ["alpha", "beta"], max_files: 3, cursor }, ctx),
		);
	const notePaths: string[] = [];
	let notesNext: number | null = 0;
	let notesCursor = 0;
	let notesPages = 0;
	while (notesNext !== null) {
		const result = await notesPage(notesCursor);
		assert.ok(result.files.length > 0, "notes: a page is never empty");
		notePaths.push(...result.files.map((file) => file.path));
		notesNext = result.next_cursor;
		if (notesNext !== null) notesCursor = notesNext;
		assert.ok(++notesPages < 20, "notes: pagination terminates");
	}
	assert.equal(notePaths.length, 8, "notes: every OR match is reached exactly once across pages");
	assert.equal(new Set(notePaths).size, notePaths.length, "notes: no file repeats across pages");
	assert.equal(notesNext, null, "notes: null only at the true end");
	assert.equal((await notesPage(0)).next_cursor, 3, "notes: next_cursor echoes the next page start");
	const notesLastPage = await notesPage(6);
	assert.equal(notesLastPage.files.length, 2);
	assert.equal(notesLastPage.next_cursor, null, "notes: the last page terminates the cursor");
});

test("history multi-query search composes with role, tool_name, and window filters", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const userId = appendText(session, "user", "alpha root message");
	const assistantId = appendText(session, "assistant", "beta assistant message");
	const toolId = appendText(session, "toolResult", "alpha beta bash output");
	const rootWindow = historyFromSession(ctx)[0]!.windowId;
	const leaf = session.getLeafId();
	assert.ok(leaf);
	session.appendCompaction("window summary without needles", leaf, 100, { piContext: "reset-v2", windowId: "pcw:test:second" }, true);
	const nextId = appendText(session, "user", "alpha next window");

	const searchIds = async (params: Record<string, unknown>) =>
		resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_search_contents", { query: ["alpha", "beta"], recent_first: false, ...params }, ctx)).items.map((item) => item.item_id);
	assert.deepEqual(await searchIds({ role: "user" }), [userId, nextId], "role filter composes with multi-query");
	assert.deepEqual(await searchIds({ role: "assistant" }), [assistantId], "role filter narrows the OR set");
	assert.deepEqual(await searchIds({ tool_name: "bash" }), [toolId], "tool_name filter composes with multi-query");
	assert.deepEqual(await searchIds({ tool_name: "read" }), [], "a non-matching tool_name yields nothing");
	assert.deepEqual(await searchIds({ window_id: rootWindow }), [userId, assistantId, toolId], "window filter restricts the OR set to that window");
	assert.deepEqual(await searchIds({ window_id: "pcw:test:second" }), [nextId], "the second window's matches are addressable");
});

test("an over-budget note line is delivered as a prefix and resumed by start_char", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const huge = `H${"x".repeat(TOOL_OUTPUT_MAX_BYTES * 2)}`;
	await call(captured, "notes_write_file", { path: "huge.md", text: `${huge}\ntail line` }, ctx);
	const first = resultJson<{ path: string; start_line: number; stop_line: number; content: string; total_lines: number; next_start_line: number | null; next_start_char: number }>(
		await call(captured, "notes_read_file", { path: "huge.md", start_line: 1 }, ctx),
	);
	assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= TOOL_OUTPUT_MAX_BYTES, "single oversized line stays within budget");
	assert.ok(first.content.length > 0, "the page is not empty");
	assert.equal(first.content.includes("…"), false, "the payload is a plain prefix with no marker");
	assert.ok(huge.startsWith(first.content), "the delivered text is a prefix of the line");
	assert.equal(first.total_lines, 2);
	assert.equal(first.stop_line, 1, "stop_line names the line the page was reading");
	assert.equal(first.next_start_line, 1, "the cursor continues the same line");
	assert.equal(first.next_start_char, Array.from(first.content).length, "next_start_char is the delivered code-point count");
	// Following the cursor reconstructs the huge line and then the tail line.
	const parts = [first.content];
	let line: number | null = first.next_start_line;
	let char = first.next_start_char;
	while (line !== null) {
		if (parts.length > 0 && char === 0) parts.push("\n");
		const page: { content: string; next_start_line: number | null; next_start_char: number } = resultJson<{ content: string; next_start_line: number | null; next_start_char: number }>(
			await call(captured, "notes_read_file", { path: "huge.md", start_line: line, start_char: char }, ctx),
		);
		parts.push(page.content);
		line = page.next_start_line;
		char = page.next_start_char;
	}
	assert.equal(parts.join(""), `${huge}\ntail line`, "the cursors reconstruct the file exactly");
});

test("an over-budget note search match is a named prefix, readable at its line", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	// A fitting file sorts before the oversized one, so the oversized match starts on a later page.
	const hugeLine = `needle ${"y".repeat(TOOL_OUTPUT_MAX_BYTES * 2)}`;
	await call(captured, "notes_write_file", { path: "a.md", text: "needle small" }, ctx);
	await call(captured, "notes_write_file", { path: "search.md", text: hugeLine }, ctx);
	const pages: Array<{ path: string; matches_total: number; matches: Array<{ line: number; text: string; truncated: boolean; total_chars: number }> }> = [];
	let cursor = 0;
	let next: number | null = 0;
	while (next !== null) {
		const found = resultJson<{ files: Array<{ path: string; matches_total: number; matches: Array<{ line: number; text: string; truncated: boolean; total_chars: number }> }>; next_cursor: number | null }>(
			await call(captured, "notes_search_contents", { query: "needle", cursor }, ctx),
		);
		assert.ok(Buffer.byteLength(JSON.stringify(found), "utf8") <= TOOL_OUTPUT_MAX_BYTES, "match result stays within budget");
		pages.push(...found.files);
		next = found.next_cursor;
		if (next !== null) cursor = next;
	}
	assert.deepEqual(pages.map((file) => file.path), ["a.md", "search.md"], "pagination reaches the oversized file instead of looping");
	const oversized = pages[1]!;
	assert.equal(oversized.matches_total, 1, "the file's full match count is named even though the line was cut");
	assert.equal(oversized.matches.length, 1);
	const match = oversized.matches[0]!;
	assert.equal(match.truncated, true, "the oversized match line is flagged as truncated");
	assert.equal(match.total_chars, Array.from(hugeLine).length, "total_chars names the full line length");
	assert.ok(hugeLine.startsWith(match.text), "the match text is a plain prefix of the line");
	assert.equal(match.text.includes("…"), false, "no marker is appended to the match text");
	// The named cursor reaches the rest of the line (the file is a single line, so no separators).
	const parts = [match.text];
	let line: number | null = match.line;
	let char = Array.from(match.text).length;
	while (line !== null) {
		const page: { content: string; next_start_line: number | null; next_start_char: number } = resultJson<{ content: string; next_start_line: number | null; next_start_char: number }>(
			await call(captured, "notes_read_file", { path: "search.md", start_line: line, start_char: char }, ctx),
		);
		parts.push(page.content);
		line = page.next_start_line;
		char = page.next_start_char;
	}
	assert.equal(parts.join(""), hugeLine, "resuming at the delivered prefix reconstructs the matched line");
});

test("history_read_item delivers a prefix and next_offset_chars names the delivered count", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const original = "z".repeat(TOOL_OUTPUT_MAX_BYTES * 3);
	const id = appendText(session, "user", original);
	const read = resultJson<{ content: string; total_chars: number; offset_chars: number; next_offset_chars: number | null }>(
		await call(captured, "history_read_item", { window_id: historyFromSession(ctx)[0]!.windowId, item_id: id, limit_chars: 50000 }, ctx),
	);
	assert.ok(Buffer.byteLength(JSON.stringify(read), "utf8") <= TOOL_OUTPUT_MAX_BYTES, "single call stays within budget");
	assert.ok(read.content.length > 0, "the read is not empty");
	assert.equal(read.content.includes("…"), false, "no marker is appended to the payload");
	assert.ok(original.startsWith(read.content), "the delivered text is a prefix of the item");
	assert.equal(read.total_chars, original.length);
	assert.equal(read.next_offset_chars, read.offset_chars + Array.from(read.content).length, "the cursor is offset plus delivered code points");
	assert.ok(read.next_offset_chars !== null && read.next_offset_chars < read.total_chars, "the cursor points at the first undelivered character");
	// Following the cursor reaches the true end and reconstructs the item.
	const parts = [read.content];
	let offset = read.next_offset_chars as number;
	let next: number | null = offset;
	while (next !== null) {
		const page = resultJson<{ content: string; total_chars: number; offset_chars: number; next_offset_chars: number | null }>(
			await call(captured, "history_read_item", { window_id: historyFromSession(ctx)[0]!.windowId, item_id: id, offset_chars: offset, limit_chars: 50000 }, ctx),
		);
		assert.equal(page.next_offset_chars, page.offset_chars + Array.from(page.content).length < page.total_chars ? page.offset_chars + Array.from(page.content).length : null, "the cursor is offset plus delivered, null only at item end");
		parts.push(page.content);
		next = page.next_offset_chars;
		if (next !== null) offset = next;
	}
	assert.equal(parts.join(""), original, "the cursors reconstruct the item exactly");
});

test("the empty note terminates and every read keeps stop_line >= start_line", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write_file", { path: "empty.md", text: "" }, ctx);
	const empty = resultJson<{ start_line: number; stop_line: number; content: string; total_lines: number; next_start_line: number | null; next_start_char: number }>(
		await call(captured, "notes_read_file", { path: "empty.md" }, ctx),
	);
	assert.equal(empty.stop_line >= empty.start_line, true, "the empty note keeps stop_line >= start_line");
	assert.equal(empty.next_start_line, null, "the empty note is exhausted instead of self-feeding");
	assert.equal(empty.next_start_char, 0);
	assert.equal(empty.content, "");
	assert.equal(empty.total_lines, 1);
	// A range beyond the file is exhausted, not looped, and still satisfies the range contract.
	const beyond = resultJson<{ start_line: number; stop_line: number; next_start_line: number | null }>(
		await call(captured, "notes_read_file", { path: "empty.md", start_line: 9 }, ctx),
	);
	assert.equal(beyond.stop_line >= beyond.start_line, true, "a beyond-the-file read keeps stop_line >= start_line");
	assert.equal(beyond.next_start_line, null, "a beyond-the-file read terminates");
});

test("history items carry honest truncated/total_chars and max_chars_per_item:1 addresses them", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const content = `${'padding '.repeat(400)}NEEDLE${' trailing'.repeat(400)}`;
	const id = appendText(session, "user", content);
	const list = resultJson<{ items: Array<{ item_id: string; truncated: boolean; total_chars: number; truncated_content: string }> }>(
		await call(captured, "history_list_items", { recent_first: false, max_chars_per_item: 5 }, ctx),
	);
	const listed = list.items.find((item) => item.item_id === id)!;
	assert.equal(listed.truncated, true, "a capped item is flagged truncated");
	assert.equal(listed.total_chars, Array.from(content).length, "total_chars is the full code-point length");
	assert.equal(listed.truncated_content, 'paddi', "the payload is the longest fitting prefix, with no marker");
	assert.equal(listed.truncated_content.includes("…"), false);
	const whole = resultJson<{ items: Array<{ item_id: string; truncated: boolean; total_chars: number; truncated_content: string }> }>(
		await call(captured, "history_list_items", { recent_first: false, max_chars_per_item: 50_000 }, ctx),
	);
	const untruncated = whole.items.find((item) => item.item_id === id)!;
	assert.equal(untruncated.truncated, false, "an item that fits is not flagged truncated");
	assert.equal(untruncated.truncated_content, content, "a fitting item is returned whole");
	const addresses = resultJson<{ items: Array<{ item_id: string; truncated: boolean; total_chars: number; truncated_content: string; match_offset_chars: number }> }>(
		await call(captured, "history_search_contents", { query: "NEEDLE", max_chars_per_item: 1 }, ctx),
	);
	const address = addresses.items.find((item) => item.item_id === id)!;
	assert.equal(Array.from(address.truncated_content).length, 1, "max_chars_per_item:1 delivers one code point");
	assert.equal(address.truncated, true);
	assert.equal(address.total_chars, Array.from(content).length);
	const resolved = resultJson<{ content: string }>(
		await call(captured, "history_read_item", { window_id: historyFromSession(ctx)[0]!.windowId, item_id: id, offset_chars: address.match_offset_chars, limit_chars: 6 }, ctx),
	);
	assert.ok(resolved.content.includes("NEEDLE"), "the address resolves to the query through history_read_item");
});

test("developer re-role names this extension's entries and leaves native compactions as system", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const foreignId = session.appendCustomMessageEntry("other/extension", "foreign custom body", false);
	const extensionId = session.appendCustomMessageEntry(internal.BOOT_TYPE, "extension boot body", false);
	const leaf = session.getLeafId();
	assert.ok(leaf);
	const resetId = session.appendCompaction("reset v2 summary", leaf, 100, { piContext: "reset-v2", windowId: "pcw:test:dev" }, true);
	const nextLeaf = session.getLeafId();
	assert.ok(nextLeaf);
	const nativeId = session.appendCompaction("native summary", nextLeaf, 100, { readFiles: [], modifiedFiles: [] }, true);
	const byRole = async (role: string) => resultJson<{ items: Array<{ item_id: string; role: string }> }>(
		await call(captured, "history_list_items", { role, recent_first: false }, ctx),
	).items;
	assert.deepEqual((await byRole("developer")).map((item) => item.item_id), [extensionId, resetId], "developer names exactly this extension's entries");
	assert.deepEqual((await byRole("system")).map((item) => item.item_id), [nativeId], "system stays native Pi compactions only");
	assert.deepEqual((await byRole("user")).map((item) => item.item_id), [foreignId], "foreign custom messages stay user turns");
});

test("oversized history tool_name: page stays within budget, item_id intact, metadata visibly truncated", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const hugeToolName = `oversized_${"t".repeat(40_000)}`;
	const itemId = appendText(session, "toolResult", "tool output line", hugeToolName);

	const listed = resultJson<{ items: Array<{ item_id: string; tool_name: string; truncated_content: string }>; next_cursor: number | null }>(
		await call(captured, "history_list_items", { recent_first: false, max_chars_per_item: 1200 }, ctx),
	);
	const listedBytes = Buffer.byteLength(JSON.stringify(listed), "utf8");
	console.log(`pathological page bytes: history_list_items tool_name=40KB -> ${listedBytes}`);
	assert.ok(listedBytes <= TOOL_OUTPUT_MAX_BYTES, `oversized tool_name list page is ${listedBytes} bytes`);
	assert.equal(listed.items.length, 1);
	assert.equal(listed.items[0]!.item_id, itemId, "item_id identity is untouched");
	assert.equal(listed.items[0]!.truncated_content, "tool output line", "the payload is preserved when only metadata is oversized");
	assert.match(listed.items[0]!.tool_name, /…\[truncated \d+ chars\]…/, "tool_name carries the truncation marker");

	const searched = resultJson<{ items: Array<{ item_id: string; tool_name: string }>; next_cursor: number | null }>(
		await call(captured, "history_search_contents", { query: "tool output", recent_first: false }, ctx),
	);
	const searchedBytes = Buffer.byteLength(JSON.stringify(searched), "utf8");
	console.log(`pathological page bytes: history_search_contents tool_name=40KB -> ${searchedBytes}`);
	assert.ok(searchedBytes <= TOOL_OUTPUT_MAX_BYTES, `oversized tool_name search page is ${searchedBytes} bytes`);
	assert.equal(searched.items.length, 1);
	assert.equal(searched.items[0]!.item_id, itemId, "search keeps item_id identity");
	assert.match(searched.items[0]!.tool_name, /…\[truncated \d+ chars\]…/, "search truncates the oversized tool_name visibly");
});

test("oversized legacy note path: list and search truncate the path only with an explicit flag", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const legacyPath = `legacy/${"p".repeat(40_000)}.md`;
	// Bypass the write cap the way history does: append the persisted op directly, then replay.
	session.appendCustomEntry(NOTE_TYPE, { op: "write", path: legacyPath, text: "needle legacy line", createdAt: Date.now(), updatedAt: Date.now() });
	assert.ok(notesFromSession(ctx).has(legacyPath), "replay accepts a legacy path beyond the write cap");

	const listed = resultJson<{ files: Array<{ path: string; path_truncated?: boolean }>; next_cursor: number | null }>(
		await call(captured, "notes_list_files", {}, ctx),
	);
	const listedBytes = Buffer.byteLength(JSON.stringify(listed), "utf8");
	console.log(`pathological page bytes: notes_list_files path=40KB -> ${listedBytes}`);
	assert.ok(listedBytes <= TOOL_OUTPUT_MAX_BYTES, `legacy path list page is ${listedBytes} bytes`);
	assert.equal(listed.files.length, 1);
	const listedFile = listed.files[0]!;
	assert.equal(listedFile.path_truncated, true, "the truncated path is explicitly flagged");
	assert.match(listedFile.path, /…\[truncated \d+ chars\]…/, "the path carries the truncation marker");
	assertTruncationOf(legacyPath, listedFile.path);

	const searched = resultJson<{ files: Array<{ path: string; path_truncated?: boolean; matches: Array<{ line: number }> }>; next_cursor: number | null }>(
		await call(captured, "notes_search_contents", { query: "needle" }, ctx),
	);
	const searchedBytes = Buffer.byteLength(JSON.stringify(searched), "utf8");
	console.log(`pathological page bytes: notes_search_contents path=40KB -> ${searchedBytes}`);
	assert.ok(searchedBytes <= TOOL_OUTPUT_MAX_BYTES, `legacy path search page is ${searchedBytes} bytes`);
	assert.equal(searched.files.length, 1);
	assert.equal(searched.files[0]!.path_truncated, true, "the search result flags the truncated path");
	assert.match(searched.files[0]!.path, /…\[truncated \d+ chars\]…/);
	assert.equal(searched.files[0]!.matches[0]!.line, 1, "the matching line number survives the truncation");
});

test("the 512-byte write-time path cap refuses longer paths while replay and reads stay un-capped", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const acceptedPath = "a".repeat(MAX_NOTE_PATH_BYTES);
	const rejectedPath = "b".repeat(MAX_NOTE_PATH_BYTES + 1);
	await call(captured, "notes_write_file", { path: acceptedPath, text: "accepted" }, ctx);
	assert.equal(notesFromSession(ctx).get(acceptedPath)?.text, "accepted", "a path exactly at the cap is accepted");
	for (const name of ["notes_write_file", "notes_append_to_file"]) {
		const refused = resultJson<{ error: string }>(await call(captured, name, { path: rejectedPath, text: "x" }, ctx));
		assert.match(refused.error, new RegExp(String(MAX_NOTE_PATH_BYTES)), `${name} refuses a path over the cap with a clear error`);
	}
	assert.equal(notesFromSession(ctx).has(rejectedPath), false, "a refused path is never persisted");

	// A legacy path longer than the cap was persisted before the cap existed: replay must still
	// load it, and reads must accept it and return its identity intact. This path is only just
	// over the cap, so the read result stays within the shared wire budget, unlike the ~40 KB
	// paths the list/search budget tests exercise.
	const persisted = manager(true);
	const legacyPath = `legacy/${"r".repeat(600)}.md`;
	assert.ok(Buffer.byteLength(legacyPath, "utf8") > MAX_NOTE_PATH_BYTES);
	persisted.appendCustomEntry(NOTE_TYPE, { op: "write", path: legacyPath, text: "legacy body\nsecond line", createdAt: Date.now(), updatedAt: Date.now() });
	// SessionManager delays writing a brand-new session until its first assistant entry.
	appendText(persisted, "assistant", "persist the legacy note");
	const file = persisted.getSessionFile();
	assert.ok(file);
	const restored = SessionManager.create("/private/tmp/pi-context-test", mkdtempSync(join(tmpdir(), "pi-context-legacy-")));
	restored.setSessionFile(file);
	const restoredCtx = context(restored);
	assert.ok(notesFromSession(restoredCtx).has(legacyPath), "the reloaded session still replays the legacy path");
	const restoredCaptured = makeExtension(restored);
	const read = resultJson<{ path: string; content: string }>(await call(restoredCaptured, "notes_read_file", { path: legacyPath }, restoredCtx));
	assert.equal(read.path, legacyPath, "reads are un-capped and return the identity intact");
	assert.equal(read.content, "legacy body\nsecond line");
	const refused = resultJson<{ error: string }>(await call(restoredCaptured, "notes_write_file", { path: legacyPath, text: "again" }, restoredCtx));
	assert.match(refused.error, new RegExp(String(MAX_NOTE_PATH_BYTES)), "the reloaded session still refuses new over-cap writes");
});

test("page() includes one middle-truncated item and advances the cursor", () => {
	const truncate = <T extends { text: string }>(item: T, fits: (candidate: T) => boolean): T => ({ ...item, text: middleTruncate(item.text, (candidate) => fits({ ...item, text: candidate })) });
	const first = page([{ text: "a".repeat(TOOL_OUTPUT_MAX_BYTES * 2) }, { text: "b" }], 0, "items", undefined, truncate) as { items: Array<{ text: string }>; next_cursor: number | null };
	assert.equal(first.items.length, 1, "the oversized item is included, not skipped");
	assert.match(first.items[0]!.text, /…\[truncated \d+ chars\]…/);
	assert.equal(first.next_cursor, 1, "the cursor advances past the truncated item");
	assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
	const last = page([{ text: "a".repeat(TOOL_OUTPUT_MAX_BYTES * 2) }], 0, "items", undefined, truncate) as { items: Array<{ text: string }>; next_cursor: number | null };
	assert.equal(last.items.length, 1);
	assert.equal(last.next_cursor, null, "the final oversized item terminates pagination");
	// An oversized item behind a fitting one must not stall: the next page starts on it.
	const behind = page([{ text: "small" }, { text: "c".repeat(TOOL_OUTPUT_MAX_BYTES * 2) }, { text: "tail" }], 0, "items", undefined, truncate) as { items: Array<{ text: string }>; next_cursor: number | null };
	assert.equal(behind.items.length, 1);
	assert.equal(behind.next_cursor, 1);
	const resumed = page([{ text: "small" }, { text: "c".repeat(TOOL_OUTPUT_MAX_BYTES * 2) }, { text: "tail" }], 1, "items", undefined, truncate) as { items: Array<{ text: string }>; next_cursor: number | null };
	assert.equal(resumed.items.length, 1, "the resumed page carries the truncated item");
	assert.match(resumed.items[0]!.text, /…\[truncated \d+ chars\]…/);
	assert.equal(resumed.next_cursor, 2, "pagination advances toward the remaining item");
});

test("note write tools run sequentially so a parallel batch cannot race the note store", () => {
	const captured = makeExtension(manager());
	for (const name of ["notes_write_file", "notes_append_to_file"]) {
		assert.equal(captured.tools.get(name)?.executionMode, "sequential", `${name} forbids parallel execution`);
	}
	assert.equal(captured.tools.get("notes_read_file")?.executionMode, undefined, "read-only note tools keep the default mode");
});

test("custom reset boundary removes old provider context but history remains searchable", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	const oldUserId = appendText(sessionManager, "user", "OLD-UNIQUE-TRANSCRIPT needle");
	appendText(sessionManager, "assistant", "I will use a tool");
	const toolResultId = appendText(sessionManager, "toolResult", "tool result safely recorded");

	const before = await runBeforeCompact(captured, ctx, 123);
	assert.ok(before && "compaction" in before);
	const markerId = sessionManager.getLeafId();
	assert.ok(markerId);
	const marker = sessionManager.getEntry(markerId);
	assert.ok(marker);
	assert.equal(marker.parentId, toolResultId, "marker follows the completed tool result");
	const compactionId = sessionManager.appendCompaction(
		before.compaction.summary,
		before.compaction.firstKeptEntryId,
		before.compaction.tokensBefore,
		before.compaction.details,
		true,
	);
	const providerText = JSON.stringify(sessionManager.buildSessionContext().messages);
	assert.equal(providerText.includes("OLD-UNIQUE-TRANSCRIPT"), false);
	assert.equal(providerText.includes(internal.CONTEXT_WINDOW_OPEN_TAG), true);

	const windows = historyFromSession(ctx);
	assert.equal(windows.length, 2);
	const oldWindow = windows[0]?.windowId;
	assert.ok(oldWindow);
	const read = resultJson<{ content: string }>(
		await call(captured, "history_read_item", { window_id: oldWindow, item_id: oldUserId }, ctx),
	);
	assert.match(read.content, /OLD-UNIQUE-TRANSCRIPT/);
	const found = resultJson<{ items: Array<{ item_id: string }> }>(
		await call(captured, "history_search_contents", { query: "needle" }, ctx),
	);
	assert.equal(found.items.length, 1);
	assert.equal(found.items[0]?.item_id, oldUserId);
	assert.ok(sessionManager.getEntry(compactionId));
});

test("the boot notes preview keeps short notes whole and long notes head-to-tail", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	// Unique Unicode code points so an overlap introduced by a naive head+tail concat is detectable.
	const longText = Array.from({ length: 400 }, (_, index) => String.fromCharCode(0x4e00 + index)).join("");
	const shortText = "short-first\nshort-second";
	await call(captured, "notes_write_file", { path: "long.md", text: longText }, ctx);
	await call(captured, "notes_write_file", { path: "short.md", text: shortText }, ctx);
	runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	const boot = captured.sent[0];
	const text = typeof boot?.message.content === "string" ? boot.message.content : "";
	assert.ok(text.includes("long.md") && text.includes("short.md"), "both notes are indexed");

	// Short note: complete, with its newline preserved and each line indented 2 spaces.
	assert.ok(text.includes("  short-first\n  short-second"), "short note text is shown whole and indented");

	// Long note preview: exactly first 80 + separator + last 240 Unicode characters.
	const chars = Array.from(longText);
	const head = chars.slice(0, 80).join("");
	const tail = chars.slice(chars.length - 240).join("");
	const previewLine = text.split("\n").find((line) => line.startsWith("  ") && line.includes("…"));
	assert.ok(previewLine, "long note carries an ellipsis preview line");
	const preview = Array.from(previewLine.slice(2));
	assert.ok(previewLine.includes(head), "long preview keeps the head");
	assert.ok(previewLine.includes(tail), "long preview keeps the tail");
	assert.equal(preview.length, 321, "head 80 + one separator + tail 240, nothing duplicated");
	assert.equal(previewLine.includes(longText), false, "long note is truncated, not shown whole");
});

test("the boot block is persisted at the root and baked into every reset summary", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	appendText(sessionManager, "user", "task before reset");
	appendText(sessionManager, "assistant", "working");
	await call(captured, "notes_write_file", { path: "decisions.md", text: "use terra" }, ctx);

	// Root window: session_start persists the boot block without triggering a turn.
	runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	assert.equal(captured.sent.length, 1);
	const rootBoot = captured.sent[0];
	assert.equal(rootBoot?.message.customType, internal.BOOT_TYPE);
	assert.equal(rootBoot?.message.display, false, "boot block stays out of the TUI");
	assert.equal(rootBoot?.options?.triggerTurn, false);
	const rootText = typeof rootBoot?.message.content === "string" ? rootBoot.message.content : "";
	assert.ok(rootText.startsWith(internal.CONTEXT_WINDOW_OPEN_TAG), "root block omits the reset line");
	assert.equal(rootText.includes("Previous context window id:"), false, "root block omits the previous-id line");
	assert.match(rootText, new RegExp(`First context window id: pcw:${sessionManager.getSessionId().slice(0, 8)}:root`));
	assert.match(rootText, new RegExp(`Current context window id: pcw:${sessionManager.getSessionId().slice(0, 8)}:root`));
	assert.ok(rootText.includes("decisions.md"));
	const decisionsMeta = notesFromSession(ctx).get("decisions.md");
	assert.ok(decisionsMeta);
	const bootUpdated = assertIsoTimestamp(rootText, "note metadata carries an updated timestamp");
	assert.equal(Date.parse(bootUpdated), decisionsMeta.updatedAt, "boot note timestamp restores the persisted updatedAt");
	assert.ok(rootText.includes(internal.CONTEXT_WINDOW_PROTOCOL_OPEN_TAG));

	// Reset: the boot block IS the compaction summary; no separate boot/hint is persisted.
	await call(captured, "new_context", {}, ctx);
	runHandlers(captured, "agent_end", {}, ctx);
	runHandlers(captured, "agent_settled", {}, ctx);
	const before = await runBeforeCompact(captured, ctx, 9);
	assert.ok(before && "compaction" in before);
	const details = before.compaction.details as { piContext: string; windowId: string };
	assert.equal(details.piContext, "reset-v2");
	assert.match(details.windowId, new RegExp(`^pcw:${sessionManager.getSessionId().slice(0, 8)}:[0-9a-f]{8}$`));
	assert.equal(before.compaction.summary.startsWith(internal.CONTEXT_WINDOW_OPEN_TAG), false, "a reset line precedes the identity block");
	assert.match(before.compaction.summary, new RegExp(`Current context window id: ${details.windowId}`));
	assert.ok(before.compaction.summary.includes("decisions.md"));
	const resetUpdated = assertIsoTimestamp(before.compaction.summary, "reset summary keeps the note updated timestamp");
	assert.equal(Date.parse(resetUpdated), decisionsMeta.updatedAt, "reset summary keeps the persisted updatedAt");
	assert.ok(before.compaction.summary.includes(internal.CONTEXT_WINDOW_PROTOCOL_OPEN_TAG));
	const windows = historyFromSession(ctx);
	assert.ok(before.compaction.summary.includes(`Previous context window id: ${windows[windows.length - 1]?.windowId}`));

	const compactionId = sessionManager.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 9, details, true);
	const compactionEntry = sessionManager.getEntry(compactionId);
	assert.ok(compactionEntry && compactionEntry.type === "compaction");
	runHandlers(captured, "session_compact", { willRetry: false, compactionEntry }, ctx);
	completeRequestedCompaction(ctx);

	// Only the hidden continuation follows a reset; no pi-context/boot message is written.
	assert.equal(captured.sent.length, 2);
	assert.equal(captured.sent[1]?.message.display, false);
	assert.equal(captured.sent[1]?.options?.triggerTurn, true);
	assert.equal(await runContextHook(captured, ctx), undefined, "context hook never injects");
});

test("reset window ids are extension-minted and drive history_* lookups", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	appendText(sessionManager, "user", "task before reset");
	const before = await runBeforeCompact(captured, ctx, 100);
	assert.ok(before && "compaction" in before);
	const details = before.compaction.details as { piContext: string; windowId: string };

	const compactionId = sessionManager.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 100, details, true);
	const compactionEntry = sessionManager.getEntry(compactionId);
	assert.ok(compactionEntry && compactionEntry.type === "compaction");

	// history_list_windows reports exactly the minted id carried in details.
	// The default is newest-first, so the current window is listed first.
	const windows = resultJson<{ windows: Array<{ window_id: string }> }>(await call(captured, "history_list_windows", {}, ctx));
	assert.equal(windows.windows.length, 2);
	assert.equal(windows.windows[0]?.window_id, details.windowId, "recent_first defaults to newest-first");
	// Only an explicit false restores oldest-first window order.
	const oldestWindows = resultJson<{ windows: Array<{ window_id: string }> }>(await call(captured, "history_list_windows", { recent_first: false }, ctx));
	assert.equal(oldestWindows.windows[0]?.window_id, `pcw:${sessionManager.getSessionId().slice(0, 8)}:root`, "explicit false keeps the oldest window first");
	assert.equal(oldestWindows.windows[1]?.window_id, details.windowId);
	// The minted id is Pi's 8-hex entry-id shape, but the window id is ours.
	assert.match(details.windowId, new RegExp(`^pcw:${sessionManager.getSessionId().slice(0, 8)}:[0-9a-f]{8}$`));

	// history_* accepts the minted window id and resolves the baked summary item.
	const listed = resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_list_items", { window_id: details.windowId }, ctx));
	assert.equal(listed.items.length, 1);
	assert.equal(listed.items[0]?.item_id, compactionEntry.id);
});

test("recent_first defaults to newest-first for items and search; only false is oldest-first", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	const firstId = appendText(sessionManager, "user", "needle alpha");
	const secondId = appendText(sessionManager, "assistant", "needle beta");
	const thirdId = appendText(sessionManager, "user", "needle gamma");

	const listOrder = async (params: Record<string, unknown>) =>
		resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_list_items", params, ctx)).items.map((item) => item.item_id);
	assert.deepEqual(await listOrder({}), [thirdId, secondId, firstId], "omitted recent_first lists the newest item first");
	assert.deepEqual(await listOrder({ recent_first: true }), [thirdId, secondId, firstId], "recent_first true lists the newest item first");
	assert.deepEqual(await listOrder({ recent_first: false }), [firstId, secondId, thirdId], "explicit false lists the oldest item first");

	const searchOrder = async (params: Record<string, unknown>) =>
		resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_search_contents", { query: "needle", ...params }, ctx)).items.map((item) => item.item_id);
	assert.deepEqual(await searchOrder({}), [thirdId, secondId, firstId], "search shares the newest-first default");
	assert.deepEqual(await searchOrder({ recent_first: false }), [firstId, secondId, thirdId], "search honours an explicit false");
});

test("a Pi-native compaction with the extension off keeps entry.id as the window id", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	appendText(sessionManager, "user", "native compaction");
	await runCommand(captured, "pi-context", "off", ctx);

	const compactionId = sessionManager.appendCompaction("Pi native summary", sessionManager.getLeafId() as string, 100, { readFiles: [], modifiedFiles: [] }, true);
	const windows = resultJson<{ windows: Array<{ window_id: string }> }>(await call(captured, "history_list_windows", {}, ctx));
	assert.equal(windows.windows[0]?.window_id, `pcw:${sessionManager.getSessionId().slice(0, 8)}:${compactionId}`, "native compactions fall back to entry.id");
});

test("a reset window baked under the older full-session id still projects and resolves opaquely", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	const sessionId = sessionManager.getSessionId();
	const projectedRoot = `pcw:${sessionId.slice(0, 8)}:root`;
	// A window id baked by the pre-shortening extension: the full session id is part of the opaque string.
	const oldWindowId = `pcw:${sessionId}:deadbeef`;

	const rootItemId = appendText(sessionManager, "user", "message before the old reset");
	const markerId = sessionManager.getLeafId();
	assert.ok(markerId);
	const compactionId = sessionManager.appendCompaction("old reset summary", markerId, 100, { piContext: "reset-v2", windowId: oldWindowId }, true);
	const currentItemId = appendText(sessionManager, "assistant", "message after the old reset");

	// The old session still projects both windows: the computed short root and the opaque baked window.
	const windows = resultJson<{ windows: Array<{ window_id: string }> }>(await call(captured, "history_list_windows", { recent_first: false }, ctx));
	assert.deepEqual(windows.windows.map((window) => window.window_id), [projectedRoot, oldWindowId], "both the short root and the older opaque id project");

	// history_read_item resolves items by the older opaque window id, and by the computed root.
	const oldRead = resultJson<{ content: string }>(await call(captured, "history_read_item", { window_id: oldWindowId, item_id: compactionId }, ctx));
	assert.equal(oldRead.content, "old reset summary");
	const oldCurrent = resultJson<{ content: string }>(await call(captured, "history_read_item", { window_id: oldWindowId, item_id: currentItemId }, ctx));
	assert.equal(oldCurrent.content, "message after the old reset");
	const rootRead = resultJson<{ content: string }>(await call(captured, "history_read_item", { window_id: projectedRoot, item_id: rootItemId }, ctx));
	assert.equal(rootRead.content, "message before the old reset");

	// No normalization: the read path matches window ids exactly and never rewrites an older spelling.
	const unrewritten = resultJson<{ error?: string }>(await call(captured, "history_read_item", { window_id: `pcw:${sessionId}:root`, item_id: rootItemId }, ctx));
	assert.match(unrewritten.error ?? "", /unknown item_id or window_id/);
});

test("low-budget guidance persists once per window with no transient copy", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);

	// Comfortable usage: the hook injects nothing and persists nothing.
	const comfortable = context(sessionManager, undefined, { tokens: 10_000, percent: 5, contextWindow: 200_000 });
	assert.equal(await runContextHook(captured, comfortable), undefined, "nothing injected above the reminder");
	assert.equal(captured.sent.length, 0);

	// Unknown usage (right after compaction): stay silent.
	const unknown = context(sessionManager, undefined, { tokens: null, percent: null, contextWindow: 200_000 });
	assert.equal(await runContextHook(captured, unknown), undefined);

	// Below threshold: persist once (hidden from the TUI; the user gets one ephemeral
	// notify instead, no turn triggered) and return no transient copy — history and
	// the model's view never diverge on position.
	const low = context(sessionManager, undefined, { tokens: 190_000, percent: 95, contextWindow: 200_000 });
	assert.equal(await runContextHook(captured, low), undefined, "the context hook injects nothing");
	assert.equal(captured.sent.length, 1, "persisted exactly once");
	assert.equal(captured.sent[0]?.message.customType, internal.GUIDANCE_TYPE);
	assert.equal(captured.sent[0]?.message.display, false, "guidance stays out of the TUI");
	assert.equal(captured.sent[0]?.options?.triggerTurn, false, "never triggers an extra turn");
	assert.ok(
		noticesOf(low).some((notice) => notice.type === "warning" && notice.message.startsWith("pi-context: context budget low")),
		"the user gets one model-invisible notify instead",
	);
	const text = captured.sent[0]?.message.content;
	assert.ok(typeof text === "string" && text.startsWith(internal.GUIDANCE_OPEN_TAG));
	assert.match(text, /\b0 tokens\b/, "guidance embeds the measured remaining count");

	// Same window: no duplicate persist.
	assert.equal(await runContextHook(captured, low), undefined);
	assert.equal(captured.sent.length, 1, "no duplicate persist, so no re-render");

	// A reset boundary creates a new window: the reminder re-arms and carries its own measured count.
	const before = await runBeforeCompact(captured, low, 190_000);
	assert.ok(before && "compaction" in before);
	sessionManager.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 190_000, before.compaction.details, true);
	const newWindow = context(sessionManager, undefined, { tokens: 196_000, percent: 98, contextWindow: 200_000 });
	assert.equal(await runContextHook(captured, newWindow), undefined, "still no injection in the fresh window");
	assert.equal(captured.sent.length, 2);
	const newWindowText = captured.sent[1]?.message.content;
	assert.ok(typeof newWindowText === "string" && newWindowText.startsWith(internal.GUIDANCE_OPEN_TAG));
	assert.match(newWindowText, /\b0 tokens\b/, "fresh window persists its own measured count");
});

test("new_context continues exactly once and cancellation/failure does not fall back or loop", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	let requestedCompact: Parameters<NonNullable<ExtensionContext["compact"]>>[0] | undefined;
	const ctx = context(sessionManager, (options) => {
		requestedCompact = options;
	});
	appendText(sessionManager, "user", "enough history for the hook test");
	const newContext = await call(captured, "new_context", {}, ctx);
	assert.equal(newContext.terminate, true);
	runHandlers(captured, "agent_end", {}, ctx);
	assert.equal(requestedCompact, undefined, "agent_end does not request compaction while the run is active");
	runHandlers(captured, "agent_settled", {}, ctx);
	assert.ok(requestedCompact, "manual compaction is deferred until agent_settled");

	const before = await runBeforeCompact(captured, ctx, 7);
	assert.ok(before && "compaction" in before);
	const compactionId = sessionManager.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 7, before.compaction.details, true);
	const compactionEntry = sessionManager.getEntry(compactionId);
	assert.ok(compactionEntry && compactionEntry.type === "compaction");
	const compactEvent: Pick<SessionCompactEvent, "willRetry" | "compactionEntry"> = { willRetry: false, compactionEntry };
	runHandlers(captured, "session_compact", compactEvent, ctx);
	runHandlers(captured, "session_compact", compactEvent, ctx);
	assert.equal(captured.sent.length, 0, "the hook never starts a run while compaction is active");
	completeRequestedCompaction(ctx);
	assert.equal(captured.sent.length, 1, "exactly one hidden continuation and no hint");
	assert.equal(captured.sent[0]?.message.display, false);
	assert.equal(captured.sent[0]?.options?.triggerTurn, true);

	const failedManager = manager();
	const failed = makeExtension(failedManager);
	let failureOptions: Parameters<NonNullable<ExtensionContext["compact"]>>[0] | undefined;
	const failedCtx = context(failedManager, (options) => {
		failureOptions = options;
	});
	await call(failed, "new_context", {}, failedCtx);
	runHandlers(failed, "agent_end", {}, failedCtx);
	runHandlers(failed, "agent_settled", {}, failedCtx);
	assert.ok(failureOptions?.onError);
	failureOptions.onError(new Error("not compactable"));
	runHandlers(failed, "session_compact", compactEvent, failedCtx);
	assert.equal(failed.sent.length, 0, "failure does not send an accidental continuation");

	const aborted = await runBeforeCompactAborted(failed, failedCtx);
	assert.deepEqual(aborted, { cancel: true }, "aborted custom compaction cannot fall through to Pi default summary");
	runHandlers(failed, "session_compact", { ...compactEvent, willRetry: true }, failedCtx);
	assert.equal(failed.sent.length, 0, "native overflow retry is left to Pi core, not doubled by the extension");
});

async function runBeforeCompactAborted(captured: Captured, ctx: ExtensionContext): Promise<CompactionHookResult> {
	const handler = captured.handlers.get("session_before_compact")?.[0];
	assert.ok(handler);
	const event = { reason: "manual", willRetry: false, signal: AbortSignal.abort(), preparation: { tokensBefore: 7 } };
	return (await handler(event as never, ctx)) as CompactionHookResult;
}

test("pi-context command toggles the boot block, guidance, and reset compaction at runtime", async () => {
	const sessionManager = manager();
	appendText(sessionManager, "user", "hello");
	const captured = makeExtension(sessionManager);
	const low = context(sessionManager, undefined, { tokens: 190_000, contextWindow: 200_000, percent: 95 });

	// On by default: session_start persists the root boot block; the low budget persists guidance.
	runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 1);
	assert.equal(captured.sent[0]?.message.customType, internal.BOOT_TYPE);
	assert.equal(await runContextHook(captured, low), undefined, "the context hook never injects");
	assert.equal(captured.sent.length, 2, "guidance persisted");
	assert.equal(captured.sent[1]?.message.customType, internal.GUIDANCE_TYPE);

	let notices = await runCommand(captured, "pi-context", "off", low);
	assert.match(notices[0]?.message ?? "", /off/);
	assert.equal(await runContextHook(captured, low), undefined, "no guidance while off");
	assert.equal(captured.sent.length, 2, "no guidance persisted while off");
	runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 2, "no boot block persisted while off");
	assert.equal(await runBeforeCompact(captured, low, 123), undefined, "default Pi compaction applies while off");
	const offResult = resultJson<{ error?: string }>(await call(captured, "new_context", {}, low));
	assert.match(offResult.error ?? "", /off/, "new_context refuses while off");

	notices = await runCommand(captured, "pi-context", "on", low);
	assert.match(notices[0]?.message ?? "", /on/);
	runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 2, "re-enable preserves the existing boot block without duplication");

	notices = await runCommand(captured, "pi-context", "maybe", low);
	assert.equal(notices[0]?.type, "error", "unknown argument rejected");

	// Bare command reports current state without changing it.
	notices = await runCommand(captured, "pi-context", "", low);
	assert.match(notices[0]?.message ?? "", /on/);
});

test("compaction paths reset directly or borrow one run, then bake the boot block without extra continuations", async () => {
	for (const reason of ["manual", "threshold", "overflow"] as const) {
		for (const idle of [false, true]) {
			const sm = manager();
			appendText(sm, "user", "long task history");
			const captured = makeExtension(sm);
			let compactions = 0;
			const ctx = context(sm, () => { compactions++; }, undefined, idle);
			assert.equal(captured.handlers.has("input"), false, "no user-input interception");
			for (let window = 0; window < 2; window++) {
				let before: CompactionHookResult;
				if (reason === "manual" || idle) {
					// Manual resets directly, and an idle automatic crossing resets directly too:
					// borrowing a turn while idle would start a nested run and break the prompt.
					before = await runBeforeCompact(captured, ctx, 100, reason);
					assert.ok(before && "compaction" in before, `${reason}, idle=${idle}: resets directly`);
					assert.equal(captured.sent.length, 0, `${reason}, idle=${idle}: no borrowed turn`);
				} else {
					// Phase 1: the streaming automatic crossing borrows exactly one fallback turn.
					before = await runBeforeCompact(captured, ctx, 100, reason);
					assert.deepEqual(before, { cancel: true }, `${reason}, idle=${idle}: first automatic crossing is borrowed`);
					assert.equal(captured.sent.filter((m) => m.message.customType === internal.FALLBACK_TYPE).length, window + 1, "one fallback steer per window");
					runHandlers(captured, "agent_end", {}, ctx);
					// Neither reason guarantees another automatic entry once the run ends.
					runHandlers(captured, "agent_settled", {}, ctx);
					assert.equal(compactions, window + 1, `${reason}: ctx.compact() requests the reset`);
					runHandlers(captured, "agent_settled", {}, ctx);
					assert.equal(compactions, window + 1, `${reason}: settling twice does not duplicate the reset`);
					before = await runBeforeCompact(captured, ctx, 100, "manual");
					assert.ok(before && "compaction" in before, `${reason}, idle=${idle}: the real reset follows the borrowed turn`);
				}
				const details = before.compaction.details as { piContext: string; windowId: string };
				assert.equal(details.piContext, "reset-v2");
				assert.match(before.compaction.summary, new RegExp(`Current context window id: ${details.windowId}`));
				const id = sm.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 100, details, true);
				const compactionEntry = sm.getEntry(id);
				assert.ok(compactionEntry && compactionEntry.type === "compaction");
				const event = { reason: !idle && reason !== "manual" ? "manual" : reason, willRetry: idle && reason === "overflow", compactionEntry };
				runHandlers(captured, "session_compact", event, ctx);
				runHandlers(captured, "session_compact", event, ctx);
				// Extension-requested resets resume after completion; native resets do not.
				if (reason !== "manual" && !idle) completeRequestedCompaction(ctx);
				assert.equal(captured.sent.filter((m) => m.message.customType !== internal.FALLBACK_TYPE).length, reason !== "manual" && !idle ? window + 1 : 0);
			}
		}
	}
});

test("threshold fallback borrows exactly one turn, then resets once and re-arms per window", async () => {
	const sm = manager();
	appendText(sm, "user", "long task history");
	const captured = makeExtension(sm);
	let compactions = 0;
	// The fallback turn runs while Pi is streaming; the hook is entered mid-run.
	const ctx = context(sm, () => { compactions++; }, undefined, false);
	assert.equal(captured.handlers.has("input"), false, "no user-input interception or replay");

	// Phase 1: the first automatic threshold crossing is cancelled and a steer is queued.
	const first = await runBeforeCompact(captured, ctx, 100, "threshold");
	assert.deepEqual(first, { cancel: true }, "first automatic entry cancels instead of resetting");
	assert.equal(captured.sent.length, 1, "exactly one fallback steer queued");
	assert.equal(captured.sent[0]?.message.customType, internal.FALLBACK_TYPE);
	assert.equal(captured.sent[0]?.options?.triggerTurn, true, "the fallback turn is triggered by Pi, not by input replay");
	assert.equal(captured.sent[0]?.message.display, true);
	assert.equal(compactions, 0, "no compaction requested while borrowing the turn");

	// The borrowed turn ends; agent_end only arms the allowance.
	runHandlers(captured, "agent_end", {}, ctx);
	assert.equal(compactions, 0, "agent_end does not itself compact");

	// Phase 2: the next automatic entry performs the real reset with no second steer.
	const second = await runBeforeCompact(captured, ctx, 100, "threshold");
	assert.ok(second && "compaction" in second, "the second entry resets for real");
	assert.equal(captured.sent.length, 1, "no second fallback turn");
	const details = second.compaction.details as { piContext: string; windowId: string };
	assert.equal(details.piContext, "reset-v2");
	const id = sm.appendCompaction(second.compaction.summary, second.compaction.firstKeptEntryId, 100, details, true);
	runHandlers(captured, "session_compact", { reason: "threshold", willRetry: false, compactionEntry: sm.getEntry(id) }, ctx);
	// If another compaction already completed, settling must not request a second one.
	runHandlers(captured, "agent_settled", {}, ctx);
	assert.equal(compactions, 0, "no extra ctx.compact() once another compaction reset successfully");

	// A completed reset re-arms the borrowed-turn phase for the next window, not before.
	const third = await runBeforeCompact(captured, ctx, 100, "threshold");
	assert.deepEqual(third, { cancel: true }, "the next window borrows one turn again");
	assert.equal(captured.sent.length, 2, "one fallback per window, never an unbounded loop");
});

test("overflow re-triggers the reset through ctx.compact() once, and manual/new_context never cancel", async () => {
	const sm = manager();
	appendText(sm, "user", "long task history");
	const captured = makeExtension(sm);
	let compactions = 0;
	const ctx = context(sm, () => { compactions++; }, undefined, false);

	// Overflow phase 1: cancel + steer.
	const first = await runBeforeCompact(captured, ctx, 100, "overflow");
	assert.deepEqual(first, { cancel: true }, "overflow also borrows a turn first");
	assert.equal(captured.sent.length, 1);
	assert.equal(captured.sent[0]?.message.customType, internal.FALLBACK_TYPE);
	runHandlers(captured, "agent_end", {}, ctx);
	assert.equal(compactions, 0, "agent_end alone does not re-trigger");

	// Pi's overflow guard blocks an automatic re-entry, so settling asks exactly once.
	runHandlers(captured, "agent_settled", {}, ctx);
	assert.equal(compactions, 1, "ctx.compact() re-triggers the reset after the fallback turn settles");
	runHandlers(captured, "agent_settled", {}, ctx);
	assert.equal(compactions, 1, "settling again does not double-request the reset");

	// The extension-requested compaction is allowed through without another steer.
	const second = await runBeforeCompact(captured, ctx, 100, "manual");
	assert.ok(second && "compaction" in second, "the requested reset performs the real compaction");
	assert.equal(captured.sent.length, 1, "no extra fallback steer");
	const details = second.compaction.details as { piContext: string; windowId: string };
	const id = sm.appendCompaction(second.compaction.summary, second.compaction.firstKeptEntryId, 100, details, true);
	runHandlers(captured, "session_compact", { reason: "manual", willRetry: false, compactionEntry: sm.getEntry(id) }, ctx);
	completeRequestedCompaction(ctx);
	assert.equal(captured.sent.length, 2, "fallback reset resumes with one continuation");

	// User /compact resets directly.
	const manual = await runBeforeCompact(captured, ctx, 100, "manual");
	assert.ok(manual && "compaction" in manual, "manual compaction is never intercepted");
	assert.equal(captured.sent.length, 2, "manual compaction sends nothing");

	// new_context requests its reset after the run settles.
	await call(captured, "new_context", {}, ctx);
	runHandlers(captured, "agent_end", {}, ctx);
	assert.equal(compactions, 1, "new_context waits for settled");
	runHandlers(captured, "agent_settled", {}, ctx);
	assert.equal(compactions, 2, "new_context still compacts through ctx.compact()");
	const explicit = await runBeforeCompact(captured, ctx, 100, "manual");
	assert.ok(explicit && "compaction" in explicit, "new_context reset is allowed");
	assert.equal(captured.sent.length, 2, "new_context never cancels or emits a fallback steer");
});

test("an idle pre-prompt automatic crossing resets directly instead of starting a nested run", async () => {
	// Pi's AgentSession.prompt() runs _checkCompaction() while idle, before submitting the
	// user's prompt. Borrowing a turn there would call sendCustomMessage -> _runAgentPrompt,
	// whose activeRun makes the pending Agent.prompt() reject with "Agent is already
	// processing a prompt". The extension must therefore never cancel an idle crossing.
	const sm = manager();
	appendText(sm, "user", "long task history");
	const captured = makeExtension(sm);
	const idle = context(sm, undefined, undefined, true);
	for (const reason of ["threshold", "overflow"] as const) {
		const result = await runBeforeCompact(captured, idle, 100, reason);
		assert.ok(result && "compaction" in result, `${reason}: idle crossing resets directly`);
	}
	assert.equal(captured.sent.length, 0, "no steer is queued while idle, so no nested run races the prompt");
});

test("remaining budget excludes the effective reserve, clamps at zero, and preserves unknown usage", async () => {
	const fixture = settingsFixture({
		reserveTokens: 16_384,
		project: { compaction: { reserveTokens: 32_768 } },
	});
	const sm = manager();
	const captured = makeExtension(sm);
	const readBudget = async (tokens: number | null, trusted = true) => {
		const ctx = context(sm, undefined, { tokens, contextWindow: 200_000, percent: tokens === null ? null : tokens / 2000 }, true, fixture.cwd, trusted);
		return resultJson<{ remaining_tokens: number | null }>(await call(captured, "get_context_remaining", {}, ctx)).remaining_tokens;
	};
	assert.equal(await readBudget(72_563), 94_669, "project reserve is subtracted from the reported 127437 physical tokens");
	assert.equal(await readBudget(167_232), 0, "at the reserve line");
	assert.equal(await readBudget(190_000), 0, "inside the reserve");
	assert.equal(await readBudget(210_000), 0, "over the physical window");
	assert.equal(await readBudget(null), null, "unknown usage remains unknown");
	const absent = context(sm, undefined, undefined, true, fixture.cwd);
	assert.equal(resultJson<{ remaining_tokens: number | null }>(await call(captured, "get_context_remaining", {}, absent)).remaining_tokens, null);
	const untrusted = context(sm, undefined, { tokens: 72_563, contextWindow: 200_000, percent: 36.2815 }, true, fixture.cwd, false);
	runHandlers(captured, "session_start", {}, untrusted);
	assert.equal(await readBudget(72_563, false), 111_053, "session start reloads the global reserve when the project is untrusted");
});

test("the reminder threshold derives from compaction.reserveTokens plus the pi-context reminder margin", async () => {
	const fixture = settingsFixture({
		reserveTokens: 100_000,
		global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 30_000 } },
	});
	const sm = manager();
	const captured = makeExtension(sm);
	const window = 300_000;
	const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);

	// reminder = 100000 + 30000. The borrowed automatic fallback has no token threshold of its own.
	assert.equal(await runContextHook(captured, at(130_001)), undefined, "nothing injected above the derived reminder");
	assert.equal(captured.sent.length, 0, "no guidance above the derived reminder");
	assert.equal(await runContextHook(captured, at(130_000)), undefined, "derived reminder crossing persists only");
	assert.equal(captured.sent.length, 1, "derived reminder fires");
	assert.match(String(captured.sent[0]?.message.content), /\b30000 tokens\b/, "derived reminder embeds the measured remaining count");
});

test("absent pi-context key or margins reproduce the default reminder threshold at Pi's default reserve", async () => {
	assert.equal(internal.DEFAULT_RESERVE_TOKENS, 16_384);
	assert.equal(internal.DEFAULT_RESERVE_TOKENS + internal.DEFAULT_REMINDER_MARGIN_TOKENS, 40_960);

	for (const [label, options] of [
		["absent key", { global: {} }],
		["absent margins", { global: { [internal.PI_CONTEXT_SETTINGS_KEY]: {} } }],
	] as const) {
		const fixture = settingsFixture(options);
		const sm = manager();
		const captured = makeExtension(sm);
		const window = 200_000;
		const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);
		const first = at(40_961);
		assert.equal(await runContextHook(captured, first), undefined, `${label}: nothing injected above the default reminder`);
		assert.equal(captured.sent.length, 0, `${label}: no guidance above the default reminder`);
		assert.equal(await runContextHook(captured, at(40_960)), undefined, `${label}: default reminder crossing persists only`);
		assert.equal(captured.sent.length, 1, `${label}: default reminder fires`);
		assert.match(String(captured.sent[0]?.message.content), /\b24576 tokens\b/, label);
		assert.equal(noticesOf(first).length, 0, `${label}: valid defaults warn nobody`);
	}
});

test("project pi-context reminder margin and reserve override global per key", async () => {
	const fixture = settingsFixture({
		reserveTokens: 20_000,
		global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 30_000 } },
		project: { compaction: { reserveTokens: 50_000 }, [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 40_000 } },
	});
	// Project reserve wins: reminder = 50000 + 40000 (project margin).
	const sm = manager();
	const captured = makeExtension(sm);
	const window = 300_000;
	const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);
	assert.equal(await runContextHook(captured, at(90_001)), undefined, "nothing injected above the project-derived reminder");
	assert.equal(captured.sent.length, 0);
	assert.equal(await runContextHook(captured, at(90_000)), undefined, "project-derived reminder crossing persists only");
	assert.equal(captured.sent.length, 1, "project reminder margin wins");
});

test("an untrusted project is ignored, so global pi-context margins apply", async () => {
	const fixture = settingsFixture({
		global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 30_000 } },
		project: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 40_000 } },
	});
	const sm = manager();
	const captured = makeExtension(sm);
	const window = 100_000;
	// Global reminder = 16384 + 30000 = 46384, not the project's 56384.
	const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd, false);
	assert.equal(await runContextHook(captured, at(56_000)), undefined, "untrusted project margin ignored; nothing injected");
	assert.equal(captured.sent.length, 0, "no guidance from the untrusted project margin");
	assert.equal(await runContextHook(captured, at(46_384)), undefined, "global margin fires instead");
	assert.equal(captured.sent.length, 1);
});

test("the reminder margin is re-read from settings.json on session_start", async () => {
	const fixture = settingsFixture({ global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 10_000 } } });
	const sm = manager();
	const captured = makeExtension(sm);
	const window = 100_000;
	const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);
	const guidance = () => captured.sent.filter((sent) => sent.message.customType === internal.GUIDANCE_TYPE);
	// Initial reminder = 16384 + 10000 = 26384; 35000 is above it, so nothing is persisted.
	runHandlers(captured, "session_start", { reason: "startup" }, at(0));
	assert.equal(await runContextHook(captured, at(35_000)), undefined);
	assert.equal(guidance().length, 0, "no guidance above the initial reminder");
	// Rewrite the global settings file, then session_start must pick up the new margin.
	writeJson(join(fixture.agentDir, "settings.json"), { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 40_000 } });
	runHandlers(captured, "session_start", { reason: "startup" }, at(0));
	// New reminder = 16384 + 40000 = 56384; 35000 is now below it.
	assert.equal(await runContextHook(captured, at(35_000)), undefined, "the crossing persists only");
	assert.equal(guidance().length, 1, "reminder margin re-read on session_start");
});

test("an invalid reminder margin degrades to its default with one warning and never throws", async () => {
	const fixture = settingsFixture({ global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 0 } } });
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm, undefined, undefined, true, fixture.cwd);
	assert.doesNotThrow(() => runHandlers(captured, "session_start", { reason: "startup" }, ctx));
	const notices = noticesOf(ctx);
	assert.equal(notices.length, 1, "one warning for the offending key");
	assert.equal(notices[0]?.type, "warning");
	assert.match(notices[0]?.message ?? "", /reminderMarginTokens/);
	assert.match(notices[0]?.message ?? "", /24576/);

	const window = 200_000;
	const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);
	// The degraded reminder is Pi's default reserve + default margin = 40960.
	assert.equal(await runContextHook(captured, at(40_961)), undefined, "nothing injected above the degraded reminder");
	assert.equal(await runContextHook(captured, at(40_960)), undefined, "degraded reminder uses its default");
	assert.equal(captured.sent.length, 2, "root boot plus degraded reminder");
	assert.equal(notices.length, 1, "warning stays one-time across handler calls");
});

test("the old threshold flags are no longer registered", () => {
	const captured = makeExtension(manager());
	assert.deepEqual(captured.flags, []);
});

test("the removed pre-prompt/turn_end fallback no longer exists; only session_before_compact borrows a turn", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	// The old graceful-fallback path registered both hooks and fired on a token threshold of its
	// own. It is gone: no fallback can be sent outside Pi's automatic compaction request.
	assert.equal(captured.handlers.has("before_agent_start"), false, "before_agent_start fallback removed");
	assert.equal(captured.handlers.has("turn_end"), false, "turn_end fallback removed");
	assert.equal(captured.handlers.has("input"), false, "no input copy/replay special case");
	assert.equal(captured.handlers.has("session_before_compact"), true, "session_before_compact is the sole entry point");

	// Even deep inside the old fallback band, nothing is sent until compaction is requested.
	const window = 200_000;
	const ctx = context(sm, undefined, { tokens: window - 24_576, percent: 0, contextWindow: window }, false);
	assert.equal(captured.sent.length, 0, "no fallback is sent before a compaction request");
	const before = await runBeforeCompact(captured, ctx, 100, "threshold");
	assert.deepEqual(before, { cancel: true }, "the automatic crossing borrows exactly one turn");
	assert.equal(captured.sent.length, 1);
	assert.equal(captured.sent[0]?.message.customType, internal.FALLBACK_TYPE);
	assert.equal(captured.sent[0]?.options?.triggerTurn, true);

	// The borrowed turn ends, and the next request performs the real reset without a second steer.
	runHandlers(captured, "agent_end", {}, ctx);
	const second = await runBeforeCompact(captured, ctx, 100, "threshold");
	assert.ok(second && "compaction" in second, "the second entry resets for real");
	assert.equal(captured.sent.length, 1, "one cancel, one steer, one real compaction");
});

test("ordinary new_context and calls inside fallback request one reset and start a fresh run", async () => {
	for (const reason of [undefined, "threshold", "overflow"] as const) {
		const sm = manager();
		appendText(sm, "user", "work to continue after reset");
		const captured = makeExtension(sm);
		let compactions = 0;
		const ctx = context(sm, () => { compactions++; }, undefined, false);
		if (reason) assert.deepEqual(await runBeforeCompact(captured, ctx, 100, reason), { cancel: true });
		const request = await call(captured, "new_context", {}, ctx);
		assert.equal(request.terminate, true, "end the current tool loop before reset");
		runHandlers(captured, "agent_end", {}, ctx);
		assert.equal(compactions, 0, "no request before settled");
		runHandlers(captured, "agent_settled", {}, ctx);
		runHandlers(captured, "agent_settled", {}, ctx);
		assert.equal(compactions, 1, "explicit reset consumes the fallback allowance");
		const before = await runBeforeCompact(captured, ctx, 100, "manual");
		assert.ok(before && "compaction" in before);
		const id = sm.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 100, before.compaction.details, true);
		const event = { willRetry: false, compactionEntry: sm.getEntry(id) };
		runHandlers(captured, "session_compact", event, ctx);
		runHandlers(captured, "session_compact", event, ctx);
		runHandlers(captured, "agent_settled", {}, ctx);
		assert.equal(compactions, 1, "no second reset after success");
		completeRequestedCompaction(ctx);
		const continuations = captured.sent.filter((sent) => sent.message.customType !== internal.FALLBACK_TYPE);
		assert.equal(continuations.length, 1, "explicit request still owns exactly one continuation");
		const continuation = continuations[0]!;
		assert.equal(continuation.options?.triggerTurn, true);
		// Exercise Pi's real custom-message routing after the old run has settled.
		// The prompt endpoint is stubbed; no provider request is made.
		const prompts: unknown[] = [];
		const runtime = {
			isStreaming: false,
			_runAgentPrompt: async (message: unknown) => { prompts.push(message); },
			agent: { steer: () => assert.fail("continuation must start a run, not wait in a steer queue") },
		};
		await AgentSession.prototype.sendCustomMessage.call(runtime as unknown as AgentSession, continuation.message, continuation.options);
		assert.equal(prompts.length, 1, "Pi starts a fresh prompt without another user message");
	}
});

test("new_context can reset successive windows without duplicate compactions or continuations", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	let compactions = 0;
	const ctx = context(sm, () => { compactions++; });
	for (let window = 0; window < 2; window++) {
		appendText(sm, "user", `window ${window}`);
		const request = resultJson<{ status: string }>(await call(captured, "new_context", {}, ctx));
		assert.equal(request.status, "rollover_requested");
		runHandlers(captured, "agent_end", {}, ctx);
		runHandlers(captured, "agent_end", {}, ctx);
		assert.equal(compactions, window, "agent_end only arms the reset");
		runHandlers(captured, "agent_settled", {}, ctx);
		runHandlers(captured, "agent_settled", {}, ctx);
		assert.equal(compactions, window + 1);
		const before = await runBeforeCompact(captured, ctx, 100);
		assert.ok(before && "compaction" in before);
		const id = sm.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 100, before.compaction.details, true);
		const event = { willRetry: false, compactionEntry: sm.getEntry(id) };
		runHandlers(captured, "session_compact", event, ctx);
		runHandlers(captured, "session_compact", event, ctx);
		completeRequestedCompaction(ctx);
		assert.equal(captured.sent.length, window + 1, "one continuation per explicit reset, and no hint");
	}
});


test("boot and guidance deduplicate across extension reload while a new branch can receive them", () => {
	const sm = manager();
	appendText(sm, "user", "branch anchor");
	const anchor = sm.getLeafId()!;
	const ctx = context(sm, undefined, { tokens: 190_000, percent: 95, contextWindow: 200_000 });
	const first = makeExtension(sm);
	runHandlers(first, "session_start", {}, ctx);
	runHandlers(first, "context", {}, ctx);
	assert.equal(first.sent.length, 2);
	const reloaded = makeExtension(sm);
	runHandlers(reloaded, "session_start", {}, ctx);
	runHandlers(reloaded, "context", {}, ctx);
	assert.equal(reloaded.sent.length, 0, "persisted messages survive runtime replacement");
	sm.branch(anchor);
	runHandlers(first, "session_tree", {}, ctx);
	runHandlers(first, "context", {}, ctx);
	assert.equal(first.sent.length, 3, "same runtime releases the previous branch's reminder reservation");
	const fork = makeExtension(sm);
	runHandlers(fork, "session_start", {}, ctx);
	runHandlers(fork, "context", {}, ctx);
	assert.equal(fork.sent.length, 1, "sibling boot is created; this branch's reminder already exists");
});

test("malformed persisted note timestamps are ignored without poisoning valid notes or boot rendering", async () => {
	const sm = manager();
	const ctx = context(sm);
	const extension = makeExtension(sm);
	await call(extension, "notes_write_file", { path: "good.md", text: "keep me" }, ctx);
	for (const time of [NaN, Infinity, -Infinity, 9e15]) {
		sm.appendCustomEntry(internal.NOTE_TYPE, { op: "write", path: "good.md", text: "corrupted", createdAt: time, updatedAt: time });
	}
	assert.equal(notesFromSession(ctx).get("good.md")?.text, "keep me");
	runHandlers(extension, "session_start", {}, ctx);
	assert.ok(JSON.stringify(extension.sent).includes("keep me"));
	assert.ok(!JSON.stringify(extension.sent).includes("NaN"));
});


test("JSONL reload retains once-per-window boot and reminder without runtime memory", () => {
	const sm = manager(true);
	const first = makeExtension(sm);
	const usage = { tokens: 190_000, percent: 95, contextWindow: 200_000 };
	const ctx = context(sm, undefined, usage);
	runHandlers(first, "session_start", {}, ctx);
	runHandlers(first, "context", {}, ctx);
	appendText(sm, "assistant", "flush the persisted session");
	const path = sm.getSessionFile();
	assert.ok(path);
	const restored = manager();
	restored.setSessionFile(path);
	const loaded = makeExtension(restored);
	const loadedCtx = context(restored, undefined, usage);
	runHandlers(loaded, "session_start", {}, loadedCtx);
	runHandlers(loaded, "context", {}, loadedCtx);
	assert.equal(loaded.sent.length, 0);
	const messages = restored.getBranch().filter((entry) => entry.type === "custom_message");
	assert.equal(messages.filter((entry) => entry.customType === internal.BOOT_TYPE).length, 1);
	assert.equal(messages.filter((entry) => entry.customType === internal.GUIDANCE_TYPE).length, 1);
});


test("fallback guidance supersedes the early reminder when usage jumps across both thresholds", async () => {
	const sm = manager();
	appendText(sm, "user", "ongoing work");
	const captured = makeExtension(sm);
	const ctx = context(sm, undefined, { tokens: 199_000, percent: 99.5, contextWindow: 200_000 }, false);
	assert.deepEqual(await runBeforeCompact(captured, ctx, 199_000, "threshold"), { cancel: true });
	runHandlers(captured, "context", {}, ctx);
	assert.deepEqual(captured.sent.map((entry) => entry.message.customType), [internal.FALLBACK_TYPE]);
	const reloaded = makeExtension(sm);
	runHandlers(reloaded, "context", {}, ctx);
	assert.equal(reloaded.sent.length, 0, "persisted fallback also suppresses a late reminder after reload");
});


test("fallback suppression is branch-local and survives toggling without becoming permanent", async () => {
	const sm = manager();
	appendText(sm, "user", "branch anchor");
	const anchor = sm.getLeafId()!;
	const captured = makeExtension(sm);
	const ctx = context(sm, undefined, { tokens: 199_000, percent: 99.5, contextWindow: 200_000 }, false);
	await runBeforeCompact(captured, ctx, 199_000, "threshold");
	const fallbackLeaf = sm.getLeafId()!;
	await runCommand(captured, "pi-context", "off", ctx);
	await runCommand(captured, "pi-context", "on", ctx);
	runHandlers(captured, "context", {}, ctx);
	assert.equal(captured.sent.length, 1, "toggle does not revive an obsolete reminder");
	sm.branch(anchor);
	runHandlers(captured, "session_tree", {}, ctx);
	runHandlers(captured, "context", {}, ctx);
	assert.equal(captured.sent.length, 2);
	assert.equal(captured.sent[1].message.customType, internal.GUIDANCE_TYPE, "sibling without fallback still needs its early reminder");
	sm.branch(fallbackLeaf);
	runHandlers(captured, "session_tree", {}, ctx);
	runHandlers(captured, "context", {}, ctx);
	assert.equal(captured.sent.length, 2, "returning to fallback branch remains suppressed");
});
