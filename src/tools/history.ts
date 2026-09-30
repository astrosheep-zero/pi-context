import { selectPage, isConversationView } from "../history/query.js";
import { Type, type Static } from "typebox";
import { output, outputRaw, earliestMatchOffsetChars, readCharacterWindow, readWindowBlock, withinTextBudget, DEFAULT_READ_WINDOW_CHARS, HISTORY_PREVIEW_CHARS, MAX_READ_WINDOW_CHARS } from "./output.js";
import { historyRoles, searchQuery, searchQueries } from "./schema.js";
import { allItems, filteredItems, type HistoryProjection, unknownWindowId } from "../history/history.js";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const historyWindowsParameters = Type.Object({}, { additionalProperties: false });

export const historyWindows = {
	name: "history_windows",
	label: "History list windows",
	description: "List durable Pi session-history windows, oldest first. Each window includes its seq range and item count. The session_id identifies this session; a fork creates a new session.",
	parameters: historyWindowsParameters,
	async execute(params: Static<typeof historyWindowsParameters>, projection: HistoryProjection, sessionId: string) {
		const windows = projection.windows.map((window) => {
			const seqs = window.items.map((item) => item.seq);
			return {
				window_id: window.windowId,
				created_at: window.createdAt ?? null,
				first_seq: seqs.length > 0 ? Math.min(...seqs) : null,
				last_seq: seqs.length > 0 ? Math.max(...seqs) : null,
				item_count: window.items.length,
			};
		});
		return output({ session_id: sessionId, windows });
	},
} as const;

export const historyListParameters = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum visible items returned; folded context rows are extra and do not count." })),
	roles: historyRoles(),
	before: Type.Optional(Type.Integer({ minimum: 1, description: "Return one older page with seq below this value. Pass older_before from the response. For a bounded range, repeat the same call and keep after unchanged." })),
	after: Type.Optional(Type.Integer({ minimum: 1, description: "Return one newer page with seq above this value. Pass newer_after from the response. For a bounded range, repeat the same call and keep before unchanged." })),
	window_id: Type.Optional(Type.String({ minLength: 1, description: "Limit to one context window; values come from history_windows or any item." })),
	max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum preview characters per item; use history_read for full content (default ${HISTORY_PREVIEW_CHARS}).` })),
}, { additionalProperties: false });

export const historyList = {
	name: "history_list",
	label: "History list items",
	description: "List the newest session events, oldest first within the page. Roles: user, assistant, tool (one call with its result), context (summaries and injected messages). By default shows user and assistant, with tool and context runs folded. Pass older_before as before to page back; use history_read with seq for full text.",
	parameters: historyListParameters,
	async execute(params: Static<typeof historyListParameters>, projection: HistoryProjection) {
		const badWindow = unknownWindowId(projection, params);
		if (badWindow) return output({ error: badWindow.message, window_id: params.window_id, known_windows: badWindow.known });
		const items = filteredItems(projection, params, "list");
		return output(selectPage(projection, params, items.map((item) => ({ item })), isConversationView(params)));
	},
} as const;

export const historyReadParameters = Type.Object({
	seq: Type.Integer({ minimum: 1, description: "Stable file-order address returned by history_list or history_search." }),
	offset_chars: Type.Optional(Type.Integer({ description: "Code-point offset to start from. A negative value counts back from the end; the response echoes the resolved absolute offset. Pass the previous next_offset_chars back unchanged to continue." })),
	limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: `Largest requested window in code points (default ${DEFAULT_READ_WINDOW_CHARS}). A window too large for the wire budget is cut short; next_offset_chars names where the next read resumes.` })),
}, { additionalProperties: false });

export const historyRead = {
	name: "history_read",
	label: "History read item",
	description: `Read one event's full text by seq, default ${DEFAULT_READ_WINDOW_CHARS} characters from offset_chars. A negative offset_chars counts back from the end. To continue, pass next_offset_chars as offset_chars.`,
	parameters: historyReadParameters,
	async execute(params: Static<typeof historyReadParameters>, projection: HistoryProjection) {
		if (params.seq > projection.highestSeq) return output({ error: `unknown seq ${params.seq}: this session's items run 1..${projection.highestSeq}` });
		if (!projection.branchSeqs.has(params.seq)) return output({ error: `seq ${params.seq} is on another branch and is not readable here` });
		const resolvedSeq = projection.resultAliases.get(params.seq) ?? params.seq;
		const item = allItems(projection).find((candidate) => candidate.seq === resolvedSeq);
		if (!item) return output({ error: `seq ${params.seq} is on another branch and is not readable here` });
		const totalChars = Array.from(item.content).length;
		if (typeof params.offset_chars === "number" && params.offset_chars > totalChars) {
			return output({ error: `offset_chars ${params.offset_chars} is past the end: the item has ${totalChars} chars; the largest legal offset is ${totalChars} (an empty end-read)`, seq: item.seq, window_id: item.windowId, offset_chars: params.offset_chars, total_chars: totalChars });
		}
		return readCharacterWindow(item.content, params.offset_chars, params.limit_chars, (window) => {
			const { content, ...cursor } = window;
			return outputRaw(readWindowBlock([["seq", String(item.seq)], ["window_id", item.windowId]], window), content, { seq: item.seq, window_id: item.windowId, ...cursor });
		}, (result) => withinTextBudget(result.content[0].text));
	},
} as const;

export const historySearchParameters = Type.Object({
	query: searchQuery(),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum matching items returned." })),
	roles: historyRoles(),
	before: Type.Optional(Type.Integer({ minimum: 1, description: "Return older hits with seq below this value. Pass older_before from the response. For a bounded range, repeat the same call and keep after unchanged." })),
	after: Type.Optional(Type.Integer({ minimum: 1, description: "Return newer hits with seq above this value. Pass newer_after from the response. For a bounded range, repeat the same call and keep before unchanged." })),
	window_id: Type.Optional(Type.String({ minLength: 1, description: "Limit to one context window; values come from history_windows or any item." })),
	max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum preview characters per item; use history_read for full content (default ${HISTORY_PREVIEW_CHARS}).` })),
}, { additionalProperties: false });

export const historySearch = {
	name: "history_search",
	label: "History search",
	description: "Case-insensitive substring search over session events; query is one string or several (OR). Searches all four roles by default. Tool events are searchable by tool name, arguments, and output. Pass seq and offset_chars to history_read to read from the match. Continue with older_before / newer_after.",
	parameters: historySearchParameters,
	async execute(params: Static<typeof historySearchParameters>, projection: HistoryProjection) {
		const badWindow = unknownWindowId(projection, params);
		if (badWindow) return output({ error: badWindow.message, window_id: params.window_id, known_windows: badWindow.known });
		let queries: string[];
		try {
			queries = searchQueries(params.query);
		} catch (error) {
			return output({ error: errorText(error) });
		}
		const matches = filteredItems(projection, params, "search")
			.map((item) => ({ item, matchOffset: earliestMatchOffsetChars(item.content, queries) }))
			.filter((candidate) => candidate.matchOffset >= 0);
		return output(selectPage(projection, params, matches, false));
	},
} as const;
