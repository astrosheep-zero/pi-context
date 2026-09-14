import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piContext, { contextWindowHint, historyFromSession, internal, notesFromSession } from "../src/index.js";

const sessionModuleUrl = "file:///opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
const { SessionManager } = await (new Function(`return import(${JSON.stringify(sessionModuleUrl)})`)() as Promise<{ SessionManager: any }>);

type Captured = {
	tools: Map<string, any>;
	handlers: Map<string, Array<(event: any, ctx: any) => any>>;
	sent: Array<{ message: any; options: any }>;
};

function manager(persisted = false) {
	if (!persisted) return SessionManager.inMemory("/private/tmp/pi-context-test");
	const dir = mkdtempSync(join(tmpdir(), "pi-context-session-"));
	return SessionManager.create("/private/tmp/pi-context-test", dir);
}

function makeExtension(sessionManager: any): Captured {
	const captured: Captured = { tools: new Map(), handlers: new Map(), sent: [] };
	const api = {
		registerTool(tool: any) { captured.tools.set(tool.name, tool); },
		on(name: string, handler: (event: any, ctx: any) => any) {
			const handlers = captured.handlers.get(name) ?? [];
			handlers.push(handler);
			captured.handlers.set(name, handlers);
		},
		appendEntry(type: string, data: unknown) { sessionManager.appendCustomEntry(type, data); },
		sendMessage(message: any, options: any) {
			captured.sent.push({ message, options });
			sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
	};
	piContext(api as any);
	return captured;
}

function context(sessionManager: any, compact?: (options: any) => void) {
	return {
		sessionManager,
		getContextUsage: () => undefined,
		compact: compact ?? (() => {}),
	};
}

async function call(captured: Captured, name: string, params: Record<string, unknown>, ctx: any) {
	const tool = captured.tools.get(name);
	assert.ok(tool, `registered ${name}`);
	return tool.execute("call-1", params, new AbortController().signal, () => {}, ctx);
}

function resultJson(result: any) {
	return JSON.parse(result.content[0].text);
}

function appendText(sessionManager: any, role: "user" | "assistant" | "toolResult", text: string) {
	return sessionManager.appendMessage({ role, content: [{ type: "text", text }], timestamp: Date.now(), ...(role === "assistant" ? { stopReason: "stop" } : {}) });
}

test("schemas cover the nine History/Notes actions plus reset controls", () => {
	const captured = makeExtension(manager());
	for (const name of [
		"history_list_windows", "history_list_items", "history_read_item", "history_search_contents",
		"notes_list_files_by_prefix", "notes_read_file", "notes_search_contents", "notes_append_to_file", "notes_write_file",
		"new_context", "get_context_remaining",
	]) {
		const tool = captured.tools.get(name);
		assert.equal(tool?.parameters.type, "object", name);
	}
	assert.equal(captured.tools.get("history_read_item").parameters.required.includes("item_id"), true);
	assert.equal(captured.tools.get("notes_write_file").parameters.required.includes("text"), true);
});

test("persisted note operations restore, are Unicode byte-limited, and use safe virtual paths", async () => {
	const original = manager(true);
	const captured = makeExtension(original);
	const ctx = context(original);
	await call(captured, "notes_write_file", { path: "checkpoint/进度.txt", text: "第一行\nneedle Café" }, ctx);
	await call(captured, "notes_append_to_file", { path: "checkpoint/进度.txt", text: "\n最后一行" }, ctx);
	assert.equal(notesFromSession(ctx as any).get("checkpoint/进度.txt")?.text, "第一行\nneedle Café\n最后一行");
	// SessionManager intentionally delays writing a brand-new session until its first assistant entry.
	appendText(original, "assistant", "persist the append-only session");

	const file = original.getSessionFile();
	assert.ok(file);
	const restored = SessionManager.create("/private/tmp/pi-context-test", mkdtempSync(join(tmpdir(), "pi-context-restore-")));
	restored.setSessionFile(file);
	const restoredCtx = context(restored);
	assert.equal(notesFromSession(restoredCtx as any).get("checkpoint/进度.txt")?.text, "第一行\nneedle Café\n最后一行");
	assert.deepEqual(resultJson(await call(captured, "notes_read_file", { path: "checkpoint/进度.txt", start_line: -1, stop_line: -1 }, ctx)), { path: "checkpoint/进度.txt", start_line: 3, stop_line: 3, content: "最后一行" });
	const searched = resultJson(await call(captured, "notes_search_contents", { query: "Café" }, ctx));
	assert.equal(searched.files[0].matches[0].line, 2);
	await assert.rejects(() => call(captured, "notes_write_file", { path: "../escape", text: "x" }, ctx), /unsupported component/);
	const tooLarge = resultJson(await call(captured, "notes_write_file", { path: "large", text: "é".repeat(500_001) }, ctx));
	assert.match(tooLarge.error, /1000000/);
});

test("custom reset boundary removes old provider context but history remains searchable", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	const oldUserId = appendText(sessionManager, "user", "OLD-UNIQUE-TRANSCRIPT needle");
	appendText(sessionManager, "assistant", "I will use a tool");
	const toolResultId = appendText(sessionManager, "toolResult", "tool result safely recorded");

	const before = await captured.handlers.get("session_before_compact")![0]({
		reason: "manual", willRetry: false, signal: new AbortController().signal,
		preparation: { tokensBefore: 123 },
	}, ctx);
	assert.ok(before.compaction);
	const markerId = sessionManager.getLeafId();
	assert.equal(sessionManager.getEntry(markerId).parentId, toolResultId, "marker follows the completed tool result");
	const compactionId = sessionManager.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, before.compaction.tokensBefore, before.compaction.details, true);
	const providerText = JSON.stringify(sessionManager.buildSessionContext().messages);
	assert.equal(providerText.includes("OLD-UNIQUE-TRANSCRIPT"), false);
	assert.equal(providerText.includes(internal.RESET_SUMMARY), true);

	const windows = historyFromSession(ctx as any);
	assert.equal(windows.length, 2);
	const oldWindow = windows[0]!.windowId;
	const read = resultJson(await call(captured, "history_read_item", { window_id: oldWindow, item_id: oldUserId }, ctx));
	assert.match(read.content, /OLD-UNIQUE-TRANSCRIPT/);
	const found = resultJson(await call(captured, "history_search_contents", { query: "needle" }, ctx));
	assert.equal(found.items.length, 1);
	assert.equal(found.items[0].item_id, oldUserId);
	assert.match(resultJson(await call(captured, "history_list_windows", { agent_name: "other" }, ctx)).error, /cross-agent/);
	assert.ok(sessionManager.getEntry(compactionId));
});

test("context hook injects a Codex-equivalent context_window hint on every model request", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	appendText(sessionManager, "user", "task before reset");
	appendText(sessionManager, "assistant", "working");
	await call(captured, "notes_write_file", { path: "decisions.md", text: "use terra" }, ctx);

	const before = await captured.handlers.get("session_before_compact")![0]({ reason: "manual", willRetry: false, signal: new AbortController().signal, preparation: { tokensBefore: 9 } }, ctx);
	sessionManager.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 9, before.compaction.details, true);

	const windows = historyFromSession(ctx as any);
	assert.equal(windows.length, 2);
	const hint = contextWindowHint(ctx as any);
	assert.ok(hint.startsWith(internal.CONTEXT_WINDOW_OPEN_TAG));
	assert.match(hint, /First context window id: pcw:/);
	assert.ok(hint.includes(`Previous context window id: ${windows[0]!.windowId}`));
	assert.ok(hint.includes(`Current context window id: ${windows[1]!.windowId}`));
	assert.match(hint, /- decisions\.md \(1 lines, 9 UTF-8 bytes\)/);

	const contextHandler = captured.handlers.get("context")![0];
	const transformed = await contextHandler({ messages: [{ role: "user", content: [{ type: "text", text: "next" }], timestamp: Date.now() }] }, ctx);
	assert.equal(transformed.messages.length, 2);
	assert.equal(transformed.messages[0].content[0].text, hint);
	const transformedAgain = await contextHandler({ messages: [] }, ctx);
	assert.equal(transformedAgain.messages[0].content[0].text, hint, "rebuilt per request without duplication");
});

test("new_context continues exactly once and cancellation/failure does not fall back or loop", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	let requestedCompact: any;
	const ctx = context(sessionManager, (options) => { requestedCompact = options; });
	appendText(sessionManager, "user", "enough history for the hook test");
	const newContext = await call(captured, "new_context", {}, ctx);
	assert.equal(newContext.terminate, true);
	for (const handler of captured.handlers.get("agent_end")!) handler({}, ctx);
	assert.ok(requestedCompact, "manual compaction is deferred until agent_end/tool result boundary");

	const before = await captured.handlers.get("session_before_compact")![0]({ reason: "manual", willRetry: false, signal: new AbortController().signal, preparation: { tokensBefore: 7 } }, ctx);
	const compactionId = sessionManager.appendCompaction(before.compaction.summary, before.compaction.firstKeptEntryId, 7, before.compaction.details, true);
	const compactEvent = { willRetry: false, compactionEntry: sessionManager.getEntry(compactionId) };
	for (const handler of captured.handlers.get("session_compact")!) handler(compactEvent, ctx);
	for (const handler of captured.handlers.get("session_compact")!) handler(compactEvent, ctx);
	assert.equal(captured.sent.length, 1, "one hidden continuation only");
	assert.equal(captured.sent[0]!.message.display, false);

	const failedManager = manager();
	const failed = makeExtension(failedManager);
	let failureOptions: any;
	const failedCtx = context(failedManager, (options) => { failureOptions = options; });
	await call(failed, "new_context", {}, failedCtx);
	for (const handler of failed.handlers.get("agent_end")!) handler({}, failedCtx);
	failureOptions.onError(new Error("not compactable"));
	for (const handler of failed.handlers.get("session_compact")!) handler(compactEvent, failedCtx);
	assert.equal(failed.sent.length, 0, "failure does not send an accidental continuation");

	const aborted = await failed.handlers.get("session_before_compact")![0]({ reason: "manual", willRetry: false, signal: AbortSignal.abort(), preparation: { tokensBefore: 7 } }, failedCtx);
	assert.deepEqual(aborted, { cancel: true }, "aborted custom compaction cannot fall through to Pi default summary");
	for (const handler of failed.handlers.get("session_compact")!) handler({ willRetry: true, compactionEntry: sessionManager.getEntry(compactionId) }, failedCtx);
	assert.equal(failed.sent.length, 0, "native overflow retry is left to Pi core, not doubled by the extension");
});
