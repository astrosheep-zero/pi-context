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
	flags: Map<string, string | boolean>;
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
	const captured: Captured = { tools: new Map(), handlers: new Map(), commands: new Map(), sent: [], flags: new Map() };
	const api = {
		registerFlag(name: string, options: { default?: string | boolean }) {
			if (options.default !== undefined) captured.flags.set(name, options.default);
		},
		getFlag(name: string) {
			return captured.flags.get(name);
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
): ExtensionContext {
	const fake: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "compact" | "isIdle"> = {
		sessionManager,
		getContextUsage: () => usage,
		compact: compact ?? (() => {}),
		isIdle: () => idle,
	};
	// Only the members the extension reads; ui/modelRegistry/events are unused.
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

test("low-budget guidance persists once per window and covers the in-flight request transiently", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	type TransformResult = { messages: Array<{ role: string; customType?: string; content: Array<{ text: string }> }> };

	// First request of the window: the transient context_window hint covers it, because
	// the hint session_compact persists may not have landed in history yet.
	const comfortable = context(sessionManager, undefined, { tokens: 10_000, percent: 5, contextWindow: 200_000 });
	let transformed = (await runContextHook(captured, comfortable)) as TransformResult;
	assert.equal(transformed.messages.length, 1, "only the transient window hint, no guidance");
	assert.equal(transformed.messages[0]?.role, "user");
	assert.match(transformed.messages[0]?.content[0]?.text ?? "", new RegExp(`^${internal.CONTEXT_WINDOW_OPEN_TAG}`));
	assert.equal(captured.sent.length, 0, "the transient hint is not persisted by the context hook");

	// Same window: no re-injection.
	assert.equal(await runContextHook(captured, comfortable), undefined);

	// A hint already present in the request messages suppresses the transient copy.
	const persisted = makeExtension(manager());
	const persistedHint = { role: "custom", customType: internal.HINT_TYPE, content: "<context_window>\npersisted\n</context_window>", display: true, timestamp: 0 };
	assert.equal(await runContextHook(persisted, comfortable, { messages: [persistedHint] }), undefined, "no transient copy beside a persisted hint");
	assert.equal(persisted.sent.length, 0);

	// Unknown usage (right after compaction): stay silent.
	const unknown = context(sessionManager, undefined, { tokens: null, percent: null, contextWindow: 200_000 });
	assert.equal(await runContextHook(captured, unknown), undefined);

	// Below threshold, first request of the window: persist once (TUI-visible, no
	// turn triggered) and return a transient tail copy for the in-flight request.
	const low = context(sessionManager, undefined, { tokens: 190_000, percent: 95, contextWindow: 200_000 });
	transformed = (await runContextHook(captured, low)) as TransformResult;
	assert.equal(transformed.messages.length, 1, "transient copy covers the in-flight request");
	const text = transformed.messages[0]?.content[0]?.text ?? "";
	assert.ok(text.startsWith(internal.GUIDANCE_OPEN_TAG));
	assert.match(text, /Context budget is running low/);
	assert.match(text, /only 10000 tokens remained when this reminder was recorded/);
	assert.match(text, /does not guarantee another note-taking turn/);
	assert.equal(captured.sent.length, 1, "persisted exactly once");
	assert.equal(captured.sent[0]?.message.customType, internal.GUIDANCE_TYPE);
	assert.equal(captured.sent[0]?.message.display, true, "guidance lands in the TUI");
	assert.equal(captured.sent[0]?.options?.triggerTurn, false, "never triggers an extra turn");
	assert.equal(captured.sent[0]?.message.content, text, "persisted and transient copies are the same render");

	// Same window: the persisted message carries it, no more transient injection.
	assert.equal(await runContextHook(captured, low), undefined);
	assert.equal(captured.sent.length, 1, "no duplicate persist, so no re-render");

	// A reset boundary creates a new window: eligible again, hint before guidance,
	// with its own measured count frozen into a fresh render.
	const before = await runBeforeCompact(captured, low, 190_000);
	assert.ok(before && "compaction" in before);
	sessionManager.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 190_000, before.compaction.details, true);
	const newWindow = context(sessionManager, undefined, { tokens: 196_000, percent: 98, contextWindow: 200_000 });
	transformed = (await runContextHook(captured, newWindow)) as TransformResult;
	assert.equal(transformed.messages.length, 2, "new window re-arms the transient hint and the guidance");
	assert.match(transformed.messages[0]?.content[0]?.text ?? "", new RegExp(`^${internal.CONTEXT_WINDOW_OPEN_TAG}`));
	assert.match(transformed.messages[1]?.content[0]?.text ?? "", new RegExp(`^${internal.GUIDANCE_OPEN_TAG}`));
	assert.equal(captured.sent.length, 2);
	const newWindowText = transformed.messages[1]?.content[0]?.text ?? "";
	assert.match(newWindowText, /only 4000 tokens remained when this reminder was recorded/);
	assert.equal(captured.sent[1]?.message.content, newWindowText, "fresh window carries its own measured count");
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

	// On by default: session_start persists a hint; low budget persists guidance.
	runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 1);
	assert.ok((await runContextHook(captured, low)) !== undefined);
	assert.equal(captured.sent.length, 2, "guidance persisted");

	let notices = await runCommand(captured, "pi-context", "off", low);
	assert.match(notices[0]?.message ?? "", /off/);
	assert.equal(await runContextHook(captured, low), undefined, "no guidance while off");
	runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 2, "no hint persisted while off");
	assert.equal(await runBeforeCompact(captured, low, 123), undefined, "default Pi compaction applies while off");
	const offResult = resultJson<{ error?: string }>(await call(captured, "new_context", {}, low));
	assert.match(offResult.error ?? "", /off/, "new_context refuses while off");

	notices = await runCommand(captured, "pi-context", "on", low);
	assert.match(notices[0]?.message ?? "", /on/);
	runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 3, "hint persisted again after re-enable");

	notices = await runCommand(captured, "pi-context", "maybe", low);
	assert.equal(notices[0]?.type, "error", "unknown argument rejected");

	// Bare command reports current state without changing it.
	notices = await runCommand(captured, "pi-context", "", low);
	assert.match(notices[0]?.message ?? "", /on/);
});

test("all compaction paths reset immediately, persist one hint, and leave native scheduling alone", async () => {
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
				assert.equal(captured.sent.length, window, "no extra note-taking turn");
				assert.match(before.compaction.summary, /No summary was generated/);
				const id = sm.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 100, before.compaction.details, true);
				const compactionEntry = sm.getEntry(id);
				assert.ok(compactionEntry && compactionEntry.type === "compaction");
				const event = { reason, willRetry: reason === "overflow", compactionEntry };
				runHandlers(captured, "session_compact", event, ctx);
				runHandlers(captured, "session_compact", event, ctx);
				assert.equal(captured.sent.length, window + 1, "one hint per reset, including overflow");
				assert.equal(captured.sent[window]?.message.customType, internal.HINT_TYPE);
				assert.equal(captured.sent[window]?.options?.triggerTurn, false, "Pi owns automatic continuation/retry");
			}
		}
	}
});

test("reminder defaults precede a 32768-token reserve and are configurable", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	const window = 200_000;
	const atRemaining = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window });
	assert.equal(internal.REMINDER_THRESHOLD_TOKENS, 65_536);
	assert.equal(internal.FALLBACK_THRESHOLD_TOKENS, 40_960);
	assert.equal(
		(await runContextHook(captured, atRemaining(65_537)) as { messages: unknown[] } | undefined)?.messages.length,
		1,
		"above the reminder threshold only the transient window hint is injected",
	);
	assert.equal(captured.sent.length, 0, "no guidance above the reminder threshold");
	assert.ok(await runContextHook(captured, atRemaining(65_536)));
	assert.equal(captured.sent.length, 1, "reminds well before Pi's 32768 reserve");
	const boundaryText = typeof captured.sent[0]?.message.content === "string" ? captured.sent[0].message.content : "";
	assert.match(boundaryText, /only 65536 tokens remained when this reminder was recorded/);
	const marker = captured.sent[0];
	assert.ok(marker);
	assert.deepEqual(resultJson(await call(captured, "get_context_remaining", {}, atRemaining(65_536))), { remaining_tokens: 65_536 });

	const customSm = manager();
	const custom = makeExtension(customSm);
	const customAt = (remaining: number) => context(customSm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window });
	custom.flags.set(internal.REMINDER_FLAG, "100000");
	custom.flags.set(internal.FALLBACK_FLAG, "50000");
	assert.equal(
		(await runContextHook(custom, customAt(100_001)) as { messages: unknown[] } | undefined)?.messages.length,
		1,
		"transient window hint only, no guidance above the custom threshold",
	);
	assert.equal(custom.sent.length, 0, "no guidance above the custom reminder threshold");
	assert.ok(await runContextHook(custom, customAt(100_000)), "custom reminder threshold fires");
	const invalidAt = atRemaining(90_000);	for (const value of ["0", "-1", "NaN", "2.5"]) {
		const invalid = makeExtension(manager());
		invalid.flags.set(internal.REMINDER_FLAG, value);
		await assert.rejects(() => runContextHook(invalid, invalidAt), /positive integer/);
	}
	const reversed = makeExtension(manager());
	reversed.flags.set(internal.REMINDER_FLAG, "30000");
	reversed.flags.set(internal.FALLBACK_FLAG, "40000");
	await assert.rejects(() => runContextHook(reversed, atRemaining(20_000)), /lower than/);
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
	assert.equal(captured.sent.length, 1, "automatic reset persists a hint only; Pi owns scheduling");
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
	assert.equal(streaming.sent.length, 2, "the reset persists a hint only");
	runHandlers(streaming, "turn_end", {}, streamingCtx);
	assert.equal(streaming.sent.length, 3, "fresh window re-arms the streaming fallback once");
	assert.equal(streaming.sent[2]?.message.customType, internal.FALLBACK_TYPE);
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
		assert.equal(captured.sent.length, (window + 1) * 2);
	}
});
