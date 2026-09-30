import type { ToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionReader } from "./session-reader.js";
import { isWindowMarker, rootWindowId } from "./window.js";
import { contentText, projectHistory, type HistoryItem, type HistoryProjection, type DecodedHistoryWindow } from "../history/history.js";

function mapRole(role: AgentMessage["role"]): HistoryItem["role"] | undefined {
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
			return message.output;
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default:
			return contentText(message.content);
	}
}

function toolInfo(message: AgentMessage): Pick<HistoryItem, "toolName" | "toolArgs" | "outputTruncated" | "fullOutputPath" | "toolError" | "toolCallId"> {
	if (message.role === "bashExecution") {
		// A truncated bash run is only half the record without the on-disk path: surface both.
		return { toolName: "bash", toolArgs: JSON.stringify({ command: message.command }), outputTruncated: message.truncated || undefined, fullOutputPath: message.truncated ? message.fullOutputPath : undefined };
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
			content: JSON.stringify(part.arguments) ?? "{}",
			createdAt: entry.timestamp,
			toolName: part.name,
			toolCallId: part.id,
		});
		callIndex += 1;
	}
	return items;
}

/** Build stable internal addresses, then project the active branch into public events. */
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
	let window: DecodedHistoryWindow = { windowId: rootWindowId(sessionId), items: [] };
	const rawWindows = [window];
	const branchSeqs = new Set<number>();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (isWindowMarker(entry)) {
			window = { windowId: entry.data.windowId, createdAt: entry.timestamp, items: [] };
			rawWindows.push(window);
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
			});
			const calls = toolCallItems(window.windowId, entry, entry.message, entrySeq);
			for (const call of calls) branchSeqs.add(call.seq);
			window.items.push(...calls);
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

	return projectHistory(rawWindows, highestSeq, branchSeqs);
}
