import { Type } from "@earendil-works/pi-ai";
export const nullableString = () => Type.Optional(Type.Union([Type.String(), Type.Null()]));
export const positiveInteger = () => Type.Optional(Type.Integer({ minimum: 1 }));
export const cursor = () => Type.Optional(Type.Integer({ minimum: 0, description: "Continuation cursor: pass the previous next_cursor back unchanged, with the same filters and ordering. Omit to start. next_cursor is null only when the set is exhausted." }));
export const recentFirst = () => Type.Optional(Type.Boolean({ description: "Return newest-first. Only an explicit false returns oldest-first. Defaults to true." }));
/** Role filter. `developer` is the known author for this extension's own custom entries. */
export const role = Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"), Type.Literal("system"), Type.Literal("developer"), Type.Null()], { description: "Filter by the entry's known author: user/assistant/tool from the conversation, system for native Pi compaction summaries, developer for entries this extension authored (its boot, guidance, warning, and continuation messages, its reset-window compaction summaries, and any other pi-context/* entry)." });

/** Search query parameter: one literal, or several literals combined with OR. */
export const searchQuery = () => Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })]);

/**
 * Normalize a search `query` parameter into the literal needles to match.
 * A bare string is a one-element list, so single-query behavior is unchanged.
 * An empty list or a non-string element is refused rather than silently searching
 * for nothing: an empty array is an argument error, not an empty result set.
 */
export function searchQueries(query: unknown): string[] {
	if (typeof query === "string") return [query];
	if (!Array.isArray(query) || query.length === 0) throw new Error("query must be a string or a non-empty array of strings");
	if (!query.every((candidate) => typeof candidate === "string")) throw new Error("query array elements must be strings");
	return query as string[];
}

