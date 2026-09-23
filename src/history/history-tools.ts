import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { output, outputRaw, middleTruncate, prefixFit, earliestMatchOffsetChars, readCharacterWindow, readWindowBlock, withinBudget, withinTextBudget, DEFAULT_READ_WINDOW_CHARS, HISTORY_PREVIEW_CHARS, MAX_READ_WINDOW_CHARS } from "../tool-output.js";
import { historyRoles, searchQuery, searchQueries } from "../tool-schema.js";
import { allItems, filteredItems, historyFromSession, type HistoryFilter, type HistoryItem, type HistoryProjection, unknownWindowId, validateHistoryFilters, visibleItem } from "./history.js";

const SEQ_DESCRIPTION = "Items are ascending by seq. A seq is an item's fixed position in this session and never changes while the session lives; a fork starts a new session and renumbers. Compare seq values to tell which item came first. Page with before or after using a seq from the page. created_at is metadata only.";
const ROLE_DESCRIPTION = "Exactly six roles: user is a human turn; assistant is visible model text; tool_call is one invocation with JSON arguments; tool is one result; system is a native compaction or branch summary; developer is any message injected by an extension, including every custom_message. custom_type identifies developer messages.";

type VisibleItem = ReturnType<typeof visibleItem>;
type FoldedRow = { folded: true; first_seq: number; last_seq: number; count: number; tools: Record<string, number>; custom_types: Record<string, number> };
type RenderedItem = VisibleItem | FoldedRow;
type Candidate = { item: HistoryItem; matchOffset?: number; preview?: VisibleItem };
type AnchorParams = { before?: number; after?: number; around?: number; limit?: number; max_chars_per_item?: number };
type PageResponse = { items: RenderedItem[]; has_older: boolean; has_newer: boolean };

/** Shrink a single page item to fit the fully rendered response. */
function truncateHistoryItem<T extends { truncated_content: string; truncated: boolean; tool_name: string | null }>(item: T, fits: (candidate: T) => boolean): T {
	if (fits(item)) return item;
	const shrinkContent = (base: T): T => ({
		...base,
		truncated: true,
		truncated_content: prefixFit(base.truncated_content, (candidate) => fits({ ...base, truncated: true, truncated_content: candidate } as T)),
	});
	const withContent = shrinkContent(item);
	if (fits(withContent)) return withContent;
	if (item.tool_name === null) return withContent;
	const withName = { ...item, tool_name: middleTruncate(item.tool_name, (candidate) => fits({ ...item, tool_name: candidate } as T)) } as T;
	if (fits(withName)) return withName;
	return shrinkContent(withName);
}

function isConversationItem(item: HistoryItem): boolean {
	return (item.role === "user" || item.role === "assistant" || item.role === "system") && item.content !== "";
}

function isConversationView(params: HistoryFilter): boolean {
	return !params.roles && typeof params.tool_name !== "string" && typeof params.custom_type !== "string";
}

function foldedRuns(items: HistoryItem[]): FoldedRow[] {
	if (items.length === 0) return [];
	const sorted = [...items].sort((a, b) => a.seq - b.seq);
	const tools: Record<string, number> = {};
	const customTypes: Record<string, number> = {};
	for (const item of sorted) {
		if (item.role === "tool_call") {
			const name = item.toolName ?? "unknown";
			tools[name] = (tools[name] ?? 0) + 1;
		}
		if (item.role === "developer" && item.customType !== null) customTypes[item.customType] = (customTypes[item.customType] ?? 0) + 1;
	}
	return [{ folded: true, first_seq: sorted[0]!.seq, last_seq: sorted.at(-1)!.seq, count: sorted.length, tools, custom_types: customTypes }];
}

function pageEdges(vis: HistoryItem[], selected: HistoryItem[], anchor: number | undefined): { has_older: boolean; has_newer: boolean } {
	if (selected.length === 0) {
		if (anchor === undefined) return { has_older: false, has_newer: false };
		return { has_older: vis.some((item) => item.seq < anchor), has_newer: vis.some((item) => item.seq > anchor) };
	}
	const seqs = selected.map((item) => item.seq);
	const first = Math.min(...seqs);
	const last = Math.max(...seqs);
	return { has_older: vis.some((item) => item.seq < first), has_newer: vis.some((item) => item.seq > last) };
}

function foldRows(projection: HistoryProjection, params: HistoryFilter, vis: HistoryItem[], selected: HistoryItem[], edges: { has_older: boolean; has_newer: boolean }): FoldedRow[] {
	if (selected.length === 0) {
		// If the conversation has no visible messages at all, keep its hidden run legible.
		if (vis.length === 0 && !edges.has_older && !edges.has_newer) {
			const onlyWindow = typeof params.window_id === "string" ? [params.window_id] : undefined;
			const hidden = allItems(projection).filter((item) => (!onlyWindow || onlyWindow.includes(item.windowId)) && !isConversationItem(item));
			return foldedRuns(hidden);
		}
		return [];
	}
	const windowItems = allItems(projection)
		.filter((item) => typeof params.window_id !== "string" || item.windowId === params.window_id)
		.sort((a, b) => a.seq - b.seq);
	const folded: FoldedRow[] = [];
	const firstSeq = Math.min(...selected.map((item) => item.seq));
	const lastSeq = Math.max(...selected.map((item) => item.seq));
	if (!edges.has_older) folded.push(...foldedRuns(windowItems.filter((item) => item.seq < firstSeq && !isConversationItem(item))));
	const orderedSelected = [...selected].sort((a, b) => a.seq - b.seq);
	for (let i = 0; i + 1 < orderedSelected.length; i++) {
		const left = orderedSelected[i]!.seq;
		const right = orderedSelected[i + 1]!.seq;
		folded.push(...foldedRuns(windowItems.filter((item) => item.seq > left && item.seq < right && !isConversationItem(item))));
	}
	if (!edges.has_newer) folded.push(...foldedRuns(windowItems.filter((item) => item.seq > lastSeq && !isConversationItem(item))));
	return folded;
}

function renderedPage(projection: HistoryProjection, params: HistoryFilter, vis: HistoryItem[], selected: Candidate[], anchor: number | undefined, maxChars: number, folds: boolean): PageResponse {
	const selectedItems = selected.map((candidate) => candidate.item).sort((a, b) => a.seq - b.seq);
	const edges = pageEdges(vis, selectedItems, anchor);
	const orderedSelected = [...selected].sort((a, b) => a.item.seq - b.item.seq);
	const visible = orderedSelected.map((candidate) => {
		const base = candidate.preview ?? visibleItem(candidate.item, maxChars);
		return candidate.matchOffset === undefined ? base : { ...base, match_offset_chars: candidate.matchOffset };
	});
	let rows: RenderedItem[] = visible;
	if (folds) {
		const folded = foldRows(projection, params, vis, selectedItems, edges);
		rows = [...visible, ...folded].sort((a, b) => ("folded" in a ? a.first_seq : a.seq) - ("folded" in b ? b.first_seq : b.seq));
	}
	return { items: rows, ...edges };
}

function orderedCandidates(vis: Candidate[], before: number | undefined, after: number | undefined, around: number | undefined, limit: number): Candidate[] {
	const ascending = [...vis].sort((a, b) => a.item.seq - b.item.seq);
	if (around !== undefined) {
		if (ascending.length === 0) return [];
		let pivot = ascending.findIndex((candidate) => candidate.item.seq >= around);
		if (pivot < 0) pivot = ascending.length - 1;
		const ordered = [ascending[pivot]!];
		for (let distance = 1; ordered.length < limit; distance++) {
			const older = ascending[pivot - distance];
			if (older) ordered.push(older);
			const newer = ascending[pivot + distance];
			if (newer) ordered.push(newer);
			if (!older && !newer) break;
		}
		return ordered.slice(0, limit);
	}
	if (after !== undefined) return ascending.filter((candidate) => candidate.item.seq > after).slice(0, limit);
	if (before !== undefined) return ascending.filter((candidate) => candidate.item.seq < before).reverse().slice(0, limit);
	return ascending.slice(-limit).reverse();
}

function selectPage(projection: HistoryProjection, params: HistoryFilter & AnchorParams, vis: Candidate[], folds: boolean): PageResponse {
	const before = params.before;
	const after = params.after;
	const around = params.around;
	const anchor = before ?? after ?? around;
	const maxChars = params.max_chars_per_item ?? HISTORY_PREVIEW_CHARS;
	const limit = params.limit ?? 20;
	const candidates = orderedCandidates(vis, before, after, around, limit);
	const allVisible = vis.map((candidate) => candidate.item).sort((a, b) => a.seq - b.seq);
	const kept: Candidate[] = [];
	for (const candidate of candidates) {
		const proposed = [...kept, candidate];
		const response = renderedPage(projection, params, allVisible, proposed, anchor, maxChars, folds);
		if (withinBudget(response)) {
			kept.push(candidate);
			continue;
		}
		if (kept.length === 0) {
			const base = visibleItem(candidate.item, maxChars);
			const shrunk = truncateHistoryItem(base, (preview) => withinBudget(renderedPage(projection, params, allVisible, [{ ...candidate, preview }], anchor, maxChars, folds)));
			kept.push({ ...candidate, preview: shrunk });
		}
		break;
	}
	return renderedPage(projection, params, allVisible, kept, anchor, maxChars, folds);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerHistoryTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "history_windows",
		label: "History list windows",
		description: "List durable Pi session-history windows, oldest first. Each window includes its seq range and item count. The session_id identifies this session; a fork creates a new session.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _update, ctx) {
			const projection = historyFromSession(ctx);
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
			return output({ session_id: ctx.sessionManager.getSessionId(), windows });
		},
	}));

	pi.registerTool(defineTool({
		name: "history_list",
		label: "History list items",
		description: `List session history in the conversation view by default: non-empty user, assistant, and system items, with hidden tool and developer runs folded into summaries. Use roles to expand selected roles, tool_name for tool calls/results, or custom_type for injected developer messages. Every item carries truncated and total_chars; resolve an item by seq with history_read. ${SEQ_DESCRIPTION} ${ROLE_DESCRIPTION}`,
		parameters: Type.Object({
			before: Type.Optional(Type.Integer({ minimum: 0, description: "Return items with seq below this number, nearest first before ascending output." })),
			after: Type.Optional(Type.Integer({ minimum: 0, description: "Return items with seq above this number, nearest first." })),
			around: Type.Optional(Type.Integer({ minimum: 0, description: "Center the page on this seq, alternating older and newer items." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum visible items; folded rows do not count." })),
			roles: historyRoles(),
			tool_name: Type.Optional(Type.String({ description: "Return only calls and results from this tool; defaults to both tool_call and tool roles." })),
			custom_type: Type.Optional(Type.String({ description: "Return only developer messages with this custom type; defaults to the developer role." })),
			window_id: Type.Optional(Type.String({ description: "Limit history to this known context window." })),
			max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum preview code points per item (default ${HISTORY_PREVIEW_CHARS}).` })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const projection = historyFromSession(ctx);
			if ([params.before, params.after, params.around].filter((value) => value !== undefined).length > 1) return output({ error: "give at most one of before, after, around" });
			const invalid = validateHistoryFilters(params);
			if (invalid) return output({ error: invalid });
			const badWindow = unknownWindowId(projection, params);
			if (badWindow) return output({ error: badWindow.message, window_id: params.window_id, known_windows: badWindow.known });
			const items = filteredItems(projection, params, "list");
			return output(selectPage(projection, params, items.map((item) => ({ item })), isConversationView(params)));
		},
	}));

	pi.registerTool(defineTool({
		name: "history_read",
		label: "History read item",
		description: "Read a bounded character range from one session item using its seq. Each response delivers the longest contiguous prefix of the requested window that fits the wire budget: follow the resume cursor to reconstruct the item exactly. A negative offset_chars counts back from the item's end. Offsets and counts are code points (an emoji or CJK character counts as one). The READ WINDOW block names seq and window_id, in that order.",
		parameters: Type.Object({
			seq: Type.Integer({ minimum: 1, description: "Stable file-order address returned by history_list or history_search." }),
			offset_chars: Type.Optional(Type.Integer({ description: "Code-point offset to start from. A negative value counts back from the end; the response echoes the resolved absolute offset. Pass the previous next_offset_chars back unchanged to continue." })),
			limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: `Largest requested window in code points (default ${DEFAULT_READ_WINDOW_CHARS}). A window too large for the wire budget is cut short; next_offset_chars names where the next read resumes.` })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const projection = historyFromSession(ctx);
			if (params.seq > projection.highestSeq) return output({ error: `unknown seq ${params.seq}: this session's items run 1..${projection.highestSeq}` });
			if (!projection.branchSeqs.has(params.seq)) return output({ error: `seq ${params.seq} is on another branch and is not readable here` });
			const item = allItems(projection).find((candidate) => candidate.seq === params.seq);
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
	}));

	pi.registerTool(defineTool({
		name: "history_search",
		label: "History search",
		description: `Case-sensitive literal substring search over durable Pi session history; query accepts one string or an array of strings, an item matches when it contains any of them (OR), and each item appears once. Search defaults to every role because a query already narrows the set. No semantic search. Each hit carries truncated, total_chars, and match_offset_chars; resolve an address with history_read at that offset. ${SEQ_DESCRIPTION} ${ROLE_DESCRIPTION}`,
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ minimum: 1 })),
			before: Type.Optional(Type.Integer({ minimum: 0, description: "Return hits with seq below this number." })),
			after: Type.Optional(Type.Integer({ minimum: 0, description: "Return hits with seq above this number." })),
			query: searchQuery(),
			roles: historyRoles(),
			tool_name: Type.Optional(Type.String()),
			custom_type: Type.Optional(Type.String()),
			window_id: Type.Optional(Type.String()),
			max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1 })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const projection = historyFromSession(ctx);
			if (params.before !== undefined && params.after !== undefined) return output({ error: "give at most one of before, after" });
			const invalid = validateHistoryFilters(params);
			if (invalid) return output({ error: invalid });
			const badWindow = unknownWindowId(projection, params);
			if (badWindow) return output({ error: badWindow.message, window_id: params.window_id, known_windows: badWindow.known });
			let queries: string[];
			try {
				queries = searchQueries(params.query);
			} catch (error) {
				return output({ error: errorText(error) });
			}
			const matches = filteredItems(projection, params, "search")
				.filter((item) => queries.some((query) => item.content.includes(query)))
				.map((item) => ({ item, matchOffset: earliestMatchOffsetChars(item.content, queries) }));
			return output(selectPage(projection, params, matches, false));
		},
	}));
}
