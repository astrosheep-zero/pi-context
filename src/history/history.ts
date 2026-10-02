/** Recorded facts stay whole; only the metadata returned beside a read window is bounded. */
import { Type, type Static } from "typebox";
import { structuredBytes } from "../tools/result.js";

/** Oversized arguments remain readable in the document, but become a byte count in metadata. */
export const MAX_EXECUTION_ARGUMENT_BYTES = 8 * 1024;

/** Bound nested metadata by omitting whole records, with an explicit omission count. */
export const MAX_NESTED_CALLS_BYTES = 8 * 1024;

/** The four public roles a history event carries on the wire, in presentation order. */
export const HistoryRoleSchema = Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"), Type.Literal("context")]);
export type HistoryRole = Static<typeof HistoryRoleSchema>;

/** How a recorded tool run ended. A call with no recorded result has not ended. */
export const ToolCallStatusSchema = Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("unfinished")]);
export type ToolCallStatus = Static<typeof ToolCallStatusSchema>;

/** Native nested-call evidence: no invented child result body or history seq. */
export const NestedCallRecordSchema = Type.Object({
	id: Type.String({ description: "Host-assigned id of the nested call. It is not a history seq." }),
	name: Type.String(),
	arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	argumentsBytes: Type.Optional(Type.Integer({ minimum: 0, description: "Serialized size of the arguments, present exactly when arguments were omitted." })),
	status: ToolCallStatusSchema,
	durationMs: Type.Optional(Type.Number({ minimum: 0 })),
	error: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type NestedCallRecord = Static<typeof NestedCallRecordSchema>;

/** Recorded facts as the host stored them: whole records, unbounded. */
export type RecordedNestedCalls = Pick<NestedCalls, "calls" | "complete">;

/** Preserve the host's completeness flag; report our omissions separately. */
export const NestedCallsSchema = Type.Object({
	calls: Type.Array(NestedCallRecordSchema),
	complete: Type.Boolean({ description: "The host's completeness flag, preserved as recorded." }),
	trimmed: Type.Optional(Type.Boolean({ description: "True when records were withheld to stay bounded." })),
	omittedCalls: Type.Optional(Type.Integer({ minimum: 1, description: "How many records were withheld. An empty list with this set means withheld, not none." })),
}, { additionalProperties: false });
export type NestedCalls = Static<typeof NestedCallsSchema>;

/** Metadata beside the read window, without a second copy of the output. */
export const ToolExecutionSchema = Type.Object({
	name: Type.String(),
	status: ToolCallStatusSchema,
	arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	argumentsBytes: Type.Optional(Type.Integer({ minimum: 0, description: "Serialized size of the arguments, present exactly when they were withheld from this copy. The document still carries them." })),
	outputTruncated: Type.Optional(Type.Boolean({ description: "The persisted output was truncated and the full text is on disk." })),
	fullOutputPath: Type.Optional(Type.String()),
	nestedCalls: Type.Optional(NestedCallsSchema),
}, { additionalProperties: false });
export type ToolExecution = Static<typeof ToolExecutionSchema>;

/** Tool facts as recorded, unbounded. `HistoryEvent` holds these; the wire sees a bounded projection. */
export type ToolExecutionFacts = Omit<ToolExecution, "argumentsBytes" | "nestedCalls"> & { nestedCalls?: RecordedNestedCalls };

/** One projection event: its facts, and the document they render to. */
export type HistoryEvent = {
	seq: number;
	windowId: string;
	role: HistoryRole;
	createdAt: string | undefined;
	/** Message body for user/assistant/context; the run's output for a tool event. */
	text: string;
	/** Whole recorded facts; executionMetadata bounds only the returned copy. */
	execution?: ToolExecutionFacts;
};

export type HistoryWindow = { windowId: string; createdAt?: string; items: HistoryEvent[] };

/** Paired result seqs stay on the branch but redirect readers to the call's event. */
export type HistoryProjection = { windows: HistoryWindow[]; highestSeq: number; branchSeqs: Set<number>; pairedResults: Map<number, number> };
export type HistoryFilter = { window_id?: string | null; roles?: HistoryRole[] | null };

/** Native entries after the adapter allocates seqs and selects the active branch. */
export type DecodedHistoryItem = {
	seq: number;
	windowId: string;
	role: "user" | "assistant" | "tool_call" | "tool" | "system" | "developer";
	/** Message body; for a tool call or result, the arguments or output text respectively. */
	text: string;
	createdAt?: string;
	toolName?: string;
	/** Internal pairing key; never serialized. */
	toolCallId?: string;
	/** The recorded arguments object, exactly as the host stored it. */
	arguments?: Record<string, unknown>;
	outputTruncated?: boolean;
	fullOutputPath?: string;
	/** The run reported an error. */
	toolError?: boolean;
	/** Native outcome for a standalone run (e.g. bash exit status). */
	recordedStatus?: ToolCallStatus;
	/** toolResult only: the calls this run made to other tools. */
	nestedCalls?: RecordedNestedCalls;
};

export type DecodedHistoryWindow = { windowId: string; createdAt?: string; items: DecodedHistoryItem[] };

function isTextContent(part: unknown): part is { type: "text"; text: string } {
	return typeof part === "object" && part !== null && (part as { type: "text"; text: string }).type === "text" && typeof (part as { type: "text"; text: string }).text === "string";
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter(isTextContent).map((part) => part.text).join("\n") : "";
}

/** Withhold oversized JSON whole, never return a truncated arguments object. */
function boundedArguments(value: ToolExecutionFacts["arguments"]): Pick<ToolExecution, "arguments" | "argumentsBytes"> {
	if (value === undefined) return {};
	const bytes = structuredBytes(value);
	return bytes > MAX_EXECUTION_ARGUMENT_BYTES ? { argumentsBytes: bytes } : { arguments: value };
}

/** Keep fitting records in order, counting every record omitted. */
function boundedNestedCalls(recorded: RecordedNestedCalls): NestedCalls {
	const calls: NestedCallRecord[] = [];
	let bytes = 0;
	let omitted = 0;
	for (const call of recorded.calls) {
		const size = structuredBytes(call);
		if (bytes + size > MAX_NESTED_CALLS_BYTES) {
			omitted += 1;
			continue;
		}
		calls.push(call);
		bytes += size;
	}
	if (omitted === 0) return { calls, complete: recorded.complete };
	return { calls, complete: recorded.complete, trimmed: true, omittedCalls: omitted };
}

/** Bound metadata without changing the facts used for documents and search. */
export function executionMetadata(event: HistoryEvent): ToolExecution | undefined {
	const execution = event.execution;
	if (execution === undefined) return undefined;
	return {
		name: execution.name,
		status: execution.status,
		...boundedArguments(execution.arguments),
		...(execution.outputTruncated ? { outputTruncated: true, ...(execution.fullOutputPath ? { fullOutputPath: execution.fullOutputPath } : {}) } : {}),
		...(execution.nestedCalls ? { nestedCalls: boundedNestedCalls(execution.nestedCalls) } : {}),
	};
}

function argumentText(execution: ToolExecutionFacts): string {
	return execution.arguments === undefined ? "(arguments not recorded)" : JSON.stringify(execution.arguments);
}

function nestedCallLine(call: NestedCallRecord): string {
	const parts = [`${call.name} [${call.status}]`];
	if (call.durationMs !== undefined) parts.push(`${call.durationMs}ms`);
	if (call.error !== undefined) parts.push(`error: ${call.error}`);
	parts.push(call.arguments === undefined ? (call.argumentsBytes === undefined ? "(arguments not recorded)" : `(arguments omitted: ${call.argumentsBytes} bytes)`) : JSON.stringify(call.arguments));
	return `- ${parts.join(" ")}`;
}

/** Canonical searchable/readable text, without UI headers or continuation footers. */
export function historyDocument(event: HistoryEvent): string {
	if (event.execution === undefined) return event.text;
	const sections = [`${event.execution.name} ${argumentText(event.execution)}`];
	// An unfinished call has no recorded output at all, and saying so by omission is truthful.
	if (event.text !== "") sections.push(`--- output ---\n${event.text}`);
	const nested = event.execution.nestedCalls;
	if (nested !== undefined) {
		const header = nested.complete ? "complete" : "incomplete";
		sections.push(`--- nested calls (${header}, ${nested.calls.length} recorded) ---\n${nested.calls.map(nestedCallLine).join("\n")}`);
	}
	return sections.join("\n");
}

const documents = new WeakMap<HistoryEvent, string>();

/** Memoized `historyDocument`: search, preview, and read must agree on the same characters. */
export function eventDocument(event: HistoryEvent): string {
	const cached = documents.get(event);
	if (cached !== undefined) return cached;
	const text = historyDocument(event);
	documents.set(event, text);
	return text;
}

/** Pair a call with its result, or preserve a standalone run's recorded outcome. */
function toolEvent(item: DecodedHistoryItem, result?: DecodedHistoryItem): HistoryEvent {
	const run = result ?? item;
	// Only a call without a result is unfinished; standalone results carry their own outcome.
	const status: ToolCallStatus = item.role === "tool_call" && result === undefined
		? "unfinished"
		: run.recordedStatus ?? (run.toolError === true ? "error" : "ok");
	const truncated = run.outputTruncated === true;
	return {
		seq: item.seq,
		windowId: item.windowId,
		role: "tool",
		text: result?.text ?? (item.role === "tool" ? item.text : ""),
		createdAt: item.createdAt,
		execution: {
			name: item.toolName ?? "unknown",
			status,
			// A call records its arguments; a bare result records none, and gets none invented.
			...(item.arguments === undefined ? {} : { arguments: item.arguments }),
			...(truncated ? { outputTruncated: true, ...(run.fullOutputPath ? { fullOutputPath: run.fullOutputPath } : {}) } : {}),
			...(run.nestedCalls ? { nestedCalls: run.nestedCalls } : {}),
		},
	};
}

/** Pair results into call events; consumed result seqs are not alternate read addresses. */
export function projectHistory(rawWindows: DecodedHistoryWindow[], highestSeq: number, branchSeqs: Set<number>): HistoryProjection {
	const raw = rawWindows.flatMap((current) => current.items);
	const resultsById = new Map<string, DecodedHistoryItem>();
	for (const item of raw) {
		if (item.role === "tool" && item.toolCallId && !resultsById.has(item.toolCallId)) resultsById.set(item.toolCallId, item);
	}
	const pairedResults = new Map<number, number>();
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
					pairedResults.set(paired.seq, item.seq);
				}
				return [toolEvent(item, paired)];
			}
			if (item.role === "tool") return [toolEvent(item)];
			return [{ seq: item.seq, windowId: item.windowId, role: item.role === "system" || item.role === "developer" ? "context" : item.role, text: item.text, createdAt: item.createdAt }];
		}),
	}));
	return { windows, highestSeq, branchSeqs, pairedResults };
}

const nullableString = Type.Optional(Type.Union([Type.String(), Type.Null()]));

/** Pages count all recorded nested calls; history_read carries the bounded records. */
export const NestedCallSummarySchema = Type.Object({
	call_count: Type.Integer({ minimum: 0, description: "Nested call records carried on this event." }),
	complete: Type.Boolean({ description: "The host's completeness flag, preserved as recorded." }),
}, { additionalProperties: false });

/** Stable identity and a verbatim preview, starting at the search match when present. */
export const HistoryPageItemSchema = Type.Object({
	seq: Type.Integer({ minimum: 1, description: "Stable file-order address of this event." }),
	window_id: Type.String(),
	role: HistoryRoleSchema,
	created_at: Type.Union([Type.String(), Type.Null()]),
	tool: Type.Optional(Type.String({ description: "Tool name; present on tool events only, and absent when tool_name_omitted is set." })),
	tool_name_omitted: Type.Optional(Type.Boolean({ description: "The tool name did not fit this page and was left out rather than shortened. The event still has one; read it by seq." })),
	tool_status: Type.Optional(ToolCallStatusSchema),
	output_truncated: Type.Optional(Type.Boolean()),
	full_output_path: nullableString,
	nested_calls: Type.Optional(NestedCallSummarySchema),
	truncated: Type.Boolean({ description: "True when the preview omits part of the document; history_read returns all of it." }),
	total_chars: Type.Integer({ minimum: 0, description: "Code-point length of the whole document." }),
	content: Type.String({ description: "Verbatim preview of the document, starting at offset_chars." }),
	offset_chars: Type.Optional(Type.Integer({ minimum: 0, description: "Search only: code-point offset of the earliest match, and where this preview starts." })),
}, { additionalProperties: false });
export type HistoryPageItem = Static<typeof HistoryPageItemSchema>;

/** A run of tool/context events the conversation view replaces with counts. */
export const HistoryFoldedRowSchema = Type.Object({
	folded: Type.Literal(true),
	first_seq: Type.Integer({ minimum: 1 }),
	last_seq: Type.Integer({ minimum: 1 }),
	count: Type.Integer({ minimum: 1, description: "Events in this fold, always the true total." }),
	tools: Type.Record(Type.String(), Type.Integer({ minimum: 1 }), { description: "Tool name to event count within this fold, for the names that fit." }),
	omitted_tools: Type.Optional(Type.Integer({ minimum: 1, description: "Distinct tool names not listed here; absent when every name fitted." })),
}, { additionalProperties: false });
export type HistoryFoldedRow = Static<typeof HistoryFoldedRowSchema>;

/** Bound fold summaries while preserving exact counts in count/omitted_tools. */
export const MAX_FOLD_TOOL_NAMES = 20;

/** Longest tool name a fold row lists; longer names are counted in `omitted_tools` instead. */
export const MAX_FOLD_TOOL_NAME_CHARS = 120;

/** A bounded preview of one event from `matchOffset` on, plus its identity facts. */
export function visibleItem(event: HistoryEvent, maxChars: number, matchOffset?: number): HistoryPageItem {
	const document = eventDocument(event);
	const chars = Array.from(document);
	const start = matchOffset ?? 0;
	const truncated = start > 0 || start + maxChars < chars.length;
	const execution = event.execution;
	return {
		seq: event.seq,
		window_id: event.windowId,
		role: event.role,
		created_at: event.createdAt ?? null,
		...(execution ? { tool: execution.name, tool_status: execution.status } : {}),
		...(execution?.outputTruncated ? { output_truncated: true, full_output_path: execution.fullOutputPath ?? null } : {}),
		...(execution?.nestedCalls ? { nested_calls: { call_count: execution.nestedCalls.calls.length, complete: execution.nestedCalls.complete } } : {}),
		truncated,
		total_chars: chars.length,
		content: truncated ? chars.slice(start, start + maxChars).join("") : document,
		...(matchOffset === undefined ? {} : { offset_chars: matchOffset }),
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
	if (!params.roles && mode === "list") items = items.filter((item) => (item.role === "user" || item.role === "assistant") && eventDocument(item) !== "");
	return items.sort((a, b) => a.seq - b.seq);
}