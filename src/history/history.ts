import { HISTORY_PREVIEW_CHARS } from "../tools/output.js";

export type HistoryItem = {
	seq: number;
	windowId: string;
	role: "user" | "assistant" | "tool_call" | "tool" | "system" | "developer";
	content: string;
	createdAt: string | undefined;
	toolName?: string;
	/** Internal pairing key; never serialized. */
	toolCallId?: string;
	/** Arguments for a standalone bash execution, already serialized as JSON. */
	toolArgs?: string;
	// bashExecution only: the persisted output was truncated and the full text lives on disk.
	outputTruncated?: boolean;
	fullOutputPath?: string;
	// toolResult only: the run reported an error.
	toolError?: boolean;
};

export type HistoryRole = "user" | "assistant" | "tool" | "context";
export type HistoryEvent = {
	seq: number;
	windowId: string;
	role: HistoryRole;
	content: string;
	createdAt: string | undefined;
	tool?: string;
	toolError?: boolean;
	outputTruncated?: boolean;
	fullOutputPath?: string;
};
export type HistoryWindow = { windowId: string; createdAt?: string; items: HistoryEvent[] };
export type HistoryProjection = { windows: HistoryWindow[]; highestSeq: number; branchSeqs: Set<number>; resultAliases: Map<number, number> };
export type HistoryFilter = { window_id?: string | null; roles?: HistoryRole[] | null };

/** Already decoded, allocated and branch-selected by the native adapter. Not inference messages. */
export type DecodedHistoryWindow = { windowId: string; createdAt?: string; items: HistoryItem[] };

function isTextContent(part: unknown): part is { type: "text"; text: string } {
	return typeof part === "object" && part !== null && (part as { type: "text"; text: string }).type === "text" && typeof (part as { type: "text"; text: string }).text === "string";
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter(isTextContent).map((part) => part.text).join("\n") : "";
}

function toolEvent(item: HistoryItem, result?: HistoryItem): HistoryEvent {
	const name = item.toolName ?? "unknown";
	const args = item.role === "tool_call" ? item.content : item.toolArgs ?? "{}";
	const output = result?.content ?? (item.role === "tool" ? item.content : undefined);
	return {
		seq: item.seq,
		windowId: item.windowId,
		role: "tool",
		content: `${name} ${args}${output === undefined ? "" : `\n--- output ---\n${output}`}`,
		createdAt: item.createdAt,
		tool: name,
		...(result?.toolError || item.toolError ? { toolError: true } : {}),
		...(result?.outputTruncated || item.outputTruncated ? { outputTruncated: true, fullOutputPath: result?.fullOutputPath ?? item.fullOutputPath } : {}),
	};
}

export function projectHistory(rawWindows: DecodedHistoryWindow[], highestSeq: number, branchSeqs: Set<number>): HistoryProjection {
	const raw = rawWindows.flatMap((current) => current.items);
	const resultsById = new Map<string, HistoryItem>();
	for (const item of raw) {
		if (item.role === "tool" && item.toolCallId && !resultsById.has(item.toolCallId)) resultsById.set(item.toolCallId, item);
	}
	const resultAliases = new Map<number, number>();
	const consumed = new Set<number>();
	const windows: HistoryWindow[] = rawWindows.map((current) => ({
		windowId: current.windowId,
		...(current.createdAt ? { createdAt: current.createdAt } : {}),
		items: current.items.flatMap((item): HistoryEvent[] => {
			if (consumed.has(item.seq)) return [];
			if (item.role === "tool_call") {
				const result = item.toolCallId ? resultsById.get(item.toolCallId) : undefined;
				const paired = result && result.seq > item.seq && !consumed.has(result.seq) ? result : undefined;
				if (paired) {
					consumed.add(paired.seq);
					resultAliases.set(paired.seq, item.seq);
				}
				return [toolEvent(item, paired)];
			}
			if (item.role === "tool") return [toolEvent(item)];
			return [{ seq: item.seq, windowId: item.windowId, role: item.role === "system" || item.role === "developer" ? "context" : item.role, content: item.content, createdAt: item.createdAt }];
		}),
	}));
	return { windows, highestSeq, branchSeqs, resultAliases };
}

export function visibleItem(item: HistoryEvent, maxChars = HISTORY_PREVIEW_CHARS) {
	const characters = Array.from(item.content);
	const truncated = characters.length > maxChars;
	return {
		seq: item.seq,
		window_id: item.windowId,
		role: item.role,
		created_at: item.createdAt ?? null,
		...(item.tool ? { tool: item.tool } : {}),
		...(item.outputTruncated ? { output_truncated: true, full_output_path: item.fullOutputPath ?? null } : {}),
		...(item.toolError ? { tool_error: true } : {}),
		truncated,
		total_chars: characters.length,
		content: truncated ? characters.slice(0, maxChars).join("") : item.content,
	};
}

export function allItems(projection: HistoryProjection): HistoryEvent[] {
	return projection.windows.flatMap((current) => current.items);
}

export function unknownWindowId(projection: HistoryProjection, params: HistoryFilter): { message: string; known: string[] } | undefined {
	if (typeof params.window_id !== "string") return undefined;
	const known = projection.windows.map((current) => current.windowId);
	return known.includes(params.window_id) ? undefined : { message: `unknown window_id "${params.window_id}"`, known };
}

/** Default list is a conversation; explicit roles and search show the requested events. */
export function filteredItems(projection: HistoryProjection, params: HistoryFilter, mode: "list" | "search"): HistoryEvent[] {
	let items = allItems(projection);
	if (typeof params.window_id === "string") items = items.filter((item) => item.windowId === params.window_id);
	if (params.roles) items = items.filter((item) => params.roles!.includes(item.role));
	if (!params.roles && mode === "list") items = items.filter((item) => (item.role === "user" || item.role === "assistant") && item.content !== "");
	return items.sort((a, b) => a.seq - b.seq);
}
