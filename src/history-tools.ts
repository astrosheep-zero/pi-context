import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { output } from "./tool-output.js";
import { positiveInteger, recentFirst, nullableString, role } from "./tool-schema.js";
import { historyFromSession, filteredItems, visibleItem, allItems } from "./history.js";

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
		parameters: Type.Object({ limit: positiveInteger(), recent_first: recentFirst(), tool_namespace: nullableString(), role: Type.Optional(role), tool_name: nullableString(), window_id: nullableString(), max_chars_per_item: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const items = filteredItems(ctx, params);
			return output({ items: items.slice(0, params.limit ?? items.length).map((item) => visibleItem(item, params.max_chars_per_item ?? 1200)) });
		},
	}));

	pi.registerTool(defineTool({
		name: "history_read_item",
		label: "History read item",
		description: "Read a bounded character range from one durable session item.",
		parameters: Type.Object({ item_id: Type.String(), offset_chars: Type.Optional(Type.Integer({ minimum: 0 })), limit_chars: positiveInteger(), window_id: Type.String() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const item = allItems(ctx).find((candidate) => candidate.windowId === params.window_id && candidate.itemId === params.item_id);
			if (!item) return output({ error: "unknown item_id or window_id" });
			const chars = Array.from(item.content);
			const offset = params.offset_chars ?? 0;
			const limit = params.limit_chars ?? chars.length;
			return output({ window_id: item.windowId, item_id: item.itemId, offset_chars: offset, content: chars.slice(offset, offset + limit).join("") });
		},
	}));

	pi.registerTool(defineTool({
		name: "history_search_contents",
		label: "History search",
		description: "Case-sensitive literal substring search over durable Pi session history; no semantic search.",
		parameters: Type.Object({ limit: positiveInteger(), query: Type.String(), recent_first: recentFirst(), tool_namespace: nullableString(), role: Type.Optional(role), tool_name: nullableString(), window_id: nullableString() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const items = filteredItems(ctx, params);
			const matching = items.filter((item) => item.content.includes(params.query));
			return output({ items: matching.slice(0, params.limit ?? matching.length).map((item) => visibleItem(item)) });
		},
	}));

}
