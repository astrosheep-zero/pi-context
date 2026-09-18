import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { output, outputRaw, page, middleTruncate, prefixFit, earliestMatchOffsetChars, readCharacterWindow, characterWindowHeader, withinTextBudget } from "./tool-output.js";
import { positiveInteger, recentFirst, nullableString, role, cursor, searchQuery, searchQueries } from "./tool-schema.js";
import { historyFromSession, filteredItems, visibleItem, allItems } from "./history.js";

/**
 * Shrink one page item to fit the wire budget. `truncated`/`total_chars` stay honest: the
 * payload is only ever cut to a plain prefix of itself, never filled with a marker, and the
 * flag flips on whenever a shrink actually removed characters. `tool_name` is metadata, not a
 * payload, and keeps its visible middle-truncation marker. `item_id`, `window_id`, and `role`
 * are identity or tiny metadata and are never touched.
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
		description: "List durable session items, including items before compaction, using opaque item and window IDs. Every item has exactly one role: \"user\"/\"assistant\" = a message's visible text (assistant text never contains tool calls), \"tool_call\" = one invocation (tool_name set, content = the call's JSON arguments), \"tool\" = one run's output (tool_name set), \"system\" = a native compaction summary, \"developer\" = an entry this extension authored. Every item carries truncated and total_chars: when truncated is true, truncated_content is a plain prefix of the item's content with no marker, and total_chars is its full code-point length. max_chars_per_item: 1 therefore yields pure addresses you can resolve with history_read_item.",
		parameters: Type.Object({ limit: positiveInteger(), cursor: cursor(), recent_first: recentFirst(), role: Type.Optional(role), tool_name: nullableString(), window_id: nullableString(), max_chars_per_item: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const items = filteredItems(ctx, params).map((item) => visibleItem(item, params.max_chars_per_item ?? 1200));
			return output(page(items, params.cursor ?? 0, "items", params.limit, truncateHistoryItem));
		},
	}));

	pi.registerTool(defineTool({
		name: "history_read_item",
		label: "History read item",
		description: "Read a bounded character range from one session item. Each response delivers the longest contiguous prefix of the requested window that fits the wire budget: follow the resume cursor to reconstruct the item exactly. A negative offset_chars counts back from the item's end. Offsets and counts are code points (an emoji or CJK character counts as one). The response is the raw item text behind a one-line [bracketed] header naming the item, the resolved offset, the delivered char range, and the resume cursor (continue at offset_chars=N, or end).",
		parameters: Type.Object({ item_id: Type.String(), offset_chars: Type.Optional(Type.Integer({ description: "Code-point offset to start from. A negative value counts back from the end; the response echoes the resolved absolute offset. Pass the previous next_offset_chars back unchanged to continue." })), limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: "Largest requested window in code points (default 12000). A window too large for the wire budget is cut short; next_offset_chars names where the next read resumes." })), window_id: Type.String() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const item = allItems(ctx).find((candidate) => candidate.windowId === params.window_id && candidate.itemId === params.item_id);
			if (!item) return output({ error: "unknown item_id or window_id" });
			const limit_chars = Math.min(params.limit_chars ?? 12000, 50000);
			return readCharacterWindow(item.content, params.offset_chars, params.limit_chars, (window) => {
				const { content, ...cursor } = window;
				return outputRaw(characterWindowHeader(`${item.windowId} · item ${item.itemId}`, window), content, { window_id: item.windowId, item_id: item.itemId, ...cursor, limit_chars });
			}, (result) => withinTextBudget(result.content[0].text));
		},
	}));

	pi.registerTool(defineTool({
		name: "history_search_contents",
		label: "History search",
		description: "Case-sensitive literal substring search over durable Pi session history; query accepts one string or an array of strings, an item matches when it contains any of them (OR), and each item appears once. No semantic search. Every item has exactly one role: \"user\"/\"assistant\" = a message's visible text (assistant text never contains tool calls), \"tool_call\" = one invocation (tool_name set, content = the call's JSON arguments), \"tool\" = one run's output (tool_name set), \"system\" = a native compaction summary, \"developer\" = an entry this extension authored. Each hit carries truncated and total_chars plus match_offset_chars: the code-point offset of the earliest query occurrence in the item's full content. With max_chars_per_item: 1 the page is an address list; resolve an address with history_read_item at match_offset_chars.",
		parameters: Type.Object({ limit: positiveInteger(), cursor: cursor(), query: searchQuery(), recent_first: recentFirst(), role: Type.Optional(role), tool_name: nullableString(), window_id: nullableString(), max_chars_per_item: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const queries = searchQueries(params.query);
			const matching = filteredItems(ctx, params)
				.filter((item) => queries.some((query) => item.content.includes(query)))
				.map((item) => ({ ...visibleItem(item, params.max_chars_per_item ?? 1200), match_offset_chars: earliestMatchOffsetChars(item.content, queries) }));
			return output(page(matching, params.cursor ?? 0, "items", params.limit, truncateHistoryItem));
		},
	}));

}
