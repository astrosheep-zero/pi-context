import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { TSchema } from "typebox";
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
	assert.equal(listSchema.properties?.around, undefined);
	assert.ok(listSchema.properties?.roles);
	assert.equal(listSchema.properties?.tool_name, undefined);
	const searchSchema = captured.tools.get("history_search")?.parameters as { properties?: Record<string, unknown> };
	assert.equal(searchSchema.properties?.tool_name, undefined);
	const publicRoles = (listSchema.properties?.roles as { items?: { anyOf?: Array<{ const?: string }> } }).items?.anyOf?.map((item) => item.const);
	assert.deepEqual(publicRoles, ["user", "assistant", "tool", "context"]);
	for (const toolName of ["history_list", "history_search"]) {
		const schema = captured.tools.get(toolName)!.parameters as TSchema;
		const base = toolName === "history_search" ? { query: "needle" } : {};
		assert.equal(Check(schema, { ...base, roles: ["tool"] }), true);
		for (const invalid of [{ roles: ["tool_call"] }, { roles: ["system"] }, { tool_name: "bash" }, { roles: [] }, { before: 0 }, { after: 0 }]) {
			assert.equal(Check(schema, { ...base, ...invalid }), false, `${toolName}: ${JSON.stringify(invalid)}`);
		}
	}
	assert.equal(listSchema.properties?.custom_type, undefined);
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
	const before = resultJson<{ items: Array<{ seq: number; content: string }> }>(await call(captured, "history_list", { roles: ["user", "assistant"] }, ctx));
	assert.deepEqual(before.items.map((item) => [item.seq, item.content]), [[1, "first"], [2, "abandoned reply"]]);

	session.branch(firstId);
	const branchId = appendText(session, "user", "new branch");
	const after = resultJson<{ items: Array<{ seq: number; content: string }> }>(await call(captured, "history_list", { roles: ["user", "assistant"] }, ctx));
	assert.deepEqual(after.items.map((item) => [item.seq, item.content]), [[1, "first"], [3, "new branch"]]);
	assert.equal(branchId !== abandonedId, true);

	const unreadable = resultJson<{ error: string }>(await call(captured, "history_read", { seq: 2 }, ctx));
	assert.match(unreadable.error, /another branch/);
	const unknown = resultJson<{ error: string }>(await call(captured, "history_read", { seq: 4 }, ctx));
	assert.match(unknown.error, /run 1\.\.3/);
});

test("anchor paging is chronological, stable under appends, and supports ranges", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	for (let index = 1; index <= 5; index++) appendText(session, "user", `message-${index}`);

	const tail = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_list", { limit: 2 }, ctx));
	assert.deepEqual(tail.items.map((item) => item.seq), [4, 5]);
	appendText(session, "user", "message-6");
	const older = resultJson<{ items: Array<{ seq: number }>; older_before: number | null; newer_after: number | null }>(await call(captured, "history_list", { before: 5, limit: 2 }, ctx));
	assert.deepEqual(older.items.map((item) => item.seq), [3, 4]);
	assert.equal(older.older_before, 3);
	assert.equal(older.newer_after, null);
	const newer = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_list", { after: 5, limit: 2 }, ctx));
	assert.deepEqual(newer.items.map((item) => item.seq), [6]);
	for (let index = 7; index <= 10; index++) appendText(session, "user", `message-${index}`);
	const range = resultJson<{ items: Array<{ seq: number }>; older_before: number | null; newer_after: number | null }>(await call(captured, "history_list", { after: 2, before: 10, limit: 3 }, ctx));
	assert.deepEqual(range.items.map((item) => item.seq), [3, 4, 5]);
	assert.equal(range.older_before, null);
	assert.equal(range.newer_after, 5);
	const rangeNext = resultJson<{ items: Array<{ seq: number }>; newer_after: number | null }>(await call(captured, "history_list", { after: range.newer_after!, before: 10, limit: 3 }, ctx));
	assert.deepEqual(rangeNext.items.map((item) => item.seq), [6, 7, 8]);
	assert.equal(rangeNext.newer_after, 8);
	const rangeLast = resultJson<{ items: Array<{ seq: number }>; older_before: number | null; newer_after: number | null }>(await call(captured, "history_list", { after: rangeNext.newer_after!, before: 10, limit: 3 }, ctx));
	assert.deepEqual(rangeLast.items.map((item) => item.seq), [9]);
	assert.equal(rangeLast.older_before, null);
	assert.equal(rangeLast.newer_after, null);
	assert.equal("has_older" in rangeLast, false);
	assert.equal("has_newer" in rangeLast, false);
	assert.equal((captured.tools.get("history_list")?.parameters as { properties?: Record<string, { minimum?: number }> }).properties?.before?.minimum, 1);
	assert.equal((captured.tools.get("history_list")?.parameters as { properties?: Record<string, { minimum?: number }> }).properties?.after?.minimum, 1);
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
	assert.equal(folded.count, 3, "two tool events and one injected context are folded, not the empty assistant message");
	assert.equal((folded.tools as Record<string, number>).bash, 1);
	assert.equal((folded.tools as Record<string, number>).read, 1);
	assert.equal("custom_types" in folded, false);

	const empty = resultJson<{ items: unknown[]; older_before: number | null; newer_after: number | null }>(await call(captured, "history_list", { roles: ["context"], before: 2 }, ctx));
	assert.deepEqual(empty.items, []);
	assert.equal(empty.older_before, null);
	assert.equal(empty.newer_after, null);
	const hiddenOnly = resultJson<{ items: Array<{ folded?: boolean; first_seq?: number; last_seq?: number; count?: number; tools?: Record<string, number> }> }>(await call(captured, "history_list", { after: 2, before: 6 }, ctx));
	assert.deepEqual(hiddenOnly.items, [{ folded: true, first_seq: 3, last_seq: 4, count: 2, tools: { bash: 1, read: 1 } }]);

	const expanded = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_list", { roles: ["tool"] }, ctx));
	assert.deepEqual(expanded.items.map((item) => [item.seq, item.role, item.tool]), [[3, "tool", "bash"], [4, "tool", "read"]]);
	assert.equal(expanded.items[0]?.content, 'bash {"command":"pwd"}\n--- output ---\nok');
	assert.equal(expanded.items[1]?.content, 'read {"path":"README.md"}\n--- output ---\ncontents');
	assert.equal(expanded.items.every((item) => !('call_seq' in item || 'result_seq' in item || 'tool_name' in item)), true);

	const bashOnly = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_search", { query: "bash", roles: ["tool"] }, ctx));
	assert.deepEqual(bashOnly.items.map((item) => item.seq), [3]);

	const injected = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_list", { roles: ["context"] }, ctx));
	assert.deepEqual(injected.items.map((item) => [item.role, item.content]), [["context", "injected event"]]);
	assert.equal("custom_type" in injected.items[0]!, false);
	assert.equal(turnId.length > 0, true);
});

test("tool events pair calls/results; pending and orphan runs remain readable", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	type Message = Parameters<SessionManager["appendMessage"]>[0];
	session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "paired", name: "edit", arguments: { path: "😀.md", oldText: "before" } }], stopReason: "toolUse", timestamp: Date.now() } as unknown as Message);
	session.appendMessage({ role: "toolResult", toolCallId: "paired", toolName: "edit", content: [{ type: "text", text: "replacement OK" }], isError: true, timestamp: Date.now() } as Message);
	session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "pending", name: "edit", arguments: { path: "pending.md" } }], stopReason: "toolUse", timestamp: Date.now() } as unknown as Message);
	session.appendMessage({ role: "toolResult", toolCallId: "orphan", toolName: "edit", content: [{ type: "text", text: "orphan output" }], isError: false, timestamp: Date.now() } as Message);
	const events = resultJson<{ items: Array<{ seq: number; role: string; tool: string; content: string; tool_error?: boolean; tool_name?: string }> }>(await call(captured, "history_list", { roles: ["tool"] }, ctx));
	assert.deepEqual(events.items.map(({ seq, role }) => [seq, role]), [[2, "tool"], [5, "tool"], [6, "tool"]]);
	assert.equal(events.items[0]!.content, 'edit {"path":"😀.md","oldText":"before"}\n--- output ---\nreplacement OK');
	assert.equal(events.items[0]!.tool_error, true);
	assert.equal(events.items[1]!.content, 'edit {"path":"pending.md"}');
	assert.equal(events.items[2]!.content, 'edit {}\n--- output ---\norphan output');
	assert.equal(events.items.every((item) => item.tool === "edit" && item.tool_name === undefined), true);
	const match = resultJson<{ items: Array<{ seq: number; offset_chars: number; content: string }> }>(await call(captured, "history_search", { query: "replacement ok", roles: ["tool"], max_chars_per_item: 14 }, ctx));
	assert.deepEqual(match.items.map((item) => item.seq), [2]);
	assert.equal(match.items[0]!.content, "replacement OK");
	const fromMatch = resultRead(await call(captured, "history_read", { seq: match.items[0]!.seq, offset_chars: match.items[0]!.offset_chars }, ctx));
	assert.equal(fromMatch.content, "replacement OK");
	const alias = resultRead(await call(captured, "history_read", { seq: 3 }, ctx));
	assert.equal(alias.header.includes("seq: 2\n"), true);
	assert.equal(alias.content, events.items[0]!.content);
	const byTool = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_search", { query: "edit", roles: ["tool"] }, ctx));
	assert.deepEqual(byTool.items.map((item) => item.seq), [2, 5, 6]);
	const byArgs = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_search", { query: "pending.md", roles: ["tool"] }, ctx));
	assert.deepEqual(byArgs.items.map((item) => item.seq), [5]);
	const byOutput = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_search", { query: "orphan output", roles: ["tool"] }, ctx));
	assert.deepEqual(byOutput.items.map((item) => item.seq), [6]);
});

test("standalone bash execution retains command, output, and truncation path", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	type Message = Parameters<SessionManager["appendMessage"]>[0];
	session.appendMessage({ role: "bashExecution", command: "echo needle", output: "needle output", truncated: true, fullOutputPath: "/tmp/bash-output.txt", timestamp: Date.now() } as unknown as Message);
	const found = resultJson<{ items: Array<{ seq: number; window_id: string; role: string; created_at: string | null; tool: string; content: string; truncated: boolean; total_chars: number; output_truncated?: boolean; full_output_path?: string }> }>(await call(captured, "history_list", { roles: ["tool"] }, ctx));
	assert.equal(found.items.length, 1);
	assert.deepEqual(found.items[0], {
		seq: 1, window_id: found.items[0]!.window_id, role: "tool", created_at: found.items[0]!.created_at,
		tool: "bash", output_truncated: true, full_output_path: "/tmp/bash-output.txt",
		truncated: false, total_chars: 59, content: 'bash {"command":"echo needle"}\n--- output ---\nneedle output',
	});
	const query = resultJson<{ items: Array<{ seq: number; offset_chars: number }> }>(await call(captured, "history_search", { roles: ["tool"], query: "NEEDLE OUTPUT" }, ctx));
	assert.deepEqual(query.items.map((item) => item.seq), [1]);
	const read = resultRead(await call(captured, "history_read", { seq: 1, offset_chars: query.items[0]!.offset_chars }, ctx));
	assert.equal(read.content, "needle output");
});

test("compaction summary becomes context and is folded in the default list", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	appendText(session, "user", "before checkpoint");
	session.appendCompaction("summary needle", session.getLeafId()!, 100);
	appendText(session, "assistant", "after checkpoint");
	const regular = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_list", {}, ctx));
	assert.deepEqual(regular.items.map((item) => item.folded ? "folded" : item.role), ["user", "folded", "assistant"]);
	const folded = regular.items[1]!;
	assert.equal(folded.count, 1);
	assert.deepEqual(folded.tools, {});
	const contextItems = resultJson<{ items: Array<{ role: string; content: string }> }>(await call(captured, "history_list", { roles: ["context"] }, ctx));
	assert.deepEqual(contextItems.items.map((item) => [item.role, item.content]), [["context", "summary needle"]]);
});

test("search covers all roles, supports filters and anchor paging", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	appendText(session, "user", "visible needle");
	session.appendCustomMessageEntry("pi-context/boot", "developer needle", false);
	appendText(session, "assistant", "assistant needle");
	const all = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_search", { query: "needle" }, ctx));
	assert.deepEqual(all.items.map((item) => item.role), ["user", "context", "assistant"]);
	assert.ok(all.items.every((item) => typeof item.seq === "number" && typeof item.offset_chars === "number"));
	const developers = resultJson<{ items: Array<Record<string, unknown>> }>(await call(captured, "history_search", { query: "needle", roles: ["context"] }, ctx));
	assert.deepEqual(developers.items.map((item) => item.role), ["context"]);
	assert.equal("custom_type" in developers.items[0]!, false);
	const first = resultJson<{ items: Array<{ seq: number }>; older_before: number | null; newer_after: number | null }>(await call(captured, "history_search", { query: "needle", after: 1, limit: 1 }, ctx));
	assert.equal(first.items.length, 1);
	const next = resultJson<{ items: Array<{ seq: number }> }>(await call(captured, "history_search", { query: "needle", after: first.items[0]!.seq, limit: 2 }, ctx));
	assert.equal(next.items.length, 1);
});

test("search keeps exclusive bounds and follows newer_after through three pages", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	for (let seq = 1; seq <= 10; seq++) appendText(session, "user", `needle ${seq}`);
	const first = resultJson<{ items: Array<{ seq: number }>; older_before: number | null; newer_after: number | null }>(await call(captured, "history_search", { query: "needle", after: 2, before: 10, limit: 3 }, ctx));
	assert.deepEqual(first.items.map((item) => item.seq), [3, 4, 5]);
	assert.equal(first.older_before, null);
	assert.equal(first.newer_after, 5);
	const second = resultJson<typeof first>(await call(captured, "history_search", { query: "needle", after: first.newer_after!, before: 10, limit: 3 }, ctx));
	assert.deepEqual(second.items.map((item) => item.seq), [6, 7, 8]);
	assert.equal(second.newer_after, 8);
	const third = resultJson<typeof first>(await call(captured, "history_search", { query: "needle", after: second.newer_after!, before: 10, limit: 3 }, ctx));
	assert.deepEqual(third.items.map((item) => item.seq), [9]);
	assert.equal(third.newer_after, null);
});

test("search previews start at case-insensitive literal matches and offsets read original Unicode text", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const prefix = "😀İ".repeat(1000);
	appendText(session, "user", prefix + "NeEdLe.* trailing");
	const found = resultJson<{ items: Array<{ seq: number; offset_chars: number; content: string; total_chars: number; truncated: boolean; match_offset_chars?: number }> }>(await call(captured, "history_search", { query: ["absent", "needle.*"], max_chars_per_item: 8 }, ctx));
	assert.equal(found.items.length, 1);
	const hit = found.items[0]!;
	assert.equal(hit.offset_chars, 2000);
	assert.equal(hit.match_offset_chars, undefined);
	assert.equal(hit.content, "NeEdLe.*");
	assert.equal(hit.truncated, true);
	assert.equal(hit.total_chars, 2017);
	const read = resultRead(await call(captured, "history_read", { seq: hit.seq, offset_chars: hit.offset_chars, limit_chars: 8 }, ctx));
	assert.equal(read.content, hit.content);
	const noMatch = resultJson<{ items: unknown[] }>(await call(captured, "history_search", { query: "needle.+" }, ctx));
	assert.deepEqual(noMatch.items, []);
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
