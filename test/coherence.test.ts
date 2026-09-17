/**
 * OWNER: pi-context (adopted).
 * STATUS: tracked acceptance spec for the history and notes read/search tools. No skip.
 * CLAIM: following the cursors these tools return must reconstruct the original text exactly,
 *   or the result must name the skipped range. In v2 this failed at 13 sites; the rows that
 *   demanded an over-budget line in a single call are rebuilt as cursor-walking rows below
 *   (the CLAIM explicitly licenses that: reconstruct exactly by following cursors, or name
 *   the skipped range).
 * HERMETIC: this file reads only its own in-memory session. Corpus replays of real sessions
 *   are NOT hermetic, must be single-pass, and belong in a dev script, not npm test.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import piContext, { historyFromSession } from "../src/index.js";
import { TOOL_OUTPUT_MAX_BYTES } from "../src/tool-output.js";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pc-coherence-agent-"));

type Captured = { tools: Map<string, ToolDefinition> };

function makeExtension(sessionManager: SessionManager): Captured {
	const captured: Captured = { tools: new Map() };
	const api = {
		registerFlag() {},
		registerTool(tool: ToolDefinition) { captured.tools.set(tool.name, tool); },
		registerCommand() {},
		on() {},
		appendEntry(customType: string, data?: unknown) { sessionManager.appendCustomEntry(customType, data); },
		sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }) {
			sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
	};
	piContext(api as unknown as ExtensionAPI);
	return captured;
}

function context(sessionManager: SessionManager): ExtensionContext {
	const fake = {
		sessionManager,
		getContextUsage: () => undefined,
		compact: () => {},
		isIdle: () => true,
		hasPendingMessages: () => false,
		cwd: "/private/tmp/pi-context-test",
		isProjectTrusted: () => true,
		ui: { notify: () => {} },
	};
	return fake as unknown as ExtensionContext;
}

async function call(captured: Captured, name: string, params: Record<string, unknown>, ctx: ExtensionContext) {
	const tool = captured.tools.get(name);
	assert.ok(tool, `registered ${name}`);
	return tool.execute("call-1", params, new AbortController().signal, () => {}, ctx) as Promise<AgentToolResult<unknown>>;
}

function resultJson<T>(result: AgentToolResult<unknown>): T {
	const text = result.content[0];
	assert.ok(text && text.type === "text");
	return JSON.parse(text.text) as T;
}

function assertWithinBudget(result: AgentToolResult<unknown>, label: string): void {
	const bytes = Buffer.byteLength(result.content[0] && result.content[0].type === "text" ? result.content[0].text : "", "utf8");
	if (bytes > TOOL_OUTPUT_MAX_BYTES) failures.push(`${label}: response is ${bytes} bytes, over the ${TOOL_OUTPUT_MAX_BYTES}-byte budget`);
}

function appendText(sessionManager: SessionManager, text: string): string {
	type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];
	return sessionManager.appendMessage({ role: "user", content: [{ type: "text" as const, text }], timestamp: Date.now() } as unknown as AppendableMessage);
}

type ReadResult = { content: string; total_chars: number; offset_chars: number; next_offset_chars: number | null };
type SearchHit = { item_id: string; truncated: boolean; total_chars: number; truncated_content: string; match_offset_chars: number };
type Match = { line: number; text: string; truncated: boolean; total_chars: number };
type NoteResult = { content: string; start_line: number; stop_line: number; total_lines: number; next_start_line: number | null; next_start_char: number };

const PROFILES = [
	{ name: "cjk", unit: "历" },
	{ name: "emoji", unit: "🕷" },
	{ name: "ascii", unit: "x" },
] as const;

const failures: string[] = [];
const report: string[] = [];

const codePoints = (text: string) => [...text].length;

/** Follow history_read_item's cursor exactly as the protocol tells the model to, asserting the law per page. */
async function walkHistory(captured: Captured, ctx: ExtensionContext, windowId: string, itemId: string, limitChars?: number): Promise<string> {
	const parts: string[] = [];
	let offset = 0;
	let next: number | null = 0;
	let calls = 0;
	let total = 0;
	while (next !== null && calls < 400) {
		const params: Record<string, unknown> = { window_id: windowId, item_id: itemId, offset_chars: offset };
		if (limitChars !== undefined) params.limit_chars = limitChars;
		const result = await call(captured, "history_read_item", params, ctx);
		assertWithinBudget(result, `history_read_item ${itemId} offset=${offset}`);
		const page = resultJson<ReadResult>(result);
		total = page.total_chars;
		const delivered = codePoints(page.content);
		if (page.offset_chars !== offset) failures.push(`cursor law: history_read_item echoed offset_chars=${page.offset_chars} for request offset ${offset}`);
		if (page.next_offset_chars !== null && page.next_offset_chars !== offset + delivered) {
			failures.push(`cursor law: next_offset_chars=${page.next_offset_chars} but offset ${offset} + delivered ${delivered}`);
		}
		if (page.next_offset_chars === null && offset + delivered !== page.total_chars) {
			failures.push(`false exhaustion: history_read_item returned next_offset_chars=null with ${page.total_chars - (offset + delivered)} characters undelivered`);
		}
		if (page.content.includes("…") || page.content.includes("[truncated")) failures.push(`honest payload: history_read_item appended a marker at offset ${offset}`);
		parts.push(page.content);
		next = page.next_offset_chars;
		if (next !== null) offset = next;
		calls++;
	}
	if (offset !== total && calls >= 400) failures.push(`history_read_item never terminated for item ${itemId}`);
	return parts.join("");
}

/**
 * Follow notes_read_file's cursors exactly. next_start_char resumes inside the same line;
 * a cursor at offset 0 begins a new line, so a newline joins the pages there and only there.
 */
async function walkNote(captured: Captured, ctx: ExtensionContext, path: string, startLine = 1, startChar = 0): Promise<string> {
	const parts: string[] = [];
	let line: number | null = startLine;
	let char = startChar;
	let calls = 0;
	while (line !== null && calls < 4000) {
		const result = await call(captured, "notes_read_file", { path, start_line: line, start_char: char }, ctx);
		assertWithinBudget(result, `notes_read_file ${path} line=${line} char=${char}`);
		const page = resultJson<NoteResult>(result);
		if (page.stop_line < page.start_line) failures.push(`range contract: ${path} returned start_line=${page.start_line} stop_line=${page.stop_line}`);
		if (parts.length > 0 && char === 0) parts.push("\n");
		parts.push(page.content);
		line = page.next_start_line;
		char = page.next_start_char;
		calls++;
	}
	return parts.join("");
}

test("coherence: following the returned cursors reconstructs the original text exactly", async () => {
	const session = SessionManager.inMemory("/private/tmp/pi-context-test");
	const captured = makeExtension(session);
	const ctx = context(session);
	const windowId = historyFromSession(ctx)[0]!.windowId;

	// --- history_read_item: every profile x length reconstructs; cursor law holds per page ---
	for (const profile of PROFILES) {
		for (const length of [12_000, 12_001, 20_000, 30_000]) {
			const original = profile.unit.repeat(length);
			const itemId = appendText(session, original);
			const reconstructed = await walkHistory(captured, ctx, windowId, itemId);
			const missing = codePoints(original) - codePoints(reconstructed);
			const line = `history_read_item default: ${profile.name} ${length} chars (${Buffer.byteLength(original, "utf8")} bytes) -> delivered ${codePoints(reconstructed)} chars, missing ${missing}, marker=${reconstructed.includes("[truncated")}`;
			report.push(line);
			if (reconstructed !== original) failures.push(line);
			session.appendMessage({ role: "assistant", content: [{ type: "text" as const, text: `ack ${length}` }], timestamp: Date.now() } as never);
		}
	}

	// --- notes_read_file: a 40,000-code-point line plus a tail, three profiles ---
	for (const profile of PROFILES) {
		const hugeLine = profile.unit.repeat(40_000);
		const text = `${hugeLine}\ntail line`;
		const path = `huge-${profile.name}.md`;
		await call(captured, "notes_write_file", { path, text }, ctx);
		const reconstructed = await walkNote(captured, ctx, path);
		const missing = codePoints(text) - codePoints(reconstructed);
		const line = `notes_read_file: ${profile.name} single line ${codePoints(hugeLine)} chars (${Buffer.byteLength(hugeLine, "utf8")} bytes) -> delivered ${codePoints(reconstructed)} chars, missing ${missing}, marker=${reconstructed.includes("[truncated")}`;
		report.push(line);
		if (reconstructed !== text) failures.push(line);
	}

	// --- The terminator itself can lie. A single line with no trailing newline is exactly what
	// notes_write_file { text } produces; the returned cursor must not be null while text remains.
	for (const profile of PROFILES) {
		const hugeLine = profile.unit.repeat(40_000);
		const path = `solo-${profile.name}.md`;
		await call(captured, "notes_write_file", { path, text: hugeLine }, ctx);
		const first = resultJson<NoteResult>(await call(captured, "notes_read_file", { path }, ctx));
		const undelivered = codePoints(hugeLine) - codePoints(first.content);
		report.push(`notes_read_file no trailing newline: ${profile.name} ${codePoints(hugeLine)} chars -> first page delivered ${codePoints(first.content)}, undelivered ${undelivered}, next_start_line=${String(first.next_start_line)}, next_start_char=${first.next_start_char}, marker=${first.content.includes("[truncated")}`);
		if (first.stop_line < first.start_line) failures.push(`range contract: ${profile.name} returns start_line=${first.start_line} stop_line=${first.stop_line}`);
		if (first.next_start_line === null && undelivered > 0) failures.push(`false exhaustion: ${profile.name} returns next_start_line=null while ${undelivered} characters were never delivered`);
		if (!hugeLine.startsWith(first.content)) failures.push(`prefix law: ${profile.name} first page is not a prefix of the line`);
		const reconstructed = await walkNote(captured, ctx, path);
		if (reconstructed !== hugeLine) failures.push(`notes_read_file single line is not reconstructible: ${profile.name}, ${codePoints(hugeLine) - codePoints(reconstructed)} chars missing`);
	}

	// --- The empty note must terminate: the old self-feeding { start_line: 1, stop_line: 0,
	// next_start_line: 1 } shape is gone, and every success keeps stop_line >= start_line.
	await call(captured, "notes_write_file", { path: "empty.md", text: "" }, ctx);
	const empty = resultJson<NoteResult>(await call(captured, "notes_read_file", { path: "empty.md" }, ctx));
	report.push(`notes_read_file empty note: start_line=${empty.start_line} stop_line=${empty.stop_line} next_start_line=${String(empty.next_start_line)} content=${JSON.stringify(empty.content)}`);
	if (empty.stop_line < empty.start_line) failures.push("range contract: the empty note returns stop_line < start_line");
	if (empty.next_start_line !== null) failures.push("pagination hole: the empty note is never exhausted");

	// --- notes_search_contents: an over-budget matched line is named, then read back with cursors ---
	const hugeCjkLine = "历".repeat(40_000);
	const searched = resultJson<{ files: Array<{ path: string; matches_total: number; matches: Match[] }> }>(
		await call(captured, "notes_search_contents", { query: "历", path_prefix: "huge-cjk.md" }, ctx),
	);
	const matchedFile = searched.files[0];
	const matched = matchedFile?.matches[0];
	report.push(`notes_search_contents: matches_total=${String(matchedFile?.matches_total)} returned=${String(matchedFile?.matches.length)} first match delivered ${codePoints(matched?.text ?? "")} of ${String(matched?.total_chars)} chars, truncated=${String(matched?.truncated)}`);
	if (!matched) failures.push("notes_search_contents dropped the over-budget matched line entirely");
	else {
		if (matched.truncated !== true) failures.push("notes_search_contents does not flag the over-budget matched line as truncated");
		if (matched.total_chars !== codePoints(hugeCjkLine)) failures.push(`notes_search_contents match total_chars=${matched.total_chars}, expected ${codePoints(hugeCjkLine)}`);
		if (!hugeCjkLine.startsWith(matched.text)) failures.push("notes_search_contents delivered a non-prefix of the matched line");
		if (codePoints(matched.text) >= matched.total_chars) failures.push("notes_search_contents claims the over-budget line fits in one response");
		const walked = await walkNote(captured, ctx, "huge-cjk.md", matched.line);
		if (walked !== `${hugeCjkLine}\ntail line`) failures.push(`notes_search_contents match line is not reconstructible from its cursor: missing ${codePoints(`${hugeCjkLine}\ntail line`) - codePoints(walked)} chars`);
	}

	// --- history_search_contents: a hit's visible text may be cut, but the offset it carries
	// must resolve to the query through history_read_item (addresses-only mode).
	const searchItemContent = `${"padding ".repeat(400)}历史内容${" trailing".repeat(400)}`;
	const searchItemId = appendText(session, searchItemContent);
	const hit = resultJson<{ items: SearchHit[] }>(
		await call(captured, "history_search_contents", { query: "历史内容", max_chars_per_item: 400, window_id: windowId }, ctx),
	);
	const first = hit.items.find((item) => item.item_id === searchItemId);
	report.push(`history_search_contents: hit present=${Boolean(first)}, fields=${JSON.stringify(Object.keys(first ?? {}))}, match_offset_chars=${String(first?.match_offset_chars)}, truncated=${String(first?.truncated)}`);
	if (!first) failures.push("history_search_contents did not return the matching item");
	else {
		if (first.truncated !== true) failures.push("history_search_contents does not flag the capped item as truncated");
		if (first.total_chars !== codePoints(searchItemContent)) failures.push(`history_search_contents total_chars=${first.total_chars}, expected ${codePoints(searchItemContent)}`);
		if (!searchItemContent.startsWith(first.truncated_content)) failures.push("history_search_contents delivered a non-prefix of the item");
		if (first.truncated_content.includes("…")) failures.push("history_search_contents appended a marker to the payload");
		if (!Number.isInteger(first.match_offset_chars)) failures.push("history_search_contents carries no match_offset_chars");
		else {
			const at = resultJson<ReadResult>(await call(captured, "history_read_item", { window_id: windowId, item_id: searchItemId, offset_chars: first.match_offset_chars, limit_chars: 8 }, ctx));
			if (!at.content.includes("历史内容")) failures.push(`history_read_item at match_offset_chars=${first.match_offset_chars} does not show the query`);
		}
	}

	// max_chars_per_item: 1 is a real address page for both history tools.
	const addresses = resultJson<{ items: SearchHit[] }>(
		await call(captured, "history_search_contents", { query: "历史内容", max_chars_per_item: 1, window_id: windowId }, ctx),
	);
	const address = addresses.items.find((item) => item.item_id === searchItemId);
	report.push(`history_search_contents max_chars_per_item=1: address=${JSON.stringify(address)}`);
	if (!address) failures.push("history_search_contents max_chars_per_item=1 dropped the hit");
	else {
		if (codePoints(address.truncated_content) !== 1) failures.push(`max_chars_per_item=1 delivered ${codePoints(address.truncated_content)} code points`);
		if (address.truncated !== true || address.total_chars !== codePoints(searchItemContent)) failures.push("max_chars_per_item=1 does not name the full length");
		if (!Number.isInteger(address.match_offset_chars)) failures.push("max_chars_per_item=1 carries no address");
	}
	const listed = resultJson<{ items: Array<{ item_id: string; truncated: boolean; total_chars: number; truncated_content: string }> }>(
		await call(captured, "history_list_items", { window_id: windowId, max_chars_per_item: 1, recent_first: false, limit: 500 }, ctx),
	);
	const listedAddress = listed.items.find((item) => item.item_id === searchItemId);
	report.push(`history_list_items max_chars_per_item=1: ${JSON.stringify(listedAddress)}`);
	if (!listedAddress) failures.push("history_list_items max_chars_per_item=1 dropped the item");
	else if (codePoints(listedAddress.truncated_content) !== 1 || listedAddress.truncated !== true || listedAddress.total_chars !== codePoints(searchItemContent)) {
		failures.push("history_list_items max_chars_per_item=1 is not an honest address page");
	}

	// --- brain-04: capping a file's matches to fit the wire budget must be named, never silent.
	const manyLines = Array.from({ length: 8_000 }, (_, index) => `needle ${index}`);
	await call(captured, "notes_write_file", { path: "many.md", text: manyLines.join("\n") }, ctx);
	const many = resultJson<{ files: Array<{ path: string; matches_total: number; matches: Match[] }> }>(
		await call(captured, "notes_search_contents", { query: "needle", path_prefix: "many.md" }, ctx),
	);
	const manyEntry = many.files[0];
	report.push(`brain-04: matches_total=${String(manyEntry?.matches_total)} returned=${String(manyEntry?.matches.length)}, next_cursor=${String((many as { next_cursor?: unknown }).next_cursor)}`);
	if (!manyEntry) failures.push("brain-04: the many-match file is absent from the search result");
	else {
		if (manyEntry.matches_total !== manyLines.length) failures.push(`brain-04: matches_total=${manyEntry.matches_total}, expected ${manyLines.length}`);
		if (!(manyEntry.matches_total > manyEntry.matches.length)) failures.push("brain-04: budget-capped matches were silently dropped (matches_total === matches.length)");
		if (manyEntry.matches_total - manyEntry.matches.length <= 0) failures.push("brain-04: the response names no dropped matches");
	}

	// A file whose first match alone is over budget with more matches behind it: dropping trailing
	// matches and cutting the kept line must still leave the whole response inside the wire budget.
	const manyHugeLines = Array.from({ length: 4 }, (_, index) => `needle ${index} ${"w".repeat(45_000)}`);
	await call(captured, "notes_write_file", { path: "huge-many.md", text: manyHugeLines.join("\n") }, ctx);
	const hugeManyResult = await call(captured, "notes_search_contents", { query: "needle", path_prefix: "huge-many.md" }, ctx);
	assertWithinBudget(hugeManyResult, "notes_search_contents huge-many");
	const hugeEntry = resultJson<{ files: Array<{ matches_total: number; matches: Match[] }> }>(hugeManyResult).files[0];
	report.push(`huge-many: matches_total=${String(hugeEntry?.matches_total)} returned=${String(hugeEntry?.matches.length)} truncated=${String(hugeEntry?.matches[0]?.truncated)}`);
	if (!hugeEntry) failures.push("huge-many: the many-huge-match file is absent from the search result");
	else {
		if (!(hugeEntry.matches_total > hugeEntry.matches.length)) failures.push("huge-many: dropped matches are not named");
		if (hugeEntry.matches[0]?.truncated !== true) failures.push("huge-many: the kept match is not flagged as a prefix");
	}

	console.log(report.map((line) => `  ${line}`).join("\n"));
	assert.deepEqual(failures, [], `cursor-following lost text at ${failures.length} site(s)`);
});
