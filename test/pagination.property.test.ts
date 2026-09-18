/**
 * Property-based pagination tests for the four paginating pi-context tools:
 * history_list_items, history_search_contents, notes_search_contents,
 * notes_list_files.
 *
 * Each case is generated from a seed, so a failure names its seed and reproduces by
 * re-running that one seed:
 *
 *   PI_CONTEXT_PROPERTY_SEED=137 npm test
 *
 * Invariants asserted per tool across random session shapes x page caps x budgets:
 *   1. enumeration complete: concatenated pages equal the expected ordered set
 *   2. no duplicates across pages
 *   3. cursors strictly advance: no cycle, no repeated page, no empty non-terminal page
 *   4. next_cursor is null only at the true end
 *   5. every serialized page stays within the 32 KiB tool-output budget
 *
 * Expected sets come from the underlying stores (historyFromSession / notesFromSession)
 * combined with the tools' documented filters -- never from the pagination code under test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { historyFromSession, notesFromSession } from "../src/index.js";
import { TOOL_OUTPUT_MAX_BYTES } from "../src/tool-output.js";
import { NOTE_TYPE, MAX_NOTE_PATH_BYTES } from "../src/protocol.js";
import { appendText, call, context, makeExtension, manager, resultJson, type Captured } from "./integration.test.js";

const NEEDLE = "PAGE_NEEDLE";

/** Default seed corpus; PI_CONTEXT_PROPERTY_SEED=<n|n,n,...> re-runs exactly those seeds. */
const DEFAULT_SEEDS = [11, 23, 37, 51, 67, 89, 101, 137, 173, 211, 251, 307];
const OVERRIDE = process.env.PI_CONTEXT_PROPERTY_SEED
	?.split(",")
	.map((part) => Number(part.trim()))
	.filter((value) => Number.isFinite(value));
const SEEDS = OVERRIDE && OVERRIDE.length > 0 ? OVERRIDE : DEFAULT_SEEDS;

/** Deterministic PRNG (mulberry32): the whole generated case is a pure function of the seed. */
class Rng {
	private state: number;
	constructor(seed: number) {
		this.state = seed >>> 0;
	}
	next(): number {
		this.state = (this.state + 0x6d2b79f5) | 0;
		let t = this.state;
		t = Math.imul(t ^ (t >>> 15), 1 | t);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
	int(min: number, max: number): number {
		return min + Math.floor(this.next() * (max - min + 1));
	}
	bool(probability = 0.5): boolean {
		return this.next() < probability;
	}
	pick<T>(values: readonly T[]): T {
		return values[this.int(0, values.length - 1)] as T;
	}
}

// ---------------------------------------------------------------------------
// History shapes
// ---------------------------------------------------------------------------

type HistoryRole = "user" | "assistant" | "toolResult";

type HistoryEntryPlan =
	| { kind: "message"; role: HistoryRole; toolName: string; content: string }
	| { kind: "custom_message"; content: string }
	| { kind: "compaction"; summary: string };

type HistoryFilterName = "user" | "assistant" | "tool" | "system" | "developer";

type HistoryVariant = {
	label: string;
	query?: string;
	windowIndex: number | null;
	role: HistoryFilterName | null;
	toolName: string | null;
	recentFirst: boolean;
	limit: number;
	maxCharsPerItem: number;
};

type HistoryPlan = {
	seed: number;
	entries: HistoryEntryPlan[];
	windowCount: number;
	list: HistoryVariant[];
	search: HistoryVariant[];
};

const TOOL_NAMES = ["bash", "notes_read_file", "notes_write_file", "history_list_items", "history_search_contents", "web_search", "mcp_tool_call", "read", "_odd"] as const;
const CONTENT_LIMITS = [1, 5, 60, 1200, 24_000, 50_000] as const;
const PAGE_LIMITS = [1, 2, 3, 5, 8, 13, 34, 200] as const;
const ROLE_FILTERS = [null, "user", "assistant", "tool", "system", "developer"] as const;
const NAME_FILTERS = [null, "bash", "notes_read_file", "history_list_items", "read", "_odd", "mcp_tool_call"] as const;

function makeContent(rng: Rng, large: boolean): string {
	const shape = large ? rng.pick(["large", "large", "medium", "needle"] as const) : rng.pick(["empty", "tiny", "tiny", "needle", "medium"] as const);
	switch (shape) {
		case "empty": return "";
		case "tiny": return rng.pick(["", "x", "hello world", "日本語のテキスト", "line one\nline two", NEEDLE, `${NEEDLE} ${NEEDLE}`]);
		case "needle": return `${NEEDLE} item ${rng.int(0, 9999)}`;
		case "medium": return rng.bool() ? `${NEEDLE}\n${"m".repeat(rng.int(400, 4000))}` : `${"m".repeat(rng.int(400, 4000))}\n${NEEDLE}`;
		case "large": return `${NEEDLE}\n${"L".repeat(rng.int(24_000, 70_000))}`;
	}
}

function historyPlan(seed: number): HistoryPlan {
	const rng = new Rng(seed * 2 + 1);
	const count = rng.pick([0, 1, 1, 2, 3, 5, 8, 13, 21]);
	const entries: HistoryEntryPlan[] = [];
	let compactions = 0;
	for (let index = 0; index < count; index++) {
		// A compaction entry splits the branch into a new window.
		if (index > 0 && rng.bool(0.12)) {
			compactions++;
			entries.push({ kind: "compaction", summary: makeContent(rng, rng.bool(0.2)) });
		}
		const roll = rng.next();
		if (roll < 0.12) {
			entries.push({ kind: "custom_message", content: makeContent(rng, rng.bool(0.15)) });
		} else {
			const role: HistoryRole = roll < 0.45 ? "user" : roll < 0.75 ? "assistant" : "toolResult";
			entries.push({ kind: "message", role, toolName: role === "toolResult" ? rng.pick(TOOL_NAMES) : "bash", content: makeContent(rng, rng.bool(0.18)) });
		}
	}
	// Rare pathological shape on a deterministic subset of seeds: a tool result whose 40 KB
	// tool_name only fits once the metadata is middle-truncated. Inserted at the head so the
	// oversized item is the first item of its page, and a fixed size keeps later rng draws
	// (and therefore the filters) unchanged.
	if (seed % 3 === 0) entries.unshift({ kind: "message", role: "toolResult", toolName: `oversized_${"t".repeat(40_000)}`, content: "oversized tool_name probe" });
	const windowCount = compactions + 1;
	const variant = (label: string, query?: string): HistoryVariant => ({
		label,
		query,
		windowIndex: rng.bool(0.3) ? rng.int(0, windowCount - 1) : null,
		role: rng.pick(ROLE_FILTERS),
		toolName: rng.pick(NAME_FILTERS),
		recentFirst: rng.bool(),
		limit: rng.pick(PAGE_LIMITS),
		maxCharsPerItem: rng.pick(CONTENT_LIMITS),
	});
	// Variant 0 of each list is deliberately unfiltered: it must enumerate the whole set.
	const list: HistoryVariant[] = [
		{ label: "unfiltered", windowIndex: null, role: null, toolName: null, recentFirst: false, limit: 200, maxCharsPerItem: rng.pick(CONTENT_LIMITS) },
		variant("list-1"),
		variant("list-2"),
		variant("list-3"),
	];
	const search: HistoryVariant[] = [
		{ label: "needle-unfiltered", query: NEEDLE, windowIndex: null, role: null, toolName: null, recentFirst: false, limit: 200, maxCharsPerItem: rng.pick(CONTENT_LIMITS) },
		variant("search-1", rng.pick([NEEDLE, "", "line", "no-such-token", "…"])),
		variant("search-2", rng.pick([NEEDLE, "", "x", "item", "_odd"])),
		variant("search-3", rng.pick([NEEDLE, "", "日本語", "m", "L"])),
	];
	return { seed, entries, windowCount, list, search };
}

function materializeHistory(session: SessionManager, plan: HistoryPlan): void {
	for (const entry of plan.entries) {
		if (entry.kind === "message") appendText(session, entry.role, entry.content, entry.toolName);
		else if (entry.kind === "custom_message") session.appendCustomMessageEntry("pi-context/property", entry.content, false);
		else session.appendCompaction(entry.summary, session.getLeafId() ?? "property-root", 1000);
	}
}

function historyParams(ctx: ExtensionContext, variant: HistoryVariant): Record<string, unknown> {
	const windows = historyFromSession(ctx);
	const windowId = variant.windowIndex === null ? null : windows[variant.windowIndex]?.windowId ?? null;
	return {
		limit: variant.limit,
		recent_first: variant.recentFirst,
		role: variant.role,
		tool_name: variant.toolName,
		window_id: windowId,
		max_chars_per_item: variant.maxCharsPerItem,
	};
}

type StoreHistoryItem = { itemId: string; windowId: string; role: string; content: string; toolName?: string };

/** The documented filter order (filteredItems), reimplemented over the store, never over page(). */
function storeHistoryItems(ctx: ExtensionContext, params: Record<string, unknown>): StoreHistoryItem[] {
	let items = historyFromSession(ctx).flatMap((window) => window.items);
	if (typeof params.window_id === "string") items = items.filter((item) => item.windowId === params.window_id);
	if (typeof params.role === "string") items = items.filter((item) => item.role === params.role);
	if (typeof params.tool_name === "string") items = items.filter((item) => item.toolName === params.tool_name);
	if (params.recent_first !== false) items = [...items].reverse();
	return items;
}

// ---------------------------------------------------------------------------
// Notes shapes
// ---------------------------------------------------------------------------

type NoteOpPlan =
	| { kind: "entry"; data: unknown }
	| { kind: "write"; path: string; text: string }
	| { kind: "append"; path: string; text: string }
	| { kind: "mark"; path: string; stale: boolean };

type NoteListVariant = { label: string; pattern: string | null; orderBy: "name" | "created_at" | "updated_at"; order: "ascending" | "descending"; maxResults: number };
type NoteSearchVariant = { label: string; query: string; prefix: string | null; maxFiles: number; maxMatchesPerFile: number; recentFileFirst: boolean };

type NotesPlan = { seed: number; ops: NoteOpPlan[]; list: NoteListVariant[]; search: NoteSearchVariant[] };

function makeNotePath(rng: Rng, index: number): string {
	const dir = rng.pick(["", "notes/", "deep/nested/dir/", "unicode-日本語/"]);
	const name = rng.pick([`f${index}.md`, `long-${"x".repeat(rng.int(1, 260))}-${index}.md`, `note ${index}.md`, `ünïcode-${index}.md`, `checkpoint-${index}.md`]);
	return `${dir}${name}`;
}

function makeNoteText(rng: Rng): string {
	const shape = rng.pick(["empty", "tiny", "needle", "lines", "huge-line", "huge-lines"] as const);
	switch (shape) {
		case "empty": return "";
		case "tiny": return rng.pick(["small note", "needle", "one\ntwo"]);
		case "needle": return `${NEEDLE} ${rng.int(0, 999)}\nsecond line`;
		case "lines": return Array.from({ length: rng.int(2, 40) }, (_, line) => `${rng.bool(0.4) ? `${NEEDLE} ` : ""}line ${line} ${"z".repeat(rng.int(0, 80))}`).join("\n");
		case "huge-line": return `${NEEDLE} ${"H".repeat(rng.int(24_000, 70_000))}`;
		case "huge-lines": return Array.from({ length: rng.int(2, 5) }, (_, line) => `${NEEDLE} line ${line} ${"G".repeat(rng.int(8_000, 20_000))}`).join("\n");
	}
}

function notesPlan(seed: number): NotesPlan {
	const rng = new Rng(seed * 4 + 3);
	const ops: NoteOpPlan[] = [];
	const fileCount = rng.pick([0, 1, 2, 3, 6, 11, 17]);
	let clock = 1_700_000_000_000 + rng.int(0, 100_000);
	for (let index = 0; index < fileCount; index++) {
		const path = makeNotePath(rng, index);
		clock += rng.int(0, 3); // ties are common on purpose: sort stability is part of the contract
		ops.push({ kind: "entry", data: { op: "write", path, text: makeNoteText(rng), createdAt: clock, updatedAt: clock } });
		if (rng.bool(0.35)) {
			clock += rng.int(0, 2);
			ops.push({ kind: "entry", data: { op: "append", path, text: `\nappended ${rng.int(0, 999)}`, createdAt: clock, updatedAt: clock } });
		}
		if (rng.bool(0.25)) {
			clock += rng.int(0, 2);
			ops.push({ kind: "mark", path, stale: true });
		}
		if (rng.bool(0.2)) {
			clock += rng.int(0, 2);
			ops.push({ kind: "entry", data: { op: "write", path, text: makeNoteText(rng), createdAt: clock, updatedAt: clock } });
		}
		if (rng.bool(0.15)) ops.push({ kind: "write", path: `${path}-tool.md`, text: rng.pick(["tool write", `${NEEDLE} from tool`]) });
	}
	// Replay-filtering edges: the store drops all of these, and so must every page.
	ops.push({ kind: "entry", data: { op: "nope", path: "bad-op.md", text: "x", createdAt: clock, updatedAt: clock } });
	ops.push({ kind: "entry", data: { op: "write", path: "../escape.md", text: "x", createdAt: clock, updatedAt: clock } });
	ops.push({ kind: "entry", data: { op: "write", path: "/absolute.md", text: "x", createdAt: clock, updatedAt: clock } });
	ops.push({ kind: "entry", data: { op: "write", path: "nonstring.md", text: 42, createdAt: clock, updatedAt: clock } });
	ops.push({ kind: "entry", data: null });
	ops.push({ kind: "entry", data: { op: "write", path: "oversized.md", text: "z".repeat(1_000_001), createdAt: clock, updatedAt: clock } });
	ops.push({ kind: "entry", data: { op: "write", path: "mark-missing.md", stale: true, createdAt: clock, updatedAt: clock } });
	ops.push({ kind: "entry", data: { op: "write", path: "bad-time.md", text: "x", createdAt: Number.NaN, updatedAt: clock } });
	// Rare pathological legacy path on a deterministic subset of seeds: predates the 512-byte
	// write cap, so it can only enter the store by replaying a persisted op. The list/search
	// tools must truncate it visibly rather than silently, while replay and reads stay un-capped.
	if (seed % 3 === 0) ops.push({ kind: "entry", data: { op: "write", path: `legacy/${"p".repeat(40_000)}.md`, text: `${NEEDLE} legacy oversized path`, createdAt: clock, updatedAt: clock } });

	const prefixes = [null, "", "notes", "deep/nested", "unicode-日本語", "absent"];
	// Literal patterns like "notes" discriminate glob from prefix semantics: they must match
	// only an exact path, never the directory's children.
	const patterns = [null, "", "**", "*.md", "**.md", "notes/*", "notes", "deep/**", "deep/nested", "unicode-日本語/*", "checkpoint-*", "absent*", "f?.md"];
	const list: NoteListVariant[] = [
		{ label: "all-name-asc", pattern: null, orderBy: "name", order: "ascending", maxResults: 200 },
		{ label: "paged-name-asc", pattern: rng.pick(patterns), orderBy: "name", order: "ascending", maxResults: rng.pick([1, 2, 3, 5]) },
		{ label: "created-desc", pattern: rng.pick(patterns), orderBy: "created_at", order: "descending", maxResults: rng.pick([1, 3, 7, 200]) },
		{ label: "updated-asc", pattern: rng.pick(patterns), orderBy: "updated_at", order: "ascending", maxResults: rng.pick([2, 4, 200]) },
	];
	const search: NoteSearchVariant[] = [
		{ label: "needle-all", query: NEEDLE, prefix: null, maxFiles: 200, maxMatchesPerFile: 100, recentFileFirst: false },
		{ label: "needle-paged", query: NEEDLE, prefix: null, maxFiles: rng.pick([1, 2, 3]), maxMatchesPerFile: rng.pick([1, 2, 5, 100]), recentFileFirst: rng.bool() },
		{ label: "empty-query", query: "", prefix: null, maxFiles: rng.pick([1, 3, 200]), maxMatchesPerFile: 100, recentFileFirst: false },
		{ label: "rare-query", query: rng.pick(["line 3", "z", "日本語", "absent-token", "…"]), prefix: rng.pick(prefixes), maxFiles: rng.pick([1, 5, 200]), maxMatchesPerFile: rng.pick([1, 100]), recentFileFirst: rng.bool() },
	];
	return { seed, ops, list, search };
}

async function materializeNotes(plan: NotesPlan, captured: Captured, ctx: ExtensionContext, session: SessionManager): Promise<void> {
	for (const op of plan.ops) {
		if (op.kind === "entry") session.appendCustomEntry(NOTE_TYPE, op.data);
		else if (op.kind === "write") await call(captured, "notes_write_file", { path: op.path, text: op.text }, ctx);
		else if (op.kind === "append") await call(captured, "notes_append_to_file", { path: op.path, text: op.text }, ctx);
		else await call(captured, "notes_write_file", { path: op.path, mark_stale: op.stale }, ctx);
	}
}

type StoreNoteFile = { path: string; text: string; stale: boolean; createdAt: number; updatedAt: number };

/** Test-local reimplementation of the documented glob semantics -- never imported from src. */
function globMatch(pattern: string, path: string): boolean {
	let source = "^";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index]!;
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				const followedBySlash = pattern[index + 2] === "/";
				source += followedBySlash ? "(?:[^]*/)?" : "[^]*";
				index += followedBySlash ? 2 : 1;
			} else {
				source += "[^/]*";
			}
		} else {
			source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`).test(path);
}

function storeNoteFiles(ctx: ExtensionContext, match: (path: string) => boolean): StoreNoteFile[] {
	return [...notesFromSession(ctx)]
		.filter(([path]) => match(path))
		.map(([path, file]) => ({ path, text: file.text, stale: file.stale, createdAt: file.createdAt, updatedAt: file.updatedAt }));
}

/** The documented ordering of notes_list_files, reimplemented over the store: the total order
 * (axis key, createdAt, path) ascending, then the whole comparator reversed for descending. */
function expectedNoteOrder(ctx: ExtensionContext, variant: NoteListVariant): StoreNoteFile[] {
	const files = storeNoteFiles(ctx, (path) => !variant.pattern || globMatch(variant.pattern, path));
	const key = variant.orderBy;
	files.sort((a, b) => {
		const primary = key === "name" ? a.path.localeCompare(b.path) : key === "created_at" ? a.createdAt - b.createdAt : a.updatedAt - b.updatedAt;
		if (primary !== 0) return primary;
		if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
		return a.path.localeCompare(b.path);
	});
	if (variant.order === "descending") files.reverse();
	return files;
}

/** The documented matching/ordering of notes_search_contents, reimplemented over the store. */
function expectedSearchOrder(ctx: ExtensionContext, variant: NoteSearchVariant): StoreNoteFile[] {
	const files = storeNoteFiles(ctx, (path) => !variant.prefix || path.startsWith(variant.prefix));
	if (variant.recentFileFirst) files.sort((a, b) => b.createdAt - a.createdAt);
	return files.filter((file) => file.text.split("\n").some((line) => line.includes(variant.query)));
}

// ---------------------------------------------------------------------------
// Paging driver
// ---------------------------------------------------------------------------

function rawText(result: AgentToolResult<unknown>): string {
	const part = result.content[0];
	if (!part || part.type !== "text") throw new Error("tool result carries text");
	return part.text;
}

type PageJson = Record<string, unknown> & { next_cursor: number | null };

/**
 * Follow next_cursor to the true end, asserting invariants 1-5 for every page.
 * `expected` is the full ordered id sequence the store says the tool must enumerate.
 * `idsOf` receives the page and the page's starting cursor (its index into the expected
 * ordered set), so an identity-paginating tool can map a visibly truncated identity back
 * to the expected one instead of pretending it was never returned.
 */
async function walkPages(options: {
	captured: Captured;
	ctx: ExtensionContext;
	tool: string;
	params: Record<string, unknown>;
	idsOf: (json: PageJson, cursor: number) => string[];
	expected: readonly string[];
	label: string;
}): Promise<PageJson[]> {
	const { captured, ctx, tool, params, idsOf, expected, label } = options;
	const seen = new Set<string>();
	const cursors = new Set<number>();
	const collected: string[] = [];
	const pages: PageJson[] = [];
	let cursor = 0;
	let next: number | null = 0;
	const guard = expected.length + 4;
	while (next !== null) {
		assert.ok(pages.length < guard, `${label}: pagination exceeded ${guard} pages (cursor=${cursor}); cursor cycle or stall, collected ${collected.length}/${expected.length}`);
		const result = await call(captured, tool, { ...params, cursor }, ctx);
		const text = rawText(result);
		const bytes = Buffer.byteLength(text, "utf8");
		assert.ok(bytes <= TOOL_OUTPUT_MAX_BYTES, `${label} cursor=${cursor}: serialized page is ${bytes} bytes, over the ${TOOL_OUTPUT_MAX_BYTES}-byte budget`);
		const page = resultJson<PageJson>(result);
		assert.ok(page.next_cursor === null || Number.isInteger(page.next_cursor), `${label} cursor=${cursor}: next_cursor is an integer or null`);
		const ids = idsOf(page, cursor);
		for (const id of ids) {
			assert.equal(seen.has(id), false, `${label} cursor=${cursor}: duplicate id ${id} across pages`);
			seen.add(id);
		}
		collected.push(...ids);
		if (page.next_cursor === null) {
			assert.equal(collected.length, expected.length, `${label} cursor=${cursor}: next_cursor is null but ${expected.length - collected.length} of ${expected.length} items are unenumerated`);
		} else {
			assert.ok(ids.length > 0, `${label} cursor=${cursor}: non-terminal page is empty (stall)`);
			assert.ok(page.next_cursor > cursor, `${label}: cursor did not strictly advance (${cursor} -> ${page.next_cursor})`);
			assert.equal(cursors.has(page.next_cursor), false, `${label}: cursor ${page.next_cursor} was revisited`);
			cursors.add(page.next_cursor);
		}
		assert.ok(collected.length <= expected.length, `${label} cursor=${cursor}: enumerated ${collected.length} items, more than the expected ${expected.length}`);
		pages.push(page);
		next = page.next_cursor;
		if (next !== null) cursor = next;
	}
	assert.deepEqual(collected, [...expected], `${label}: concatenated pages differ from the expected enumeration`);
	return pages;
}

const TRUNCATION_MARKER = /^([\s\S]*)…\[truncated \d+ chars\]…([\s\S]*)$/;

/**
 * A truncated identity is only legitimate when it is visibly a middle-truncation of the
 * expected store path: same head, same tail, and strictly fewer characters. This is what
 * keeps `path` from being silently mangled.
 */
function assertTruncatedIdentity(expectedPath: string, actual: string, label: string): void {
	const match = TRUNCATION_MARKER.exec(actual);
	assert.ok(match, `${label}: truncated path carries the …[truncated N chars]… marker`);
	const head = match[1] as string;
	const tail = match[2] as string;
	const expectedChars = Array.from(expectedPath);
	const headChars = Array.from(head);
	const tailChars = Array.from(tail);
	assert.equal(expectedChars.slice(0, headChars.length).join(""), head, `${label}: truncated path keeps the original head`);
	assert.equal(expectedChars.slice(expectedChars.length - tailChars.length).join(""), tail, `${label}: truncated path keeps the original tail`);
	assert.ok(headChars.length + tailChars.length < expectedChars.length, `${label}: truncation actually removes characters`);
}

/**
 * Map a notes page entry's path back to the expected store path. A non-truncated path must
 * equal it; a flagged path must be a visible middle-truncation of a legacy path that the
 * write cap could never have produced. The expected path is returned either way so the
 * pagination invariants compare like with like.
 */
function notePathIdentity(expectedPaths: readonly string[], cursor: number, label: string, page: PageJson, key: "files"): string[] {
	return (page[key] as Array<{ path: string; path_truncated?: boolean }>).map((file, index) => {
		const expectedPath = expectedPaths[cursor + index];
		assert.ok(expectedPath !== undefined, `${label} cursor=${cursor}: page returned more entries than the store holds`);
		if (file.path_truncated) {
			assert.ok(Buffer.byteLength(expectedPath, "utf8") > MAX_NOTE_PATH_BYTES, `${label} cursor=${cursor}: only a legacy path beyond the write cap may be truncated, got ${file.path}`);
			assertTruncatedIdentity(expectedPath, file.path, `${label} cursor=${cursor}`);
		} else {
			assert.equal(file.path, expectedPath, `${label} cursor=${cursor}: path is returned intact when its entry fits`);
		}
		return expectedPath;
	});
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/** Run one generated case per seed, naming the seed in any thrown failure so it reproduces alone. */
async function runSeeds(label: string, body: (seed: number) => Promise<void>): Promise<void> {
	for (const seed of SEEDS) {
		try {
			await body(seed);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`${label} failed at seed=${seed} (re-run with PI_CONTEXT_PROPERTY_SEED=${seed}): ${detail}`, { cause: error });
		}
	}
}

test("generators are deterministic: the same seed replays the same shapes", () => {
	for (const seed of SEEDS) {
		assert.deepEqual(historyPlan(seed), historyPlan(seed), `historyPlan(seed=${seed}) replays identically`);
		assert.deepEqual(notesPlan(seed), notesPlan(seed), `notesPlan(seed=${seed}) replays identically`);
	}
	assert.notDeepEqual(historyPlan(DEFAULT_SEEDS[0]), historyPlan(DEFAULT_SEEDS[1]), "different seeds generate different history shapes");
	assert.notDeepEqual(notesPlan(DEFAULT_SEEDS[0]), notesPlan(DEFAULT_SEEDS[1]), "different seeds generate different notes shapes");
	// The rare pathological shapes are reachable from the committed corpus, so the new
	// truncation paths are actually exercised by the default run rather than only in theory.
	const historyEntries = DEFAULT_SEEDS.flatMap((seed) => historyPlan(seed).entries);
	assert.ok(historyEntries.some((entry) => entry.kind === "message" && Buffer.byteLength(entry.toolName, "utf8") > TOOL_OUTPUT_MAX_BYTES), "some committed seed generates an oversized tool_name");
	const noteOps = DEFAULT_SEEDS.flatMap((seed) => notesPlan(seed).ops);
	assert.ok(noteOps.some((op) => op.kind === "entry" && typeof op.data === "object" && op.data !== null && typeof (op.data as { path?: unknown }).path === "string" && Buffer.byteLength((op.data as { path: string }).path, "utf8") > MAX_NOTE_PATH_BYTES), "some committed seed generates an oversized legacy note path");
});

test("history_list_items enumerates every item across seeded session shapes", async () => {
	console.log(`pagination property seeds: ${SEEDS.join(", ")}`);
	await runSeeds("history_list_items", async (seed) => {
		const plan = historyPlan(seed);
		const session = manager();
		const captured = makeExtension(session);
		const ctx = context(session);
		materializeHistory(session, plan);
		const windows = historyFromSession(ctx);
		assert.equal(windows.length, plan.windowCount, `seed=${seed}: generated ${plan.windowCount} windows`);
		for (const variant of plan.list) {
			const params = historyParams(ctx, variant);
			const expected = storeHistoryItems(ctx, params).map((item) => item.itemId);
			await walkPages({
				captured, ctx, tool: "history_list_items", params,
				idsOf: (page) => (page.items as Array<{ item_id: string }>).map((item) => item.item_id),
				expected,
				label: `history_list_items seed=${seed} ${variant.label} windowIndex=${variant.windowIndex} role=${variant.role} tool_name=${variant.toolName} recent_first=${variant.recentFirst} limit=${variant.limit} max_chars_per_item=${variant.maxCharsPerItem}`,
			});
		}
	});
});

test("history_search_contents enumerates every match across seeded session shapes", async () => {
	await runSeeds("history_search_contents", async (seed) => {
		const plan = historyPlan(seed);
		const session = manager();
		const captured = makeExtension(session);
		const ctx = context(session);
		materializeHistory(session, plan);
		for (const variant of plan.search) {
			const params = { ...historyParams(ctx, variant), query: variant.query ?? "" };
			const expected = storeHistoryItems(ctx, params).filter((item) => item.content.includes(params.query)).map((item) => item.itemId);
			await walkPages({
				captured, ctx, tool: "history_search_contents", params,
				idsOf: (page) => (page.items as Array<{ item_id: string }>).map((item) => item.item_id),
				expected,
				label: `history_search_contents seed=${seed} ${variant.label} query=${JSON.stringify(params.query)} windowIndex=${variant.windowIndex} role=${variant.role} tool_name=${variant.toolName} recent_first=${variant.recentFirst} limit=${variant.limit} max_chars_per_item=${variant.maxCharsPerItem}`,
			});
		}
	});
});

test("notes_list_files enumerates every note file across seeded mixes", async () => {
	await runSeeds("notes_list_files", async (seed) => {
		const plan = notesPlan(seed);
		const session = manager();
		const captured = makeExtension(session);
		const ctx = context(session);
		await materializeNotes(plan, captured, ctx, session);
		for (const variant of plan.list) {
			const params = { pattern: variant.pattern, max_results: variant.maxResults, file_order_by: variant.orderBy, file_order: variant.order };
			const expected = expectedNoteOrder(ctx, variant).map((file) => file.path);
			const label = `notes_list_files seed=${seed} ${variant.label} pattern=${JSON.stringify(variant.pattern)} order_by=${variant.orderBy} order=${variant.order} max_results=${variant.maxResults}`;
			const pages = await walkPages({
				captured, ctx, tool: "notes_list_files", params,
				idsOf: (page, cursor) => notePathIdentity(expected, cursor, label, page, "files"),
				expected,
				label,
			});
			// Each listed file must describe the store's file exactly, not a stale or invented one.
			let flat = 0;
			for (const page of pages) {
				for (const file of page.files as Array<{ path: string; path_truncated?: boolean; size_bytes: number; stale: boolean; created_at: string; updated_at: string }>) {
					const storePath = expected[flat++]!;
					const store = notesFromSession(ctx).get(storePath);
					assert.ok(store, `${label}: listed ${storePath} is not in the note store`);
					assert.equal(file.size_bytes, Buffer.byteLength(store.text, "utf8"), `${label}: size_bytes for ${storePath}`);
					assert.equal(file.stale, store.stale, `${label}: stale for ${storePath}`);
					assert.equal(Date.parse(file.created_at), store.createdAt, `${label}: created_at for ${storePath}`);
					assert.equal(Date.parse(file.updated_at), store.updatedAt, `${label}: updated_at for ${storePath}`);
				}
			}
		}
	});
});

test("notes_search_contents enumerates every matching file across seeded mixes", async () => {
	await runSeeds("notes_search_contents", async (seed) => {
		const plan = notesPlan(seed);
		const session = manager();
		const captured = makeExtension(session);
		const ctx = context(session);
		await materializeNotes(plan, captured, ctx, session);
		for (const variant of plan.search) {
			const params = { query: variant.query, path_prefix: variant.prefix, max_files: variant.maxFiles, max_matches_per_file: variant.maxMatchesPerFile, recent_file_first: variant.recentFileFirst };
			const expected = expectedSearchOrder(ctx, variant).map((file) => file.path);
			const label = `notes_search_contents seed=${seed} ${variant.label} query=${JSON.stringify(variant.query)} prefix=${JSON.stringify(variant.prefix)} max_files=${variant.maxFiles} max_matches_per_file=${variant.maxMatchesPerFile} recent_file_first=${variant.recentFileFirst}`;
			const pages = await walkPages({
				captured, ctx, tool: "notes_search_contents", params,
				idsOf: (page, cursor) => notePathIdentity(expected, cursor, label, page, "files"),
				expected,
				label,
			});
			// Matches are a prefix of the file's real matching lines (never invented, never reordered).
			let flat = 0;
			for (const page of pages) {
				for (const file of page.files as Array<{ path: string; path_truncated?: boolean; matches: Array<{ line: number; text: string; offset_chars: number }> }>) {
					const storePath = expected[flat++]!;
					const store = notesFromSession(ctx).get(storePath);
					assert.ok(store, `${label}: reported ${storePath} is not in the note store`);
					const lines = store.text.split("\n");
					const matchingLines = lines.flatMap((line, index) => line.includes(variant.query) ? [index + 1] : []);
					assert.ok(file.matches.length >= 1, `${label}: ${storePath} reports no matches but appears in the result`);
					assert.ok(file.matches.length <= Math.min(matchingLines.length, variant.maxMatchesPerFile), `${label}: ${storePath} reports ${file.matches.length} matches beyond its cap`);
					assert.deepEqual(file.matches.map((match) => match.line), matchingLines.slice(0, file.matches.length), `${label}: ${storePath} match lines are not the first matching lines`);
					const lineBase: number[] = [];
					let lineOffset = 0;
					for (const text of lines) {
						lineBase.push(lineOffset);
						lineOffset += Array.from(text).length + 1;
					}
					for (const match of file.matches) {
						const line = lines[match.line - 1]!;
						assert.ok(line.includes(variant.query), `${label}: ${storePath}:${match.line} does not contain the query`);
						// The documented address: file-absolute code points up to the line, plus the query's
						// earliest occurrence inside it -- so notes_read_file at offset_chars shows the query.
						const earliest = line.indexOf(variant.query);
						assert.equal(match.offset_chars, (lineBase[match.line - 1] as number) + Array.from(line.slice(0, earliest)).length, `${label}: ${storePath}:${match.line} offset_chars does not address the query`);
					}
				}
			}
		}
	});
});
