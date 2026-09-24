import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { output, outputRaw, middleTruncate, prefixFit, earliestMatchOffsetChars, readCharacterWindow, readWindowBlock, withinBudget, withinTextBudget, DEFAULT_READ_WINDOW_CHARS, HISTORY_PREVIEW_CHARS, MAX_READ_WINDOW_CHARS } from "../tool-output.js";
import { historyRoles, searchQuery, searchQueries } from "../tool-schema.js";
import { allItems, filteredItems, historyFromSession, type HistoryEvent, type HistoryFilter, type HistoryProjection, unknownWindowId, visibleItem } from "./history.js";

type VisibleItem = ReturnType<typeof visibleItem>;
type FoldedRow = { folded: true; first_seq: number; last_seq: number; count: number; tools: Record<string, number> };
type RenderedItem = VisibleItem | FoldedRow;
type Candidate = { item: HistoryEvent; matchOffset?: number; preview?: VisibleItem };
type AnchorParams = { before?: number; after?: number; limit?: number; max_chars_per_item?: number };
type PageResponse = { items: RenderedItem[]; older_before: number | null; newer_after: number | null };

/** Shrink a single page item to fit the fully rendered response. */
function truncateHistoryItem<T extends { content: string; truncated: boolean; tool?: string }>(item: T, fits: (candidate: T) => boolean): T {
	if (fits(item)) return item;
	const shrinkContent = (base: T): T => ({
		...base,
		truncated: true,
		content: prefixFit(base.content, (candidate) => fits({ ...base, truncated: true, content: candidate } as T)),
	});
	const withContent = shrinkContent(item);
	if (fits(withContent)) return withContent;
	if (item.tool === undefined) return withContent;
	const withName = { ...item, tool: middleTruncate(item.tool, (candidate) => fits({ ...item, tool: candidate } as T)) } as T;
	if (fits(withName)) return withName;
	return shrinkContent(withName);
}

function isFoldableEvent(item: HistoryEvent): boolean {
	return item.role === "tool" || item.role === "context";
}

function isConversationView(params: HistoryFilter): boolean {
	return !params.roles;
}

function foldedRuns(items: HistoryEvent[]): FoldedRow[] {
	if (items.length === 0) return [];
	const sorted = [...items].sort((a, b) => a.seq - b.seq);
	const tools: Record<string, number> = {};
	for (const item of sorted) {
		if (item.role === "tool") {
			const name = item.tool ?? "unknown";
			tools[name] = (tools[name] ?? 0) + 1;
		}
	}
	return [{ folded: true, first_seq: sorted[0]!.seq, last_seq: sorted.at(-1)!.seq, count: sorted.length, tools }];
}

function pageAnchors(vis: HistoryEvent[], selected: HistoryEvent[], before: number | undefined, after: number | undefined): { older_before: number | null; newer_after: number | null } {
	if (selected.length === 0) return { older_before: null, newer_after: null };
	const lower = after ?? 0;
	const upper = before ?? Number.POSITIVE_INFINITY;
	const seqs = selected.map((item) => item.seq);
	const first = Math.min(...seqs);
	const last = Math.max(...seqs);
	return {
		older_before: vis.some((item) => item.seq > lower && item.seq < first && item.seq < upper) ? first : null,
		newer_after: vis.some((item) => item.seq > last && item.seq < upper && item.seq > lower) ? last : null,
	};
}


function foldRows(projection: HistoryProjection, params: HistoryFilter & AnchorParams, selected: HistoryEvent[], anchors: { older_before: number | null; newer_after: number | null }): FoldedRow[] {
	if (selected.length === 0) {
		// Even a range with no conversation can contain tool/context events.
		const lower = params.after ?? 0;
		const upper = params.before ?? Number.POSITIVE_INFINITY;
		const hidden = allItems(projection).filter((item) => (typeof params.window_id !== "string" || params.window_id === item.windowId) && item.seq > lower && item.seq < upper && isFoldableEvent(item));
		return foldedRuns(hidden);
	}
	const lower = params.after ?? 0;
	const upper = params.before ?? Number.POSITIVE_INFINITY;
	const windowItems = allItems(projection)
		.filter((item) => (typeof params.window_id !== "string" || item.windowId === params.window_id) && item.seq > lower && item.seq < upper)
		.sort((a, b) => a.seq - b.seq);
	const folded: FoldedRow[] = [];
	const firstSeq = Math.min(...selected.map((item) => item.seq));
	const lastSeq = Math.max(...selected.map((item) => item.seq));
	if (anchors.older_before === null) folded.push(...foldedRuns(windowItems.filter((item) => item.seq < firstSeq && isFoldableEvent(item))));
	const orderedSelected = [...selected].sort((a, b) => a.seq - b.seq);
	for (let i = 0; i + 1 < orderedSelected.length; i++) {
		const left = orderedSelected[i]!.seq;
		const right = orderedSelected[i + 1]!.seq;
		folded.push(...foldedRuns(windowItems.filter((item) => item.seq > left && item.seq < right && isFoldableEvent(item))));
	}
	if (anchors.newer_after === null) folded.push(...foldedRuns(windowItems.filter((item) => item.seq > lastSeq && isFoldableEvent(item))));
	return folded;
}

function candidatePreview(candidate: Candidate, maxChars: number): VisibleItem {
	const base = visibleItem(candidate.item, maxChars);
	if (candidate.matchOffset === undefined) return base;
	const chars = Array.from(candidate.item.content);
	const start = candidate.matchOffset;
	return { ...base, truncated: start > 0 || start + maxChars < chars.length, content: chars.slice(start, start + maxChars).join("") };
}

function renderedPage(projection: HistoryProjection, params: HistoryFilter & AnchorParams, vis: HistoryEvent[], selected: Candidate[], maxChars: number, folds: boolean): PageResponse {
	const selectedItems = selected.map((candidate) => candidate.item).sort((a, b) => a.seq - b.seq);
	const anchors = pageAnchors(vis, selectedItems, params.before, params.after);
	const orderedSelected = [...selected].sort((a, b) => a.item.seq - b.item.seq);
	const visible = orderedSelected.map((candidate) => {
		const base = candidate.preview ?? candidatePreview(candidate, maxChars);
		return candidate.matchOffset === undefined ? base : { ...base, offset_chars: candidate.matchOffset };
	});
	let rows: RenderedItem[] = visible;
	if (folds) {
		const folded = foldRows(projection, params, selectedItems, anchors);
		rows = [...visible, ...folded].sort((a, b) => ("folded" in a ? a.first_seq : a.seq) - ("folded" in b ? b.first_seq : b.seq));
	}
	return { items: rows, ...anchors };
}

function orderedCandidates(vis: Candidate[], before: number | undefined, after: number | undefined, limit: number): Candidate[] {
	const ascending = [...vis].sort((a, b) => a.item.seq - b.item.seq);
	if (before !== undefined && after !== undefined) return ascending.filter((candidate) => candidate.item.seq > after && candidate.item.seq < before).slice(0, limit);
	if (after !== undefined) return ascending.filter((candidate) => candidate.item.seq > after).slice(0, limit);
	if (before !== undefined) return ascending.filter((candidate) => candidate.item.seq < before).reverse().slice(0, limit);
	return ascending.slice(-limit).reverse();
}

function selectPage(projection: HistoryProjection, params: HistoryFilter & AnchorParams, vis: Candidate[], folds: boolean): PageResponse {
	const before = params.before;
	const after = params.after;
	const maxChars = params.max_chars_per_item ?? HISTORY_PREVIEW_CHARS;
	const limit = params.limit ?? 20;
	const candidates = orderedCandidates(vis, before, after, limit);
	const allVisible = vis.map((candidate) => candidate.item).sort((a, b) => a.seq - b.seq);
	const kept: Candidate[] = [];
	for (const candidate of candidates) {
		const proposed = [...kept, candidate];
		const response = renderedPage(projection, params, allVisible, proposed, maxChars, folds);
		if (withinBudget(response)) {
			kept.push(candidate);
			continue;
		}
		if (kept.length === 0) {
			const base = candidatePreview(candidate, maxChars);
			const shrunk = truncateHistoryItem(base, (preview) => withinBudget(renderedPage(projection, params, allVisible, [{ ...candidate, preview }], maxChars, folds)));
			kept.push({ ...candidate, preview: shrunk });
		}
		break;
	}
	return renderedPage(projection, params, allVisible, kept, maxChars, folds);
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
		description: "List the newest session events, oldest first within the page. Roles: user, assistant, tool (one call with its result), context (summaries and injected messages). By default shows user and assistant, with tool and context runs folded. Pass older_before as before to page back; use history_read with seq for full text.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum visible items returned; folded context rows are extra and do not count." })),
			roles: historyRoles(),
			before: Type.Optional(Type.Integer({ minimum: 1, description: "Return one older page with seq below this value. Pass older_before from the response. For a bounded range, repeat the same call and keep after unchanged." })),
			after: Type.Optional(Type.Integer({ minimum: 1, description: "Return one newer page with seq above this value. Pass newer_after from the response. For a bounded range, repeat the same call and keep before unchanged." })),
			window_id: Type.Optional(Type.String({ minLength: 1, description: "Limit to one context window; values come from history_windows or any item." })),
			max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum preview characters per item; use history_read for full content (default ${HISTORY_PREVIEW_CHARS}).` })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const projection = historyFromSession(ctx);
			const badWindow = unknownWindowId(projection, params);
			if (badWindow) return output({ error: badWindow.message, window_id: params.window_id, known_windows: badWindow.known });
			const items = filteredItems(projection, params, "list");
			return output(selectPage(projection, params, items.map((item) => ({ item })), isConversationView(params)));
		},
	}));

	pi.registerTool(defineTool({
		name: "history_read",
		label: "History read item",
		description: "Read one event's full text by seq, default 12000 characters from offset_chars. A negative offset_chars counts back from the end. To continue, pass next_offset_chars as offset_chars.",
		parameters: Type.Object({
			seq: Type.Integer({ minimum: 1, description: "Stable file-order address returned by history_list or history_search." }),
			offset_chars: Type.Optional(Type.Integer({ description: "Code-point offset to start from. A negative value counts back from the end; the response echoes the resolved absolute offset. Pass the previous next_offset_chars back unchanged to continue." })),
			limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: `Largest requested window in code points (default ${DEFAULT_READ_WINDOW_CHARS}). A window too large for the wire budget is cut short; next_offset_chars names where the next read resumes.` })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const projection = historyFromSession(ctx);
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
	}));

	pi.registerTool(defineTool({
		name: "history_search",
		label: "History search",
		description: "Case-insensitive substring search over session events; query is one string or several (OR). Searches all four roles by default. Tool events are searchable by tool name, arguments, and output. Pass seq and offset_chars to history_read to read from the match. Continue with older_before / newer_after.",
		parameters: Type.Object({
			query: searchQuery(),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum matching items returned." })),
			roles: historyRoles(),
			before: Type.Optional(Type.Integer({ minimum: 1, description: "Return older hits with seq below this value. Pass older_before from the response. For a bounded range, repeat the same call and keep after unchanged." })),
			after: Type.Optional(Type.Integer({ minimum: 1, description: "Return newer hits with seq above this value. Pass newer_after from the response. For a bounded range, repeat the same call and keep before unchanged." })),
			window_id: Type.Optional(Type.String({ minLength: 1, description: "Limit to one context window; values come from history_windows or any item." })),
			max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum preview characters per item; use history_read for full content (default ${HISTORY_PREVIEW_CHARS}).` })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const projection = historyFromSession(ctx);
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
	}));
}
