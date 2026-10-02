/** Host-neutral history operations: one bounded payload for text and structured results. */
import { Type, type Static } from "typebox";
import { DEFAULT_READ_WINDOW_CHARS, MAX_READ_WINDOW_CHARS, earliestMatchOffsetChars, HISTORY_PREVIEW_CHARS } from "./output.js";
import { failure, fitsResult, outcomeSchema, readTextWindow, renderOutcome, renderTextWindow, success, TextWindowSchema, type Operation, type Outcome } from "./result.js";
import { historyRoles, InvalidQueryError, searchQueries, searchQuery } from "./schema.js";
import { HistoryPageSchema, isConversationView, selectPage, type HistoryPage } from "../history/query.js";
import { allItems, eventDocument, executionMetadata, filteredItems, HistoryRoleSchema, ToolExecutionSchema, type HistoryFilter, type HistoryFoldedRow, type HistoryPageItem, type HistoryProjection, unknownWindowId } from "../history/history.js";

const HistoryWindowsDataSchema = Type.Object({
	session_id: Type.String({ description: "The session these addresses belong to; a fork creates a new session." }),
	windows: Type.Array(Type.Object({
		window_id: Type.String(),
		created_at: Type.Union([Type.String(), Type.Null()]),
		first_seq: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
		last_seq: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
		item_count: Type.Integer({ minimum: 0 }),
	}, { additionalProperties: false }), { description: "Oldest first." }),
	more: Type.Integer({ minimum: 0, description: "Windows omitted by the response budget. This is a snapshot; history_list also reports window ids on events." }),
}, { additionalProperties: false });
type HistoryWindowsData = Static<typeof HistoryWindowsDataSchema>;

/** One read: identity, typed tool metadata, and a window of the document. Never a second copy of the output text. */
const HistoryReadDataSchema = Type.Object({
	seq: Type.Integer({ minimum: 1 }),
	window_id: Type.String(),
	role: HistoryRoleSchema,
	created_at: Type.Union([Type.String(), Type.Null()]),
	execution: Type.Optional(ToolExecutionSchema),
	window: TextWindowSchema,
}, { additionalProperties: false });
type HistoryReadData = Static<typeof HistoryReadDataSchema>;

/* ------------------------------------------------------------------ rendering */

function header(item: { seq: number; window_id: string; role: string }): string {
	return `seq ${item.seq} | window ${item.window_id} | ${item.role}`;
}

function toolHeader(item: HistoryPageItem): string | undefined {
	if (item.role !== "tool") return undefined;
	const parts = [item.tool_name_omitted ? "tool name omitted" : `tool ${item.tool}`, `status ${item.tool_status}`];
	if (item.output_truncated) parts.push(`output truncated${item.full_output_path ? `, full text at ${item.full_output_path}` : ""}`);
	if (item.nested_calls) {
		parts.push(`nested calls ${item.nested_calls.call_count} recorded, ${item.nested_calls.complete ? "complete" : "incomplete"}`);
	}
	return parts.join(" | ");
}

function renderPageItem(item: HistoryPageItem): string {
	const tool = toolHeader(item);
	const lines = tool === undefined ? [header(item)] : [header(item), tool];
	if (item.truncated) lines.push(`[preview of ${item.total_chars} chars from offset ${item.offset_chars ?? 0}; read this seq for the rest]`);
	lines.push(item.content);
	return lines.join("\n");
}

function isFoldedRow(item: HistoryPageItem | HistoryFoldedRow): item is HistoryFoldedRow {
	return "folded" in item;
}

function renderFoldedRow(row: HistoryFoldedRow): string {
	const tools = Object.entries(row.tools).map(([name, count]) => `${name} ${count}`).join(", ");
	const omitted = row.omitted_tools ? ` | ${row.omitted_tools} distinct tool names omitted` : "";
	return `seqs ${row.first_seq}-${row.last_seq} | folded ${row.count} events${tools ? ` | ${tools}` : ""}${omitted}`;
}

function renderPage(page: HistoryPage): string {
	// An empty selection has no anchors either, so it would otherwise render as nothing at all.
	if (page.items.length === 0) return "no events match this selection";
	const body = page.items.map((item) => (isFoldedRow(item) ? renderFoldedRow(item) : renderPageItem(item))).join("\n\n");
	const cursors = [
		page.older_before === null ? "" : `older_before ${page.older_before}`,
		page.newer_after === null ? "" : `newer_after ${page.newer_after}`,
	].filter((line) => line !== "");
	return cursors.length === 0 ? body : `${body}\n\n${cursors.join(" | ")}`;
}

function renderRead(data: HistoryReadData): string {
	const lines = [header(data)];
	if (data.execution) {
		const execution = data.execution;
		lines.push(`tool ${execution.name} | status ${execution.status}`);
		if (execution.argumentsBytes !== undefined) lines.push(`arguments omitted: ${execution.argumentsBytes} bytes; read the window for them`);
		if (execution.outputTruncated) lines.push(`output truncated${execution.fullOutputPath ? `, full text at ${execution.fullOutputPath}` : ""}`);
		if (execution.nestedCalls) {
			const nested = execution.nestedCalls;
			const withheld = nested.trimmed === true ? `, ${nested.omittedCalls ?? 0} more omitted` : "";
			lines.push(`nested calls ${nested.calls.length} recorded, ${nested.complete ? "complete" : "incomplete"}${withheld}`);
			for (const call of nested.calls) {
				const facts = [`  ${call.id} ${call.name} [${call.status}]`];
				if (call.durationMs !== undefined) facts.push(`${call.durationMs}ms`);
				if (call.argumentsBytes !== undefined) facts.push(`arguments omitted: ${call.argumentsBytes} bytes`);
				if (call.error !== undefined) facts.push(`error: ${call.error}`);
				lines.push(facts.join(" "));
			}
		}
	}
	lines.push("", renderTextWindow(data.window));
	return lines.join("\n");
}

/* ------------------------------------------------------------------ shared bounding */

/** Include rendering and cursors in the budget, not just row contents. */
function pageFits(page: HistoryPage): boolean {
	return fitsResult(success(page), (result) => renderOutcome(result, renderPage));
}

// Sample known ids on errors without turning the refusal into a second listing.
const MAX_REPORTED_WINDOWS = 25;

function badWindowId(projection: HistoryProjection, params: HistoryFilter): Outcome<never> | undefined {
	const badWindow = unknownWindowId(projection, params);
	if (!badWindow) return undefined;
	const known = badWindow.known;
	return failure("unknown_window_id", badWindow.message, {
		window_id: params.window_id,
		known_windows: known.slice(0, MAX_REPORTED_WINDOWS),
		...(known.length > MAX_REPORTED_WINDOWS ? { known_windows_omitted: known.length - MAX_REPORTED_WINDOWS } : {}),
	});
}

/* ------------------------------------------------------------------ history_windows */

export const historyWindowsParameters = Type.Object({}, { additionalProperties: false });

export const historyWindows: Operation<typeof historyWindowsParameters, HistoryWindowsData, [HistoryProjection, string]> = {
	name: "history_windows",
	label: "History list windows",
	description: "List durable Pi session-history windows, oldest first. Each window includes its seq range and item count. The session_id identifies this session; a fork creates a new session.",
	parameters: historyWindowsParameters,
	outputSchema: outcomeSchema(HistoryWindowsDataSchema),
	async execute(_params, projection, sessionId) {
		const data: HistoryWindowsData = { session_id: sessionId, windows: [], more: projection.windows.length };
		const fits = (candidate: HistoryWindowsData) => fitsResult(success(candidate), (result) => renderOutcome(result, renderWindows));
		for (const window of projection.windows) {
			let first: number | null = null;
			let last: number | null = null;
			for (const event of window.items) {
				first = first === null ? event.seq : Math.min(first, event.seq);
				last = last === null ? event.seq : Math.max(last, event.seq);
			}
			const row = { window_id: window.windowId, created_at: window.createdAt ?? null, first_seq: first, last_seq: last, item_count: window.items.length };
			if (!fits({ ...data, windows: [...data.windows, row], more: data.more - 1 })) break;
			data.windows.push(row);
			data.more--;
		}
		return fits(data) ? success(data) : failure("output_too_large", "The session identity does not fit one history_windows response.");
	},
	render: (result) => renderOutcome(result, renderWindows),
};

function renderWindows(data: HistoryWindowsData): string {
	const lines = [`session ${data.session_id}`, ...data.windows.map((window) => `window ${window.window_id} | seqs ${window.first_seq ?? "-"}-${window.last_seq ?? "-"} | ${window.item_count} events`)];
	if (data.more > 0) lines.push(`${data.more} more windows not shown; history_list also reports window ids on events`);
	return lines.join("\n");
}

/* ------------------------------------------------------------------ history_list */

export const historyListParameters = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum visible items returned; folded context rows are extra and do not count." })),
	roles: historyRoles(),
	before: Type.Optional(Type.Integer({ minimum: 1, description: "Return one older page with seq below this value. Pass older_before from the response. For a bounded range, repeat the same call and keep after unchanged." })),
	after: Type.Optional(Type.Integer({ minimum: 1, description: "Return one newer page with seq above this value. Pass newer_after from the response. For a bounded range, repeat the same call and keep before unchanged." })),
	window_id: Type.Optional(Type.String({ minLength: 1, description: "Limit to one context window; values come from history_windows or any item." })),
	max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum preview characters per item; use history_read for full content (default ${HISTORY_PREVIEW_CHARS}).` })),
}, { additionalProperties: false });

export const historyList: Operation<typeof historyListParameters, HistoryPage, [HistoryProjection]> = {
	name: "history_list",
	label: "History list items",
	description: "List the newest session events, oldest first within the page. Roles: user, assistant, tool (one call with its result), context (summaries and injected messages). Tool rows carry the tool name, its outcome status, and how many nested calls it made. By default shows user and assistant, with tool and context runs folded. Pass older_before as before to page back; use history_read with seq for full text.",
	parameters: historyListParameters,
	outputSchema: outcomeSchema(HistoryPageSchema),
	async execute(params, projection) {
		const badWindow = badWindowId(projection, params);
		if (badWindow) return badWindow;
		const items = filteredItems(projection, params, "list");
		return selectPage(projection, params, items.map((event) => ({ event })), isConversationView(params), pageFits, params.max_chars_per_item ?? HISTORY_PREVIEW_CHARS);
	},
	render: (result) => renderOutcome(result, renderPage),
};

/* ------------------------------------------------------------------ history_read */

export const historyReadParameters = Type.Object({
	seq: Type.Integer({ minimum: 1, description: "Stable file-order address returned by history_list or history_search." }),
	offset_chars: Type.Optional(Type.Integer({ description: "Code-point offset to start from. A negative value counts back from the end; the response echoes the resolved absolute offset. Pass the previous next_offset_chars back unchanged to continue." })),
	limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: `Largest requested window in code points (default ${DEFAULT_READ_WINDOW_CHARS}). A window too large for the wire budget is cut short; next_offset_chars names where the next read resumes.` })),
}, { additionalProperties: false });

export const historyRead: Operation<typeof historyReadParameters, HistoryReadData, [HistoryProjection]> = {
	name: "history_read",
	label: "History read item",
	description: `Read one event by seq: default ${DEFAULT_READ_WINDOW_CHARS} characters of its document from offset_chars, plus that event's typed metadata. A tool event reports its name, arguments, outcome status, and nested-call records; its output text is the window itself. A negative offset_chars counts back from the end. To continue, pass next_offset_chars as offset_chars.`,
	parameters: historyReadParameters,
	outputSchema: outcomeSchema(HistoryReadDataSchema),
	async execute(params, projection) {
		const item = allItems(projection).find((event) => event.seq === params.seq);
		// Address checks run in one order: past the end of the file, off this branch, then
		// consumed by a pairing. Only the last two can mention what is at the address.
		if (item === undefined && params.seq > projection.highestSeq) {
			return failure("unknown_seq", `unknown seq ${params.seq}: this session's items run 1..${projection.highestSeq}`, { seq: params.seq, highest_seq: projection.highestSeq });
		}
		if (!projection.branchSeqs.has(params.seq)) {
			return failure("not_on_branch", `seq ${params.seq} is on another branch and is not readable here`, { seq: params.seq });
		}
		if (item === undefined) {
			const callSeq = projection.pairedResults.get(params.seq);
			if (callSeq !== undefined) {
				return failure("not_an_event", `seq ${params.seq} is a tool result already shown inside the call at seq ${callSeq}; read that seq instead`, { seq: params.seq, read_seq: callSeq });
			}
			return failure("unknown_seq", `seq ${params.seq} is on this branch but carries no readable event`, { seq: params.seq });
		}
		const document = eventDocument(item);
		const totalChars = Array.from(document).length;
		if (typeof params.offset_chars === "number" && params.offset_chars > totalChars) {
			return failure("invalid_offset", `offset_chars ${params.offset_chars} is past the end: the item has ${totalChars} chars; the largest legal offset is ${totalChars} (an empty end-read)`, { seq: item.seq, window_id: item.windowId, offset_chars: params.offset_chars, total_chars: totalChars });
		}
		const metadata = executionMetadata(item);
		return readTextWindow(
			document,
			params.offset_chars,
			params.limit_chars,
			(window) => ({
				seq: item.seq,
				window_id: item.windowId,
				role: item.role,
				created_at: item.createdAt ?? null,
				...(metadata ? { execution: metadata } : {}),
				window,
			}),
			(result) => renderOutcome(result, renderRead),
		);
	},
	render: (result) => renderOutcome(result, renderRead),
};

/* ------------------------------------------------------------------ history_search */

export const historySearchParameters = Type.Object({
	query: searchQuery(),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum matching items returned." })),
	roles: historyRoles(),
	before: Type.Optional(Type.Integer({ minimum: 1, description: "Return older hits with seq below this value. Pass older_before from the response. For a bounded range, repeat the same call and keep after unchanged." })),
	after: Type.Optional(Type.Integer({ minimum: 1, description: "Return newer hits with seq above this value. Pass newer_after from the response. For a bounded range, repeat the same call and keep before unchanged." })),
	window_id: Type.Optional(Type.String({ minLength: 1, description: "Limit to one context window; values come from history_windows or any item." })),
	max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum preview characters per item; use history_read for full content (default ${HISTORY_PREVIEW_CHARS}).` })),
}, { additionalProperties: false });

export const historySearch: Operation<typeof historySearchParameters, HistoryPage, [HistoryProjection]> = {
	name: "history_search",
	label: "History search",
	description: "Case-insensitive substring search over session events; query is one string or several (OR). Searches all four roles by default. Tool events are searchable by tool name, arguments, output, and nested-call evidence. offset_chars addresses the event's document, which is exactly what history_read returns. Continue with older_before / newer_after.",
	parameters: historySearchParameters,
	outputSchema: outcomeSchema(HistoryPageSchema),
	async execute(params, projection) {
		const badWindow = badWindowId(projection, params);
		if (badWindow) return badWindow;
		let queries: string[];
		try {
			queries = searchQueries(params.query);
		} catch (error) {
			if (error instanceof InvalidQueryError) return failure("invalid_query", error.message);
			throw error;
		}
		const matches = filteredItems(projection, params, "search")
			.map((event) => ({ event, matchOffset: earliestMatchOffsetChars(eventDocument(event), queries) }))
			.filter((candidate) => candidate.matchOffset >= 0);
		return selectPage(projection, params, matches, false, pageFits, params.max_chars_per_item ?? HISTORY_PREVIEW_CHARS);
	},
	render: (result) => renderOutcome(result, renderPage),
};