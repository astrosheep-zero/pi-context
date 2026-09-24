import { Type } from "@earendil-works/pi-ai";
export const nullableString = () => Type.Optional(Type.Union([Type.String(), Type.Null()]));
export const positiveInteger = () => Type.Optional(Type.Integer({ minimum: 1 }));
export const historyRole = Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool_call"), Type.Literal("tool"), Type.Literal("system"), Type.Literal("developer")]);
export const historyRoles = () => Type.Optional(Type.Array(historyRole, { minItems: 1, description: "Show exactly these roles. user is a human turn; assistant is visible model text; tool_call is one invocation; tool is one result; system is a native compaction or branch summary; developer is any extension-injected message, including every custom_message. Use custom_type to select a developer message type." }));

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
