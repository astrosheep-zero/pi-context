export const TOOL_OUTPUT_MAX_BYTES = 32 * 1024;

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/** True when `value` serializes within the same wire budget `output()` enforces. */
export function withinBudget(value: unknown, budget = TOOL_OUTPUT_MAX_BYTES): boolean {
	return Buffer.byteLength(json(value), "utf8") <= budget;
}

/** Marker standing in for characters elided from the middle of an oversized single unit. */
export function truncationMarker(removedChars: number): string {
	return `…[truncated ${removedChars} chars]…`;
}

/**
 * Middle-truncate `text` until `fits` accepts it, keeping a head and a tail joined by
 * `truncationMarker`. Codex's `truncate_middle` semantics: when one indivisible unit
 * (a note line, a single match, a history item) exceeds the wire budget on its own, it is
 * still returned — visibly truncated — so cursors advance and no page comes back empty.
 * Returns `text` unchanged when it already fits.
 */
export function middleTruncate(text: string, fits: (content: string) => boolean): string {
	if (fits(text)) return text;
	const chars = Array.from(text);
	const build = (kept: number) => {
		const head = Math.ceil(kept / 2);
		return chars.slice(0, head).join("") + truncationMarker(chars.length - kept) + chars.slice(chars.length - (kept - head)).join("");
	};
	// The serialized size is non-decreasing in `kept` (each kept character adds at least one
	// byte while the marker loses at most one digit), so a binary search finds the largest
	// keep count that still fits.
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(build(mid))) low = mid;
		else high = mid - 1;
	}
	return build(low);
}

/**
 * Longest contiguous prefix of `text` (counted in code points) accepted by `fits`.
 *
 * This is the truncation used by every cursor-bearing payload: the delivered text is
 * always a plain prefix of the original, so a cursor computed from its code-point length
 * addresses exactly the first undelivered character. No marker character is ever appended;
 * the companion `truncated`/`total_chars` fields name what was left out.
 */
export function prefixFit(text: string, fits: (content: string) => boolean): string {
	if (fits(text)) return text;
	const chars = Array.from(text);
	// Serialized size is non-decreasing in the kept count, so the largest fitting prefix is
	// found by a monotone binary search instead of a quadratic shrink loop.
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(chars.slice(0, mid).join(""))) low = mid;
		else high = mid - 1;
	}
	// A candidate's serialized size can dip by a byte or two at the very end (a numeric cursor
	// becoming null), so the predicate is not perfectly monotone at the tail. Back off until the
	// returned prefix provably fits; in the monotone case this loop never runs.
	while (low > 0 && !fits(chars.slice(0, low).join(""))) low -= 1;
	return chars.slice(0, low).join("");
}

/** Shrink a single page item to fit; only invoked when that item alone exceeds the budget. */
export type ItemTruncator<T> = (item: T, fits: (candidate: T) => boolean) => T;

/**
 * Build a page without ever adding an item that would exceed the wire budget.
 *
 * A single item that cannot fit is middle-truncated through the optional `truncate`
 * callback and still included, with `next_cursor` advanced past it. Without that fallback
 * an oversized item would yield an empty page forever: the cursor would keep pointing back
 * at the same index.
 */
export function page<T>(items: T[], cursor: number, key: string, limit?: number, truncate?: ItemTruncator<T>) {
	const end = Math.min(items.length, cursor + (limit ?? items.length));
	const selected: T[] = [];
	let next = end < items.length ? end : null;
	for (let index = cursor; index < end; index++) {
		const candidateNext = index + 1 < end || end < items.length ? index + 1 : null;
		const fits = (list: T[]) => withinBudget({ [key]: list, next_cursor: candidateNext });
		if (!fits([...selected, items[index]])) {
			if (selected.length === 0 && truncate) {
				selected.push(truncate(items[index], (candidate) => fits([candidate])));
				next = candidateNext;
			} else {
				next = index;
			}
			break;
		}
		selected.push(items[index]);
	}
	return { [key]: selected, next_cursor: next };
}

/** Encode a result through the common tool result boundary. */
export function output(value: unknown, details: unknown = value, terminate = false) {
	return { content: [{ type: "text" as const, text: json(value) }], details, terminate };
}
