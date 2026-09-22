import type { TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionReader } from "./session-reader.js";
import { isWindowMarker, rootWindowId } from "./context-window.js";
import { HISTORY_PREVIEW_CHARS } from "./tool-output.js";

type HistoryItem = {
	windowId: string;
	itemId: string;
	role: "user" | "assistant" | "tool_call" | "tool" | "system" | "developer";
	content: string;
	createdAt: string | undefined;
	toolName?: string;
	// bashExecution only: the persisted output was truncated and the full text lives on disk.
	outputTruncated?: boolean;
	fullOutputPath?: string;
	// toolResult only: the run reported an error.
	toolError?: boolean;
};
type HistoryWindow = { windowId: string; createdAt?: string; items: HistoryItem[] };

type HistoryFilter = {
	window_id?: string | null;
	role?: HistoryItem["role"] | null;
	tool_name?: string | null;
	recent_first?: boolean;
};

function isTextContent(part: unknown): part is TextContent {
	return typeof part === "object" && part !== null && (part as TextContent).type === "text" && typeof (part as TextContent).text === "string";
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter(isTextContent).map((part) => part.text).join("\n") : "";
}

function mapRole(role: AgentMessage["role"]): HistoryItem["role"] | undefined {
	if (role === "user" || role === "assistant") return role;
	if (role === "toolResult" || role === "bashExecution") return "tool";
	if (role === "custom") return "user";
	if (role === "compactionSummary" || role === "branchSummary") return "system";
	return undefined;
}

/** This extension's own custom-entry namespace; entries under it are authored by pi-context. */
const PI_CONTEXT_ENTRY_PREFIX = "pi-context/";

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

function toolInfo(message: AgentMessage): Pick<HistoryItem, "toolName" | "outputTruncated" | "fullOutputPath" | "toolError"> {
	if (message.role === "bashExecution") {
		// A truncated bash run is only half the record without the on-disk path: surface both.
		return { toolName: "bash", outputTruncated: message.truncated || undefined, fullOutputPath: message.truncated ? message.fullOutputPath : undefined };
	}
	if (message.role !== "toolResult") return {};
	return { toolName: message.toolName, toolError: message.isError === true ? true : undefined };
}

/**
 * An assistant turn's tool calls, projected as their own items: calls wear their own role so the
 * authoring turn's visible text (role "assistant") stays pure; what was invoked stays as
 * searchable as what came back (role "tool"). Ids derive from the turn's entry id and stay
 * opaque; history_read resolves them like any other item.
 */
function toolCallItems(windowId: string, entry: { id: string; timestamp?: string }, message: AgentMessage): HistoryItem[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const items: HistoryItem[] = [];
	let callIndex = 0;
	for (const part of message.content) {
		if (typeof part !== "object" || part === null || (part as { type?: unknown }).type !== "toolCall") continue;
		const call = part as ToolCall;
		items.push({
			windowId,
			itemId: `${entry.id}#${callIndex++}`,
			role: "tool_call",
			content: JSON.stringify(call.arguments),
			createdAt: entry.timestamp,
			toolName: call.name,
		});
	}
	return items;
}

/** Build durable, on-demand history directly from every entry on the current session branch. */
export function historyFromSession(ctx: SessionReader): HistoryWindow[] {
	const sessionId = ctx.sessionManager.getSessionId();
	let window: HistoryWindow = { windowId: rootWindowId(sessionId), items: [] };
	const windows = [window];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (isWindowMarker(entry)) {
			window = { windowId: entry.data.windowId, createdAt: entry.timestamp, items: [] };
			windows.push(window);
			continue;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			window.items.push({
				windowId: window.windowId,
				itemId: entry.id,
				role: "system",
				content: entry.summary,
				createdAt: entry.timestamp,
			});
			continue;
		}
		if (entry.type === "message") {
			const role = mapRole(entry.message.role);
			if (!role) continue;
			window.items.push({
				windowId: window.windowId,
				itemId: entry.id,
				role,
				content: messageContent(entry.message),
				createdAt: entry.timestamp,
				...toolInfo(entry.message),
			});
			window.items.push(...toolCallItems(window.windowId, entry, entry.message));
			continue;
		}
		if (entry.type === "custom_message") {
			window.items.push({
				windowId: window.windowId,
				itemId: entry.id,
				// Only entries this extension wrote are its own; every foreign custom message stays a user turn.
				role: entry.customType.startsWith(PI_CONTEXT_ENTRY_PREFIX) ? "developer" : "user",
				content: contentText(entry.content),
				createdAt: entry.timestamp,
			});
		}
	}
	return windows;
}

export function visibleItem(item: HistoryItem, maxChars = HISTORY_PREVIEW_CHARS) {
	const characters = Array.from(item.content);
	const truncated = characters.length > maxChars;
	return {
		window_id: item.windowId,
		item_id: item.itemId,
		role: item.role,
		tool_name: item.toolName ?? null,
		// Surfaced only when set: a truncated bash run names its full-output path, and an
		// errored tool run says so. Absent keys mean nothing special happened.
		...(item.outputTruncated ? { output_truncated: true, full_output_path: item.fullOutputPath ?? null } : {}),
		...(item.toolError ? { tool_error: true } : {}),
		truncated,
		total_chars: characters.length,
		// A truncated payload is a plain prefix: no synthetic marker is appended, and
		// `total_chars` names exactly how many code points were left out.
		truncated_content: truncated ? characters.slice(0, maxChars).join("") : item.content,
	};
}

export function allItems(ctx: SessionReader) {
	return historyFromSession(ctx).flatMap((window) => window.items);
}

/**
 * window_id must name a real window; anything else is a named error, not a silent empty page
 * (a window that exists but has no matching items after the other filters stays a legal empty
 * page). Returns the teaching message plus the known window ids so the error is self-healing.
 */
export function unknownWindowId(ctx: SessionReader, params: HistoryFilter): { message: string; known: string[] } | undefined {
	if (typeof params.window_id !== "string") return undefined;
	const known = historyFromSession(ctx).map((window) => window.windowId);
	return known.includes(params.window_id) ? undefined : { message: `unknown window_id "${params.window_id}"`, known };
}

/**
 * A role×tool_name combination is vacuous — provably empty from the taxonomy alone, before
 * any data is read — when tool_name is given alongside a role that never carries one. Only
 * "tool_call" and "tool" items have a tool name. Returns the teaching error message, or
 * undefined when the combination can match.
 */
export function vacuousRoleToolCombo(params: HistoryFilter): string | undefined {
	if (typeof params.tool_name === "string" && typeof params.role === "string" && params.role !== "tool_call" && params.role !== "tool") {
		return `tool_name is only set on "tool_call" and "tool" items; role "${params.role}" never carries one`;
	}
	return undefined;
}

export function filteredItems(ctx: SessionReader, params: HistoryFilter): HistoryItem[] {
	let items = allItems(ctx);
	if (typeof params.window_id === "string") items = items.filter((item) => item.windowId === params.window_id);
	if (typeof params.role === "string") items = items.filter((item) => item.role === params.role);
	if (typeof params.tool_name === "string") items = items.filter((item) => item.toolName === params.tool_name);
	if (params.recent_first !== false) items.reverse();
	return items;
}
