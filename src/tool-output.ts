export const TOOL_OUTPUT_MAX_BYTES = 32 * 1024;

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/** Build a page without ever adding an item that would exceed the wire budget. */
export function page<T>(items: T[], offset: number, key: string, limit?: number) {
	const end = Math.min(items.length, offset + (limit ?? items.length));
	const selected: T[] = [];
	let next = end < items.length ? end : null;
	for (let index = offset; index < end; index++) {
		const candidate = [...selected, items[index]];
		const candidateNext = index + 1 < end || end < items.length ? index + 1 : null;
		const value = { [key]: candidate, next_offset: candidateNext };
		if (Buffer.byteLength(json(value), "utf8") > TOOL_OUTPUT_MAX_BYTES) {
			next = index;
			break;
		}
		selected.push(items[index]);
	}
	return { [key]: selected, next_offset: next };
}

/** Encode a result through the common tool result boundary. */
export function output(value: unknown, details: unknown = value, terminate = false) {
	return { content: [{ type: "text" as const, text: json(value) }], details, terminate };
}
