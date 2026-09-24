import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { historyFromSession } from "../src/index.js";
import { TOOL_OUTPUT_MAX_BYTES } from "../src/tool-output.js";
import {
	appendText,
	assertWithinBudget,
	call,
	context,
	makeExtension,
	manager,
	objectSchema,
	resultJson,
	resultRead,
} from "./helpers/extension.js";
import { installExtensionTestHooks } from "./helpers/extension-test-environment.js";

installExtensionTestHooks("pi-context-history-v2");

test("history schemas expose seq and anchor paging, while notes use snapshot limits", () => {
	const captured = makeExtension(manager());
	const readSchema = captured.tools.get("history_read")?.parameters as { properties?: Record<string, unknown>; required?: string[] };
	const legacyItemKey = ["item", "id"].join("_");
	const legacyOrderingKey = ["recent", "first"].join("_");
	assert.ok(readSchema.properties?.seq);
	assert.deepEqual(readSchema.required, ["seq"]);
	assert.equal(readSchema.properties?.[legacyItemKey], undefined);
	assert.equal(readSchema.properties?.window_id, undefined);

	const listSchema = captured.tools.get("history_list")?.parameters as { properties?: Record<string, unknown> };
	assert.ok(listSchema.properties?.before);
	assert.ok(listSchema.properties?.after);
	assert.ok(listSchema.properties?.around);
	assert.ok(listSchema.properties?.roles);
	assert.ok(listSchema.properties?.custom_type);
	assert.equal(listSchema.properties?.cursor, undefined);
	assert.equal(listSchema.properties?.[legacyOrderingKey], undefined);

	const windowsSchema = captured.tools.get("history_windows")?.parameters as { properties?: Record<string, unknown> };
	assert.deepEqual(Object.keys(windowsSchema.properties ?? []), []);

	const notesSchema = captured.tools.get("notes_list")?.parameters as { properties?: Record<string, unknown> };
	assert.equal(notesSchema.properties?.cursor, undefined);
	assert.ok(notesSchema.properties?.limit);
	assert.equal(notesSchema.properties?.max_results, undefined);
	const notesSearchSchema = captured.tools.get("notes_search")?.parameters as { properties?: Record<string, unknown> };
	assert.equal(notesSearchSchema.properties?.cursor, undefined);
	assert.ok(notesSearchSchema.properties?.limit);
	assert.equal(notesSearchSchema.properties?.max_files, undefined);
});

test("seq is stable across branch changes and abandoned entries remain unreadable", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const firstId = appendText(session, "user", "first");
	const abandonedId = appendText(session, "assistant", "abandoned reply");
	const before = resultJson<{ items: Array<{ seq: number; truncated_content: string }> }>(await call(captured, "history_list", { roles: ["user", "assistant"] }, ctx));
	assert.deepEqual(before.items.map((item) => [item.seq, item.truncated_content]), [[1, "first"], [2, "abandoned reply"]]);

	session.branch(firstId);
	const branchId = appendText(session, "user", "new branch");
	const after = resultJson<{ items: Array<{ seq: number; truncated_content: string }> }>(await call(captured, "history_list", { roles: ["user", "assistant"] }, ctx));
	assert.deepEqual(after.items.map((item) => [item.seq, item.truncated_content]), [[1, "first"], [3, "new branch"]]);
	assert.equal(branchId !== abandonedId, true);

	const unreadable = resultJson<{ error: string }>(await call(captured, "history_read", { seq: 2 }, ctx));
	assert.match(unreadable.error, /another branch/);
	const unknown = resultJson<{ error: string }>(await call(captured, "history_read", { seq: 4 }, ctx));
	assert.match(unknown.error, /run 1\.\.3/);
});

test("anchor paging is chronological, stable under appends, and around is centered", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	for (let index = 1; index <= 5; index++) appendText(session, "user", `message-${index}`);

	const tail = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_list", { limit: 2 }, ctx));
	assert.deepEqual(tail.items.map((item) => item.seq), [4, 5]);
	appendText(session, "user", "message-6");
	const older = resultJson<{ items: Array<{ seq: number }>; has_older: boolean; has_newer: boolean }>(await call(captured, "history_list", { before: 5, limit: 2 }, ctx));
	assert.deepEqual(older.items.map((item) => item.seq), [3, 4]);
	assert.equal(older.has_older, true);
	assert.equal(older.has_newer, true);
	const newer = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_list", { after: 5, limit: 2 }, ctx));
	assert.deepEqual(newer.items.map((item) => item.seq), [6]);
	const around = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_list", { around: 3, limit: 3 }, ctx));
	assert.deepEqual(around.items.map((item) => item.seq), [2, 3, 4]);
	const single = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_list", { around: 3, limit: 1 }, ctx));
	assert.deepEqual(single.items.map((item) => item.seq), [3]);
	const invalid = resultJson<{ error: string }>(await call(captured, "history_list", { before: 3, after: 4 }, ctx));
	assert.match(invalid.error, /at most one/);
});

test("conversation view folds tools and injected messages, while explicit roles expand them", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	appendText(session, "user", "please inspect");
	type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];
	const turnId = session.appendMessage({
		role: "assistant",
		content: [
			{ type: "text", text: "I will inspect" },
			{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "pwd" } },
			{ type: "toolCall", id: "tc-2", name: "read", arguments: { path: "README.md" } },
		],
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as unknown as AppendableMessage);
	session.appendMessage({ role: "toolResult", toolCallId: "tc-1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() } as unknown as AppendableMessage);
	session.appendMessage({ role: "toolResult", toolCallId: "tc-2", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false, timestamp: Date.now() } as unknown as AppendableMessage);
	session.appendCustomMessageEntry("square", "injected event", false);
	session.appendMessage({ role: "assistant", content: [], stopReason: "toolUse", timestamp: Date.now() } as unknown as AppendableMessage);

	const conversation = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_list", {}, ctx));
	const legacyItemKey = ["item", "id"].join("_");
	assert.equal(conversation.items.some((item) => item.folded === true), true);
	assert.equal(conversation.items.some((item) => item.role === "developer"), false);
	assert.equal(conversation.items.some((item) => item.role === "tool"), false);
	assert.equal(conversation.items.some((item) => item.role === "assistant" && item.total_chars === 0), false);
	assert.equal(conversation.items.every((item) => legacyItemKey in item === false), true);
	const folded = conversation.items.find((item) => item.folded === true)!;
	assert.ok(Number(folded.count) >= 5);
	assert.equal((folded.tools as Record<string, number>).bash, 1);
	assert.equal((folded.tools as Record<string, number>).read, 1);
	assert.equal((folded.custom_types as Record<string, number>).square, 1);

	const expanded = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_list", { roles: ["tool_call", "tool"] }, ctx));
	assert.deepEqual(expanded.items.map((item) => item.role), ["tool_call", "tool_call", "tool", "tool"]);
	assert.equal(expanded.items[0]?.result_seq, expanded.items[2]?.seq);
	assert.equal(expanded.items[1]?.result_seq, expanded.items[3]?.seq);
	assert.equal(expanded.items[2]?.call_seq, expanded.items[0]?.seq);
	assert.equal(expanded.items[3]?.call_seq, expanded.items[1]?.seq);

	const bashOnly = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_list", { roles: ["tool_call", "tool"], tool_name: "bash" }, ctx));
	assert.deepEqual(bashOnly.items.map((item) => item.role), ["tool_call", "tool"]);
	assert.equal(bashOnly.items[1]?.call_seq, bashOnly.items[0]?.seq);

	const injected = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_list", { custom_type: "square" }, ctx));
	assert.deepEqual(injected.items.map((item) => [item.role, item.custom_type, item.truncated_content]), [["developer", "square", "injected event"]]);
	assert.equal(turnId.length > 0, true);
});

test("search covers all roles, supports filters and anchor paging", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	appendText(session, "user", "visible needle");
	session.appendCustomMessageEntry("pi-context/boot", "developer needle", false);
	appendText(session, "assistant", "assistant needle");
	const all = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_search", { query: "needle" }, ctx));
	assert.deepEqual(all.items.map((item) => item.role), ["user", "developer", "assistant"]);
	assert.ok(all.items.every((item) => typeof item.seq === "number" && typeof item.match_offset_chars === "number"));
	const developers = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_search", { query: "needle", custom_type: "pi-context/boot" }, ctx));
	assert.deepEqual(developers.items.map((item) => item.custom_type), ["pi-context/boot"]);
	const first = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_search", { query: "needle", after: 0, limit: 1 }, ctx));
	const next = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_search", { query: "needle", after: first.items[0]!.seq }, ctx));
	assert.equal(next.items.length, 2);
});

test("history_read uses seq and preserves the shared character-window contract", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const content = "z".repeat(TOOL_OUTPUT_MAX_BYTES * 2);
	appendText(session, "user", content);
	const listed = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_list", { max_chars_per_item: 1 }, ctx));
	const seq = listed.items[0]!.seq;
	const raw = await call(captured, "history_read", { seq, limit_chars: 50_000 }, ctx);
	assertWithinBudget(raw, "history_read page");
	const read = resultRead(raw);
	assert.ok(read.content.length > 0);
	assert.equal(read.header.startsWith(`--- READ WINDOW ---\nseq: ${seq}\nwindow_id: `), true);
	assert.deepEqual(Object.keys(read.details), ["seq", "window_id", "offset_chars", "total_chars", "next_offset_chars"]);
	assert.equal(read.total_chars, content.length);
	const next = read.next_offset_chars;
	assert.ok(next !== null);
	const second = resultRead(await call(captured, "history_read", { seq, offset_chars: next, limit_chars: 50_000 }, ctx));
	assert.equal(read.content + second.content, content.slice(0, read.content.length + second.content.length));
});

test("history windows expose stable ranges and session identity", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	appendText(session, "user", "before");
	const windows = resultJson<{ session_id: string; windows: Array<{ window_id: string; first_seq: number | null; last_seq: number | null; item_count: number }> }>(await call(captured, "history_windows", {}, ctx));
	assert.equal(windows.session_id, session.getSessionId());
	assert.equal(windows.windows.length, 1);
	assert.deepEqual(windows.windows[0], { window_id: windows.windows[0]!.window_id, created_at: null, first_seq: 1, last_seq: 1, item_count: 1 });
});
