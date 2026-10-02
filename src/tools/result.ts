/** Shared outcomes and bounded read windows. Host envelopes belong to the adapters. */
import { Type, type Static, type TSchema } from "typebox";
import { DEFAULT_READ_WINDOW_CHARS, TOOL_OUTPUT_MAX_BYTES, withinTextBudget } from "./output.js";

/** `details` is sanitized context for a caller, never a payload or a file body. */
export const OperationErrorSchema = Type.Object({
	code: Type.String({ description: "Stable refusal code, for example not_found or invalid_offset." }),
	message: Type.String({ description: "One short sentence naming the refusal and the offending input." }),
	details: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Sanitized structured context: edit index, match line numbers, known window ids. Never a raw payload." })),
}, { additionalProperties: false });
export type OperationError = Static<typeof OperationErrorSchema>;

/** `data` exists without `error`, never both, never neither. */
export type Outcome<T> = { ok: true; data: T } | { ok: false; error: OperationError };

export function success<T>(data: T): Outcome<T> {
	return { ok: true, data };
}

/** A code is an internal stable identifier and is never clipped; the dynamic message and details are the bounded surface. */
export const ERROR_MESSAGE_MAX_CHARS = 2000;
export const ERROR_DETAILS_MAX_BYTES = 4096;

function boundedMessage(message: string): string {
	const chars = Array.from(message);
	return chars.length <= ERROR_MESSAGE_MAX_CHARS ? message : `${chars.slice(0, ERROR_MESSAGE_MAX_CHARS).join("")}…[truncated ${chars.length - ERROR_MESSAGE_MAX_CHARS} chars]`;
}

/** Oversized context becomes an explicit marker, and context JSON cannot serialize propagates instead of being swallowed. */
function boundedDetails(details: Record<string, unknown>): Record<string, unknown> {
	const json = JSON.stringify(details);
	const bytes = Buffer.byteLength(json, "utf8");
	return bytes <= ERROR_DETAILS_MAX_BYTES ? JSON.parse(json) as Record<string, unknown> : { truncated: true, details_bytes: bytes };
}

export function failure(code: string, message: string, details?: Record<string, unknown>): Outcome<never> {
	return {
		ok: false,
		error: {
			code,
			message: boundedMessage(message),
			...(details === undefined ? {} : { details: boundedDetails(details) }),
		},
	};
}

export function outcomeSchema<S extends TSchema>(dataSchema: S) {
	return Type.Union([
		Type.Object({ ok: Type.Literal(true), data: dataSchema }, { additionalProperties: false }),
		Type.Object({ ok: Type.Literal(false), error: OperationErrorSchema }, { additionalProperties: false }),
	]);
}

/** A refusal reads as one short line; a success is the operation's own reading of its data. */
export function renderOutcome<T>(result: Outcome<T>, renderData: (data: T) => string): string {
	if (result.ok) return renderData(result.data);
	const { code, message, details } = result.error;
	return `error: ${code}: ${message}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`;
}

/** Bytes of the structured payload as delivered: compact JSON, not the model-facing text. A value with no JSON representation has no size to measure. */
export function structuredBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * The one bound: the rendered text and the structured payload must both fit, and the rendered
 * measure covers everything the renderer puts around the payload, headers and footers included.
 */
export function fitsResult<T>(result: Outcome<T>, render: (result: Outcome<T>) => string): boolean {
	return withinTextBudget(render(result)) && structuredBytes(result) <= TOOL_OUTPUT_MAX_BYTES;
}

/** `text` is verbatim, with no marker inserted, so windows concatenate back into the source. */
export const TextWindowSchema = Type.Object({
	text: Type.String({ description: "The delivered slice, verbatim, with nothing inserted." }),
	offset_chars: Type.Integer({ minimum: 0, description: "Resolved absolute code-point offset this slice starts at." }),
	total_chars: Type.Integer({ minimum: 0, description: "Code-point length of the whole source text." }),
	next_offset_chars: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], { description: "Offset to pass back as offset_chars to continue; null only at the true end of the text." }),
	limited_by: Type.Union([Type.Literal("limit"), Type.Literal("bytes"), Type.Null()], { description: "Why the slice stopped before the end: the requested count (limit) or the byte cap (bytes); null when nothing was withheld." }),
}, { additionalProperties: false });
export type TextWindow = Static<typeof TextWindowSchema>;

/**
 * Read one code-point window of `text` and build the operation's data around it. `offset` and
 * `limit` are the integers the parameter schema already admitted; a negative `offset` resolves to
 * `max(0, total + offset)`, and the caller refuses an offset past the end.
 *
 * An envelope that cannot fit even empty is refused instead of returned: a zero-length window
 * would resume at the offset it started from, so paging could never make progress.
 */
export function readTextWindow<T>(
	text: string,
	offset: number | undefined,
	limit: number | undefined,
	makeData: (window: TextWindow) => T,
	render: (result: Outcome<T>) => string,
): Outcome<T> {
	const chars = Array.from(text);
	const requested = offset ?? 0;
	const start = requested < 0 ? Math.max(0, chars.length + requested) : requested;
	const requestedChars = limit ?? DEFAULT_READ_WINDOW_CHARS;
	const range = Math.min(requestedChars, chars.length - start);
	const window = (delivered: number): TextWindow => {
		const end = start + delivered;
		const withheld = end < chars.length;
		return {
			text: chars.slice(start, end).join(""),
			offset_chars: start,
			total_chars: chars.length,
			next_offset_chars: withheld ? end : null,
			limited_by: !withheld ? null : delivered === range ? "limit" : "bytes",
		};
	};
	const fits = (delivered: number): boolean => fitsResult(success(makeData(window(delivered))), render);
	// Test the full range first: its footer can disappear at the end of the document.
	if (fits(range)) return success(makeData(window(range)));
	let low = 0;
	let high = range;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(mid)) low = mid;
		else high = mid - 1;
	}
	if (low === 0) {
		return failure("output_too_large", "The response metadata leaves no room for a progressing read window.", { total_chars: chars.length, offset_chars: start, budget_bytes: TOOL_OUTPUT_MAX_BYTES });
	}
	return success(makeData(window(low)));
}

/** The continuation line never becomes part of `window.text`, and a complete window has none. */
export function renderTextWindow(window: TextWindow): string {
	const next = window.next_offset_chars;
	if (next === null) return window.text;
	const resume = `Use offset_chars=${next} to continue.`;
	if (window.limited_by === "limit") return `${window.text}\n\n[${window.total_chars - next} more characters. ${resume}]`;
	return `${window.text}\n\n[Showing chars [${window.offset_chars}, ${next}) of ${window.total_chars} (${TOOL_OUTPUT_MAX_BYTES / 1024}KB limit). ${resume}]`;
}

/** One outcome in, model-facing text out. */
export type Renderer<TData> = (result: Outcome<TData>) => string;

/** What both host adapters register: parameters in, canonical outcome out, and its text. */
export type Operation<TParams extends TSchema, TData, TRest extends readonly unknown[]> = {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TParams;
	/** Absent leaves concurrency to the host default. */
	readonly executionMode?: "sequential" | "parallel";
	readonly outputSchema: TSchema;
	readonly execute: (params: Static<TParams>, ...rest: TRest) => Promise<Outcome<TData>>;
	readonly render: Renderer<TData>;
};
