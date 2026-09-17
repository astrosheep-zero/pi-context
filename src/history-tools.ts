import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { output, page, middleTruncate, withinBudget } from "./tool-output.js";
import { positiveInteger, recentFirst, nullableString, role, cursor, searchQuery, searchQueries } from "./tool-schema.js";
import { historyFromSession, filteredItems, visibleItem, allItems } from "./history.js";

/**
 * Shrink one oversized history item to fit the page budget. The payload is `truncated_content`,
 * so it is elided first; only when even a marker-only payload cannot fit is `tool_name` elided
 * too. `item_id`, `window_id`, `role`, and `tool_namespace` are identity or tiny metadata and
 * are never touched. Both history page tools share this truncator.
 */
function truncateHistoryItem<T extends { truncated_content: string; tool_name: string | null }>(item: T, fits: (candidate: T) => boolean): T {
	const withContent = { ...item, truncated_content: middleTruncate(item.truncated_content, (candidate) => fits({ ...item, truncated_content: candidate })) } as T;
	if (fits(withContent)) return withContent;
	if (item.tool_name === null) return withContent;
	// Content could not help even at marker-only size: tool_name is the oversized field, so
	// keep the original content and truncate the metadata as the last resort.
	const withName = { ...item, tool_name: middleTruncate(item.tool_name, (candidate) => fits({ ...item, tool_name: candidate })) } as T;
	if (fits(withName)) return withName;
	// Both fields are oversized: dissolve the payload against the truncated metadata.
	return { ...withName, truncated_content: middleTruncate(item.truncated_content, (candidate) => fits({ ...withName, truncated_content: candidate })) } as T;
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
		description: "List durable session items, including items before compaction, using opaque item and window IDs.",
		parameters: Type.Object({ limit: positiveInteger(), cursor: cursor(), recent_first: recentFirst(), tool_namespace: nullableString(), role: Type.Optional(role), tool_name: nullableString(), window_id: nullableString(), max_chars_per_item: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const items = filteredItems(ctx, params).map((item) => visibleItem(item, params.max_chars_per_item ?? 1200));
			return output(page(items, params.cursor ?? 0, "items", params.limit, truncateHistoryItem));
		},
	}));

	pi.registerTool(defineTool({
		name: "history_read_item",
		label: "History read item",
		description: "Read a bounded character range from one durable session item.",
		parameters: Type.Object({ item_id: Type.String(), offset_chars: Type.Optional(Type.Integer({ minimum: 0 })), limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000 })), window_id: Type.String() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const item = allItems(ctx).find((candidate) => candidate.windowId === params.window_id && candidate.itemId === params.item_id);
			if (!item) return output({ error: "unknown item_id or window_id" });
			const chars = Array.from(item.content);
			const offset = params.offset_chars ?? 0;
			const limit = Math.min(params.limit_chars ?? 12000, 50000);
			const result = (content: string) => ({ window_id: item.windowId, item_id: item.itemId, offset_chars: offset, content, total_chars: chars.length, next_offset_chars: offset + limit < chars.length ? offset + limit : null });
			// One clean middle-truncation replaces the old 0.9 shrink loop: a requested window larger
			// than the budget comes back with its middle elided, never empty, and the cursor advances.
			const content = middleTruncate(chars.slice(offset, offset + limit).join(""), (candidate) => withinBudget(result(candidate)));
			return output(result(content));
		},
	}));

	pi.registerTool(defineTool({
		name: "history_search_contents",
		label: "History search",
		description: "Case-sensitive literal substring search over durable Pi session history; query accepts one string or an array of strings, an item matches when it contains any of them (OR), and each item appears once. No semantic search.",
		parameters: Type.Object({ limit: positiveInteger(), cursor: cursor(), query: searchQuery(), recent_first: recentFirst(), tool_namespace: nullableString(), role: Type.Optional(role), tool_name: nullableString(), window_id: nullableString(), max_chars_per_item: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const queries = searchQueries(params.query);
			const matching = filteredItems(ctx, params).filter((item) => queries.some((query) => item.content.includes(query))).map((item) => visibleItem(item, params.max_chars_per_item ?? 1200));
			return output(page(matching, params.cursor ?? 0, "items", params.limit, truncateHistoryItem));
		},
	}));

}
