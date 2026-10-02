/** Stable-anchor paging and folding. The operation supplies the full-response budget check. */
import { Type, type Static } from "typebox";
import { failure, success, type Outcome } from "../tools/result.js";
import { prefixFit } from "../tools/output.js";
import { allItems, visibleItem, HistoryFoldedRowSchema, HistoryPageItemSchema, MAX_FOLD_TOOL_NAMES, MAX_FOLD_TOOL_NAME_CHARS, type HistoryEvent, type HistoryFilter, type HistoryFoldedRow, type HistoryPageItem, type HistoryProjection } from "./history.js";

type PageRow = HistoryPageItem | HistoryFoldedRow;
type Candidate = { event: HistoryEvent; matchOffset?: number; preview?: HistoryPageItem };
type AnchorParams = { before?: number; after?: number; limit?: number; max_chars_per_item?: number };

export const HistoryPageSchema = Type.Object({
	items: Type.Array(Type.Union([HistoryPageItemSchema, HistoryFoldedRowSchema])),
	older_before: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { description: "Pass as before to page older." }),
	newer_after: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { description: "Pass as after to page newer." }),
}, { additionalProperties: false });
/** One whole page payload, before it becomes an outcome. */
export type HistoryPage = Static<typeof HistoryPageSchema>;

/** Shorten preview text first; omit an oversized tool name rather than invent a partial name. */
function truncateHistoryItem(item: HistoryPageItem, fits: (candidate: HistoryPageItem) => boolean): HistoryPageItem {
	if (fits(item)) return item;
	const shrinkContent = (base: HistoryPageItem): HistoryPageItem => ({
		...base,
		truncated: true,
		content: prefixFit(base.content, (candidate) => fits({ ...base, truncated: true, content: candidate })),
	});
	const withContent = shrinkContent(item);
	if (fits(withContent)) return withContent;
	if (item.tool === undefined) return withContent;
	const { tool: _dropped, ...withoutName } = item;
	const named = { ...withoutName, tool_name_omitted: true };
	if (fits(named)) return named;
	return shrinkContent(named);
}

function isFoldableEvent(event: HistoryEvent): boolean {
	return event.role === "tool" || event.role === "context";
}

export function isConversationView(params: HistoryFilter): boolean {
	return !params.roles;
}

/** Folded counts stay exact even when some distinct tool names must be omitted. */
function foldedRuns(events: HistoryEvent[]): HistoryFoldedRow[] {
	if (events.length === 0) return [];
	const sorted = [...events].sort((a, b) => a.seq - b.seq);
	const counts = new Map<string, number>();
	for (const event of sorted) {
		if (event.role !== "tool") continue;
		const name = event.execution?.name ?? "unknown";
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const entries = [...counts].filter(([name]) => name.length <= MAX_FOLD_TOOL_NAME_CHARS).slice(0, MAX_FOLD_TOOL_NAMES);
	// fromEntries preserves __proto__ as an ordinary key without mutating the prototype.
	const tools = Object.fromEntries(entries);
	const omitted = counts.size - entries.length;
	return [{ folded: true, first_seq: sorted[0]!.seq, last_seq: sorted.at(-1)!.seq, count: sorted.length, tools, ...(omitted > 0 ? { omitted_tools: omitted } : {}) }];
}

function pageAnchors(vis: HistoryEvent[], selected: HistoryEvent[], before: number | undefined, after: number | undefined): { older_before: number | null; newer_after: number | null } {
	if (selected.length === 0) return { older_before: null, newer_after: null };
	const lower = after ?? 0;
	const upper = before ?? Number.POSITIVE_INFINITY;
	// Selected events are in seq order.
	const first = selected[0]!.seq;
	const last = selected.at(-1)!.seq;
	return {
		older_before: vis.some((event) => event.seq > lower && event.seq < first && event.seq < upper) ? first : null,
		newer_after: vis.some((event) => event.seq > last && event.seq < upper && event.seq > lower) ? last : null,
	};
}

function foldRows(projection: HistoryProjection, params: HistoryFilter & AnchorParams, selected: HistoryEvent[], anchors: { older_before: number | null; newer_after: number | null }): HistoryFoldedRow[] {
	const lower = params.after ?? 0;
	const upper = params.before ?? Number.POSITIVE_INFINITY;
	if (selected.length === 0) {
		// Even a range with no conversation can contain tool/context events.
		const hidden = allItems(projection).filter((event) => (typeof params.window_id !== "string" || params.window_id === event.windowId) && event.seq > lower && event.seq < upper && isFoldableEvent(event));
		return foldedRuns(hidden);
	}
	const windowEvents = allItems(projection)
		.filter((event) => (typeof params.window_id !== "string" || params.window_id === event.windowId) && event.seq > lower && event.seq < upper)
		.sort((a, b) => a.seq - b.seq);
	const folded: HistoryFoldedRow[] = [];
	const firstSeq = selected[0]!.seq;
	const lastSeq = selected.at(-1)!.seq;
	if (anchors.older_before === null) folded.push(...foldedRuns(windowEvents.filter((event) => event.seq < firstSeq && isFoldableEvent(event))));
	// pageData already ordered selected by seq.
	for (let i = 0; i + 1 < selected.length; i++) {
		const left = selected[i]!.seq;
		const right = selected[i + 1]!.seq;
		folded.push(...foldedRuns(windowEvents.filter((event) => event.seq > left && event.seq < right && isFoldableEvent(event))));
	}
	if (anchors.newer_after === null) folded.push(...foldedRuns(windowEvents.filter((event) => event.seq > lastSeq && isFoldableEvent(event))));
	return folded;
}

function pageData(projection: HistoryProjection, params: HistoryFilter & AnchorParams, vis: HistoryEvent[], selected: Candidate[], maxChars: number, folds: boolean): HistoryPage {
	const orderedSelected = [...selected].sort((a, b) => a.event.seq - b.event.seq);
	const selectedEvents = orderedSelected.map((candidate) => candidate.event);
	const anchors = pageAnchors(vis, selectedEvents, params.before, params.after);
	const visible = orderedSelected.map((candidate) => candidate.preview ?? visibleItem(candidate.event, maxChars, candidate.matchOffset));
	let rows: PageRow[] = visible;
	if (folds) {
		const folded = foldRows(projection, params, selectedEvents, anchors);
		rows = [...visible, ...folded].sort((a, b) => ("folded" in a ? a.first_seq : a.seq) - ("folded" in b ? b.first_seq : b.seq));
	}
	return { items: rows, ...anchors };
}

function orderedCandidates(vis: Candidate[], before: number | undefined, after: number | undefined, limit: number): Candidate[] {
	const ascending = [...vis].sort((a, b) => a.event.seq - b.event.seq);
	if (before !== undefined && after !== undefined) return ascending.filter((candidate) => candidate.event.seq > after && candidate.event.seq < before).slice(0, limit);
	if (after !== undefined) return ascending.filter((candidate) => candidate.event.seq > after).slice(0, limit);
	if (before !== undefined) return ascending.filter((candidate) => candidate.event.seq < before).reverse().slice(0, limit);
	return ascending.slice(-limit).reverse();
}

/** Grow the page in query order; shorten the first preview only when no full row fits. */
export function selectPage(projection: HistoryProjection, params: HistoryFilter & AnchorParams, vis: Candidate[], folds: boolean, fits: (page: HistoryPage) => boolean, maxChars: number): Outcome<HistoryPage> {
	const before = params.before;
	const after = params.after;
	const limit = params.limit ?? 20;
	const candidates = orderedCandidates(vis, before, after, limit);
	const allVisible = vis.map((candidate) => candidate.event).sort((a, b) => a.seq - b.seq);
	const kept: Candidate[] = [];
	for (const candidate of candidates) {
		if (fits(pageData(projection, params, allVisible, [...kept, candidate], maxChars, folds))) {
			kept.push(candidate);
			continue;
		}
		if (kept.length === 0) kept.push({ ...candidate, preview: truncateHistoryItem(visibleItem(candidate.event, maxChars, candidate.matchOffset), (preview) => fits(pageData(projection, params, allVisible, [{ ...candidate, preview }], maxChars, folds))) });
		break;
	}
	const page = pageData(projection, params, allVisible, kept, maxChars, folds);
	if (!fits(page)) {
		return failure("page_too_large", `${page.items.length} history rows and their fold summary do not fit one response even at their smallest; narrow the range with before/after or read one seq`, { rows: page.items.length });
	}
	return success(page);
}