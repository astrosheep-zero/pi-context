import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type RegisteredCommand,
	SessionManager,
	SettingsManager,
	type SessionBoundaryDraft,
	type SessionBeforeCompactEvent,
	type ToolDefinition,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import piContext, { historyFromSession, internal, notesFromSession } from "../src/index.js";
import { bootBlock } from "../src/prompts.js";
import { localIso } from "../src/notes/model.js";
import { physicalPath } from "../src/notes/paths.js";
import { listNotes } from "../src/notes/store.js";
import { middleTruncate, page, TOOL_OUTPUT_MAX_BYTES } from "../src/tool-output.js";
import { CONTINUATION_TYPE, NOTE_TYPE, MAX_NOTE_PATH_BYTES } from "../src/protocol.js";

// Settings fixtures live in temp directories. PI_CODING_AGENT_DIR is redirected for the
// whole test process so the extension's SettingsManager.create(ctx.cwd, undefined, ...)
// never reads the user's real ~/.pi. beforeEach points it back at an empty fixture.
const DEFAULT_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-context-agent-"));
const DEFAULT_CWD = mkdtempSync(join(tmpdir(), "pi-context-cwd-"));
process.env.PI_CODING_AGENT_DIR = DEFAULT_AGENT_DIR;
// Notes are real files now: every test process points the store at a throwaway root so no
// test can read or write the user's ~/.agents/notes/pi.
const DEFAULT_NOTES_ROOT = mkdtempSync(join(tmpdir(), "pi-context-notes-"));
process.env.PI_NOTES_HOME = DEFAULT_NOTES_ROOT;

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
	process.env.PI_NOTES_HOME = mkdtempSync(join(tmpdir(), "pi-context-notes-"));
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
	contextMessages: unknown[];
	flags: string[];
};

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

type CompactionHookResult =
	| { cancel: true }
	| { compaction: { summary: string; firstKeptEntryId: string | null; tokensBefore: number; details?: unknown } }
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
	const captured: Captured = { tools: new Map(), handlers: new Map(), commands: new Map(), sent: [], contextMessages: [], flags: [] };
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
	model?: string,
): ExtensionContext {
	const notices: Notice[] = [];
	const compactionRequests: Array<Parameters<ExtensionContext["compact"]>[0]> = [];
	const fake: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "compact" | "isIdle" | "hasPendingMessages" | "cwd" | "isProjectTrusted" | "ui" | "model"> = {
		sessionManager,
		model: model ? ({ id: model } as unknown as ExtensionContext["model"]) : undefined,
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

function sentOf(captured: Captured, customType: string): SentMessage[] {
	return captured.sent.filter((sent) => sent.message.customType === customType);
}

export async function call(
	captured: Captured,
	name: string,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const tool = captured.tools.get(name);
	assert.ok(tool, `registered ${name}`);
	// Most pre-redesign coverage names session notes by their bare address. Keep these old
	// fixture call sites readable while routing the direct tool invocation through its new
	// address-shaped input; contract-specific tests below pass address themselves.
	const noteCall = name === "notes_write" || name === "notes_edit" || name === "notes_read";
	if (noteCall && "path" in params && !("address" in params)) {
		const { path, scope, ...rest } = params;
		assert.equal(typeof path, "string", "legacy note fixture path is a string");
		const address = scope === "project" ? `@project/${path}` : scope === "human" ? `@human/${path}` : path;
		return tool.execute("call-1", { ...rest, address }, new AbortController().signal, () => {}, ctx) as Promise<AgentToolResult<unknown>>;
	}
	if ((name === "notes_list" || name === "notes_search") && params.scope === "human") {
		const { scope: _scope, pattern, ...rest } = params;
		return tool.execute("call-1", { ...rest, pattern: `@human/${typeof pattern === "string" ? pattern : "**"}` }, new AbortController().signal, () => {}, ctx) as Promise<AgentToolResult<unknown>>;
	}
	if ((name === "notes_list" || name === "notes_search") && params.scope === "session") {
		const { scope: _scope, pattern, ...rest } = params;
		return tool.execute("call-1", { ...rest, pattern: typeof pattern === "string" ? pattern : "*.md" }, new AbortController().signal, () => {}, ctx) as Promise<AgentToolResult<unknown>>;
	}
	return tool.execute("call-1", params, new AbortController().signal, () => {}, ctx) as Promise<AgentToolResult<unknown>>;
}

export function resultJson<T>(result: AgentToolResult<unknown>): T {
	const text = result.content[0];
	assert.ok(text && text.type === "text", "tool result carries text");
	const value = JSON.parse(text.text) as Record<string, unknown>;
	const suffix = (address: string) => address.startsWith("@project/") ? address.slice("@project/".length) : address.startsWith("@human/") ? address.slice("@human/".length) : address;
	const legacyPath = (row: Record<string, unknown>) => {
		if (typeof row.address === "string" && row.path === undefined) Object.defineProperty(row, "path", { value: suffix(row.address), enumerable: false });
	};
	legacyPath(value);
	if (Array.isArray(value.files)) for (const file of value.files) if (file && typeof file === "object") legacyPath(file as Record<string, unknown>);
	return value as T;
}

/** Assert the delivered wire text fits the tool-output budget, header included for raw reads. */
export function assertWithinBudget(result: AgentToolResult<unknown>, message: string): void {
	const text = result.content[0];
	const bytes = text && text.type === "text" ? Buffer.byteLength(text.text, "utf8") : 0;
	assert.ok(bytes <= TOOL_OUTPUT_MAX_BYTES, `${message}: ${bytes} bytes over the ${TOOL_OUTPUT_MAX_BYTES}-byte budget`);
}

/** Decoded raw read response using the shared READ WINDOW grammar. */
export type ReadWindow = {
	header: string;
	content: string;
	offset_chars: number;
	total_chars: number;
	next_offset_chars: number | null;
	details: Record<string, unknown>;
};

/** Decode either raw read without including its shared metadata block in the payload. */
export function resultRead(result: AgentToolResult<unknown>): ReadWindow {
	const text = result.content[0];
	assert.ok(text && text.type === "text", "read result carries text");
	const block = /^(--- READ WINDOW ---\n(?:[a-z_]+: [^\n]*\n)+chars: \[(\d+),(\d+)\) of (\d+)\nnext_offset_chars: (null|\d+)\n)\n/.exec(text.text);
	assert.ok(block, "raw read carries one READ WINDOW block followed by exactly one blank line");
	const header = block[1]!;
	const content = text.text.slice(block[0].length);
	const offset_chars = Number(block[2]);
	const end = Number(block[3]);
	const total_chars = Number(block[4]);
	const next_offset_chars = block[5] === "null" ? null : Number(block[5]);
	assert.equal(Array.from(content).length, end - offset_chars, "READ WINDOW range matches the delivered payload");
	return { header, content, offset_chars, total_chars, next_offset_chars, details: (result.details ?? {}) as Record<string, unknown> };
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

async function runManualCompact(captured: Captured, ctx: ExtensionContext): Promise<CompactionHookResult> {
	const handler = captured.handlers.get("session_before_compact")?.[0];
	assert.ok(handler, "session_before_compact handler registered");
	const event: SessionBeforeCompactEvent = {
		type: "session_before_compact",
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		branchEntries: ctx.sessionManager.getBranch(),
		preparation: {
			firstKeptEntryId: "",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 0,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
		},
	};
	return (await handler(event as never, ctx)) as CompactionHookResult;
}

export function runHandlers(captured: Captured, name: string, event: unknown, ctx: ExtensionContext): void {
	const isIdle = ctx.isIdle;
	if (name === "agent_settled") ctx.isIdle = () => true;
	try {
		for (const handler of captured.handlers.get(name) ?? []) handler(event as never, ctx);
	} finally { ctx.isIdle = isIdle; }
}

export async function runHandlersAsync(captured: Captured, name: string, event: unknown, ctx: ExtensionContext): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of captured.handlers.get(name) ?? []) results.push(await handler(event as never, ctx));
	return results;
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
		waitForIdle: async () => {},
		ui: { notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }) },
	}) as unknown as ExtensionCommandContext;
	await command.handler(args, cmdCtx);
	return notices;
}

type ContextHookResult = { messages: unknown[] } | undefined;

async function runContextHook(captured: Captured, ctx: ExtensionContext, eventOverride: Record<string, unknown> = {}): Promise<ContextHookResult> {
	const handlers = captured.handlers.get("context") ?? [];
	assert.ok(handlers.length > 0, "context handler registered");
	// Pi invokes every registered context handler in order; budget and warning each own one.
	let result: ContextHookResult;
	for (const handler of handlers) {
		const returned = (await handler({ type: "context", messages: [], ...eventOverride } as never, ctx)) as ContextHookResult;
		if (returned !== undefined) {
			captured.contextMessages.push(...returned.messages);
			result = result ? { messages: [...result.messages, ...returned.messages] } : returned;
		}
	}
	return result;
}

export async function runContextWithSystemHook(
	captured: Captured,
	ctx: ExtensionContext,
	messages: unknown[],
): Promise<ContextHookResult> {
	const handlers = captured.handlers.get("context_with_system") ?? [];
	assert.ok(handlers.length > 0, "context_with_system handler registered");
	let result: ContextHookResult;
	for (const handler of handlers) {
		const returned = (await handler({ type: "context_with_system", messages } as never, ctx)) as ContextHookResult;
		if (returned !== undefined) {
			captured.contextMessages.push(...returned.messages);
			result = result ? { messages: [...result.messages, ...returned.messages] } : returned;
		}
	}
	return result;
}

async function commitTurnEndBoundary(captured: Captured, sessionManager: SessionManager, ctx: ExtensionContext): Promise<{ entries: SessionBoundaryDraft[]; continue: boolean }> {
	let entries: SessionBoundaryDraft[] = [];
	let shouldContinue = false;
	const event: TurnEndEvent = {
		type: "turn_end",
		entries,
		continue: false,
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
		outcome: "completed",
		turnIndex: 0,
		message: { role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() } as unknown as AgentMessage,
		toolResults: [],
		messageEntryId: "assistant-entry",
		toolResultEntryIds: [],
	};
	for (const handler of captured.handlers.get("turn_end") ?? []) {
		event.entries = entries;
		const result = (await handler(event as never, ctx)) as { entries?: SessionBoundaryDraft[]; continue?: boolean } | undefined;
		if (result?.entries !== undefined) entries = result.entries;
		if (result?.continue !== undefined) shouldContinue = result.continue;
	}
	for (const entry of entries) {
		switch (entry.type) {
			case "custom":
				sessionManager.appendCustomEntry(entry.customType, entry.data);
				break;
			case "custom_message":
				sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
				break;
			case "compaction":
				sessionManager.appendCompaction(entry.summary, entry.firstKeptEntryId, 0, entry.details, true, entry.usage);
				break;
			case "context_edit":
				sessionManager.appendContextEdit(entry.targetId, entry.replacement);
				break;
		}
	}
	return { entries, continue: shouldContinue };
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

test("schemas cover the History/Notes actions plus reset controls", () => {
	const captured = makeExtension(manager());
	for (const name of [
		"history_windows", "history_list", "history_read", "history_search",
		"notes_list", "notes_read", "notes_search", "notes_edit", "notes_write",
		"wipe_memory", "get_context_remaining",
	]) {
		const tool = captured.tools.get(name);
		assert.equal(objectSchema(tool)?.type, "object", name);
	}
	assert.equal(objectSchema(captured.tools.get("history_read"))?.required?.includes("item_id"), true);
	// The write surface requires its body; the edit surface requires its anchors.
	const writeSchema = captured.tools.get("notes_write")?.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined;
	assert.ok(writeSchema?.properties?.content, "notes_write exposes content");
	assert.ok(writeSchema?.properties?.address, "notes_write exposes address");
	assert.equal(writeSchema?.properties?.scope, undefined, "notes_write has no scope parameter");
	assert.deepEqual([...(writeSchema?.required ?? [])].sort(), ["address", "content"], "notes_write requires address and content");
	const editSchema = captured.tools.get("notes_edit")?.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined;
	assert.ok(editSchema?.properties?.edits, "notes_edit exposes edits");
	assert.equal(editSchema?.properties?.scope, undefined, "notes_edit has no scope parameter");
	assert.deepEqual([...(editSchema?.required ?? [])].sort(), ["address"], "notes_edit requires only address; edits are optional for metadata-only updates");
	// Both read tools are the same character window: identical params, one offset sugar, no line surface.
	for (const name of ["notes_read", "history_read"]) {
		const schema = captured.tools.get(name)?.parameters as { properties?: Record<string, { minimum?: number; maximum?: number }> } | undefined;
		assert.ok(schema?.properties?.offset_chars, `${name} exposes offset_chars`);
		assert.ok(schema?.properties?.limit_chars, `${name} exposes limit_chars`);
		assert.equal(schema?.properties?.offset_chars?.minimum, undefined, `${name} accepts negative offset_chars`);
		assert.equal(schema?.properties?.limit_chars?.maximum, 50000, `${name} caps limit_chars at 50000`);
	}
	const noteReadSchema = captured.tools.get("notes_read")?.parameters as { properties?: Record<string, unknown> } | undefined;
	assert.deepEqual(Object.keys(noteReadSchema?.properties ?? {}).sort(), ["address", "limit_chars", "offset_chars"], "notes_read exposes exactly address and character-window params");
	for (const name of ["notes_write", "notes_edit", "notes_read", "notes_list", "notes_search"]) {
		const schema = captured.tools.get(name)?.parameters as { properties?: Record<string, unknown>; additionalProperties?: boolean } | undefined;
		assert.equal(schema?.properties?.scope, undefined, `${name} has no scope property`);
		assert.equal(schema?.additionalProperties, false, `${name} rejects scope as an additional property`);
	}
});

test("notes_list is most-recently-updated first across merged scopes", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const put = (scope: "session" | "project" | "human", path: string, updated: number) => {
		const file = physicalPath(scope, path, ctx);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `---\nscope: ${scope}\norigin: self\nstatus: active\nstale: false\ncreated_at: ${localIso(updated - 1000)}\nupdated_at: ${localIso(updated)}\nlast_accessed: ${localIso(updated)}\naccess_count: 0\n---\n\nbody`);
	};
	const base = 1_700_000_000_000;
	put("session", "b.md", base + 10);
	put("session", "a.md", base + 10);
	put("project", "c.md", base + 5);
	put("human", "e.md", base + 20);
	const files = async (params: Record<string, unknown>) =>
		resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_list", params, ctx)).files;
	assert.deepEqual((await files({})).map((file) => file.address), ["@human/e.md", "a.md", "b.md", "@project/c.md"], "updated_at descending with address ascending as the tiebreak");
	// A same-path pair in two scopes keeps both rows; equal timestamps tie-break by scope name.
	put("human", "a.md", base + 10);
	assert.deepEqual((await files({})).filter((file) => file.address.endsWith("a.md")).map((file) => file.address), ["@human/a.md", "a.md"], "equal timestamps tie-break by full address");
	assert.deepEqual((await files({ pattern: "*.md" })).map((file) => file.address), ["a.md", "b.md"], "a bare pattern narrows to the session home");
});

test("notes are real files that persist across sessions and round-trip Unicode", async () => {
	const original = manager();
	const captured = makeExtension(original);
	const ctx = context(original);
	await call(captured, "notes_write", { path: "checkpoint/进度.md", content: "第一行\nneedle Café", scope: "human" }, ctx);

	// A brand-new session over the same physical root sees the human note: nothing is replayed
	// from session entries, the file itself is the durable artifact.
	const restored = manager();
	const restoredCaptured = makeExtension(restored);
	const restoredCtx = context(restored);
	const rawRead = await call(restoredCaptured, "notes_read", { path: "checkpoint/进度.md", scope: "human", offset_chars: -4 }, restoredCtx);
	const read = resultRead(rawRead);
	assert.equal(read.details.address, "@human/checkpoint/进度.md");
	assert.equal(read.content, "Café", "a negative offset reads the body tail in one call");
	const searched = resultJson<{ files: Array<{ path: string; created_at: unknown; updated_at: unknown; matches: Array<{ line: number }> }> }>(
		await call(restoredCaptured, "notes_search", { query: "Café", scope: "human" }, restoredCtx),
	);
	assert.equal(searched.files[0]?.matches[0]?.line, 2);
	const listedFiles = resultJson<{ files: Array<{ path: string; created_at: unknown; updated_at: unknown }> }>(
		await call(restoredCaptured, "notes_list", { pattern: "checkpoint/**", scope: "human" }, restoredCtx),
	);
	assert.equal(listedFiles.files.length, 1, "glob ** crosses into the checkpoint directory");
	assert.equal(listedFiles.files[0]?.path, "checkpoint/进度.md");
	// A single-segment * never crosses `/`, so a nested-only store matches nothing at the root.
	const rootOnly = resultJson<{ files: Array<{ path: string }> }>(
		await call(restoredCaptured, "notes_list", { pattern: "*", scope: "human" }, restoredCtx)
	);
	assert.equal(rootOnly.files.length, 0, "glob * stays within one segment");
	assert.equal(searched.files[0]?.created_at, listedFiles.files[0]?.created_at, "note tools agree on the timestamp format");
	assert.equal(searched.files[0]?.updated_at, listedFiles.files[0]?.updated_at);
	await assert.rejects(() => call(captured, "notes_write", { path: "../escape", content: "x" }, ctx), /unsupported component/);
});

test("stale lifecycle: writes and metadata-only edits close and revive a note", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm);

	await call(captured, "notes_write", { path: "journal.md", content: "log line" }, ctx);

	// metadata-only: content unchanged, flag set, applied 0
	const markOnly = resultJson<{ address: string; applied: number; diff: string }>(await call(captured, "notes_edit", { path: "journal.md", stale: true }, ctx));
	assert.equal(markOnly.applied, 0);
	assert.equal(listNotes(ctx, { scope: "session" })[0]?.meta.stale, true);
	assert.equal(resultRead(await call(captured, "notes_read", { path: "journal.md" }, ctx)).content.endsWith("log line"), true, "mark-only leaves content unchanged");

	// explicit revive
	const revived = resultJson<{ address: string; applied: number; diff: string }>(await call(captured, "notes_edit", { path: "journal.md", stale: false }, ctx));
	assert.equal(listNotes(ctx, { scope: "session" })[0]?.meta.stale, false, "stale:false revives");

	// write+stale closure then plain write revival
	await call(captured, "notes_write", { path: "journal.md", content: "final", stale: true }, ctx);
	assert.equal(listNotes(ctx, { scope: "session" })[0]?.meta.stale, true);
	await call(captured, "notes_write", { path: "journal.md", content: "reopened" }, ctx);
	assert.equal(listNotes(ctx, { scope: "session" })[0]?.meta.stale, false, "writing without stale revives");

	// metadata-only on a missing path is the typed not-found arm
	const missing = resultJson<{ error?: string }>(await call(captured, "notes_edit", { path: "missing.md", stale: true }, ctx));
	assert.equal(missing.error, "note not found");
});

test("notes tools stay usable while a dream holds the lock", async () => {
	// A live dream lock is not a general lock: the awake notes tools never consult it.
	writeFileSync(join(process.env.PI_NOTES_HOME!, ".dream.lock"), String(process.pid));
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm);
	const written = resultJson<{ address?: string }>(await call(captured, "notes_write", { path: "during-dream.md", content: "awake" }, ctx));
	assert.equal(written.address, "during-dream.md");
	const edited = resultJson<{ applied?: number }>(await call(captured, "notes_edit", { path: "during-dream.md", edits: [{ oldText: "awake", newText: "still awake" }] }, ctx));
	assert.equal(edited.applied, 1, "notes_edit still applies while a dream lock is held");
});

test("the boot notes index excludes stale notes while list, read, and search still see them", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm);

	await call(captured, "notes_write", { path: "fresh.md", content: "fresh content" }, ctx);
	await call(captured, "notes_write", { path: "old.md", content: "stale content", stale: true }, ctx);

	runHandlers(captured, "session_start", {}, ctx);
	const boot = captured.sent[0];
	const text = typeof boot?.message.content === "string" ? boot.message.content : "";
	assert.ok(text.includes("fresh.md"), "the fresh note is indexed");
	assert.equal(text.includes("old.md"), false, "the stale note leaves the boot index");
	assert.equal(text.includes("stale content"), false, "the stale note's body is absent from boot");

	const listed = resultJson<{ files: Array<{ path: string; stale: boolean }> }>(await call(captured, "notes_list", {}, ctx));
	assert.equal(listed.files.find((file) => file.path === "old.md")?.stale, true, "list carries the stale flag");
	assert.equal(listed.files.find((file) => file.path === "fresh.md")?.stale, false);

	// stale notes are still readable and searchable
	const read = resultRead(await call(captured, "notes_read", { path: "old.md" }, ctx));
	assert.ok(read.content.endsWith("stale content"));
	const searched = resultJson<{ files: Array<{ path: string }> }>(await call(captured, "notes_search", { query: "stale content" }, ctx));
	assert.equal(searched.files[0]?.path, "old.md");
});

test("the boot notes index omits itself when every note is stale", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm);

	await call(captured, "notes_write", { path: "done.md", content: "finished", stale: true }, ctx);
	runHandlers(captured, "session_start", {}, ctx);
	const text = typeof captured.sent[0]?.message.content === "string" ? captured.sent[0].message.content : "";
	assert.equal(text.includes("done.md"), false, "no stale note is indexed");
	assert.equal(text.includes("finished"), false, "the stale note's body is absent from boot");
	assert.ok(text.includes(internal.CONTEXT_WINDOW_PROTOCOL_OPEN_TAG), "the rest of the boot block still renders");
});

test("the boot block gives awake agents the notes-home file layout", () => {
	const session = manager();
	const rendered = bootBlock(context(session), "pcw:test:root", undefined, false);
	assert.equal(rendered.includes(process.env.PI_NOTES_HOME ?? ""), false, "the absolute notes home is never exposed");
	assert.match(rendered, /bare <vpath>.*@project\/<vpath>.*@human\/<vpath>/);
});

test("the boot block keeps fresh human and project maps resident, never a session map", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "MAP.md", content: "MAP: session" }, ctx);
	await call(captured, "notes_write", { address: "@project/MAP.md", content: "MAP: project" }, ctx);
	await call(captured, "notes_write", { address: "@human/MAP.md", content: "MAP: human" }, ctx);
	const rendered = bootBlock(ctx, "pcw:test:root", undefined, false);
	assert.ok(rendered.includes("MAP: human"));
	assert.ok(rendered.includes("MAP: project"));
	assert.equal(rendered.includes("MAP: session"), false);
	assert.ok(rendered.indexOf("MAP: human") < rendered.indexOf("MAP: project"), "human map precedes project map");
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
		const result = resultJson<{ items: Array<{ item_id: string; truncated_content: string }>; next_cursor: number | null }>(await call(captured, "history_list", { recent_first: false, max_chars_per_item: 1200, cursor }, ctx));
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
		historyPages.push(...result.items); next = result.next_cursor; if (next !== null) cursor = next;
	}
	assert.deepEqual(historyPages.filter((item) => historyIds.includes(item.item_id)).map((item) => item.item_id), historyIds);
	const search = resultJson<{ items: Array<unknown>; next_cursor: number | null }>(await call(captured, "history_search", { query: "历史内容", recent_first: false, max_chars_per_item: 50_000 }, ctx));
	assert.ok(Buffer.byteLength(JSON.stringify(search), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
	assert.notEqual(search.next_cursor, null);
	const searchPages: Array<{ item_id: string }> = [];
	let searchOffset = 0;
	let searchNext: number | null = 0;
	while (searchNext !== null) {
		const result = resultJson<{ items: Array<{ item_id: string }>; next_cursor: number | null }>(await call(captured, "history_search", { query: "历史内容", recent_first: false, max_chars_per_item: 1200, cursor: searchOffset }, ctx));
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
		searchPages.push(...result.items); searchNext = result.next_cursor; if (searchNext !== null) searchOffset = searchNext;
	}
	assert.equal(searchPages.length, 13);
	assert.equal(searchNext, null);
	const readParts: string[] = [];
	let readOffset = 0;
	let readNext: number | null = 0;
	while (readNext !== null) {
		const raw = await call(captured, "history_read", { window_id: historyFromSession(ctx)[0]!.windowId, item_id: historyIds[0], offset_chars: readOffset, limit_chars: 12000 }, ctx);
		assertWithinBudget(raw, `history_read page at ${readOffset}`);
		const result = resultRead(raw);
		readParts.push(result.content); readNext = result.next_offset_chars; if (readNext !== null) readOffset = readNext;
	}
	assert.equal(readParts.join(""), historyText);

	for (let index = 0; index < 100; index++) {
		await call(captured, "notes_write", { path: `page-${"x".repeat(120)}-${index}.md`, content: Array.from({ length: 1000 }, (_, line) => `needle ${line} ${"z".repeat(30)}`).join("\n") }, ctx);
	}
	const listPages: string[] = [];
	let listOffset = 0;
	let listNext: number | null = 0;
	while (listNext !== null) {
		const result = resultJson<{ files: Array<{ path: string }>; next_cursor: number | null }>(await call(captured, "notes_list", { max_results: 300, cursor: listOffset }, ctx));
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
		listPages.push(...result.files.map((file) => file.path)); listNext = result.next_cursor; if (listNext !== null) listOffset = listNext;
	}
	assert.deepEqual([...listPages].sort((a, b) => a.localeCompare(b)), Array.from({ length: 100 }, (_, index) => `page-${"x".repeat(120)}-${index}.md`).sort((a, b) => a.localeCompare(b)));
	assert.equal(listNext, null);
	const searchFiles: Array<{ path: string; matches: Array<{ line: number; text: string }> }> = [];
	let notesSearchOffset = 0;
	let notesSearchNext: number | null = 0;
	while (notesSearchNext !== null) {
		const result = resultJson<{ files: Array<{ path: string; matches: Array<{ line: number; text: string }> }>; next_cursor: number | null }>(await call(captured, "notes_search", { query: "needle", max_matches_per_file: 100, max_files: 300, cursor: notesSearchOffset }, ctx));
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
		searchFiles.push(...result.files); notesSearchNext = result.next_cursor; if (notesSearchNext !== null) notesSearchOffset = notesSearchNext;
	}
	assert.equal(searchFiles.length, 100); assert.equal(notesSearchNext, null);
	const bodyText = Array.from({ length: 1000 }, (_, line) => `needle ${line} ${"z".repeat(30)}`).join("\n");
	const noteParts: string[] = [];
	let noteOffset = 0;
	let noteNext: number | null = 0;
	while (noteNext !== null) {
		const raw = await call(captured, "notes_read", { path: `page-${"x".repeat(120)}-0.md`, offset_chars: noteOffset }, ctx);
		assertWithinBudget(raw, `notes_read page at ${noteOffset}`);
		const result = resultRead(raw);
		// The window is a plain prefix of the file, so the pages join by plain concatenation.
		noteParts.push(result.content); noteNext = result.next_offset_chars; if (noteNext !== null) noteOffset = noteNext;
	}
	const joined = noteParts.join("");
	assert.ok(joined.startsWith("---\n"), "the frontmatter is delivered first");
	assert.ok(joined.endsWith(bodyText), "cursor-following reconstructs the body");
	assert.equal(noteNext, null);
});

test("a page cap limits the page, not the enumerable set: cursors stay truthful past the cap", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	for (let index = 0; index < 60; index++) {
		appendText(session, "user", `entry-${index}`);
		appendText(session, "assistant", `reply-${index}`);
	}

	// history_list: 120 items with limit 50 page as 50/50/20, null only at the true end.
	const windows = resultJson<{ windows: Array<{ item_count: number }> }>(await call(captured, "history_windows", {}, ctx));
	assert.equal(windows.windows[0]?.item_count, 120);
	const list = async (params: Record<string, unknown>) => resultJson<{ items: unknown[]; next_cursor: number | null }>(await call(captured, "history_list", params, ctx));
	const first = await list({ limit: 50, recent_first: false, max_chars_per_item: 100 });
	assert.equal(first.items.length, 50);
	assert.equal(first.next_cursor, 50, "limit caps the page, not the enumerable set");
	const second = await list({ limit: 50, cursor: 50, recent_first: false, max_chars_per_item: 100 });
	assert.equal(second.items.length, 50);
	assert.equal(second.next_cursor, 100);
	const third = await list({ limit: 50, cursor: 100, recent_first: false, max_chars_per_item: 100 });
	assert.equal(third.items.length, 20);
	assert.equal(third.next_cursor, null, "null only at the true end");

	// history_search: the same contract holds over the matching set.
	const search = async (params: Record<string, unknown>) => resultJson<{ items: unknown[]; next_cursor: number | null }>(await call(captured, "history_search", params, ctx));
	const searchFirst = await search({ query: "entry-", limit: 50, recent_first: false, max_chars_per_item: 100 });
	assert.equal(searchFirst.items.length, 50);
	assert.equal(searchFirst.next_cursor, 50);
	const searchTail = await search({ query: "entry-", limit: 50, cursor: 50, recent_first: false, max_chars_per_item: 100 });
	assert.equal(searchTail.items.length, 10);
	assert.equal(searchTail.next_cursor, null);

	// notes_search: max_files caps the page, not the matched files.
	for (let index = 0; index < 7; index++) await call(captured, "notes_write", { path: `needle-${index}.md`, content: "needle" }, ctx);
	const notes = async (params: Record<string, unknown>) => resultJson<{ files: unknown[]; next_cursor: number | null }>(await call(captured, "notes_search", params, ctx));
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
		resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_search", { recent_first: false, ...params }, ctx)).items.map((item) => item.item_id);
	const orIds = await historyIds({ query: ["alpha", "beta"] });
	assert.deepEqual(orIds, [bothId, alphaId, betaId], "history: an item matching any query is returned once");
	assert.equal(orIds.includes(noneId), false, "history: an item matching no query is not returned");
	assert.deepEqual(await historyIds({ query: ["alpha"] }), [bothId, alphaId], "history: a one-element array searches that literal");
	assert.deepEqual(await historyIds({ query: "alpha" }), orIds.filter((id) => id !== betaId), "history: a bare string still behaves exactly as before");
	assert.deepEqual(await historyIds({ query: "alpha" }), await historyIds({ query: ["alpha"] }), "history: bare string equals the single-element list");

	await call(captured, "notes_write", { path: "both.md", content: "alpha beta\nunrelated" }, ctx);
	await call(captured, "notes_write", { path: "alpha.md", content: "alpha only" }, ctx);
	await call(captured, "notes_write", { path: "beta.md", content: "beta only" }, ctx);
	await call(captured, "notes_write", { path: "gamma.md", content: "gamma only" }, ctx);
	const notesSearch = async (params: Record<string, unknown>) =>
		resultJson<{ files: Array<{ path: string; matches: Array<{ line: number; text: string }> }> }>(await call(captured, "notes_search", params, ctx)).files;
	const orFiles = await notesSearch({ query: ["alpha", "beta"] });
	assert.deepEqual(orFiles.map((file) => file.path), ["alpha.md", "beta.md", "both.md"], "notes: a file matching any query is returned once, path-ordered");
	assert.equal(orFiles.find((file) => file.path === "both.md")?.matches.length, 1, "notes: one line containing both queries is reported once");
	assert.deepEqual((await notesSearch({ query: ["alpha"] })).map((file) => file.path), ["alpha.md", "both.md"], "notes: a one-element array searches that literal");
	assert.deepEqual((await notesSearch({ query: "alpha" })).map((file) => file.path), ["alpha.md", "both.md"], "notes: a bare string still behaves exactly as before");
	assert.deepEqual((await notesSearch({ query: "alpha" })).map((file) => file.path), (await notesSearch({ query: ["alpha"] })).map((file) => file.path), "notes: bare string equals the single-element list");
	assert.deepEqual((await notesSearch({ query: ["gamma"] })).map((file) => file.path), ["gamma.md"]);

	// An empty array is an argument error, not a silently empty result set.
	await assert.rejects(() => call(captured, "history_search", { query: [] }, ctx), /non-empty array of strings/, "history: empty query array is refused");
	await assert.rejects(() => call(captured, "notes_search", { query: [] }, ctx), /non-empty array of strings/, "notes: empty query array is refused");
	await assert.rejects(() => call(captured, "history_search", { query: ["alpha", 7] }, ctx), /elements must be strings/, "history: non-string query element is refused");
	await assert.rejects(() => call(captured, "notes_search", { query: ["alpha", 7] }, ctx), /elements must be strings/, "notes: non-string query element is refused");
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
			await call(captured, "history_search", { query: ["alpha", "beta"], recent_first: false, max_chars_per_item: 100, limit: 3, cursor }, ctx),
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
		await call(captured, "notes_write", { path: `f${index}.md`, content: text }, ctx);
	}
	const notesPage = async (cursor: number) =>
		resultJson<{ files: Array<{ path: string }>; next_cursor: number | null }>(
			await call(captured, "notes_search", { query: ["alpha", "beta"], max_files: 3, cursor }, ctx),
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
	session.appendCustomEntry(internal.RESET_MARKER_TYPE, { windowId: "pcw:test:second" });
	const nextId = appendText(session, "user", "alpha next window");

	const searchIds = async (params: Record<string, unknown>) =>
		resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_search", { query: ["alpha", "beta"], recent_first: false, ...params }, ctx)).items.map((item) => item.item_id);
	assert.deepEqual(await searchIds({ role: "user" }), [userId, nextId], "role filter composes with multi-query");
	assert.deepEqual(await searchIds({ role: "assistant" }), [assistantId], "role filter narrows the OR set");
	assert.deepEqual(await searchIds({ tool_name: "bash" }), [toolId], "tool_name filter composes with multi-query");
	assert.deepEqual(await searchIds({ tool_name: "read" }), [], "a non-matching tool_name yields nothing");
	assert.deepEqual(await searchIds({ window_id: rootWindow }), [userId, assistantId, toolId], "window filter restricts the OR set to that window");
	assert.deepEqual(await searchIds({ window_id: "pcw:test:second" }), [nextId], "the second window's matches are addressable");
});

test("an over-budget note is delivered as a prefix and resumed by next_offset_chars", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const huge = `H${"x".repeat(TOOL_OUTPUT_MAX_BYTES * 2)}`;
	const text = `${huge}\ntail line`;
	await call(captured, "notes_write", { path: "huge.md", content: text }, ctx);
	const rawFirst = await call(captured, "notes_read", { path: "huge.md" }, ctx);
	assertWithinBudget(rawFirst, "single oversized note");
	const first = resultRead(rawFirst);
	assert.ok(first.content.length > 0, "the page is not empty");
	assert.equal(first.content.includes("…"), false, "the payload is a plain prefix with no marker");
	assert.ok(first.content.startsWith("---\n"), "the frontmatter is delivered first");
	assert.equal(first.header, `--- READ WINDOW ---\naddress: huge.md\nchars: [0,${first.next_offset_chars}) of ${first.total_chars}\nnext_offset_chars: ${first.next_offset_chars}\n`, "the raw block names the address, half-open range, and resume cursor");
	assert.deepEqual(Object.keys(first.details).sort(), ["address", "next_offset_chars", "offset_chars", "total_chars"], "notes_read details carries exactly the raw window address and cursor metadata");
	assert.equal("content" in first.details, false, "details never duplicates the payload");
	assert.equal(first.offset_chars, 0, "the default window starts at the resolved offset 0");
	// Following the cursor reconstructs frontmatter + body by plain concatenation.
	const parts = [first.content];
	let offset: number | null = first.next_offset_chars;
	while (offset !== null) {
		const rawChunk = await call(captured, "notes_read", { path: "huge.md", offset_chars: offset }, ctx);
		assertWithinBudget(rawChunk, `huge note chunk at ${offset}`);
		const chunk = resultRead(rawChunk);
		assert.equal(chunk.offset_chars, offset, "the response echoes the resolved absolute offset");
		parts.push(chunk.content);
		offset = chunk.next_offset_chars;
	}
	assert.ok(parts.join("").endsWith(text), "the cursors reconstruct the body exactly");

	// A success carries structured details; an error stays a JSON envelope with no details.
	const missingResult = await call(captured, "notes_read", { path: "no-such.md" }, ctx);
	const missing = resultJson<Record<string, unknown>>(missingResult);
	assert.deepEqual(Object.keys(missing).sort(), ["address", "error"], "the read error carries exactly error and address");
	assert.equal(missing.error, "note not found");
	assert.equal(missingResult.details, undefined, "a JSON error carries no details metadata");
});

test("an over-budget note search match is a named prefix with an honest line address", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	// The query sits behind a prefix, so its address is a real body-absolute offset, not line 1.
	const hugeLine = `${'p'.repeat(500)}needle ${"y".repeat(TOOL_OUTPUT_MAX_BYTES * 2)}`;
	await call(captured, "notes_write", { path: "a.md", content: "needle small" }, ctx);
	await call(captured, "notes_write", { path: "search.md", content: hugeLine }, ctx);
	const pages: Array<{ path: string; matches_total: number; matches: Array<{ line: number; text: string; truncated: boolean; offset_chars: number }> }> = [];
	let cursor = 0;
	let next: number | null = 0;
	while (next !== null) {
		const found = resultJson<{ files: Array<{ path: string; matches_total: number; matches: Array<{ line: number; text: string; truncated: boolean; offset_chars: number }> }>; next_cursor: number | null }>(
			await call(captured, "notes_search", { query: "needle", cursor }, ctx),
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
	assert.ok(hugeLine.startsWith(match.text), "the match text is a plain prefix of the line");
	assert.equal(match.text.includes("…"), false, "no marker is appended to the match text");
	assert.equal(match.line, 1, "the informational line number survives");
	const atMatch = resultRead(await call(captured, "notes_read", { path: "search.md", offset_chars: match.offset_chars }, ctx));
	assert.ok(atMatch.content.startsWith("needle"), "the search offset starts a read at the matched substring");
	// The body is reconstructible by following notes_read's cursor from the start of the file.
	const parts: string[] = [];
	let offset: number | null = 0;
	while (offset !== null) {
		const rawChunk = await call(captured, "notes_read", { path: "search.md", offset_chars: offset }, ctx);
		assertWithinBudget(rawChunk, `search.md chunk at ${offset}`);
		const chunk = resultRead(rawChunk);
		assert.equal(chunk.offset_chars, offset, "the read echoes the resolved address");
		parts.push(chunk.content);
		offset = chunk.next_offset_chars;
	}
	assert.ok(parts.join("").endsWith(hugeLine), "resuming across pages reconstructs the matched body line");
});

test("history_read delivers a prefix and next_offset_chars names the delivered count", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const original = "z".repeat(TOOL_OUTPUT_MAX_BYTES * 3);
	const id = appendText(session, "user", original);
	const rawRead = await call(captured, "history_read", { window_id: historyFromSession(ctx)[0]!.windowId, item_id: id, limit_chars: 50000 }, ctx);
	assertWithinBudget(rawRead, "single history_read call");
	const read = resultRead(rawRead);
	assert.ok(read.content.length > 0, "the read is not empty");
	assert.equal(read.content.includes("…"), false, "no marker is appended to the payload");
	assert.ok(original.startsWith(read.content), "the delivered text is a prefix of the item");
	assert.equal(read.total_chars, original.length);
	assert.equal(read.header, `--- READ WINDOW ---\nwindow_id: ${historyFromSession(ctx)[0]!.windowId}\nitem_id: ${id}\nchars: [0,${read.next_offset_chars}) of ${read.total_chars}\nnext_offset_chars: ${read.next_offset_chars}\n`, "the paged history block names identities, half-open range, and resume cursor");
	assert.deepEqual(Object.keys(read.details), ["window_id", "item_id", "offset_chars", "total_chars", "next_offset_chars"], "history_read details carries exactly the raw window identity and cursor metadata");
	assert.equal("limit_chars" in read.details, false, "history_read details omits the request cap");
	assert.equal("content" in read.details, false, "details never duplicates the payload");
	assert.equal(read.next_offset_chars, read.offset_chars + Array.from(read.content).length, "the cursor is offset plus delivered code points");
	assert.ok(read.next_offset_chars !== null && read.next_offset_chars < read.total_chars, "the cursor points at the first undelivered character");
	// Following the cursor reaches the true end and reconstructs the item.
	const parts = [read.content];
	let offset = read.next_offset_chars as number;
	let next: number | null = offset;
	while (next !== null) {
		const page = resultRead(
			await call(captured, "history_read", { window_id: historyFromSession(ctx)[0]!.windowId, item_id: id, offset_chars: offset, limit_chars: 50000 }, ctx),
		);
		assert.equal(page.header, `--- READ WINDOW ---\nwindow_id: ${historyFromSession(ctx)[0]!.windowId}\nitem_id: ${id}\nchars: [${page.offset_chars},${page.offset_chars + Array.from(page.content).length}) of ${page.total_chars}\nnext_offset_chars: ${page.next_offset_chars}\n`, "every history page retains the exact shared READ WINDOW block");
		assert.equal(page.next_offset_chars, page.offset_chars + Array.from(page.content).length < page.total_chars ? page.offset_chars + Array.from(page.content).length : null, "the cursor is offset plus delivered, null only at item end");
		parts.push(page.content);
		next = page.next_offset_chars;
		if (next !== null) offset = next;
	}
	assert.equal(parts.join(""), original, "the cursors reconstruct the item exactly");
});

test("an empty body is a frontmatter-only file that terminates cleanly", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { path: "empty.md", content: "" }, ctx);
	const empty = resultRead(
		await call(captured, "notes_read", { path: "empty.md" }, ctx),
	);
	assert.equal(empty.offset_chars, 0);
	assert.ok(empty.content.startsWith("---\n"), "the frontmatter is still delivered");
	assert.ok(empty.content.endsWith("---\n\n"), "an empty body leaves frontmatter and the blank separator only");
	assert.ok(empty.total_chars > 0, "the file is not zero-length once the harness frontmatter is written");
	assert.equal(empty.next_offset_chars, null, "a note that fits terminates instead of self-feeding");
	assert.equal(empty.header, `--- READ WINDOW ---\naddress: empty.md\nchars: [0,${empty.total_chars}) of ${empty.total_chars}\nnext_offset_chars: null\n`, "an exhausted window writes literal null");
	// An offset beyond the file is an addressing error that names the real length,
	// not a silent empty page.
	const beyond = resultJson<{ error?: string; offset_chars?: number; total_chars?: number }>(
		await call(captured, "notes_read", { path: "empty.md", offset_chars: empty.total_chars + 9 }, ctx),
	);
	assert.match(beyond.error ?? "", /past the end/, "a beyond-the-file read is a named error");
	assert.equal(beyond.offset_chars, empty.total_chars + 9, "the error echoes the offending offset");
	assert.equal(beyond.total_chars, empty.total_chars, "the error names the real length");
});

test("history items carry honest truncated/total_chars and max_chars_per_item:1 addresses them", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const content = `${'padding '.repeat(400)}NEEDLE${' trailing'.repeat(400)}`;
	const id = appendText(session, "user", content);
	const list = resultJson<{ items: Array<{ item_id: string; truncated: boolean; total_chars: number; truncated_content: string }> }>(
		await call(captured, "history_list", { recent_first: false, max_chars_per_item: 5 }, ctx),
	);
	const listed = list.items.find((item) => item.item_id === id)!;
	assert.equal(listed.truncated, true, "a capped item is flagged truncated");
	assert.equal(listed.total_chars, Array.from(content).length, "total_chars is the full code-point length");
	assert.equal(listed.truncated_content, 'paddi', "the payload is the longest fitting prefix, with no marker");
	assert.equal(listed.truncated_content.includes("…"), false);
	const whole = resultJson<{ items: Array<{ item_id: string; truncated: boolean; total_chars: number; truncated_content: string }> }>(
		await call(captured, "history_list", { recent_first: false, max_chars_per_item: 50_000 }, ctx),
	);
	const untruncated = whole.items.find((item) => item.item_id === id)!;
	assert.equal(untruncated.truncated, false, "an item that fits is not flagged truncated");
	assert.equal(untruncated.truncated_content, content, "a fitting item is returned whole");
	const addresses = resultJson<{ items: Array<{ item_id: string; truncated: boolean; total_chars: number; truncated_content: string; match_offset_chars: number }> }>(
		await call(captured, "history_search", { query: "NEEDLE", max_chars_per_item: 1 }, ctx),
	);
	const address = addresses.items.find((item) => item.item_id === id)!;
	assert.equal(Array.from(address.truncated_content).length, 1, "max_chars_per_item:1 delivers one code point");
	assert.equal(address.truncated, true);
	assert.equal(address.total_chars, Array.from(content).length);
	const resolved = resultRead(
		await call(captured, "history_read", { window_id: historyFromSession(ctx)[0]!.windowId, item_id: id, offset_chars: address.match_offset_chars, limit_chars: 6 }, ctx),
	);
	assert.ok(resolved.content.includes("NEEDLE"), "the address resolves to the query through history_read");
});

test("tool calls wear their own role and assistant text stays pure", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];
	const turnId = session.appendMessage({
		role: "assistant",
		content: [
			{ type: "text", text: "on it" },
			{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "keiyaku status" } },
			{ type: "toolCall", id: "tc-2", name: "notes_read", arguments: { path: "x.md" } },
		],
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AppendableMessage);
	const windowId = historyFromSession(ctx)[0]!.windowId;

	const listed = resultJson<{ items: Array<{ item_id: string; role: string; tool_name: string | null; truncated_content: string }> }>(
		await call(captured, "history_list", { recent_first: false, max_chars_per_item: 50_000 }, ctx),
	);
	const turn = listed.items.find((item) => item.item_id === turnId)!;
	assert.equal(turn.role, "assistant");
	assert.equal(turn.tool_name, null, "the turn's text item carries no tool identity");
	assert.equal(turn.truncated_content, "on it", "the turn item keeps only the visible text");
	const call1 = listed.items.find((item) => item.item_id === `${turnId}#0`)!;
	assert.equal(call1.role, "tool_call");
	assert.equal(call1.tool_name, "bash");
	assert.equal(call1.truncated_content, JSON.stringify({ command: "keiyaku status" }), "a call item's content is the call's JSON arguments");
	const call2 = listed.items.find((item) => item.item_id === `${turnId}#1`)!;
	assert.equal(call2.tool_name, "notes_read");

	// The invocation is searchable exactly where a searcher reaches for it: tool_call + tool_name.
	const calls = resultJson<{ items: Array<{ item_id: string }> }>(
		await call(captured, "history_search", { query: "keiyaku status", role: "tool_call", tool_name: "bash" }, ctx),
	);
	assert.deepEqual(calls.items.map((item) => item.item_id), [`${turnId}#0`], "the command line is found on the call item, not the turn");
	const assistantCalls = resultJson<{ items: Array<{ item_id: string }> }>(
		await call(captured, "history_search", { query: "keiyaku status", role: "assistant" }, ctx),
	);
	assert.equal(assistantCalls.items.length, 0, "calls never leak into assistant text");
	const assistantText = resultJson<{ items: Array<{ item_id: string }> }>(
		await call(captured, "history_search", { query: "on it", role: "assistant" }, ctx),
	);
	assert.deepEqual(assistantText.items.map((item) => item.item_id), [turnId], "assistant search returns the turn's text item only");
	const outputs = resultJson<{ items: Array<{ item_id: string }> }>(
		await call(captured, "history_search", { query: "keiyaku status", role: "tool" }, ctx),
	);
	assert.equal(outputs.items.length, 0, "nothing ran, so no output carries the command");
	const resolved = resultRead(await call(captured, "history_read", { window_id: windowId, item_id: `${turnId}#0` }, ctx));
	assert.equal(resolved.content, JSON.stringify({ command: "keiyaku status" }), "a call item resolves through history_read like any other");
});

test("a vacuous role×tool_name combination is a named error, not a silent empty page", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	appendText(session, "user", "anything");
	for (const tool of ["history_list", "history_search"] as const) {
		const base = tool === "history_search" ? { query: "keiyaku" } : {};
		const dead = resultJson<{ error?: string; role?: string; tool_name?: string }>(
			await call(captured, tool, { ...base, role: "assistant", tool_name: "bash" }, ctx),
		);
		assert.match(dead.error ?? "", /only set on "tool_call" and "tool"/, `${tool} names the rule`);
		assert.equal(dead.role, "assistant", "the error echoes the offending role");
		assert.equal(dead.tool_name, "bash", "the error echoes the offending tool_name");
		for (const role of ["user", "system", "developer"] as const) {
			const also = resultJson<{ error?: string }>(await call(captured, tool, { ...base, role, tool_name: "bash" }, ctx));
			assert.match(also.error ?? "", /never carries one/, `${tool} rejects role ${role} + tool_name too`);
		}
		for (const legit of [{ role: "tool_call", tool_name: "bash" }, { role: "tool", tool_name: "bash" }, { tool_name: "bash" }, { role: "assistant" }]) {
			const fine = resultJson<{ error?: string; items?: unknown[] }>(await call(captured, tool, { ...base, ...legit }, ctx));
			assert.equal(fine.error, undefined, `${tool} accepts ${JSON.stringify(legit)}`);
			assert.ok(Array.isArray(fine.items), `${tool} returns a page for ${JSON.stringify(legit)}`);
		}
		const realWindow = historyFromSession(ctx)[0]!.windowId;
		const badWindow = resultJson<{ error?: string; window_id?: string; known_windows?: string[] }>(
			await call(captured, tool, { ...base, window_id: "pcw:00000000:deadbeef" }, ctx),
		);
		assert.match(badWindow.error ?? "", /unknown window_id/, `${tool} names an unknown window_id`);
		assert.equal(badWindow.window_id, "pcw:00000000:deadbeef", "the error echoes the offending window_id");
		assert.deepEqual(badWindow.known_windows, [realWindow], "the error lists the known windows so it is self-healing");
		const goodWindow = resultJson<{ error?: string; items?: unknown[] }>(await call(captured, tool, { ...base, window_id: realWindow }, ctx));
		assert.equal(goodWindow.error, undefined, `${tool} accepts a real window_id`);
		assert.ok(Array.isArray(goodWindow.items), `${tool} returns a page for a real window_id`);
	}
});

test("developer re-role names this extension's entries and leaves native compactions as system", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const foreignId = session.appendCustomMessageEntry("other/extension", "foreign custom body", false);
	const extensionId = session.appendCustomMessageEntry(internal.BOOT_TYPE, "extension boot body", false);
	session.appendCustomEntry(internal.RESET_MARKER_TYPE, { windowId: "pcw:test:dev" });
	const resetBootId = session.appendCustomMessageEntry(internal.BOOT_TYPE, "reset boot body", false, { windowId: "pcw:test:dev" });
	const nextLeaf = session.getLeafId();
	assert.ok(nextLeaf);
	const nativeId = session.appendCompaction("native summary", nextLeaf, 100, { readFiles: [], modifiedFiles: [] }, true);
	const byRole = async (role: string) => resultJson<{ items: Array<{ item_id: string; role: string }> }>(
		await call(captured, "history_list", { role, recent_first: false }, ctx),
	).items;
	assert.deepEqual((await byRole("developer")).map((item) => item.item_id), [extensionId, resetBootId], "developer names exactly this extension's entries");
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
		await call(captured, "history_list", { recent_first: false, max_chars_per_item: 1200 }, ctx),
	);
	const listedBytes = Buffer.byteLength(JSON.stringify(listed), "utf8");
	console.log(`pathological page bytes: history_list tool_name=40KB -> ${listedBytes}`);
	assert.ok(listedBytes <= TOOL_OUTPUT_MAX_BYTES, `oversized tool_name list page is ${listedBytes} bytes`);
	assert.equal(listed.items.length, 1);
	assert.equal(listed.items[0]!.item_id, itemId, "item_id identity is untouched");
	assert.equal(listed.items[0]!.truncated_content, "tool output line", "the payload is preserved when only metadata is oversized");
	assert.match(listed.items[0]!.tool_name, /…\[truncated \d+ chars\]…/, "tool_name carries the truncation marker");

	const searched = resultJson<{ items: Array<{ item_id: string; tool_name: string }>; next_cursor: number | null }>(
		await call(captured, "history_search", { query: "tool output", recent_first: false }, ctx),
	);
	const searchedBytes = Buffer.byteLength(JSON.stringify(searched), "utf8");
	console.log(`pathological page bytes: history_search tool_name=40KB -> ${searchedBytes}`);
	assert.ok(searchedBytes <= TOOL_OUTPUT_MAX_BYTES, `oversized tool_name search page is ${searchedBytes} bytes`);
	assert.equal(searched.items.length, 1);
	assert.equal(searched.items[0]!.item_id, itemId, "search keeps item_id identity");
	assert.match(searched.items[0]!.tool_name, /…\[truncated \d+ chars\]…/, "search truncates the oversized tool_name visibly");
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

test("note write/edit tools run sequentially so a parallel batch cannot race the note store", () => {
	const captured = makeExtension(manager());
	for (const name of ["notes_write", "notes_edit"]) {
		assert.equal(captured.tools.get(name)?.executionMode, "sequential", `${name} forbids parallel execution`);
	}
	assert.equal(captured.tools.get("notes_read")?.executionMode, undefined, "read-only note tools keep the default mode");
});

test("custom reset marker removes old provider context while history remains searchable", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	const oldUserId = appendText(sessionManager, "user", "OLD-UNIQUE-TRANSCRIPT needle");
	appendText(sessionManager, "assistant", "I will use a tool");
	const toolResultId = appendText(sessionManager, "toolResult", "tool result safely recorded");
	await call(captured, "wipe_memory", {}, ctx);
	const boundary = await commitTurnEndBoundary(captured, sessionManager, ctx);
	assert.equal(boundary.continue, true);
	const branch = sessionManager.getBranch();
	const marker = branch.find((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE);
	assert.ok(marker && marker.type === "custom");
	assert.equal(marker.parentId, toolResultId, "marker follows the completed tool result");
	assert.deepEqual(Object.keys(marker.data as object), ["windowId"]);
	const projected = await runContextWithSystemHook(captured, ctx, sessionManager.buildSessionContext().messages);
	const providerText = JSON.stringify(projected?.messages ?? []);
	assert.equal(providerText.includes("OLD-UNIQUE-TRANSCRIPT"), false);
	assert.equal(providerText.includes(internal.CONTEXT_WINDOW_OPEN_TAG), true);
	assert.equal(providerText.includes(internal.RESET_MARKER_TYPE), false, "plain reset state never reaches the provider");

	const windows = historyFromSession(ctx);
	assert.equal(windows.length, 2);
	const oldWindow = windows[0]?.windowId;
	assert.ok(oldWindow);
	const read = resultRead(await call(captured, "history_read", { window_id: oldWindow, item_id: oldUserId }, ctx));
	assert.match(read.content, /OLD-UNIQUE-TRANSCRIPT/);
	const found = resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_search", { query: "needle" }, ctx));
	assert.equal(found.items.length, 1);
	assert.equal(found.items[0]?.item_id, oldUserId);
});

test("the boot notes index shows one metadata line per note and never a body", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	const longText = Array.from({ length: 400 }, (_, index) => String.fromCharCode(0x4e00 + index)).join("");
	const shortText = "short-first\nshort-second";
	await call(captured, "notes_write", { path: "long.md", content: longText }, ctx);
	await call(captured, "notes_write", { path: "short.md", content: shortText }, ctx);
	runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	const boot = captured.sent[0];
	const text = typeof boot?.message.content === "string" ? boot.message.content : "";
	assert.ok(text.includes("long.md") && text.includes("short.md"), "both notes are indexed");

	// Each note is exactly one metadata line: address, line count, byte count, timestamp.
	assert.match(text, /^- long\.md \(1 lines, \d+ UTF-8 bytes, updated [^)]+\)$/m, "the long note is a single metadata line");
	assert.match(text, /^- short\.md \(2 lines, \d+ UTF-8 bytes, updated [^)]+\)$/m, "the short note is a single metadata line");
	assert.equal(text.includes(longText), false, "the long note's body never reaches boot");
	assert.equal(text.includes(shortText), false, "the short note's body never reaches boot");
});

test("the root boot and reset boot carry durable window identity", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	appendText(sessionManager, "user", "task before reset");
	appendText(sessionManager, "assistant", "working");
	await call(captured, "notes_write", { path: "decisions.md", content: "use terra" }, ctx);

	// Root window: session_start persists the boot block without triggering a turn.
	runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	assert.equal(captured.sent.length, 1);
	const rootBoot = captured.sent[0];
	assert.equal(rootBoot?.message.customType, internal.BOOT_TYPE);
	assert.equal(rootBoot?.message.display, false, "boot block stays out of the TUI");
	assert.equal(rootBoot?.options?.triggerTurn, false);
	assert.deepEqual(rootBoot?.message.details, { windowId: `pcw:${sessionManager.getSessionId().slice(0, 8)}:root` });
	const rootText = typeof rootBoot?.message.content === "string" ? rootBoot.message.content : "";
	assert.ok(rootText.startsWith(internal.CONTEXT_WINDOW_OPEN_TAG), "root block omits the reset line");
	assert.equal(rootText.includes("Previous context window id:"), false, "root block omits the previous-id line");
	assert.match(rootText, new RegExp(`First context window id: pcw:${sessionManager.getSessionId().slice(0, 8)}:root`));
	assert.match(rootText, new RegExp(`Current context window id: pcw:${sessionManager.getSessionId().slice(0, 8)}:root`));
	assert.ok(rootText.includes("decisions.md"));
	const decisionsMeta = listNotes(ctx, { scope: "session" }).find((row) => row.path === "decisions.md")?.meta;
	assert.ok(decisionsMeta);
	assert.match(rootText, /updated \d+s ago\)/, "boot note metadata carries a relative update time");
	assert.ok(rootText.includes(internal.CONTEXT_WINDOW_PROTOCOL_OPEN_TAG));

	// Reset: the marker and boot are committed together at the turn boundary.
	await call(captured, "wipe_memory", {}, ctx);
	const boundary = await commitTurnEndBoundary(captured, sessionManager, ctx);
	assert.equal(boundary.continue, true);
	const entries = sessionManager.getBranch();
	const marker = entries.find((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE);
	assert.ok(marker && marker.type === "custom");
	const resetWindowId = (marker.data as { windowId: string }).windowId;
	const resetBoot = entries.find((entry) => entry.type === "custom_message" && entry.customType === internal.BOOT_TYPE && entry.details && typeof entry.details === "object" && (entry.details as { windowId?: unknown }).windowId === resetWindowId);
	assert.ok(resetBoot && resetBoot.type === "custom_message");
	assert.equal((resetBoot.details as { windowId: string }).windowId, (marker.data as { windowId: string }).windowId);
	const continuation = entries.find((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE);
	assert.ok(continuation && continuation.type === "custom_message" && continuation.display === false, "the resumed run is represented by one hidden continuation");
});

test("a marker tail with only metadata repairs its missing boot without moving the boundary", () => {
	const sessionManager = manager(true);
	const windowId = "pcw:metadata-tail";
	const markerId = sessionManager.appendCustomEntry(internal.RESET_MARKER_TYPE, { windowId });
	const modelChangeId = sessionManager.appendModelChange("openai", "scripted-model");
	sessionManager.appendThinkingLevelChange("low");
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);

	runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	const branch = sessionManager.getBranch();
	const markerIndex = branch.findIndex((entry) => entry.id === markerId);
	const bootEntries = branch.filter((entry) => entry.type === "custom_message" && entry.customType === internal.BOOT_TYPE && entry.details && typeof entry.details === "object" && (entry.details as { windowId?: unknown }).windowId === windowId);
	assert.equal(bootEntries.length, 1, "an incomplete marker tail gets one repaired boot");
	assert.ok(branch.findIndex((entry) => entry.id === modelChangeId) > markerIndex, "metadata remains after the marker");
	assert.ok(branch.findIndex((entry) => entry.id === bootEntries[0]?.id) > markerIndex, "the repaired boot remains in the marked window");
	assert.equal(captured.sent.length, 1, "repair emits one hidden boot without a model turn");
});

test("a root fork refreshes boot identity while preserving copied root messages", async () => {
	const source = manager(true);
	const sourceExtension = makeExtension(source);
	const sourceCtx = context(source);
	appendText(source, "user", "ROOT_FORK_PRESERVE_THIS_MESSAGE");
	runHandlers(sourceExtension, "session_start", { reason: "startup" }, sourceCtx);
	appendText(source, "assistant", "ROOT_FORK_FLUSHES_SOURCE_SESSION");
	const sourcePath = source.getSessionFile();
	assert.ok(sourcePath);

	const targetCwd = mkdtempSync(join(tmpdir(), "pi-context-fork-cwd-"));
	const targetSessionDir = mkdtempSync(join(tmpdir(), "pi-context-fork-session-"));
	const fork = SessionManager.forkFrom(sourcePath, targetCwd, targetSessionDir, { id: "forkboot1" });
	try {
		const forkExtension = makeExtension(fork);
		const forkCtx = context(fork, undefined, undefined, true, targetCwd);
		runHandlers(forkExtension, "session_start", { reason: "startup" }, forkCtx);
		const rootWindowId = `pcw:${fork.getSessionId().slice(0, 8)}:root`;
		const boots = fork.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.BOOT_TYPE);
		assert.equal(boots.length, 2, "the fork keeps the copied boot and appends one refreshed boot");
		assert.equal(forkExtension.sent.length, 1, "the fork refreshes boot identity without starting a turn");
		assert.deepEqual(forkExtension.sent[0]?.message.details, { windowId: rootWindowId });
		const projected = await runContextWithSystemHook(forkExtension, forkCtx, fork.buildSessionContext().messages);
		const providerText = JSON.stringify(projected?.messages ?? []);
		assert.ok(providerText.includes("ROOT_FORK_PRESERVE_THIS_MESSAGE"), "root fork keeps the copied conversation");
		assert.ok(providerText.includes(rootWindowId), "root projection exposes the fork's boot identity");
	} finally {
		// SessionManager owns the persisted file; remove only this test's isolated roots.
		rmSync(targetCwd, { recursive: true, force: true });
		rmSync(targetSessionDir, { recursive: true, force: true });
	}
});

test("marker window ids drive history_* lookups and provider projection", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	appendText(sessionManager, "user", "task before reset");
	const windowId = "pcw:test:marker";
	const markerId = sessionManager.appendCustomEntry(internal.RESET_MARKER_TYPE, { windowId });
	sessionManager.appendCustomMessageEntry(internal.BOOT_TYPE, bootBlock(ctx, windowId, "pcw:test:root", true), false, { windowId });
	const currentId = appendText(sessionManager, "assistant", "message after reset");

	// history_windows reports exactly the minted id carried in details.
	// The default is newest-first, so the current window is listed first.
	const windows = resultJson<{ windows: Array<{ window_id: string }> }>(await call(captured, "history_windows", {}, ctx));
	assert.equal(windows.windows.length, 2);
	assert.equal(windows.windows[0]?.window_id, windowId, "recent_first defaults to newest-first");
	// Only an explicit false restores oldest-first window order.
	const oldestWindows = resultJson<{ windows: Array<{ window_id: string }> }>(await call(captured, "history_windows", { recent_first: false }, ctx));
	assert.equal(oldestWindows.windows[0]?.window_id, `pcw:${sessionManager.getSessionId().slice(0, 8)}:root`, "explicit false keeps the oldest window first");
	assert.equal(oldestWindows.windows[1]?.window_id, windowId);

	// history_* accepts the minted window id and resolves the baked summary item.
	const listed = resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_list", { window_id: windowId }, ctx));
	assert.equal(listed.items.some((item) => item.item_id === markerId), false, "plain marker entries stay out of history items");
	assert.ok(listed.items.some((item) => item.item_id === currentId));
	const projected = await runContextWithSystemHook(captured, ctx, sessionManager.buildSessionContext().messages);
	assert.equal(JSON.stringify(projected?.messages ?? []).includes("task before reset"), false);
	assert.ok(JSON.stringify(projected?.messages ?? []).includes("message after reset"));
});

test("recent_first defaults to newest-first for items and search; only false is oldest-first", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	const firstId = appendText(sessionManager, "user", "needle alpha");
	const secondId = appendText(sessionManager, "assistant", "needle beta");
	const thirdId = appendText(sessionManager, "user", "needle gamma");

	const listOrder = async (params: Record<string, unknown>) =>
		resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_list", params, ctx)).items.map((item) => item.item_id);
	assert.deepEqual(await listOrder({}), [thirdId, secondId, firstId], "omitted recent_first lists the newest item first");
	assert.deepEqual(await listOrder({ recent_first: true }), [thirdId, secondId, firstId], "recent_first true lists the newest item first");
	assert.deepEqual(await listOrder({ recent_first: false }), [firstId, secondId, thirdId], "explicit false lists the oldest item first");

	const searchOrder = async (params: Record<string, unknown>) =>
		resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_search", { query: "needle", ...params }, ctx)).items.map((item) => item.item_id);
	assert.deepEqual(await searchOrder({}), [thirdId, secondId, firstId], "search shares the newest-first default");
	assert.deepEqual(await searchOrder({ recent_first: false }), [firstId, secondId, thirdId], "search honours an explicit false");
});

test("off preserves an existing marker window and still cancels native compaction", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	appendText(sessionManager, "user", "old context must stay hidden");
	const windowId = "pcw:test:existing";
	sessionManager.appendCustomEntry(internal.RESET_MARKER_TYPE, { windowId });
	sessionManager.appendCustomMessageEntry(internal.BOOT_TYPE, "fresh boot", false, { windowId });
	await runCommand(captured, "pi-context", "off", ctx);
	const before = await runManualCompact(captured, ctx);
	assert.deepEqual(before, { cancel: true });
	const projected = await runContextWithSystemHook(captured, ctx, sessionManager.buildSessionContext().messages);
	assert.equal(JSON.stringify(projected?.messages ?? []).includes("old context must stay hidden"), false);
	const windows = resultJson<{ windows: Array<{ window_id: string }> }>(await call(captured, "history_windows", {}, ctx));
	assert.equal(windows.windows[0]?.window_id, windowId);
});

test("low-budget guidance and warning persist at turn_end, once per active window", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const low = context(sessionManager, undefined, { tokens: 170_000, percent: 85, contextWindow: 200_000 });
	assert.equal(await runContextHook(captured, low), undefined, "guidance is staged, not injected into this request");
	assert.equal(captured.sent.length, 0, "guidance does not trigger a detached turn");
	const guidanceBoundary = await commitTurnEndBoundary(captured, sessionManager, low);
	assert.equal(guidanceBoundary.entries.filter((entry) => entry.type === "custom_message" && entry.customType === internal.GUIDANCE_TYPE).length, 1);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.GUIDANCE_TYPE).length, 1);
	assert.equal(await runContextHook(captured, low), undefined, "the same window does not repeat guidance");

	const warningContext = context(sessionManager, undefined, { tokens: 199_000, percent: 99.5, contextWindow: 200_000 });
	const warning = await runContextHook(captured, warningContext);
	assert.equal(warning?.messages.length, 1, "the warning is visible in the current provider request");
	assert.equal((warning?.messages[0] as { customType?: string }).customType, internal.WARNING_TYPE);
	const warningBoundary = await commitTurnEndBoundary(captured, sessionManager, warningContext);
	assert.equal(warningBoundary.entries.filter((entry) => entry.type === "custom_message" && entry.customType === internal.WARNING_TYPE).length, 1);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.WARNING_TYPE).length, 1);
});

test("an ignored warning is redelivered after settlement without creating a durable checkpoint", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm, undefined, { tokens: 199_000, percent: 99.5, contextWindow: 200_000 });
	const first = await runContextHook(captured, ctx);
	assert.equal(first?.messages.length, 1);
	runHandlers(captured, "agent_end", {}, ctx);
	runHandlers(captured, "agent_settled", {}, ctx);
	const second = await runContextHook(captured, ctx);
	assert.equal(second?.messages.length, 1, "an uncommitted warning is eligible again after settlement");
	assert.equal((second?.messages[0] as { customType?: string }).customType, internal.WARNING_TYPE);
	assert.equal(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.WARNING_TYPE).length, 0);
});

test("wipe_memory uses one turn boundary and never calls ctx.compact", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager, () => assert.fail("ctx.compact must not be used"));
	appendText(sessionManager, "user", "enough history for the boundary test");
	const result = resultJson<{ status?: string }>(await call(captured, "wipe_memory", {}, ctx));
	assert.ok(result.status);
	const boundary = await commitTurnEndBoundary(captured, sessionManager, ctx);
	assert.equal(boundary.continue, true);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE).length, 1);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.BOOT_TYPE && entry.details && typeof entry.details === "object" && "windowId" in entry.details).length, 1);
});

test("pi-context command toggles future work, /clear-context is the manual path, and active markers cancel /compact", async () => {
	const sessionManager = manager();
	appendText(sessionManager, "user", "hello");
	const captured = makeExtension(sessionManager);
	const low = context(sessionManager, undefined, { tokens: 170_000, contextWindow: 200_000, percent: 85 });

	// On by default: session_start persists the root boot block.
	runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 1);
	assert.equal(captured.sent[0]?.message.customType, internal.BOOT_TYPE);

	let notices = await runCommand(captured, "pi-context", "off", low);
	assert.match(notices[0]?.message ?? "", /off/);
	assert.equal(await runContextHook(captured, low), undefined, "no guidance while off");
	assert.equal(sentOf(captured, internal.GUIDANCE_TYPE).length, 0, "no guidance persisted while off");
	runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 1, "no new boot block is persisted while off");
	const offResult = resultJson<{ error?: string }>(await call(captured, "wipe_memory", {}, low));
	assert.match(offResult.error ?? "", /off/, "wipe_memory refuses while off");

	notices = await runCommand(captured, "pi-context", "on", low);
	assert.match(notices[0]?.message ?? "", /on/);
	await runCommand(captured, "clear-context", "", low);
	assert.equal(captured.sent.length, 2, "/clear-context writes one hidden boot without triggering a model turn");
	assert.equal(captured.sent[1]?.options?.triggerTurn, false);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE).length, 1);
	const markerContext = await runManualCompact(captured, low);
	assert.deepEqual(markerContext, { cancel: true }, "/compact is canceled while a marker is active");
	const projected = await runContextWithSystemHook(captured, low, sessionManager.buildSessionContext().messages);
	assert.equal(JSON.stringify(projected?.messages ?? []).includes("hello"), false, "off keeps the existing wipe in force");

	notices = await runCommand(captured, "pi-context", "maybe", low);
	assert.equal(notices[0]?.type, "error", "unknown argument rejected");

	// Bare command reports current state without changing it.
	notices = await runCommand(captured, "pi-context", "", low);
	assert.match(notices[0]?.message ?? "", /on/);
});

test("the visible countdown ends at the warning line, clamps at zero, and preserves unknown usage", async () => {
	const fixture = settingsFixture({
		reserveTokens: 16_384,
		project: { compaction: { reserveTokens: 32_768 } },
	});
	const sm = manager();
	const captured = makeExtension(sm);
	runHandlers(captured, "session_tree", {}, context(sm, undefined, undefined, true, fixture.cwd, true));
	const readBudget = async (tokens: number | null, trusted = true) => {
		const ctx = context(sm, undefined, { tokens, contextWindow: 200_000, percent: tokens === null ? null : tokens / 2000 }, true, fixture.cwd, trusted);
		return resultJson<{ remaining_tokens: number | null }>(await call(captured, "get_context_remaining", {}, ctx)).remaining_tokens;
	};
	assert.equal(await readBudget(72_563), 82_381, "the reported 127437 physical tokens exclude reserve plus runway (45056)");
	assert.equal(await readBudget(167_232), 0, "inside the runway the countdown reads zero");
	assert.equal(await readBudget(190_000), 0, "below the reserve, still zero");
	assert.equal(await readBudget(210_000), 0, "over the physical window");
	assert.equal(await readBudget(null), null, "unknown usage remains unknown");
	const absent = context(sm, undefined, undefined, true, fixture.cwd);
	assert.equal(resultJson<{ remaining_tokens: number | null }>(await call(captured, "get_context_remaining", {}, absent)).remaining_tokens, null);
	const untrusted = context(sm, undefined, { tokens: 72_563, contextWindow: 200_000, percent: 36.2815 }, true, fixture.cwd, false);
	runHandlers(captured, "session_start", {}, untrusted);
	assert.equal(await readBudget(72_563, false), 98_765, "session start reloads the global reserve when the project is untrusted");
});

test("the reminder threshold derives from compaction.reserveTokens plus the pi-context reminder margin", async () => {
	const fixture = settingsFixture({
		reserveTokens: 100_000,
		global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 30_000 } },
	});
	const sm = manager();
	const captured = makeExtension(sm);
	// Thresholds are resolved once per session and cached; branch navigation clears the
	// cache without emitting a boot block, so the next read uses this fixture.
	runHandlers(captured, "session_tree", {}, context(sm, undefined, undefined, true, fixture.cwd));
	const window = 300_000;
	const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);

	// reminder = 100000 + 30000.
	assert.equal(await runContextHook(captured, at(130_001)), undefined, "nothing injected above the derived reminder");
	assert.equal(sentOf(captured, internal.GUIDANCE_TYPE).length, 0, "no guidance above the derived reminder");
	const crossing = at(130_000);
	assert.equal(await runContextHook(captured, crossing), undefined, "derived reminder crossing persists only");
	await commitTurnEndBoundary(captured, sm, crossing);
	assert.equal(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.GUIDANCE_TYPE).length, 1, "derived reminder fires");
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
		// Thresholds are resolved once per session and cached; branch navigation clears the
		// cache without emitting a boot block, so the next read uses this fixture.
		runHandlers(captured, "session_tree", {}, context(sm, undefined, undefined, true, fixture.cwd));
		const window = 200_000;
		const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);
		const first = at(40_961);
		assert.equal(await runContextHook(captured, first), undefined, `${label}: nothing injected above the default reminder`);
		assert.equal(sentOf(captured, internal.GUIDANCE_TYPE).length, 0, `${label}: no guidance above the default reminder`);
		const crossing = at(40_960);
		assert.equal(await runContextHook(captured, crossing), undefined, `${label}: default reminder crossing persists only`);
		await commitTurnEndBoundary(captured, sm, crossing);
		assert.equal(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.GUIDANCE_TYPE).length, 1, `${label}: default reminder fires`);
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
	runHandlers(captured, "session_tree", {}, context(sm, undefined, undefined, true, fixture.cwd));
	const window = 300_000;
	const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);
	assert.equal(await runContextHook(captured, at(90_001)), undefined, "nothing injected above the project-derived reminder");
	assert.equal(sentOf(captured, internal.GUIDANCE_TYPE).length, 0);
	const crossing = at(90_000);
	assert.equal(await runContextHook(captured, crossing), undefined, "project-derived reminder crossing persists only");
	await commitTurnEndBoundary(captured, sm, crossing);
	assert.equal(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.GUIDANCE_TYPE).length, 1, "project reminder margin wins");
});

test("an untrusted project is ignored, so global pi-context margins apply", async () => {
	const fixture = settingsFixture({
		global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 30_000 } },
		project: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 40_000 } },
	});
	const sm = manager();
	const captured = makeExtension(sm);
	runHandlers(captured, "session_tree", {}, context(sm, undefined, undefined, true, fixture.cwd, false));
	const window = 100_000;
	// Global reminder = 16384 + 30000 = 46384, not the project's 56384.
	const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd, false);
	assert.equal(await runContextHook(captured, at(56_000)), undefined, "untrusted project margin ignored; nothing injected");
	assert.equal(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.GUIDANCE_TYPE).length, 0, "no guidance from the untrusted project margin");
	const crossing = at(46_384);
	assert.equal(await runContextHook(captured, crossing), undefined, "global margin fires instead");
	await commitTurnEndBoundary(captured, sm, crossing);
	assert.equal(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.GUIDANCE_TYPE).length, 1);
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
	const crossing = at(35_000);
	assert.equal(await runContextHook(captured, crossing), undefined, "the crossing persists only");
	await commitTurnEndBoundary(captured, sm, crossing);
	assert.equal(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.GUIDANCE_TYPE).length, 1, "reminder margin re-read on session_start");
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
	const crossing = at(40_960);
	assert.equal(await runContextHook(captured, crossing), undefined, "degraded reminder uses its default");
	await commitTurnEndBoundary(captured, sm, crossing);
	assert.equal(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.GUIDANCE_TYPE).length, 1, "the degraded reminder is persisted once");
	assert.equal(notices.length, 1, "warning stays one-time across handler calls");
});

test("the old threshold flags are no longer registered", () => {
	const captured = makeExtension(manager());
	assert.deepEqual(captured.flags, []);
});

test("boot and staged guidance deduplicate across extension reload while a new branch can receive them", async () => {
	const sm = manager();
	appendText(sm, "user", "branch anchor");
	const anchor = sm.getLeafId()!;
	const ctx = context(sm, undefined, { tokens: 170_000, percent: 85, contextWindow: 200_000 });
	const first = makeExtension(sm);
	runHandlers(first, "session_start", {}, ctx);
	await runContextHook(first, ctx);
	await commitTurnEndBoundary(first, sm, ctx);
	assert.equal(first.sent.length, 1);
	const reloaded = makeExtension(sm);
	runHandlers(reloaded, "session_start", {}, ctx);
	await runContextHook(reloaded, ctx);
	assert.equal(reloaded.sent.length, 0, "persisted messages survive runtime replacement");
	sm.branch(anchor);
	runHandlers(first, "session_tree", {}, ctx);
	await runContextHook(first, ctx);
	assert.equal(first.sent.length, 2, "same runtime releases the previous branch's boot reservation");
	const fork = makeExtension(sm);
	runHandlers(fork, "session_start", {}, ctx);
	await runContextHook(fork, ctx);
	assert.equal(fork.sent.length, 0, "a persisted sibling boot is not duplicated");
});

test("malformed frontmatter timestamps degrade to a finite fallback without poisoning valid notes or boot rendering", async () => {
	const sm = manager();
	const ctx = context(sm);
	const extension = makeExtension(sm);
	await call(extension, "notes_write", { path: "good.md", content: "keep me" }, ctx);
	// Corrupt every timestamp in place; parse must fall back rather than emit NaN.
	const file = physicalPath("session", "good.md", ctx);
	writeFileSync(file, readFileSync(file, "utf8").replace(/^(created_at|updated_at|last_accessed): .*$/gm, "$1: not-a-timestamp"));
	const rows = listNotes(ctx, { scope: "session" });
	assert.equal(rows.length, 1);
	assert.ok(Number.isFinite(rows[0]!.meta.updated_at), "a malformed timestamp degrades to a finite fallback");
	runHandlers(extension, "session_start", {}, ctx);
	const rendered = JSON.stringify(extension.sent);
	assert.ok(rendered.includes("good.md"), "the valid note still renders as a metadata line");
	assert.equal(rendered.includes("keep me"), false, "note bodies stay out of the boot block");
	assert.equal(rendered.includes("NaN"), false, "no malformed timestamp leaks into the boot block");
});


test("JSONL reload retains once-per-window boot and reminder without runtime memory", async () => {
	const sm = manager(true);
	const first = makeExtension(sm);
	const usage = { tokens: 170_000, percent: 85, contextWindow: 200_000 };
	const ctx = context(sm, undefined, usage);
	runHandlers(first, "session_start", {}, ctx);
	await runContextHook(first, ctx);
	await commitTurnEndBoundary(first, sm, ctx);
	appendText(sm, "assistant", "flush the persisted session");
	const path = sm.getSessionFile();
	assert.ok(path);
	const restored = manager();
	restored.setSessionFile(path);
	const loaded = makeExtension(restored);
	const loadedCtx = context(restored, undefined, usage);
	runHandlers(loaded, "session_start", {}, loadedCtx);
	await runContextHook(loaded, loadedCtx);
	assert.equal(loaded.sent.length, 0);
	const messages = restored.getBranch().filter((entry) => entry.type === "custom_message");
	assert.equal(messages.filter((entry) => entry.customType === internal.BOOT_TYPE).length, 1);
	assert.equal(messages.filter((entry) => entry.customType === internal.GUIDANCE_TYPE).length, 1);
});


test("the warning supersedes the early reminder when usage jumps across both thresholds", async () => {
	const sm = manager();
	appendText(sm, "user", "ongoing work");
	const captured = makeExtension(sm);
	const ctx = context(sm, undefined, { tokens: 199_000, percent: 99.5, contextWindow: 200_000 }, false);
	const warningResult = await runContextHook(captured, ctx);
	assert.deepEqual(warningResult?.messages.map((message) => (message as { customType?: string }).customType), [internal.WARNING_TYPE]);
	await commitTurnEndBoundary(captured, sm, ctx);
	const reloaded = makeExtension(sm);
	runHandlers(reloaded, "context", {}, ctx);
	assert.equal(reloaded.sent.length, 0, "persisted warning also suppresses a late reminder after reload");
});


test("warning suppression is branch-local and survives toggling without becoming permanent", async () => {
	const sm = manager();
	appendText(sm, "user", "branch anchor");
	const anchor = sm.getLeafId()!;
	const captured = makeExtension(sm);
	const ctx = context(sm, undefined, { tokens: 199_000, percent: 99.5, contextWindow: 200_000 }, false);
	await runContextHook(captured, ctx);
	await commitTurnEndBoundary(captured, sm, ctx);
	assert.equal(captured.contextMessages.length, 1);
	const warnedLeaf = sm.getLeafId()!;
	await runCommand(captured, "pi-context", "off", ctx);
	await runCommand(captured, "pi-context", "on", ctx);
	await runContextHook(captured, ctx);
	assert.equal(captured.contextMessages.length, 1, "toggle does not revive the warning");
	sm.branch(anchor);
	runHandlers(captured, "session_tree", {}, ctx);
	await runContextHook(captured, ctx);
	assert.equal(captured.contextMessages.length, 2);
	assert.equal((captured.contextMessages[1] as { customType?: string }).customType, internal.WARNING_TYPE, "sibling without the warning gets its own injection");
	sm.branch(warnedLeaf);
	runHandlers(captured, "session_tree", {}, ctx);
	await runContextHook(captured, ctx);
	assert.equal(captured.contextMessages.length, 2, "returning to the warned branch stays suppressed");
});

test("argument footguns die loudly and tool-run metadata surfaces (A1/A2/A3/B4/B5)", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	// A1: an empty query string is an argument error on both search tools, never a match-everything.
	for (const tool of ["history_search", "notes_search"] as const) {
		await assert.rejects(() => call(captured, tool, { query: "" }, ctx), /empty query matches everything/, `${tool}: bare empty string refused`);
		await assert.rejects(() => call(captured, tool, { query: ["alpha", ""] }, ctx), /empty query matches everything/, `${tool}: empty array element refused`);
	}

	// A2: a positive offset past the end is a named error on both read tools; offset == total stays the legal empty end-read.
	await call(captured, "notes_write", { path: "a.md", content: "hello" }, ctx);
	appendText(session, "user", "hello world");
	const windowId = historyFromSession(ctx)[0]!.windowId;
	const listed = resultJson<{ items: Array<{ item_id: string; total_chars: number }> }>(await call(captured, "history_list", {}, ctx));
	const target = listed.items.find((candidate) => candidate.total_chars === "hello world".length);
	assert.ok(target, "the user item is listed");
	const noteTotal = resultRead(await call(captured, "notes_read", { path: "a.md" }, ctx)).total_chars;
	const notePastEnd = resultJson<{ error?: string; offset_chars?: number; total_chars?: number; address?: string }>(
		await call(captured, "notes_read", { path: "a.md", offset_chars: noteTotal + 1 }, ctx),
	);
	assert.match(notePastEnd.error ?? "", /past the end/, "notes: past-end offset is a named error");
	assert.equal(notePastEnd.offset_chars, noteTotal + 1, "notes: the error echoes the offending offset");
	assert.equal(notePastEnd.total_chars, noteTotal, "notes: the error names the real length");
	assert.equal(notePastEnd.address, "a.md", "notes: the error echoes the address");
	const noteEnd = resultRead(await call(captured, "notes_read", { path: "a.md", offset_chars: noteTotal }, ctx));
	assert.equal(noteEnd.content, "", "notes: offset == total is the legal empty end-read");
	assert.equal(noteEnd.next_offset_chars, null, "notes: the end-read terminates");
	assert.equal(noteEnd.header, `--- READ WINDOW ---\naddress: a.md\nchars: [${noteTotal},${noteTotal}) of ${noteTotal}\nnext_offset_chars: null\n`, "notes: empty end-read retains the exact READ WINDOW block");
	const itemFull = resultRead(await call(captured, "history_read", { window_id: windowId, item_id: target.item_id }, ctx));
	assert.equal(itemFull.header, `--- READ WINDOW ---\nwindow_id: ${windowId}\nitem_id: ${target.item_id}\nchars: [0,11) of 11\nnext_offset_chars: null\n`, "history: a fitting read retains the exact shared READ WINDOW block");
	const itemPastEnd = resultJson<{ error?: string; offset_chars?: number; total_chars?: number; window_id?: string; item_id?: string }>(
		await call(captured, "history_read", { window_id: windowId, item_id: target.item_id, offset_chars: 12 }, ctx),
	);
	assert.match(itemPastEnd.error ?? "", /past the end/, "history: past-end offset is a named error");
	assert.equal(itemPastEnd.total_chars, 11, "history: the error names the real length");
	assert.equal(itemPastEnd.item_id, target.item_id, "history: the error echoes the item_id");
	const itemEnd = resultRead(await call(captured, "history_read", { window_id: windowId, item_id: target.item_id, offset_chars: 11 }, ctx));
	assert.equal(itemEnd.content, "", "history: offset == total is the legal empty end-read");
	assert.equal(itemEnd.header, `--- READ WINDOW ---\nwindow_id: ${windowId}\nitem_id: ${target.item_id}\nchars: [11,11) of 11\nnext_offset_chars: null\n`, "history: empty end-read retains the exact READ WINDOW block");

	// A3: editing a missing note is the typed not-found arm; write still creates it.
	const editMissing = resultJson<{ error?: string; path?: string }>(await call(captured, "notes_edit", { path: "missing.md", stale: true }, ctx));
	assert.equal(editMissing.error, "note not found", "an edit of a missing note is named");
	const writeCreates = resultJson<{ error?: string }>(await call(captured, "notes_write", { path: "missing.md", content: "x" }, ctx));
	assert.equal(writeCreates.error, undefined, "write still creates the note");
	const editNow = resultJson<{ error?: string; applied?: number }>(await call(captured, "notes_edit", { path: "missing.md", edits: [{ oldText: "x", newText: "y" }] }, ctx));
	assert.equal(editNow.error, undefined, "edit of an existing note still works");

	// B4/B5: truncation and error metadata ride along on the projected history items.
	type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];
	session.appendMessage({ role: "bashExecution", command: "yes", output: "y\ny\n", exitCode: 0, cancelled: false, truncated: true, fullOutputPath: "/tmp/full-yes.txt", timestamp: Date.now() } as unknown as AppendableMessage);
	session.appendMessage({ role: "bashExecution", command: "true", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now() } as unknown as AppendableMessage);
	session.appendMessage({ role: "toolResult", content: [{ type: "text", text: "boom" }], toolCallId: "call-err", toolName: "bash", isError: true, timestamp: Date.now() } as unknown as AppendableMessage);
	appendText(session, "toolResult", "fine");
	const tools = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_list", { role: "tool", limit: 20 }, ctx));
	const byContent = (needle: string) => {
		const found = tools.items.find((candidate) => String(candidate.truncated_content).includes(needle));
		assert.ok(found, `tool item containing ${JSON.stringify(needle)} is listed`);
		return found;
	};
	const truncatedBash = byContent("yes");
	assert.equal(truncatedBash.output_truncated, true, "a truncated bash run says so");
	assert.equal(truncatedBash.full_output_path, "/tmp/full-yes.txt", "a truncated bash run names its full-output path");
	const cleanBash = byContent("true");
	assert.equal("output_truncated" in cleanBash, false, "an untruncated bash run carries no truncation keys");
	assert.equal("full_output_path" in cleanBash, false, "an untruncated bash run names no path");
	const errored = byContent("boom");
	assert.equal(errored.tool_error, true, "an errored tool result says so");
	const fine = byContent("fine");
	assert.equal("tool_error" in fine, false, "a clean tool result carries no error key");
});

test("notes_search scopes by glob pattern; a non-matching pattern is an empty page, not an error", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { path: "deep/nested/a.md", content: "needle here" }, ctx);
	await call(captured, "notes_write", { path: "top.md", content: "needle there" }, ctx);
	const scoped = resultJson<{ files: Array<{ path: string }> }>(await call(captured, "notes_search", { query: "needle", pattern: "deep/**" }, ctx));
	assert.deepEqual(scoped.files.map((file) => file.path), ["deep/nested/a.md"], "a glob scopes the search to the subtree");
	const none = resultJson<{ files: unknown[]; error?: string }>(await call(captured, "notes_search", { query: "needle", pattern: "absent/**" }, ctx));
	assert.equal(none.error, undefined, "a non-matching pattern is not an error");
	assert.deepEqual(none.files, [], "a non-matching pattern is an empty page");
});
