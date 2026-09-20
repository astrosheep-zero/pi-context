import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { localIso } from "./model.js";
import { characterWindowHeader, DEFAULT_READ_WINDOW_CHARS, MAX_READ_WINDOW_CHARS, middleTruncate, output, outputRaw, page, prefixFit, readCharacterWindow, withinTextBudget } from "../tool-output.js";
import { cursor, nullableString, positiveInteger, searchQueries, searchQuery } from "../tool-schema.js";
import { assertAddress } from "./address.js";
import { serializeNote, stripLeadingFrontmatter, type NoteMeta, type Origin } from "./frontmatter.js";
import { NoteError, editNote, listNotes, readNote, searchNotes, writeNote } from "./store.js";

const ORIGIN = Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("self"), Type.Literal("external")], {
	description: "Where the note's content came from. user: written or dictated by the human. self: written by you, the agent (default). external: anything else — third-party text, tool output, fetched material.",
}));
const ADDRESS_DESCRIPTION = "Address forms are bare `<vpath>` for this session, `@project/<vpath>` for this project's home, and `@global/<vpath>` for the global home. `@` means leaving home. Any other `@` prefix, or `@` inside a vpath, is a hard error: legal prefixes are `@project/` and `@global/`; bare names are the session home. There is no cross-home fallback. Paths reject `..`, absolute paths, and backslashes.";

function wireMeta(meta: NoteMeta): Record<string, unknown> {
	return { ...meta, created_at: localIso(meta.created_at), updated_at: localIso(meta.updated_at), last_accessed: localIso(meta.last_accessed) };
}

function failure(error: unknown) {
	if (error instanceof NoteError) {
		const payload: Record<string, unknown> = { error: error.message };
		if (error.line_numbers) payload.line_numbers = error.line_numbers;
		if (error.edit_index !== undefined) payload.edit_index = error.edit_index;
		return output(payload);
	}
	throw error;
}

export function registerNotesTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "notes_write", label: "Notes write",
		description: `Create or replace a note as a real markdown file, and name it for what it holds: a fresh window sees only an index entry, never the note itself. ${ADDRESS_DESCRIPTION} Keep notes small and split by topic — by what the note is about, never by who said it (authorship is origin's job); a rewrite replaces the body whole while preserving created_at and every other frontmatter key. stale: true marks the note closed so it leaves the boot index but stays readable and searchable.`,
		parameters: Type.Object({ address: Type.String(), content: Type.String(), origin: ORIGIN, stale: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const content = params.content;
			try {
				const destination = assertAddress(params.address);
				const { meta } = writeNote(ctx, destination.path, content, { scope: destination.scope, origin: (params.origin ?? "self") as Origin, stale: params.stale });
				return output({ address: params.address, scope: meta.scope, size_bytes: Buffer.byteLength(stripLeadingFrontmatter(content), "utf8"), meta: wireMeta(meta) });
			} catch (error) { return failure(error); }
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_edit", label: "Notes edit",
		description: `Edit a note body by exact-text replacement; frontmatter is never editable this way. ${ADDRESS_DESCRIPTION} Each oldText must occur exactly once unless replace_all is set; a multi-match anchor fails with its match line numbers and a zero-match anchor names the failing edit index. edits may be omitted (or empty) for a metadata-only update, which requires at least one of origin/stale. Moving while awake means notes_write at a new address and notes_edit at the old address with stale=true. The success return carries resolved_scope and a diff of what changed.`,
		parameters: Type.Object({ address: Type.String(), edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }, { additionalProperties: false }))), origin: ORIGIN, stale: Type.Optional(Type.Boolean()), replace_all: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const destination = assertAddress(params.address);
				const { meta, applied, resolved_scope, diff } = editNote(ctx, destination.path, destination.scope, params.edits, { origin: params.origin as Origin | undefined, stale: params.stale, replaceAll: params.replace_all });
				return output({ address: params.address, applied, resolved_scope, diff, meta: wireMeta(meta) });
			} catch (error) { return failure(error); }
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_read", label: "Notes read",
		description: `Read a character window of a note file, frontmatter included. ${ADDRESS_DESCRIPTION} offset_chars is the code-point offset to start from (default 0) — a negative value counts back from the end — and limit_chars caps the window (default ${DEFAULT_READ_WINDOW_CHARS}, max ${MAX_READ_WINDOW_CHARS}). Each response delivers the longest fitting prefix of that window: concatenate pages in order to reconstruct the note. The response is the raw frontmatter + body behind a one-line [bracketed] header naming the address, the resolved offset, the delivered char range, and the resume cursor.`,
		parameters: Type.Object({ address: Type.String(), offset_chars: Type.Optional(Type.Integer({ description: "Code-point offset to start from (default 0). A negative value counts back from the end; the response echoes the resolved absolute offset. Pass the previous next_offset_chars back unchanged to continue." })), limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: `Largest requested window in code points (default ${DEFAULT_READ_WINDOW_CHARS}). A window too large for the wire budget is cut short; next_offset_chars names where the next read resumes.` })) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			let note: ReturnType<typeof readNote>;
			try {
				const destination = assertAddress(params.address);
				note = readNote(ctx, destination.path, destination.scope);
			} catch (error) { return failure(error); }
			if (!note) return output({ error: "note not found", address: params.address });
			const text = serializeNote(note.meta, note.body);
			const totalChars = Array.from(text).length;
			if (typeof params.offset_chars === "number" && params.offset_chars > totalChars) return output({ error: `offset_chars ${params.offset_chars} is past the end: the note has ${totalChars} chars; the largest legal offset is ${totalChars} (an empty end-read)`, address: params.address, offset_chars: params.offset_chars, total_chars: totalChars });
			const created_at = localIso(note.meta.created_at);
			const updated_at = localIso(note.meta.updated_at);
			const limit_chars = Math.min(params.limit_chars ?? DEFAULT_READ_WINDOW_CHARS, MAX_READ_WINDOW_CHARS);
			return readCharacterWindow(text, params.offset_chars, params.limit_chars, (window) => {
				const { content, ...rest } = window;
				return outputRaw(characterWindowHeader(params.address, window, ` · ${note.resolvedScope} · created ${created_at} · updated ${updated_at}`), content, { address: params.address, scope: note.resolvedScope, ...rest, limit_chars, created_at, updated_at });
			}, (result) => withinTextBudget(result.content[0].text));
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_list", label: "Notes list",
		description: `List note files as rows carrying address, scope, origin, status, stale, size_bytes, created_at, and updated_at, most recently updated first. ${ADDRESS_DESCRIPTION} All three homes are merged. A glob pattern (* within a path segment, ** across segments) filters full address strings: *.md is session-only, @project/** is project-only, and ** covers every home.`,
		parameters: Type.Object({ pattern: nullableString(), cursor: cursor(), max_results: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			let rows: ReturnType<typeof listNotes>;
			try { rows = listNotes(ctx, { pattern: params.pattern ?? undefined }); } catch (error) { return failure(error); }
			const files: Array<{ address: string; scope: string; origin: Origin; status: string; stale: boolean; size_bytes: number; created_at: string; updated_at: string; address_truncated?: boolean }> = rows.map((row) => ({ address: row.address, scope: row.scope, origin: row.meta.origin, status: row.meta.status, stale: row.meta.stale, size_bytes: row.sizeBytes, created_at: localIso(row.meta.created_at), updated_at: localIso(row.meta.updated_at) }));
			return output(page(files, params.cursor ?? 0, "files", params.max_results, (file, fits) => {
				if (fits(file)) return file;
				const address = middleTruncate(file.address, (candidate) => fits({ ...file, address: candidate, address_truncated: true }));
				return { ...file, address, address_truncated: true };
			}));
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_search", label: "Notes search",
		description: `Case-sensitive literal substring search over note bodies; query is one string or several (OR), each matched line appears once. ${ADDRESS_DESCRIPTION} All three homes are merged and every entry carries its full address and derived scope. Patterns glob over full address strings. Each file entry carries matches_total, its full match count before capping. Each match carries line, text, offset_chars (the body-absolute code-point offset of the earliest match).`,
		parameters: Type.Object({ query: searchQuery(), pattern: nullableString(), cursor: cursor(), max_matches_per_file: positiveInteger(), max_files: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const queries = searchQueries(params.query);
			let rows: ReturnType<typeof searchNotes>;
			try { rows = searchNotes(ctx, queries, { pattern: params.pattern ?? undefined }); } catch (error) { return failure(error); }
			const maxPerFile = params.max_matches_per_file ?? Number.POSITIVE_INFINITY;
			const result: Array<{ address: string; scope: string; created_at: string; updated_at: string; matches_total: number; matches: Array<{ line: number; text: string; truncated: boolean; total_chars: number; offset_chars: number }>; address_truncated?: boolean }> = rows.map((row) => {
				const matches = row.matches.map((match) => ({ line: match.line, text: match.text, truncated: false, total_chars: Array.from(match.text).length, offset_chars: match.offsetChars }));
				return { address: row.address, scope: row.scope, created_at: localIso(row.meta.created_at), updated_at: localIso(row.meta.updated_at), matches_total: matches.length, matches: matches.slice(0, maxPerFile) };
			});
			const fitFile = (file: (typeof result)[number], fits: (candidate: (typeof result)[number]) => boolean) => {
				if (fits(file)) return file;
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
			return output(page(result, params.cursor ?? 0, "files", params.max_files, fitFile));
		},
	}));
}
