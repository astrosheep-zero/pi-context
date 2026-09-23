import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { historyFromSession, internal } from "../src/index.js";
import { middleTruncate, page, TOOL_OUTPUT_MAX_BYTES } from "../src/tool-output.js";
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

const testEnvironment = installExtensionTestHooks("pi-context-integration");

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
