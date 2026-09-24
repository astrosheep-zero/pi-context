import { Type } from "@earendil-works/pi-ai";
import { defineTool, generateDiffString, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { localIso } from "../../notes/frontmatter.js";
import { createNotesStore, NoteError, type NoteChange, type NoteReadResult, type NoteRow, type NoteSearchRow, type Origin } from "../../notes/index.js";
import { DEFAULT_READ_WINDOW_CHARS, MAX_READ_WINDOW_CHARS, middleTruncate, output, outputRaw, prefixFit, readCharacterWindow, readWindowBlock, withinBudget, withinTextBudget } from "../../tool-output.js";
import { nullableString, positiveInteger, searchQueries, searchQuery } from "../../tool-schema.js";
import { notesContextFromPi } from "./adapter.js";

const ORIGIN = Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("self"), Type.Literal("external")], {
	description: "Where the note's content came from. user: written or dictated by the human. self: written by you, the agent (default). external: anything else — third-party text, tool output, fetched material.",
}));
const ADDRESS_DESCRIPTION = "Address forms are bare `<vpath>` for this session, `@project/<vpath>` for this project, `@human/<vpath>` for the human's cross-project notes, `@self/<vpath>` for your own, and `@model/<vpath>` for the current model's. `@self` and `@model` mean whoever is running now. Any other `@` prefix, or `@` inside a vpath, is a hard error. There is no fallback across prefixes. Paths reject `..`, absolute paths, and backslashes.";

function failure(error: unknown) {
	if (error instanceof NoteError) {
		const payload: Record<string, unknown> = { error: error.message };
		if (error.lineNumbers) payload.line_numbers = error.lineNumbers;
		if (error.editIndex !== undefined) payload.edit_index = error.editIndex;
		return output(payload);
	}
	throw error;
}

function renderDiff(change: NoteChange): string {
	if (change.kind === "none") return "";
	return generateDiffString(change.before, change.after).diff;
}

function snapshot<T>(rows: T[], limit: number | undefined, truncate: (item: T, fits: (candidate: T) => boolean) => T): { files: T[]; more: number } {
	const selected: T[] = [];
	const maxItems = Math.min(rows.length, limit ?? rows.length);
	const response = (files: T[]) => ({ files, more: rows.length - files.length });
	for (let index = 0; index < maxItems; index++) {
		const item = rows[index]!;
		const fits = (candidate: T) => withinBudget(response([...selected, candidate]));
		if (fits(item)) {
			selected.push(item);
			continue;
		}
		if (selected.length === 0) selected.push(truncate(item, fits));
		break;
	}
	return response(selected);
}

function byRecent<T extends { address: string; meta: { updatedAt: number } }>(a: T, b: T): number {
	return b.meta.updatedAt - a.meta.updatedAt || a.address.localeCompare(b.address);
}

export function registerNotesTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "notes_write", label: "Notes write",
		description: `Create or replace a note as a real markdown file, and name it for what it holds: a fresh window sees only an index entry, never the note itself. ${ADDRESS_DESCRIPTION} Keep notes small and split by topic — by what the note is about, never by who said it (authorship is origin's job); a rewrite replaces the body whole while preserving createdAt and every other frontmatter key. stale: true marks the note closed so it leaves the boot index but stays readable and searchable.`,
		parameters: Type.Object({ address: Type.String(), content: Type.String(), origin: ORIGIN, stale: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const content = params.content;
			try {
				await createNotesStore(notesContextFromPi(ctx)).write(params.address, content, { origin: (params.origin ?? "self") as Origin, stale: params.stale });
				return output({ address: params.address, written: true });
			} catch (error) { return failure(error); }
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_edit", label: "Notes edit",
		description: `Edit a note body by exact-text replacement; frontmatter is never editable this way. ${ADDRESS_DESCRIPTION} Each oldText must occur exactly once unless replace_all is set; a multi-match anchor fails with its match line numbers and a zero-match anchor names the failing edit index. edits may be omitted (or empty) for a metadata-only update, which requires at least one of origin/stale. Moving while awake means notes_write at a new address and notes_edit at the old address with stale=true. The success return carries the address and a diff of what changed.`,
		parameters: Type.Object({ address: Type.String(), edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }, { additionalProperties: false }))), origin: ORIGIN, stale: Type.Optional(Type.Boolean()), replace_all: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const { applied, change } = await createNotesStore(notesContextFromPi(ctx)).edit(params.address, params.edits, { origin: params.origin as Origin | undefined, stale: params.stale, replaceAll: params.replace_all });
				const diff = renderDiff(change);
				return output({ address: params.address, applied, diff });
			} catch (error) { return failure(error); }
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_read", label: "Notes read",
		description: `Read a character window of a note file, frontmatter included. ${ADDRESS_DESCRIPTION} offset_chars is the code-point offset to start from (default 0) — a negative value counts back from the end — and limit_chars caps the window (default ${DEFAULT_READ_WINDOW_CHARS}, max ${MAX_READ_WINDOW_CHARS}). Each response delivers the longest fitting prefix of that window in the shared READ WINDOW block: concatenate only the content after the block to reconstruct the note.`,
		parameters: Type.Object({ address: Type.String(), offset_chars: Type.Optional(Type.Integer({ description: "Code-point offset to start from (default 0). A negative value counts back from the end; the response echoes the resolved absolute offset. Pass the previous next_offset_chars back unchanged to continue." })), limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: `Largest requested window in code points (default ${DEFAULT_READ_WINDOW_CHARS}). A window too large for the wire budget is cut short; next_offset_chars names where the next read resumes.` })) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			let note: NoteReadResult | undefined;
			try {
				note = await createNotesStore(notesContextFromPi(ctx)).read(params.address);
			} catch (error) { return failure(error); }
			if (!note) return output({ error: "note not found", address: params.address });
			const text = note.text;
			const totalChars = Array.from(text).length;
			if (typeof params.offset_chars === "number" && params.offset_chars > totalChars) return output({ error: `offset_chars ${params.offset_chars} is past the end: the note has ${totalChars} chars; the largest legal offset is ${totalChars} (an empty end-read)`, address: params.address, offset_chars: params.offset_chars, total_chars: totalChars });
			return readCharacterWindow(text, params.offset_chars, params.limit_chars, (window) => {
				const { content, ...rest } = window;
				return outputRaw(readWindowBlock([["address", params.address]], window), content, { address: params.address, ...rest });
			}, (result) => withinTextBudget(result.content[0].text));
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_list", label: "Notes list",
		description: `List note files as a recent-first snapshot carrying address, updated_at, and stale. more is the number of matching files omitted by limit or the wire budget; use pattern to narrow the address range. ${ADDRESS_DESCRIPTION} Listings merge your five prefixes: this session, @project/, @human/, @self/, and @model/.`,
		parameters: Type.Object({ pattern: nullableString(), limit: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			let rows: NoteRow[];
			try { rows = await createNotesStore(notesContextFromPi(ctx)).list({ pattern: params.pattern ?? undefined }); } catch (error) { return failure(error); }
			const files: Array<{ address: string; stale: boolean; updated_at: string; address_truncated?: boolean }> = rows.map((row) => ({ address: row.address, stale: row.meta.stale, updated_at: localIso(row.meta.updatedAt) }));
			return output(snapshot(files, params.limit, (file, fits) => {
				const address = middleTruncate(file.address, (candidate) => fits({ ...file, address: candidate, address_truncated: true }));
				return { ...file, address, address_truncated: true };
			}));
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_search", label: "Notes search",
		description: `Case-insensitive literal substring search over note bodies; query is one string or several (OR), each matched line appears once. Results are a recent-first snapshot, not pageable; more counts matching files omitted by limit or the wire budget. Use pattern to narrow the address range. ${ADDRESS_DESCRIPTION} Search merges the same five prefixes as notes_list. Patterns glob over full address strings. Each file entry carries matches_total, its full match count before per-file capping. Each match carries line, text, offset_chars (a code-point offset into the serialized note returned by notes_read, at the earliest query match), and truncated (some line text is omitted). Pass address and offset_chars to notes_read to read from the match.`,
		parameters: Type.Object({ query: searchQuery(), pattern: nullableString(), limit: positiveInteger(), max_matches_per_file: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const queries = searchQueries(params.query);
			let rows: NoteSearchRow[];
			try { rows = await createNotesStore(notesContextFromPi(ctx)).search(queries, { pattern: params.pattern ?? undefined }); } catch (error) { return failure(error); }
			const maxPerFile = params.max_matches_per_file ?? Number.POSITIVE_INFINITY;
			rows.sort(byRecent);
			const result: Array<{ address: string; updated_at: string; stale: boolean; matches_total: number; matches: Array<{ line: number; text: string; truncated: boolean; offset_chars: number }>; address_truncated?: boolean }> = rows.map((row) => {
				const matches = row.matches.map((match) => ({ line: match.line, text: match.text, truncated: false, offset_chars: match.offsetChars }));
				return { address: row.address, updated_at: localIso(row.meta.updatedAt), stale: row.meta.stale, matches_total: matches.length, matches: matches.slice(0, maxPerFile) };
			});
			const fitFile = (file: (typeof result)[number], fits: (candidate: (typeof result)[number]) => boolean) => {
				const matches = file.matches;
				let low = 0;
				let high = matches.length;
				while (low < high) {
					const mid = Math.ceil((low + high) / 2);
					if (mid >= 1 && fits({ ...file, matches: matches.slice(0, mid) })) low = mid;
					else high = mid - 1;
				}
				if (low >= 1) return { ...file, matches: matches.slice(0, low) };
				const first = matches[0]!;
				const fitted = (text: string): (typeof result)[number] => ({ ...file, matches: [{ ...first, text, truncated: true }] });
				const text = prefixFit(first.text, (candidate) => fits(fitted(candidate)));
				const prefix = fitted(text);
				if (fits(prefix)) return prefix;
				const address = middleTruncate(prefix.address, (candidate) => fits({ ...prefix, address: candidate, address_truncated: true }));
				return { ...prefix, address, address_truncated: true };
			};
			return output(snapshot(result, params.limit, fitFile));
		},
	}));
}
