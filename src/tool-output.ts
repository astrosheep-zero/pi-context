export const TOOL_OUTPUT_MAX_BYTES = 32 * 1024;

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/** True when `value` serializes within the same wire budget `output()` enforces. */
export function withinBudget(value: unknown, budget = TOOL_OUTPUT_MAX_BYTES): boolean {
	return Buffer.byteLength(json(value), "utf8") <= budget;
}

/** True when `text` fits the wire budget verbatim, for raw payloads with no JSON encoding. */
export function withinTextBudget(text: string, budget = TOOL_OUTPUT_MAX_BYTES): boolean {
	return Buffer.byteLength(text, "utf8") <= budget;
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

/**
 * Fields every character-window read returns; each tool adds its own identity and metadata.
 * `offset_chars` is always the resolved absolute offset, and `next_offset_chars` is exactly
 * that offset plus the delivered code-point count, null only at the text's true end.
 */
export type CharacterWindow = {
	offset_chars: number;
	content: string;
	total_chars: number;
	next_offset_chars: number | null;
};

/**
 * Read one character window of `text`: the longest contiguous prefix of
 * `chars[resolved, resolved + limit)` that fits the wire budget.
 *
 * `offsetChars` is a code-point offset. A negative value counts back from the end and
 * resolves to `max(0, total_chars + offsetChars)`, so `-N` reaches the tail and any
 * `N >= total_chars` reads from the start; the resolved absolute offset is always echoed.
 * Following `next_offset_chars` reconstructs `text` by plain concatenation, because the
 * payload is always a plain prefix with no marker. `render` builds the exact response for
 * a candidate window, and `measure` decides whether that response fits the wire budget (JSON
 * serialization by default; raw-text renders pass a verbatim byte measure), so the budget is
 * always measured on the bytes that go on the wire.
 */
export function readCharacterWindow<T>(text: string, offsetChars: number | undefined, limitChars: number | undefined, render: (window: CharacterWindow) => T, measure: (rendered: T) => boolean = withinBudget): T {
	const chars = Array.from(text);
	const requested = offsetChars ?? 0;
	const resolved = requested < 0 ? Math.max(0, chars.length + requested) : Math.max(0, requested);
	const windowChars = chars.slice(resolved, resolved + Math.min(limitChars ?? 12000, 50000));
	const build = (content: string): CharacterWindow => {
		const next = resolved + Array.from(content).length;
		return { offset_chars: resolved, content, total_chars: chars.length, next_offset_chars: next < chars.length ? next : null };
	};
	const content = prefixFit(windowChars.join(""), (candidate) => measure(render(build(candidate))));
	return render(build(content));
}

/**
 * One-line bracketed header preceding a raw character-window payload: the identity, the
 * delivered char range, and either the resume cursor or `end`. `tail` appends extra
 * metadata (notes add their timestamps) inside the same brackets.
 */
export function characterWindowHeader(identity: string, window: CharacterWindow, tail = ""): string {
	// The range end is offset + delivered count, never `total_chars`: a read resolved past the
	// end delivers zero characters there, and the header must not render an inverted range.
	const end = window.offset_chars + Array.from(window.content).length;
	const resume = window.next_offset_chars === null ? "end" : `continue at offset_chars=${window.next_offset_chars}`;
	return `[${identity} · chars ${window.offset_chars}-${end} of ${window.total_chars} · ${resume}${tail}]`;
}

/**
 * Code-point offset of the earliest occurrence of any of `queries` in `text`, or 0 when
 * none occurs. Shared by the two search tools so a match address is computed identically.
 */
export function earliestMatchOffsetChars(text: string, queries: string[]): number {
	let earliest = -1;
	for (const query of queries) {
		const index = text.indexOf(query);
		if (index < 0) continue;
		if (earliest < 0 || index < earliest) earliest = index;
	}
	return earliest <= 0 ? 0 : Array.from(text.slice(0, earliest)).length;
}

/** Shrink a single page item to fit; only invoked when that item alone exceeds the budget. */
export type ItemTruncator<T> = (item: T, fits: (candidate: T) => boolean) => T;

/**
 * Build a page without ever adding an item that would exceed the wire budget.
 *
 * A single item that cannot fit is middle-truncated through the optional `truncate`
 * callback and still included, with `next_cursor` advanced past it. Without that treatment
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

/**
 * Encode a structured result through the common tool result boundary. `details` is slim
 * metadata for logs/UI (pi convention: never a second copy of the payload) and stays
 * undefined unless the tool has metadata worth persisting.
 */
export function output(value: unknown, details?: unknown, terminate = false) {
	return { content: [{ type: "text" as const, text: json(value) }], details, terminate };
}

/**
 * Encode a prose payload as raw text: a one-line bracketed metadata header, then the payload
 * verbatim. The model reads the note or history item itself instead of a JSON envelope;
 * `details` carries the slim metadata object and never duplicates the payload.
 */
export function outputRaw(header: string, content: string, details: unknown, terminate = false) {
	return { content: [{ type: "text" as const, text: `${header}\n${content}` }], details, terminate };
}
