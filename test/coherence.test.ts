/**
 * OWNER: pi-context (adopted).
 * STATUS: tracked acceptance spec for the history and notes read/search tools. No skip.
 * CLAIM: following the cursors these tools return must reconstruct the original text exactly,
 *   or the result must name the skipped range. Both read tools are one character window over two
 *   stores (notes_read_file and history_read_item share the cursor walk below). In v2 this failed
 *   at 13 sites; the rows that demanded an over-budget line in a single call are rebuilt as
 *   cursor-walking rows below (the CLAIM explicitly licenses that: reconstruct exactly by
 *   following cursors, or name the skipped range).
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

type ReadResult = { header: string; content: string; offset_chars: number; total_chars: number; next_offset_chars: number | null };
type SearchHit = { item_id: string; truncated: boolean; total_chars: number; truncated_content: string; match_offset_chars: number };
type Match = { line: number; text: string; truncated: boolean; total_chars: number; offset_chars: number };

/**
 * Decode a raw read (notes_read_file / history_read_item): a one-line bracketed header, then
 * the payload verbatim (which may itself contain newlines), so split on the first newline only.
 */
function resultRead(result: AgentToolResult<unknown>): ReadResult {
	const text = result.content[0];
	assert.ok(text && text.type === "text", "read result carries text");
	const newline = text.text.indexOf("\n");
	assert.ok(newline !== -1, "raw read carries a header line and a payload");
	const header = text.text.slice(0, newline);
	const content = text.text.slice(newline + 1);
	assert.match(header, /^\[/, "the header is bracketed");
	assert.match(header, /\]$/, "the header closes its bracket");
	const match = header.match(/ · chars (\d+)-(\d+) of (\d+) · (end|continue at offset_chars=(\d+))/);
	assert.ok(match, `read header names the char range and resume cursor: ${header}`);
	const offset_chars = Number(match[1]);
	const total_chars = Number(match[3]);
	const next_offset_chars = match[4] === "end" ? null : Number(match[5]);
	assert.equal([...content].length, Number(match[2]) - offset_chars, "the header range matches the delivered payload");
	return { header, content, offset_chars, total_chars, next_offset_chars };
}

const PROFILES = [
	{ name: "cjk", unit: "历" },
	{ name: "emoji", unit: "🕷" },
	{ name: "ascii", unit: "x" },
] as const;

const failures: string[] = [];
const report: string[] = [];

const codePoints = (text: string) => [...text].length;
const codePointSlice = (text: string, start: number, end?: number) => [...text].slice(start, end).join("");

/**
 * Follow either read tool's cursor exactly as the protocol tells the model to, asserting the
 * cursor law on every page. Both tools are the same character window over two stores, so one
 * walker serves both; `address` carries the tool's own identity parameters, and `options.start`
 * lets a walk begin at a resolved address (a search hit's offset, or a negative tail read).
 */
async function walkWindow(captured: Captured, ctx: ExtensionContext, tool: "history_read_item" | "notes_read_file", address: Record<string, unknown>, label: string, options: { start?: number; limitChars?: number } = {}): Promise<string> {
	const parts: string[] = [];
	let offset = options.start ?? 0;
	let next: number | null = 0;
	let calls = 0;
	let total = 0;
	while (next !== null && calls < 400) {
		const params: Record<string, unknown> = { ...address, offset_chars: offset };
		if (options.limitChars !== undefined) params.limit_chars = options.limitChars;
		const result = await call(captured, tool, params, ctx);
		assertWithinBudget(result, `${label} offset=${offset}`);
		const page = resultRead(result);
		total = page.total_chars;
		const delivered = codePoints(page.content);
		if (page.offset_chars !== offset) failures.push(`cursor law: ${label} echoed offset_chars=${page.offset_chars} for request offset ${offset}`);
		if (page.next_offset_chars !== null && page.next_offset_chars !== offset + delivered) {
			failures.push(`cursor law: ${label} next_offset_chars=${page.next_offset_chars} but offset ${offset} + delivered ${delivered}`);
		}
		if (page.next_offset_chars === null && offset + delivered !== page.total_chars) {
			failures.push(`false exhaustion: ${label} returned next_offset_chars=null with ${page.total_chars - (offset + delivered)} characters undelivered`);
		}
		if (page.content.includes("…") || page.content.includes("[truncated")) failures.push(`honest payload: ${label} appended a marker at offset ${offset}`);
		parts.push(page.content);
		next = page.next_offset_chars;
		if (next !== null) offset = next;
		calls++;
	}
	if (offset !== total && calls >= 400) failures.push(`${label} never terminated`);
	return parts.join("");
}

const walkHistory = (captured: Captured, ctx: ExtensionContext, windowId: string, itemId: string, limitChars?: number) =>
	walkWindow(captured, ctx, "history_read_item", { window_id: windowId, item_id: itemId }, `history_read_item ${itemId}`, { limitChars });

const walkNote = (captured: Captured, ctx: ExtensionContext, path: string, start = 0) =>
	walkWindow(captured, ctx, "notes_read_file", { path }, `notes_read_file ${path}`, { start });

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

	// --- notes_read_file: a 40,000-code-point single line plus a tail, three profiles ---
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
		const first = resultRead(await call(captured, "notes_read_file", { path }, ctx));
		const undelivered = codePoints(hugeLine) - codePoints(first.content);
		report.push(`notes_read_file no trailing newline: ${profile.name} ${codePoints(hugeLine)} chars -> first page delivered ${codePoints(first.content)}, undelivered ${undelivered}, offset_chars=${first.offset_chars}, next_offset_chars=${String(first.next_offset_chars)}, marker=${first.content.includes("[truncated")}`);
		if (first.offset_chars !== 0) failures.push(`window echo: ${profile.name} first page echoed offset_chars=${first.offset_chars}, expected 0`);
		if (first.total_chars !== codePoints(hugeLine)) failures.push(`window total: ${profile.name} total_chars=${first.total_chars}, expected ${codePoints(hugeLine)}`);
		if (first.next_offset_chars === null && undelivered > 0) failures.push(`false exhaustion: ${profile.name} returns next_offset_chars=null while ${undelivered} characters were never delivered`);
		if (!hugeLine.startsWith(first.content)) failures.push(`prefix law: ${profile.name} first page is not a prefix of the line`);
		const reconstructed = await walkNote(captured, ctx, path);
		if (reconstructed !== hugeLine) failures.push(`notes_read_file single line is not reconstructible: ${profile.name}, ${codePoints(hugeLine) - codePoints(reconstructed)} chars missing`);
	}

	// --- The empty note must terminate: no self-feeding cursor, and an empty window from 0.
	await call(captured, "notes_write_file", { path: "empty.md", text: "" }, ctx);
	const empty = resultRead(await call(captured, "notes_read_file", { path: "empty.md" }, ctx));
	report.push(`notes_read_file empty note: offset_chars=${empty.offset_chars} total_chars=${empty.total_chars} next_offset_chars=${String(empty.next_offset_chars)} content=${JSON.stringify(empty.content)}`);
	if (empty.offset_chars !== 0 || empty.total_chars !== 0 || empty.content !== "") failures.push("the empty note is not an empty window from 0");
	if (empty.next_offset_chars !== null) failures.push("pagination hole: the empty note is never exhausted");

	// --- notes_search_contents: an over-budget matched line is named, then read back with cursors ---
	const hugeCjkLine = "历".repeat(40_000);
	const searched = resultJson<{ files: Array<{ path: string; matches_total: number; matches: Match[] }> }>(
		await call(captured, "notes_search_contents", { query: "历", pattern: "huge-cjk.md" }, ctx),
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
		const walked = await walkNote(captured, ctx, "huge-cjk.md", matched.offset_chars);
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
			const at = resultRead(await call(captured, "history_read_item", { window_id: windowId, item_id: searchItemId, offset_chars: first.match_offset_chars, limit_chars: 8 }, ctx));
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
		await call(captured, "notes_search_contents", { query: "needle", pattern: "many.md" }, ctx),
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
	const hugeManyResult = await call(captured, "notes_search_contents", { query: "needle", pattern: "huge-many.md" }, ctx);
	assertWithinBudget(hugeManyResult, "notes_search_contents huge-many");
	const hugeEntry = resultJson<{ files: Array<{ matches_total: number; matches: Match[] }> }>(hugeManyResult).files[0];
	report.push(`huge-many: matches_total=${String(hugeEntry?.matches_total)} returned=${String(hugeEntry?.matches.length)} truncated=${String(hugeEntry?.matches[0]?.truncated)}`);
	if (!hugeEntry) failures.push("huge-many: the many-huge-match file is absent from the search result");
	else {
		if (!(hugeEntry.matches_total > hugeEntry.matches.length)) failures.push("huge-many: dropped matches are not named");
		if (hugeEntry.matches[0]?.truncated !== true) failures.push("huge-many: the kept match is not flagged as a prefix");
	}

	// --- notes_search_contents addresses: a match's offset_chars is the file-absolute code-point
	// position of the earliest query occurrence in its line, so search → read composes exactly like
	// history's match_offset_chars two-stage.
	const addressLine1 = "pad ".repeat(50);
	const addressLine3 = `${"历".repeat(20)}needle-address here`;
	const addressLine4 = "zeta 历 needle-address";
	await call(captured, "notes_write_file", { path: "address.md", text: `${addressLine1}\nsecond\n${addressLine3}\n${addressLine4}` }, ctx);
	const expectedAddress = codePoints(addressLine1) + 1 + codePoints("second") + 1 + 20;
	const addressHit = resultJson<{ files: Array<{ path: string; matches: Match[] }> }>(
		await call(captured, "notes_search_contents", { query: "needle-address", pattern: "address.md" }, ctx),
	).files[0]?.matches.find((match) => match.line === 3);
	report.push(`notes_search_contents address: line=${String(addressHit?.line)} offset_chars=${String(addressHit?.offset_chars)} expected=${expectedAddress}`);
	const addressOffset = addressHit?.offset_chars;
	if (typeof addressOffset !== "number") failures.push("notes_search_contents carries no offset_chars");
	else if (addressOffset !== expectedAddress) failures.push(`notes_search_contents offset_chars=${addressOffset}, expected ${expectedAddress} (file-absolute, at the query)`);
	else {
		const at = resultRead(await call(captured, "notes_read_file", { path: "address.md", offset_chars: addressOffset, limit_chars: 32 }, ctx));
		if (!at.content.startsWith("needle-address")) failures.push(`notes_read_file at a search hit's offset_chars does not start at the query: ${JSON.stringify(at.content)}`);
		if (!at.content.includes("needle-address")) failures.push("notes_read_file at a search hit's offset_chars does not show the query");
	}
	// Multi-query OR: a line's address is the earliest occurrence of any query inside that line.
	const line4Base = expectedAddress - 20 + codePoints(addressLine3) + 1;
	const orLine4 = resultJson<{ files: Array<{ matches: Match[] }> }>(
		await call(captured, "notes_search_contents", { query: ["needle-address", "zeta"], pattern: "address.md" }, ctx),
	).files[0]?.matches.find((match) => match.line === 4);
	report.push(`notes_search_contents OR address: offset_chars=${String(orLine4?.offset_chars)} expected=${line4Base}`);
	if (orLine4?.offset_chars !== line4Base) failures.push(`notes_search_contents OR offset_chars=${String(orLine4?.offset_chars)}, expected ${line4Base} (earliest of any query)`);

	// --- Negative offsets on both stores: a tail read reaches the end in one call, the response
	// echoes the resolved absolute offset, N >= total_chars reads from the start, and the cursor
	// law still holds when a negative-start page is cut short.
	for (const profile of PROFILES) {
		const tailText = `head${profile.unit.repeat(20)}TAIL${profile.unit.repeat(20)}`;
		const path = `tail-${profile.name}.md`;
		await call(captured, "notes_write_file", { path, text: tailText }, ctx);
		const total = codePoints(tailText);
		const tail = resultRead(await call(captured, "notes_read_file", { path, offset_chars: -10 }, ctx));
		report.push(`notes_read_file negative offset: ${profile.name} total=${total} -> offset_chars=${tail.offset_chars} next=${String(tail.next_offset_chars)} content=${JSON.stringify(tail.content)}`);
		if (tail.offset_chars !== total - 10) failures.push(`negative offset: notes_read_file ${profile.name} echoed ${tail.offset_chars}, expected ${total - 10}`);
		if (tail.content !== codePointSlice(tailText, total - 10)) failures.push(`negative offset: notes_read_file ${profile.name} did not reach the tail in one call`);
		if (tail.next_offset_chars !== null) failures.push(`negative offset: notes_read_file ${profile.name} tail read is not exhausted`);
		const fromStart = resultRead(await call(captured, "notes_read_file", { path, offset_chars: -(total + 5), limit_chars: 8 }, ctx));
		if (fromStart.offset_chars !== 0) failures.push(`negative offset: notes_read_file ${profile.name} with N >= total_chars echoed ${fromStart.offset_chars}, expected 0`);
		if (fromStart.content !== codePointSlice(tailText, 0, 8)) failures.push(`negative offset: notes_read_file ${profile.name} with N >= total_chars did not read from the start`);
		const cut = resultRead(await call(captured, "notes_read_file", { path, offset_chars: -15, limit_chars: 4 }, ctx));
		if (cut.next_offset_chars !== cut.offset_chars + codePoints(cut.content)) failures.push(`negative offset: notes_read_file ${profile.name} cut a negative-start read off the cursor law`);
		const resumed = resultRead(await call(captured, "notes_read_file", { path, offset_chars: cut.next_offset_chars as number }, ctx));
		if (resumed.offset_chars !== cut.next_offset_chars) failures.push(`negative offset: notes_read_file ${profile.name} resume echoed ${resumed.offset_chars}, expected ${String(cut.next_offset_chars)}`);
	}

	// history_read_item gains the identical sugar over a durable item.
	const historyTailText = `${"h".repeat(50)}END`;
	const historyTailId = appendText(session, historyTailText);
	const historyTail = resultRead(await call(captured, "history_read_item", { window_id: windowId, item_id: historyTailId, offset_chars: -3 }, ctx));
	report.push(`history_read_item negative offset: offset_chars=${historyTail.offset_chars} next=${String(historyTail.next_offset_chars)} content=${JSON.stringify(historyTail.content)}`);
	if (historyTail.offset_chars !== 50 || historyTail.content !== "END" || historyTail.next_offset_chars !== null) failures.push(`negative offset: history_read_item returned ${JSON.stringify(historyTail)}`);
	const historyFromStart = resultRead(await call(captured, "history_read_item", { window_id: windowId, item_id: historyTailId, offset_chars: -500, limit_chars: 4 }, ctx));
	if (historyFromStart.offset_chars !== 0 || historyFromStart.content !== "hhhh") failures.push(`negative offset: history_read_item with N >= total_chars returned ${JSON.stringify(historyFromStart)}`);

	console.log(report.map((line) => `  ${line}`).join("\n"));
	assert.deepEqual(failures, [], `cursor-following lost text at ${failures.length} site(s)`);
});
