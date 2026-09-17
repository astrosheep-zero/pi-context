import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { output, page, middleTruncate, prefixFit, withinBudget } from "./tool-output.js";
import { positiveInteger, recentFirst, nullableString, role, cursor, searchQuery, searchQueries } from "./tool-schema.js";
import { historyFromSession, filteredItems, visibleItem, allItems } from "./history.js";

/**
 * Shrink one page item to fit the wire budget. `truncated`/`total_chars` stay honest: the
 * payload is only ever cut to a plain prefix of itself, never filled with a marker, and the
 * flag flips on whenever a shrink actually removed characters. `tool_name` is metadata, not a
 * payload, and keeps its visible middle-truncation marker. `item_id`, `window_id`, `role`, and
 * `tool_namespace` are identity or tiny metadata and are never touched.
 */
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
	// Content could not help even as an empty prefix: tool_name is oversized, so keep the
	// original payload and truncate the metadata as the last resort.
	const withName = { ...item, tool_name: middleTruncate(item.tool_name, (candidate) => fits({ ...item, tool_name: candidate } as T)) } as T;
	if (fits(withName)) return withName;
	// Both fields are oversized: dissolve the payload against the truncated metadata.
	return shrinkContent(withName);
}

/** Code-point offset of the earliest occurrence of any query literal in the full content. */
function earliestMatchOffset(content: string, queries: string[]): number {
	let earliest = -1;
	for (const query of queries) {
		const index = content.indexOf(query);
		if (index < 0) continue;
		if (earliest < 0 || index < earliest) earliest = index;
	}
	return earliest <= 0 ? 0 : Array.from(content.slice(0, earliest)).length;
}

export function registerHistoryTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "history_list_windows",
		label: "History list windows",
		description: "List durable Pi session-history windows.",
		parameters: Type.Object({ limit: positiveInteger(), recent_first: recentFirst() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			let windows = historyFromSession(ctx);
			if (params.recent_first !== false) windows = [...windows].reverse();
			const limit = params.limit ?? windows.length;
			return output({ windows: windows.slice(0, limit).map((window) => ({ window_id: window.windowId, item_count: window.items.length })) });
		},
	}));

	pi.registerTool(defineTool({
		name: "history_list_items",
		label: "History list items",
		description: "List durable session items, including items before compaction, using opaque item and window IDs. Every item carries truncated and total_chars: when truncated is true, truncated_content is a plain prefix of the item's content with no marker, and total_chars is its full code-point length. max_chars_per_item: 1 therefore yields pure addresses you can resolve with history_read_item.",
		parameters: Type.Object({ limit: positiveInteger(), cursor: cursor(), recent_first: recentFirst(), tool_namespace: nullableString(), role: Type.Optional(role), tool_name: nullableString(), window_id: nullableString(), max_chars_per_item: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const items = filteredItems(ctx, params).map((item) => visibleItem(item, params.max_chars_per_item ?? 1200));
			return output(page(items, params.cursor ?? 0, "items", params.limit, truncateHistoryItem));
		},
	}));

	pi.registerTool(defineTool({
		name: "history_read_item",
		label: "History read item",
		description: "Read a bounded character range from one durable session item. Each response delivers the longest contiguous prefix of the requested window that fits the wire budget, so content is always a plain prefix with no marker. next_offset_chars is exactly offset_chars plus the delivered code-point count, and is null only once the item ends: follow it to reconstruct the item exactly. Offsets and counts are code points (an emoji or CJK character counts as one).",
		parameters: Type.Object({ item_id: Type.String(), offset_chars: Type.Optional(Type.Integer({ minimum: 0, description: "Code-point offset to start from. Pass the previous next_offset_chars back unchanged." })), limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: "Largest requested window in code points (default 12000). A window too large for the wire budget is cut short; next_offset_chars names where the next read resumes." })), window_id: Type.String() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const item = allItems(ctx).find((candidate) => candidate.windowId === params.window_id && candidate.itemId === params.item_id);
			if (!item) return output({ error: "unknown item_id or window_id" });
			const chars = Array.from(item.content);
			const offset = Math.max(0, params.offset_chars ?? 0);
			const limit = Math.min(params.limit_chars ?? 12000, 50000);
			const windowChars = chars.slice(offset, offset + limit);
			const result = (content: string) => {
				const next = offset + Array.from(content).length;
				return { window_id: item.windowId, item_id: item.itemId, offset_chars: offset, content, total_chars: chars.length, next_offset_chars: next < chars.length ? next : null };
			};
			// One monotone binary search for the longest prefix that fits: no shrink loop, no
			// middle-truncation. A middle-elided payload could never name the skipped range with a
			// cursor, which is the whole point of the cursor law.
			const content = prefixFit(windowChars.join(""), (candidate) => withinBudget(result(candidate)));
			return output(result(content));
		},
	}));

	pi.registerTool(defineTool({
		name: "history_search_contents",
		label: "History search",
		description: "Case-sensitive literal substring search over durable Pi session history; query accepts one string or an array of strings, an item matches when it contains any of them (OR), and each item appears once. No semantic search. Each hit carries truncated and total_chars plus match_offset_chars: the code-point offset of the earliest query occurrence in the item's full content. With max_chars_per_item: 1 the page is an address list; resolve an address with history_read_item at match_offset_chars.",
		parameters: Type.Object({ limit: positiveInteger(), cursor: cursor(), query: searchQuery(), recent_first: recentFirst(), tool_namespace: nullableString(), role: Type.Optional(role), tool_name: nullableString(), window_id: nullableString(), max_chars_per_item: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const queries = searchQueries(params.query);
			const matching = filteredItems(ctx, params)
				.filter((item) => queries.some((query) => item.content.includes(query)))
				.map((item) => ({ ...visibleItem(item, params.max_chars_per_item ?? 1200), match_offset_chars: earliestMatchOffset(item.content, queries) }));
			return output(page(matching, params.cursor ?? 0, "items", params.limit, truncateHistoryItem));
		},
	}));

}
