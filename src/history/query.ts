import { middleTruncate, prefixFit, withinBudget, HISTORY_PREVIEW_CHARS } from "../tools/output.js";
import { allItems, visibleItem, type HistoryEvent, type HistoryFilter, type HistoryProjection } from "./history.js";

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

export function isConversationView(params: HistoryFilter): boolean {
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

export function selectPage(projection: HistoryProjection, params: HistoryFilter & AnchorParams, vis: Candidate[], folds: boolean): PageResponse {
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
