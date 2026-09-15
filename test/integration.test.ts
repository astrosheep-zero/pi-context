import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
	type SessionCompactEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import piContext, { historyFromSession, internal, notesFromSession } from "../src/index.js";

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

type Captured = {
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

function manager(persisted = false): SessionManager {
	if (!persisted) return SessionManager.inMemory("/private/tmp/pi-context-test");
	const dir = mkdtempSync(join(tmpdir(), "pi-context-session-"));
	return SessionManager.create("/private/tmp/pi-context-test", dir);
}

function makeExtension(sessionManager: SessionManager): Captured {
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

function context(
	sessionManager: SessionManager,
	compact?: ExtensionContext["compact"],
	usage?: ContextUsage,
	idle = true,
	cwd = DEFAULT_CWD,
	projectTrusted = true,
): ExtensionContext {
	const notices: Notice[] = [];
	const fake: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "compact" | "isIdle" | "cwd" | "isProjectTrusted" | "ui"> = {
		sessionManager,
		getContextUsage: () => usage,
		compact: compact ?? (() => {}),
		isIdle: () => idle,
		cwd,
		isProjectTrusted: () => projectTrusted,
		ui: { notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }) } as unknown as ExtensionContext["ui"],
	};
	// Only the members the extension reads; the rest of the ExtensionContext surface is unused.
	return Object.assign(fake as unknown as ExtensionContext, { notices });
}

function noticesOf(ctx: ExtensionContext): Notice[] {
	return (ctx as ExtensionContext & { notices: Notice[] }).notices;
}

async function call(
	captured: Captured,
	name: string,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const tool = captured.tools.get(name);
	assert.ok(tool, `registered ${name}`);
	return tool.execute("call-1", params, new AbortController().signal, () => {}, ctx) as Promise<AgentToolResult<unknown>>;
}

function resultJson<T>(result: AgentToolResult<unknown>): T {
	const text = result.content[0];
	assert.ok(text && text.type === "text", "tool result carries text");
	return JSON.parse(text.text) as T;
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
	for (const handler of captured.handlers.get(name) ?? []) handler(event as never, ctx);
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

type BeforeAgentStartResult = { message?: { customType: string; content: unknown; display: boolean } } | undefined;

async function runBeforeAgentStart(captured: Captured, ctx: ExtensionContext): Promise<BeforeAgentStartResult> {
	const handler = captured.handlers.get("before_agent_start")?.[0];
	assert.ok(handler, "before_agent_start handler registered");
	return (await handler({ type: "before_agent_start", prompt: "user input", images: undefined, systemPrompt: "system", systemPromptOptions: {} } as never, ctx)) as BeforeAgentStartResult;
}

function appendText(sessionManager: SessionManager, role: "user" | "assistant" | "toolResult", text: string): string {
	const base = {
		role,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
		...(role === "assistant" ? { stopReason: "stop" } : {}),
		...(role === "toolResult" ? { toolCallId: "call-1", toolName: "bash", isError: false } : {}),
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
		"notes_list_files_by_prefix", "notes_read_file", "notes_search_contents", "notes_append_to_file", "notes_write_file",
		"new_context", "get_context_remaining",
	]) {
		const tool = captured.tools.get(name);
		assert.equal(objectSchema(tool)?.type, "object", name);
	}
	assert.equal(objectSchema(captured.tools.get("history_read_item"))?.required?.includes("item_id"), true);
	assert.equal(objectSchema(captured.tools.get("notes_write_file"))?.required?.includes("text"), true);
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
	assert.deepEqual(
		resultJson(await call(captured, "notes_read_file", { path: "checkpoint/进度.txt", start_line: -1, stop_line: -1 }, ctx)),
		{ path: "checkpoint/进度.txt", start_line: 3, stop_line: 3, content: "最后一行" },
	);
	const searched = resultJson<{ files: Array<{ matches: Array<{ line: number }> }> }>(
		await call(captured, "notes_search_contents", { query: "Café" }, ctx),
	);
	assert.equal(searched.files[0]?.matches[0]?.line, 2);
	await assert.rejects(() => call(captured, "notes_write_file", { path: "../escape", text: "x" }, ctx), /unsupported component/);
	const tooLarge = resultJson<{ error: string }>(
		await call(captured, "notes_write_file", { path: "large", text: "é".repeat(500_001) }, ctx),
	);
	assert.match(tooLarge.error, /1000000/);
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
	assert.equal(providerText.includes(internal.RESET_SUMMARY), true);

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
	assert.equal(rootBoot?.message.display, true, "boot block lands in the TUI");
	assert.equal(rootBoot?.options?.triggerTurn, false);
	const rootText = typeof rootBoot?.message.content === "string" ? rootBoot.message.content : "";
	assert.ok(rootText.startsWith(internal.CONTEXT_WINDOW_OPEN_TAG), "root block omits the reset line");
	assert.equal(rootText.includes("Previous context window id:"), false, "root block omits the previous-id line");
	assert.match(rootText, /Current context window id: pcw:.+:root/);
	assert.match(rootText, /- decisions\.md \(1 lines, 9 UTF-8 bytes\)/);
	assert.ok(rootText.includes(internal.CONTEXT_WINDOW_PROTOCOL_OPEN_TAG));

	// Reset: the boot block IS the compaction summary; no separate boot/hint is persisted.
	await call(captured, "new_context", {}, ctx);
	runHandlers(captured, "agent_end", {}, ctx);
	const before = await runBeforeCompact(captured, ctx, 9);
	assert.ok(before && "compaction" in before);
	const details = before.compaction.details as { piContext: string; windowId: string };
	assert.equal(details.piContext, "reset-v2");
	assert.match(details.windowId, /^pcw:.+:[0-9a-f]{8}$/);
	assert.ok(before.compaction.summary.startsWith(internal.RESET_SUMMARY));
	assert.match(before.compaction.summary, new RegExp(`Current context window id: ${details.windowId}`));
	assert.match(before.compaction.summary, /- decisions\.md \(1 lines, 9 UTF-8 bytes\)/);
	assert.ok(before.compaction.summary.includes(internal.CONTEXT_WINDOW_PROTOCOL_OPEN_TAG));
	const windows = historyFromSession(ctx);
	assert.ok(before.compaction.summary.includes(`Previous context window id: ${windows[windows.length - 1]?.windowId}`));

	const compactionId = sessionManager.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 9, details, true);
	const compactionEntry = sessionManager.getEntry(compactionId);
	assert.ok(compactionEntry && compactionEntry.type === "compaction");
	runHandlers(captured, "session_compact", { willRetry: false, compactionEntry }, ctx);

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
	const windows = resultJson<{ windows: Array<{ window_id: string }> }>(await call(captured, "history_list_windows", {}, ctx));
	assert.equal(windows.windows.length, 2);
	assert.equal(windows.windows[1]?.window_id, details.windowId);
	// The minted id is Pi's 8-hex entry-id shape, but the window id is ours.
	assert.match(details.windowId, /^pcw:.+:[0-9a-f]{8}$/);

	// history_* accepts the minted window id and resolves the baked summary item.
	const listed = resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_list_items", { window_id: details.windowId }, ctx));
	assert.equal(listed.items.length, 1);
	assert.equal(listed.items[0]?.item_id, compactionEntry.id);
});

test("a Pi-native compaction with the extension off keeps entry.id as the window id", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	appendText(sessionManager, "user", "native compaction");
	await runCommand(captured, "pi-context", "off", ctx);

	const compactionId = sessionManager.appendCompaction("Pi native summary", sessionManager.getLeafId() as string, 100, { readFiles: [], modifiedFiles: [] }, true);
	const windows = resultJson<{ windows: Array<{ window_id: string }> }>(await call(captured, "history_list_windows", {}, ctx));
	assert.equal(windows.windows[1]?.window_id, `pcw:${sessionManager.getSessionId()}:${compactionId}`, "native compactions fall back to entry.id");
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

	// Below threshold: persist once (TUI-visible, no turn triggered) and return no
	// transient copy — history and the model's view never diverge on position.
	const low = context(sessionManager, undefined, { tokens: 190_000, percent: 95, contextWindow: 200_000 });
	assert.equal(await runContextHook(captured, low), undefined, "the context hook injects nothing");
	assert.equal(captured.sent.length, 1, "persisted exactly once");
	assert.equal(captured.sent[0]?.message.customType, internal.GUIDANCE_TYPE);
	assert.equal(captured.sent[0]?.message.display, true, "guidance lands in the TUI");
	assert.equal(captured.sent[0]?.options?.triggerTurn, false, "never triggers an extra turn");
	const text = captured.sent[0]?.message.content;
	assert.ok(typeof text === "string" && text.startsWith(internal.GUIDANCE_OPEN_TAG));
	assert.match(text, /Context budget is running low/);
	assert.match(text, /only 10000 tokens remained when this reminder was recorded/);
	assert.match(text, /does not guarantee another note-taking turn/);

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
	assert.match(newWindowText, /only 4000 tokens remained when this reminder was recorded/, "fresh window persists its own measured count");
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
	assert.ok(requestedCompact, "manual compaction is deferred until agent_end/tool result boundary");

	const before = await runBeforeCompact(captured, ctx, 7);
	assert.ok(before && "compaction" in before);
	const compactionId = sessionManager.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 7, before.compaction.details, true);
	const compactionEntry = sessionManager.getEntry(compactionId);
	assert.ok(compactionEntry && compactionEntry.type === "compaction");
	const compactEvent: Pick<SessionCompactEvent, "willRetry" | "compactionEntry"> = { willRetry: false, compactionEntry };
	runHandlers(captured, "session_compact", compactEvent, ctx);
	runHandlers(captured, "session_compact", compactEvent, ctx);
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
	assert.equal(captured.sent.length, 3, "boot block persisted again after re-enable");
	assert.equal(captured.sent[2]?.message.customType, internal.BOOT_TYPE);

	notices = await runCommand(captured, "pi-context", "maybe", low);
	assert.equal(notices[0]?.type, "error", "unknown argument rejected");

	// Bare command reports current state without changing it.
	notices = await runCommand(captured, "pi-context", "", low);
	assert.match(notices[0]?.message ?? "", /on/);
});

test("all compaction paths reset immediately, bake the boot block, and leave native scheduling alone", async () => {
	for (const reason of ["manual", "threshold", "overflow"] as const) {
		for (const idle of [false, true]) {
			const sm = manager();
			appendText(sm, "user", "long task history");
			const captured = makeExtension(sm);
			const ctx = context(sm, undefined, undefined, idle);
			assert.equal(captured.handlers.has("input"), false, "no user-input interception");
			for (let window = 0; window < 2; window++) {
				const before = await runBeforeCompact(captured, ctx, 100, reason);
				assert.ok(before && "compaction" in before, `${reason}, idle=${idle}: no fallback cancellation`);
				assert.equal(captured.sent.length, 0, "no extra note-taking turn and no hint");
				assert.match(before.compaction.summary, /No summary was generated/);
				const details = before.compaction.details as { piContext: string; windowId: string };
				assert.equal(details.piContext, "reset-v2");
				assert.match(before.compaction.summary, new RegExp(`Current context window id: ${details.windowId}`));
				const id = sm.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 100, details, true);
				const compactionEntry = sm.getEntry(id);
				assert.ok(compactionEntry && compactionEntry.type === "compaction");
				const event = { reason, willRetry: reason === "overflow", compactionEntry };
				runHandlers(captured, "session_compact", event, ctx);
				runHandlers(captured, "session_compact", event, ctx);
				assert.equal(captured.sent.length, 0, "no hint and no continuation; Pi owns automatic scheduling");
			}
		}
	}
});

test("thresholds derive from compaction.reserveTokens plus pi-context margins", async () => {
	const fixture = settingsFixture({
		reserveTokens: 100_000,
		global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 30_000, fallbackMarginTokens: 10_000 } },
	});
	const sm = manager();
	const captured = makeExtension(sm);
	const window = 300_000;
	const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);

	// fallback = 100000 + 10000, reminder = 100000 + 30000.
	assert.equal(await runContextHook(captured, at(130_001)), undefined, "nothing injected above the derived reminder");
	assert.equal(captured.sent.length, 0, "no guidance above the derived reminder");
	assert.equal(await runContextHook(captured, at(130_000)), undefined, "derived reminder crossing persists only");
	assert.equal(captured.sent.length, 1, "derived reminder fires");
	assert.match(String(captured.sent[0]?.message.content), /only 130000 tokens remained when this reminder was recorded/);

	assert.equal(await runBeforeAgentStart(captured, at(110_001)), undefined, "above the derived fallback");
	const fallback = await runBeforeAgentStart(captured, at(110_000));
	assert.equal(fallback?.message?.customType, internal.FALLBACK_TYPE, "derived fallback fires");
});

test("absent pi-context key or margins reproduce the legacy thresholds at Pi's default reserve", async () => {
	assert.equal(internal.DEFAULT_RESERVE_TOKENS, 16_384);
	assert.equal(internal.DEFAULT_RESERVE_TOKENS + internal.DEFAULT_REMINDER_MARGIN_TOKENS, 65_536);
	assert.equal(internal.DEFAULT_RESERVE_TOKENS + internal.DEFAULT_FALLBACK_MARGIN_TOKENS, 40_960);

	for (const [label, options] of [
		["absent key", { global: {} }],
		["absent margins", { global: { [internal.PI_CONTEXT_SETTINGS_KEY]: {} } }],
	] as const) {
		const fixture = settingsFixture(options);
		const sm = manager();
		const captured = makeExtension(sm);
		const window = 200_000;
		const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);
		const first = at(65_537);
		assert.equal(await runContextHook(captured, first), undefined, `${label}: nothing injected above the legacy reminder`);
		assert.equal(captured.sent.length, 0, `${label}: no guidance above the legacy reminder`);
		assert.equal(await runContextHook(captured, at(65_536)), undefined, `${label}: legacy reminder crossing persists only`);
		assert.equal(captured.sent.length, 1, `${label}: legacy reminder fires`);
		assert.match(String(captured.sent[0]?.message.content), /only 65536 tokens remained/, label);
		assert.equal(await runBeforeAgentStart(captured, at(40_961)), undefined, `${label}: above the legacy fallback`);
		const fallback = await runBeforeAgentStart(captured, at(40_960));
		assert.equal(fallback?.message?.customType, internal.FALLBACK_TYPE, `${label}: legacy fallback fires`);
		assert.equal(noticesOf(first).length, 0, `${label}: valid defaults warn nobody`);
	}
});

test("project pi-context margins and reserve override global per key", async () => {
	const fixture = settingsFixture({
		reserveTokens: 20_000,
		global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 30_000, fallbackMarginTokens: 10_000 } },
		project: { compaction: { reserveTokens: 50_000 }, [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 40_000 } },
	});
	// Project reserve wins: reminder = 50000 + 40000 (project margin), fallback = 50000 + 10000 (global margin).
	const sm = manager();
	const captured = makeExtension(sm);
	const window = 300_000;
	const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);
	assert.equal(await runContextHook(captured, at(90_001)), undefined, "nothing injected above the project-derived reminder");
	assert.equal(captured.sent.length, 0);
	assert.equal(await runContextHook(captured, at(90_000)), undefined, "project-derived reminder crossing persists only");
	assert.equal(captured.sent.length, 1, "project reminder margin wins");
	assert.equal(await runBeforeAgentStart(captured, at(60_001)), undefined, "above the project-derived fallback");
	const fallback = await runBeforeAgentStart(captured, at(60_000));
	assert.equal(fallback?.message?.customType, internal.FALLBACK_TYPE, "global fallback margin survives the project override");
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

test("thresholds are re-read from settings.json on session_start", async () => {
	const fixture = settingsFixture({ global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { fallbackMarginTokens: 10_000 } } });
	const sm = manager();
	const captured = makeExtension(sm);
	const at = (remaining: number) => context(sm, undefined, { tokens: 100_000 - remaining, percent: 0, contextWindow: 100_000 }, true, fixture.cwd);
	runHandlers(captured, "session_start", { reason: "startup" }, at(0));
	// Initial fallback = 16384 + 10000 = 26384; 35000 is above it.
	assert.equal(await runBeforeAgentStart(captured, at(35_000)), undefined, "initial fallback margin");
	// Rewrite the global settings file, then session_start must pick up the new margin.
	writeJson(join(fixture.agentDir, "settings.json"), { [internal.PI_CONTEXT_SETTINGS_KEY]: { fallbackMarginTokens: 24_576 } });
	runHandlers(captured, "session_start", { reason: "startup" }, at(0));
	// New fallback = 16384 + 24576 = 40960; 35000 is now below it.
	const fallback = await runBeforeAgentStart(captured, at(35_000));
	assert.equal(fallback?.message?.customType, internal.FALLBACK_TYPE, "fallback margin re-read on session_start");
});

test("invalid margins degrade per key with one warning and never throw", async () => {
	const fixture = settingsFixture({ global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 0, fallbackMarginTokens: 10_000 } } });
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm, undefined, undefined, true, fixture.cwd);
	assert.doesNotThrow(() => runHandlers(captured, "session_start", { reason: "startup" }, ctx));
	const notices = noticesOf(ctx);
	assert.equal(notices.length, 1, "one warning for the offending key");
	assert.equal(notices[0]?.type, "warning");
	assert.match(notices[0]?.message ?? "", /reminderMarginTokens/);
	assert.match(notices[0]?.message ?? "", /49152/);

	const window = 200_000;
	const at = (remaining: number, idle = true) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, idle, fixture.cwd);
	// Valid fallback margin is preserved: fallback = 16384 + 10000 = 26384; reminder = 16384 + 49152 = 65536.
	assert.equal(await runContextHook(captured, at(65_537)), undefined, "nothing injected above the degraded reminder");
	assert.equal(await runContextHook(captured, at(65_536)), undefined, "degraded reminder uses its default");
	assert.equal(captured.sent.length, 2, "root boot plus degraded reminder");
	assert.equal(await runBeforeAgentStart(captured, at(26_385)), undefined);
	const fallback = await runBeforeAgentStart(captured, at(26_384));
	assert.equal(fallback?.message?.customType, internal.FALLBACK_TYPE, "valid fallback margin survives");
	assert.doesNotThrow(() => runHandlers(captured, "turn_end", {}, at(0, false)));
	assert.equal(notices.length, 1, "warning stays one-time across session handlers");
});

test("a reminder margin that does not clear the fallback degrades to its default with one warning", async () => {
	const fixture = settingsFixture({ global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 1_000, fallbackMarginTokens: 2_000 } } });
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm, undefined, undefined, true, fixture.cwd);
	assert.doesNotThrow(() => runHandlers(captured, "session_start", { reason: "startup" }, ctx));
	const notices = noticesOf(ctx);
	assert.equal(notices.length, 1, "one warning for the reversed ordering");
	assert.match(notices[0]?.message ?? "", /reminderMarginTokens/);
	assert.match(notices[0]?.message ?? "", /49152/);

	const at = (remaining: number, idle = true) => context(sm, undefined, { tokens: 200_000 - remaining, percent: 0, contextWindow: 200_000 }, idle, fixture.cwd);
	// reminder = 65536, valid fallback = 16384 + 2000 = 18384.
	assert.equal(await runContextHook(captured, at(65_537)), undefined, "nothing injected above the degraded reminder");
	assert.equal(await runContextHook(captured, at(65_536)), undefined, "degraded reminder fires at default margin");
	assert.equal(captured.sent.length, 2);
	assert.equal(await runBeforeAgentStart(captured, at(18_385)), undefined);
	const fallback = await runBeforeAgentStart(captured, at(18_384));
	assert.equal(fallback?.message?.customType, internal.FALLBACK_TYPE);
	assert.doesNotThrow(() => runHandlers(captured, "turn_end", {}, at(0, false)));
	assert.equal(notices.length, 1, "warning stays one-time");
});

test("an invalid fallback margin degrades alone without disturbing a valid reminder margin", async () => {
	const fixture = settingsFixture({ global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 30_000, fallbackMarginTokens: "nope" } } });
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm, undefined, undefined, true, fixture.cwd);
	runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	const notices = noticesOf(ctx);
	assert.equal(notices.length, 1, "one warning for the offending fallback key");
	assert.match(notices[0]?.message ?? "", /fallbackMarginTokens/);
	assert.match(notices[0]?.message ?? "", /24576/);

	const at = (remaining: number) => context(sm, undefined, { tokens: 200_000 - remaining, percent: 0, contextWindow: 200_000 }, true, fixture.cwd);
	// reminder = 16384 + 30000 = 46384; degraded fallback = 16384 + 24576 = 40960.
	assert.equal(await runContextHook(captured, at(46_385)), undefined, "nothing injected above the valid reminder");
	assert.equal(await runContextHook(captured, at(46_384)), undefined, "valid reminder margin still fires");
	assert.equal(captured.sent.length, 2, "root boot plus valid reminder");
	const fallback = await runBeforeAgentStart(captured, at(40_960));
	assert.equal(fallback?.message?.customType, internal.FALLBACK_TYPE, "degraded fallback uses its default");
	assert.equal(notices.length, 1);
});

test("the old threshold flags are no longer registered", () => {
	const captured = makeExtension(manager());
	assert.deepEqual(captured.flags, []);
});

test("a fallback margin that still overwhelms the default reminder degrades too, keeping the invariant", async () => {
	const fixture = settingsFixture({ global: { [internal.PI_CONTEXT_SETTINGS_KEY]: { reminderMarginTokens: 1_000, fallbackMarginTokens: 60_000 } } });
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm, undefined, undefined, true, fixture.cwd);
	runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	const notices = noticesOf(ctx);
	assert.equal(notices.length, 2, "each offending key warns once");
	assert.match(notices[0]?.message ?? "", /reminderMarginTokens/);
	assert.match(notices[1]?.message ?? "", /fallbackMarginTokens/);

	const at = (remaining: number) => context(sm, undefined, { tokens: 200_000 - remaining, percent: 0, contextWindow: 200_000 }, true, fixture.cwd);
	// Both margins degrade to defaults, so reminder 65536 > fallback 40960 > reserve 16384 still holds.
	assert.equal(await runBeforeAgentStart(captured, at(40_961)), undefined);
	const fallback = await runBeforeAgentStart(captured, at(40_960));
	assert.equal(fallback?.message?.customType, internal.FALLBACK_TYPE);
});


test("final fallback turn uses public turn boundaries without intercepting or replaying user input", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	const window = 200_000;
	const ctxAt = (remaining: number, idle = false) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, idle);

	assert.equal(captured.handlers.has("input"), false, "no input copy/replay special case");
	assert.equal(await runBeforeAgentStart(captured, ctxAt(40_961)), undefined);
	const fallback = await runBeforeAgentStart(captured, ctxAt(40_960));
	assert.equal(fallback?.message?.customType, internal.FALLBACK_TYPE);
	assert.equal(fallback?.message?.display, true);
	assert.equal(fallback?.message?.content, internal.FALLBACK_PROMPT);
	assert.equal(await runBeforeAgentStart(captured, ctxAt(40_960)), undefined, "one fallback per window");

	// Fresh window re-arms the fallback.
	const before = await runBeforeCompact(captured, ctxAt(30_000), 100, "threshold");
	assert.ok(before && "compaction" in before, "the reserve-line compaction proceeds directly");
	const compactionId = sm.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 100, before.compaction.details, true);
	const compactionEntry = sm.getEntry(compactionId);
	assert.ok(compactionEntry && compactionEntry.type === "compaction");
	runHandlers(captured, "session_compact", { reason: "threshold", willRetry: false, compactionEntry }, ctxAt(30_000));
	assert.equal(captured.sent.length, 0, "automatic reset persists nothing; the boot block is in the summary");
	const nextFallback = await runBeforeAgentStart(captured, ctxAt(40_960));
	assert.equal(nextFallback?.message?.customType, internal.FALLBACK_TYPE, "fallback re-armed after reset");

	// A running tool chain gets the same final-call message at the ordinary turn boundary.
	const streaming = makeExtension(sm);
	const streamingCtx = ctxAt(40_960, false);
	runHandlers(streaming, "turn_end", {}, streamingCtx);
	assert.equal(streaming.sent.length, 1);
	assert.equal(streaming.sent[0]?.message.customType, internal.FALLBACK_TYPE);
	assert.equal(streaming.sent[0]?.options?.triggerTurn, true);
	assert.match(String(streaming.sent[0]?.message.content), /final fallback turn/);
	runHandlers(streaming, "turn_end", {}, streamingCtx);
	assert.equal(streaming.sent.length, 1, "turn_end fallback is one-shot per window");

	// Idle turns stay with the before_agent_start path; only streaming gets a new run.
	const idleOnly = makeExtension(manager());
	runHandlers(idleOnly, "turn_end", {}, ctxAt(40_960, true));
	assert.equal(idleOnly.sent.length, 0, "turn_end fallback does not fire while idle");

	// A fresh window re-arms the turn_end fallback.
	const streamingReset = await runBeforeCompact(streaming, streamingCtx, 100, "threshold");
	assert.ok(streamingReset && "compaction" in streamingReset);
	const streamingCompactionId = sm.appendCompaction(streamingReset.compaction.summary, streamingReset.compaction.firstKeptEntryId, 100, streamingReset.compaction.details, true);
	const streamingCompactionEntry = sm.getEntry(streamingCompactionId);
	assert.ok(streamingCompactionEntry && streamingCompactionEntry.type === "compaction");
	runHandlers(streaming, "session_compact", { reason: "threshold", willRetry: false, compactionEntry: streamingCompactionEntry }, streamingCtx);
	assert.equal(streaming.sent.length, 1, "the reset persists nothing");
	runHandlers(streaming, "turn_end", {}, streamingCtx);
	assert.equal(streaming.sent.length, 2, "fresh window re-arms the streaming fallback once");
	assert.equal(streaming.sent[1]?.message.customType, internal.FALLBACK_TYPE);
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
		assert.equal(compactions, window + 1);
		const before = await runBeforeCompact(captured, ctx, 100);
		assert.ok(before && "compaction" in before);
		const id = sm.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 100, before.compaction.details, true);
		const event = { willRetry: false, compactionEntry: sm.getEntry(id) };
		runHandlers(captured, "session_compact", event, ctx);
		runHandlers(captured, "session_compact", event, ctx);
		assert.equal(captured.sent.length, window + 1, "one continuation per explicit reset, and no hint");
	}
});
