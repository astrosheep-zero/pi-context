import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type RegisteredCommand,
	SessionManager,
	type SessionCompactEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import piContext, { historyFromSession, internal, notesFromSession } from "../src/index.js";

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
	const captured: Captured = { tools: new Map(), handlers: new Map(), commands: new Map(), sent: [] };
	const api = {
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
	// The harness implements only the four ExtensionAPI members this extension uses;
	// the remaining surface (commands, UI, exec, …) is never touched.
	piContext(api as unknown as ExtensionAPI);
	return captured;
}

function context(
	sessionManager: SessionManager,
	compact?: ExtensionContext["compact"],
	usage?: ContextUsage,
): ExtensionContext {
	const fake: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "compact"> = {
		sessionManager,
		getContextUsage: () => usage,
		compact: compact ?? (() => {}),
	};
	// Only the three members the extension reads; ui/modelRegistry/events are unused.
	return fake as unknown as ExtensionContext;
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

async function runBeforeCompact(captured: Captured, ctx: ExtensionContext, tokensBefore: number): Promise<CompactionHookResult> {
	const handler = captured.handlers.get("session_before_compact")?.[0];
	assert.ok(handler, "session_before_compact handler registered");
	const event = { reason: "manual", willRetry: false, signal: new AbortController().signal, preparation: { tokensBefore } };
	return (await handler(event as never, ctx)) as CompactionHookResult;
}

function runHandlers(captured: Captured, name: string, event: unknown, ctx: ExtensionContext): void {
	for (const handler of captured.handlers.get(name) ?? []) handler(event as never, ctx);
}

type Notice = { message: string; type?: "info" | "warning" | "error" };

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

async function runContextHook(captured: Captured, ctx: ExtensionContext): Promise<ContextHookResult> {
	const handler = captured.handlers.get("context")?.[0];
	assert.ok(handler, "context handler registered");
	return (await handler({ type: "context", messages: [] } as never, ctx)) as ContextHookResult;
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
	const crossAgent = resultJson<{ error: string }>(await call(captured, "history_list_windows", { agent_name: "other" }, ctx));
	assert.match(crossAgent.error, /cross-agent/);
	assert.ok(sessionManager.getEntry(compactionId));
});

test("context_window hint persists as a TUI-visible message at session start and after each reset", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	appendText(sessionManager, "user", "task before reset");
	appendText(sessionManager, "assistant", "working");
	await call(captured, "notes_write_file", { path: "decisions.md", text: "use terra" }, ctx);

	// session_start persists the hint without triggering a turn.
	runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	assert.equal(captured.sent.length, 1);
	const startHint = captured.sent[0];
	assert.equal(startHint?.message.customType, internal.HINT_TYPE);
	assert.equal(startHint?.message.display, true, "hint lands in the TUI");
	assert.equal(startHint?.options?.triggerTurn, false);
	const startText = typeof startHint?.message.content === "string" ? startHint.message.content : "";
	assert.ok(startText.startsWith(internal.CONTEXT_WINDOW_OPEN_TAG));
	assert.match(startText, /First context window id: pcw:/);
	assert.match(startText, /- decisions\.md \(1 lines, 9 UTF-8 bytes\)/);

	// After a reset, the hint is persisted again with the new window ids, before the continuation.
	await call(captured, "new_context", {}, ctx);
	runHandlers(captured, "agent_end", {}, ctx);
	const before = await runBeforeCompact(captured, ctx, 9);
	assert.ok(before && "compaction" in before);
	const compactionId = sessionManager.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 9, before.compaction.details, true);
	const compactionEntry = sessionManager.getEntry(compactionId);
	assert.ok(compactionEntry && compactionEntry.type === "compaction");
	runHandlers(captured, "session_compact", { willRetry: false, compactionEntry }, ctx);

	assert.equal(captured.sent.length, 3, "persisted hint + hidden continuation after reset");
	const resetHint = captured.sent[1];
	const continuation = captured.sent[2];
	assert.equal(resetHint?.message.customType, internal.HINT_TYPE);
	assert.equal(resetHint?.options?.triggerTurn, false);
	assert.equal(continuation?.options?.triggerTurn, true);

	const windows = historyFromSession(ctx);
	assert.equal(windows.length, 2);
	const resetText = typeof resetHint?.message.content === "string" ? resetHint.message.content : "";
	assert.ok(resetText.includes(`Previous context window id: ${windows[0]?.windowId}`));
	assert.ok(resetText.includes(`Current context window id: ${windows[1]?.windowId}`));
});

test("low-budget guidance is injected on every request while below the threshold", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	type TransformResult = { messages: Array<{ content: Array<{ text: string }> }> };

	// Above threshold: nothing injected.
	const comfortable = context(sessionManager, undefined, { tokens: 10_000, percent: 5, contextWindow: 200_000 });
	assert.equal(await runContextHook(captured, comfortable), undefined);

	// Unknown usage (right after compaction): stay silent.
	const unknown = context(sessionManager, undefined, { tokens: null, percent: null, contextWindow: 200_000 });
	assert.equal(await runContextHook(captured, unknown), undefined);

	// Below threshold: guidance on every request, because a transient single-shot
	// would vanish from the next request (Codex's persisted reminder stays visible).
	const low = context(sessionManager, undefined, { tokens: 190_000, percent: 95, contextWindow: 200_000 });
	let transformed = (await runContextHook(captured, low)) as TransformResult;
	assert.equal(transformed.messages.length, 1);
	const guidance = transformed.messages[0]?.content[0]?.text ?? "";
	assert.ok(guidance.startsWith(internal.GUIDANCE_OPEN_TAG));
	assert.match(guidance, /You have 10000 tokens left/);
	transformed = (await runContextHook(captured, low)) as TransformResult;
	assert.equal(transformed.messages.length, 1, "re-injected while still below threshold");
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
	assert.equal(captured.sent.length, 2, "one persisted hint plus exactly one hidden continuation");
	assert.equal(captured.sent[0]?.options?.triggerTurn, false, "hint does not trigger a turn");
	assert.equal(captured.sent[1]?.message.display, false);
	assert.equal(captured.sent[1]?.options?.triggerTurn, true);

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

test("pi-context command toggles hint injection, guidance, and reset compaction at runtime", async () => {
	const sessionManager = manager();
	appendText(sessionManager, "user", "hello");
	const captured = makeExtension(sessionManager);
	const low = context(sessionManager, undefined, { tokens: 190_000, contextWindow: 200_000, percent: 95 });

	// On by default: session_start persists a hint; low budget injects guidance.
	runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 1);
	assert.ok((await runContextHook(captured, low)) !== undefined);

	let notices = await runCommand(captured, "pi-context", "off", low);
	assert.match(notices[0]?.message ?? "", /off/);
	assert.equal(await runContextHook(captured, low), undefined, "no guidance while off");
	runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 1, "no hint persisted while off");
	assert.equal(await runBeforeCompact(captured, low, 123), undefined, "default Pi compaction applies while off");
	const offResult = resultJson<{ error?: string }>(await call(captured, "new_context", {}, low));
	assert.match(offResult.error ?? "", /off/, "new_context refuses while off");

	notices = await runCommand(captured, "pi-context", "on", low);
	assert.match(notices[0]?.message ?? "", /on/);
	assert.ok((await runContextHook(captured, low)) !== undefined, "guidance injected again after re-enable");
	runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 2, "hint persisted again after re-enable");

	notices = await runCommand(captured, "pi-context", "maybe", low);
	assert.equal(notices[0]?.type, "error", "unknown argument rejected");

	// Bare command reports current state without changing it.
	notices = await runCommand(captured, "pi-context", "", low);
	assert.match(notices[0]?.message ?? "", /on/);
});
