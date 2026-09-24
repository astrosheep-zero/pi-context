/**
 * Code-point offset of the earliest case-insensitive literal match, or -1 when
 * none occurs. Match against the original text so Unicode casing cannot shift offsets.
 */
export function earliestMatchOffsetChars(text: string, queries: string[]): number {
	let earliest = -1;
	for (const query of queries) {
		const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const index = new RegExp(literal, "iu").exec(text)?.index ?? -1;
		if (index < 0) continue;
		if (earliest < 0 || index < earliest) earliest = index;
	}
	return earliest < 0 ? -1 : Array.from(text.slice(0, earliest)).length;
}
