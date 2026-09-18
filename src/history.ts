import type { TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionReader } from "./session-reader.js";
import { RESET_V2 } from "./protocol.js";

type HistoryItem = {
	windowId: string;
	itemId: string;
	role: "user" | "assistant" | "tool" | "system" | "developer";
	content: string;
	createdAt: string | undefined;
	toolName?: string;
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

function contentText(content: string | unknown[]): string {
	if (typeof content === "string") return content;
	return content.filter(isTextContent).map((part) => part.text).join("\n");
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

function toolInfo(message: AgentMessage): Pick<HistoryItem, "toolName"> {
	if (message.role === "bashExecution") return { toolName: "bash" };
	if (message.role !== "toolResult") return {};
	return { toolName: message.toolName };
}

/**
 * An assistant turn's tool calls, projected as their own items: role "assistant" like the turn
 * that authored them, tool_name set, content = the call's JSON arguments. What was invoked is
 * then as searchable as what came back (role "tool"). Ids derive from the turn's entry id and
 * stay opaque; history_read_item resolves them like any other item.
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
			role: "assistant",
			content: JSON.stringify(call.arguments),
			createdAt: entry.timestamp,
			toolName: call.name,
		});
	}
	return items;
}

/** The extension-owned window id baked onto a reset-v2 compaction entry, if present. */
export function resetV2WindowId(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = details as { piContext?: unknown; windowId?: unknown };
	if (candidate.piContext !== RESET_V2 || typeof candidate.windowId !== "string") return undefined;
	return candidate.windowId;
}

/** A compaction entry's window id: the extension-minted id for reset-v2, else Pi's entry id. */
function windowIdOf(sessionId: string, entry: { id: string; details?: unknown }): string {
	return resetV2WindowId(entry.details) ?? `pcw:${sessionId.slice(0, 8)}:${entry.id}`;
}

/** Build durable, on-demand history directly from every entry on the current session branch. */
export function historyFromSession(ctx: SessionReader): HistoryWindow[] {
	const sessionId = ctx.sessionManager.getSessionId();
	let window: HistoryWindow = { windowId: `pcw:${sessionId.slice(0, 8)}:root`, items: [] };
	const windows = [window];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction") {
			window = { windowId: windowIdOf(sessionId, entry), createdAt: entry.timestamp, items: [] };
			windows.push(window);
			window.items.push({
				windowId: window.windowId,
				itemId: entry.id,
				// A reset-v2 compaction is authored by this extension; a native Pi compaction is not.
				role: resetV2WindowId(entry.details) === undefined ? "system" : "developer",
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

export function visibleItem(item: HistoryItem, maxChars = 1200) {
	const characters = Array.from(item.content);
	const truncated = characters.length > maxChars;
	return {
		window_id: item.windowId,
		item_id: item.itemId,
		role: item.role,
		tool_name: item.toolName ?? null,
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

	export function filteredItems(ctx: SessionReader, params: HistoryFilter): HistoryItem[] {
	let items = allItems(ctx);
	if (typeof params.window_id === "string") items = items.filter((item) => item.windowId === params.window_id);
	if (typeof params.role === "string") items = items.filter((item) => item.role === params.role);
	if (typeof params.tool_name === "string") items = items.filter((item) => item.toolName === params.tool_name);
	if (params.recent_first !== false) items.reverse();
	return items;
}


/** Persisted messages in the active window, excluding earlier windows on this branch. */
export function hasWindowMessage(ctx: SessionReader, customType: string): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "compaction") break;
		if (entry.type === "custom_message" && entry.customType === customType) return true;
	}
	return false;
}

/** Cheap current-window lookup: scan the branch tail for the latest compaction entry. */
export function currentWindowId(ctx: SessionReader): string {
	const sessionId = ctx.sessionManager.getSessionId();
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "compaction") return windowIdOf(sessionId, entry);
	}
	return `pcw:${sessionId.slice(0, 8)}:root`;
}

