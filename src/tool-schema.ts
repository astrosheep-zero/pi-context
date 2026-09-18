import { Type } from "@earendil-works/pi-ai";
export const nullableString = () => Type.Optional(Type.Union([Type.String(), Type.Null()]));
export const positiveInteger = () => Type.Optional(Type.Integer({ minimum: 1 }));
export const cursor = () => Type.Optional(Type.Integer({ minimum: 0, description: "Continuation cursor: pass the previous next_cursor back unchanged, with the same filters and ordering. Omit to start. next_cursor is null only when the set is exhausted." }));
export const recentFirst = () => Type.Optional(Type.Boolean({ description: "Return newest-first. Only an explicit false returns oldest-first. Defaults to true." }));
/** Role filter. `developer` is the known author for this extension's own custom entries. */
export const role = Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool_call"), Type.Literal("tool"), Type.Literal("system"), Type.Literal("developer"), Type.Null()], { description: "Filter by the item's role. Exactly six: \"user\" and \"assistant\" are a message's visible text (assistant text never contains tool calls); \"tool_call\" is one tool invocation (tool_name set, content = the call's JSON arguments); \"tool\" is one tool run's output (tool_name set); \"system\" is a native Pi compaction summary; \"developer\" is an entry this extension authored (boot, guidance, warning, continuation messages, reset-window compaction summaries, any pi-context/* entry)." });

/** Search query parameter: one literal, or several literals combined with OR. */
export const searchQuery = () => Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })]);

/**
 * Normalize a search `query` parameter into the literal needles to match.
 * A bare string is a one-element list, so single-query behavior is unchanged.
 * An empty list, a non-string element, or an empty string is refused rather than silently
 * searching for nothing: those are argument errors, not empty result sets. An empty string
 * matches every line and every item, so it can never be what the caller meant.
 */
export function searchQueries(query: unknown): string[] {
	const candidates = typeof query === "string" ? [query] : query;
	if (!Array.isArray(candidates) || candidates.length === 0) throw new Error("query must be a string or a non-empty array of strings");
	if (!candidates.every((candidate) => typeof candidate === "string")) throw new Error("query array elements must be strings");
	if (candidates.some((candidate) => candidate === "")) throw new Error("query strings must be non-empty: an empty query matches everything");
	return candidates as string[];
}

