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
