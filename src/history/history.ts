import type { TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionReader } from "../session-reader.js";
import { isWindowMarker, rootWindowId } from "../context/context-window.js";
import { HISTORY_PREVIEW_CHARS } from "../tool-output.js";

export type HistoryItem = {
	seq: number;
	windowId: string;
	role: "user" | "assistant" | "tool_call" | "tool" | "system" | "developer";
	content: string;
	createdAt: string | undefined;
	toolName?: string;
	callSeq?: number | null;
	resultSeq?: number | null;
	/** Internal pairing key; never serialized. */
	toolCallId?: string;
	// bashExecution only: the persisted output was truncated and the full text lives on disk.
	outputTruncated?: boolean;
	fullOutputPath?: string;
	// toolResult only: the run reported an error.
	toolError?: boolean;
};

export type HistoryWindow = { windowId: string; createdAt?: string; items: HistoryItem[] };
export type HistoryProjection = { windows: HistoryWindow[]; highestSeq: number; branchSeqs: Set<number> };
export type HistoryRole = HistoryItem["role"];
export type HistoryFilter = {
	window_id?: string | null;
	roles?: HistoryRole[] | null;
	tool_name?: string | null;
};

function isTextContent(part: unknown): part is TextContent {
	return typeof part === "object" && part !== null && (part as TextContent).type === "text" && typeof (part as TextContent).text === "string";
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter(isTextContent).map((part) => part.text).join("\n") : "";
}

function mapRole(role: AgentMessage["role"]): HistoryRole | undefined {
	if (role === "user" || role === "assistant") return role;
	if (role === "toolResult" || role === "bashExecution") return "tool";
	if (role === "custom") return "developer";
	if (role === "compactionSummary" || role === "branchSummary") return "system";
	return undefined;
}

function isToolCall(part: unknown): part is ToolCall {
	return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "toolCall";
}

function mappedMessage(message: AgentMessage): boolean {
	return mapRole(message.role) !== undefined;
}

/** Seq allocation depends on entry kind and role, never on visible content. */
function sequenceCount(entry: SessionEntry): number {
	if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "custom_message") return 1;
	if (entry.type !== "message" || !mappedMessage(entry.message)) return 0;
	if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return 1;
	return 1 + entry.message.content.filter(isToolCall).length;
}

function messageContent(message: AgentMessage): string {
	switch (message.role) {
		case "bashExecution":
			// The command is as much the record as its output: without it the typed line is
			// unsearchable. Mirrors the tool-call projection below.
			return message.output ? `${message.command}\n${message.output}` : message.command;
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default:
			return contentText(message.content);
	}
}

function toolInfo(message: AgentMessage): Pick<HistoryItem, "toolName" | "outputTruncated" | "fullOutputPath" | "toolError" | "toolCallId"> {
	if (message.role === "bashExecution") {
		// A truncated bash run is only half the record without the on-disk path: surface both.
		return { toolName: "bash", outputTruncated: message.truncated || undefined, fullOutputPath: message.truncated ? message.fullOutputPath : undefined };
	}
	if (message.role !== "toolResult") return {};
	return { toolName: message.toolName, toolCallId: message.toolCallId, toolError: message.isError === true ? true : undefined };
}

function toolCallItems(windowId: string, entry: { id: string; timestamp?: string }, message: AgentMessage, entrySeq: number): HistoryItem[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const items: HistoryItem[] = [];
	let callIndex = 0;
	for (const part of message.content) {
		if (!isToolCall(part)) continue;
		const callSeq = entrySeq + callIndex + 1;
		items.push({
			seq: callSeq,
			windowId,
			role: "tool_call",
			content: JSON.stringify(part.arguments),
			createdAt: entry.timestamp,
			toolName: part.name,
			toolCallId: part.id,
			resultSeq: null,
		});
		callIndex += 1;
	}
	return items;
}

/** Build stable file-order addresses and project only the current branch into windows. */
export function historyFromSession(ctx: SessionReader): HistoryProjection {
	const seqByEntryId = new Map<string, number>();
	let nextSeq = 1;
	for (const entry of ctx.sessionManager.getEntries()) {
		const count = sequenceCount(entry);
		if (count === 0) continue;
		seqByEntryId.set(entry.id, nextSeq);
		nextSeq += count;
	}
	const highestSeq = nextSeq - 1;

	const sessionId = ctx.sessionManager.getSessionId();
	let window: HistoryWindow = { windowId: rootWindowId(sessionId), items: [] };
	const windows = [window];
	const branchSeqs = new Set<number>();
	const callsById = new Map<string, number>();
	const resultsById = new Map<string, number>();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (isWindowMarker(entry)) {
			window = { windowId: entry.data.windowId, createdAt: entry.timestamp, items: [] };
			windows.push(window);
			continue;
		}
		const entrySeq = seqByEntryId.get(entry.id);
		if (entrySeq === undefined) continue;
		branchSeqs.add(entrySeq);

		if (entry.type === "compaction" || entry.type === "branch_summary") {
			window.items.push({ seq: entrySeq, windowId: window.windowId, role: "system", content: entry.summary, createdAt: entry.timestamp });
			continue;
		}
		if (entry.type === "message") {
			const role = mapRole(entry.message.role);
			if (!role) continue;
			window.items.push({
				seq: entrySeq,
				windowId: window.windowId,
				role,
				content: messageContent(entry.message),
				createdAt: entry.timestamp,
				...toolInfo(entry.message),
				...(role === "tool" ? { callSeq: null } : {}),
			});
			const calls = toolCallItems(window.windowId, entry, entry.message, entrySeq);
			for (const call of calls) {
				branchSeqs.add(call.seq);
				if (call.toolCallId && !callsById.has(call.toolCallId)) callsById.set(call.toolCallId, call.seq);
			}
			window.items.push(...calls);
			if (entry.message.role === "toolResult" && entry.message.toolCallId && !resultsById.has(entry.message.toolCallId)) {
				resultsById.set(entry.message.toolCallId, entrySeq);
			}
			continue;
		}
		if (entry.type === "custom_message") {
			window.items.push({
				seq: entrySeq,
				windowId: window.windowId,
				role: "developer",
				content: contentText(entry.content),
				createdAt: entry.timestamp,
			});
		}
	}

	for (const item of windows.flatMap((current) => current.items)) {
		if (item.role === "tool_call" && item.toolCallId) item.resultSeq = resultsById.get(item.toolCallId) ?? null;
		if (item.role === "tool" && item.toolCallId) item.callSeq = callsById.get(item.toolCallId) ?? null;
	}
	return { windows, highestSeq, branchSeqs };
}

export function visibleItem(item: HistoryItem, maxChars = HISTORY_PREVIEW_CHARS) {
	const characters = Array.from(item.content);
	const truncated = characters.length > maxChars;
	return {
		seq: item.seq,
		window_id: item.windowId,
		role: item.role,
		created_at: item.createdAt ?? null,
		tool_name: item.toolName ?? null,
		...(item.role === "tool_call" ? { result_seq: item.resultSeq ?? null } : {}),
		...(item.role === "tool" ? { call_seq: item.callSeq ?? null } : {}),
		...(item.outputTruncated ? { output_truncated: true, full_output_path: item.fullOutputPath ?? null } : {}),
		...(item.toolError ? { tool_error: true } : {}),
		truncated,
		total_chars: characters.length,
		truncated_content: truncated ? characters.slice(0, maxChars).join("") : item.content,
	};
}

export function allItems(projection: HistoryProjection): HistoryItem[] {
	return projection.windows.flatMap((current) => current.items);
}

export function unknownWindowId(projection: HistoryProjection, params: HistoryFilter): { message: string; known: string[] } | undefined {
	if (typeof params.window_id !== "string") return undefined;
	const known = projection.windows.map((current) => current.windowId);
	return known.includes(params.window_id) ? undefined : { message: `unknown window_id "${params.window_id}"`, known };
}

export function validateHistoryFilters(params: HistoryFilter): string | undefined {
	if (typeof params.tool_name === "string" && params.roles && params.roles.some((role) => role !== "tool_call" && role !== "tool")) {
		return 'tool_name only supports roles "tool_call" and "tool"';
	}
	return undefined;
}

/** role/tool/custom filtering is applied before default conversation visibility. */
export function filteredItems(projection: HistoryProjection, params: HistoryFilter, mode: "list" | "search"): HistoryItem[] {
	let items = allItems(projection);
	if (typeof params.window_id === "string") items = items.filter((item) => item.windowId === params.window_id);
	if (params.roles) items = items.filter((item) => params.roles!.includes(item.role));
	if (typeof params.tool_name === "string") items = items.filter((item) => (item.role === "tool_call" || item.role === "tool") && item.toolName === params.tool_name);
	if (!params.roles && typeof params.tool_name !== "string" && mode === "list") items = items.filter((item) => (item.role === "user" || item.role === "assistant" || item.role === "system") && item.content !== "");
	return items.sort((a, b) => a.seq - b.seq);
}
