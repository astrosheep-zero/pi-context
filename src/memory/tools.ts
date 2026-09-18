import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { localIso } from "../notes.js";
import { characterWindowHeader, middleTruncate, output, outputRaw, page, prefixFit, readCharacterWindow, withinTextBudget } from "../tool-output.js";
import { cursor, nullableString, positiveInteger, searchQueries, searchQuery } from "../tool-schema.js";
import { serializeNote, stripLeadingFrontmatter, type NoteMeta, type Origin } from "./frontmatter.js";
import { NoteError, editNote, listNotes, readNote, searchNotes, writeNote } from "./store.js";
import type { Scope } from "./paths.js";

const SCOPE = Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("project"), Type.Literal("global")]));
const ORIGIN = Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("self"), Type.Literal("external")]));

/** Render epoch-ms metadata as the same local ISO timestamps the frontmatter carries. */
function wireMeta(meta: NoteMeta): Record<string, unknown> {
	return { ...meta, created_at: localIso(meta.created_at), updated_at: localIso(meta.updated_at), last_accessed: localIso(meta.last_accessed) };
}

/** Turn a typed store refusal into the pinned error arm; unknown errors stay thrown. */
function failure(error: unknown) {
	if (error instanceof NoteError) {
		const payload: Record<string, unknown> = { error: error.message };
		if (error.line_numbers) payload.line_numbers = error.line_numbers;
		if (error.edit_index !== undefined) payload.edit_index = error.edit_index;
		return output(payload);
	}
	throw error;
}

export function registerMemoryTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "notes_write",
		label: "Notes write",
		description: "Create or replace a note as a real markdown file under the session, project, or global note root. Keep notes small and split by topic; a rewrite replaces the body whole while preserving created_at and every other frontmatter key. stale: true marks the note closed so it leaves the boot index but stays readable and searchable.",
		parameters: Type.Object({ path: Type.String(), content: Type.String(), scope: SCOPE, origin: ORIGIN, stale: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
		// A batch containing write or edit runs one call at a time, so note read-modify-write cannot race.
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const content = params.content;
			try {
				const { meta } = writeNote(ctx, params.path, content, { scope: (params.scope ?? "session") as Scope, origin: (params.origin ?? "self") as Origin, stale: params.stale });
				return output({ path: params.path, scope: meta.scope, size_bytes: Buffer.byteLength(stripLeadingFrontmatter(content), "utf8"), meta: wireMeta(meta) });
			} catch (error) {
				return failure(error);
			}
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_edit",
		label: "Notes edit",
		description: "Edit a note body by exact-text replacement; frontmatter is never editable this way. Each oldText must occur exactly once unless replace_all is set; a multi-match anchor fails with its match line numbers and a zero-match anchor names the failing edit index. edits may be omitted (or empty) for a metadata-only update, which requires at least one of scope/origin/stale. scope/origin/stale are setters: scope moves the file, refusing when the target already exists. The success return carries resolved_scope and a diff of what changed.",
		parameters: Type.Object({ path: Type.String(), edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }, { additionalProperties: false }))), scope: SCOPE, origin: ORIGIN, stale: Type.Optional(Type.Boolean()), replace_all: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const { meta, applied, resolved_scope, diff } = editNote(ctx, params.path, params.edits, { scope: params.scope as Scope | undefined, origin: params.origin as Origin | undefined, stale: params.stale, replaceAll: params.replace_all });
				return output({ path: params.path, applied, resolved_scope, diff, meta: wireMeta(meta) });
			} catch (error) {
				return failure(error);
			}
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_read",
		label: "Notes read",
		description: "Read a character window of a note file, frontmatter included: offset_chars is the code-point offset to start from (default 0) — a negative value counts back from the end — and limit_chars caps the window (default 12000, max 50000). Each response delivers the longest fitting prefix of that window: concatenate pages in order to reconstruct the note. The response is the raw frontmatter + body behind a one-line [bracketed] header naming the file, the resolved offset, the delivered char range, and the resume cursor.",
		parameters: Type.Object({ path: Type.String(), scope: SCOPE, offset_chars: Type.Optional(Type.Integer({ description: "Code-point offset to start from (default 0). A negative value counts back from the end; the response echoes the resolved absolute offset. Pass the previous next_offset_chars back unchanged to continue." })), limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: "Largest requested window in code points (default 12000). A window too large for the wire budget is cut short; next_offset_chars names where the next read resumes." })) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			let note: ReturnType<typeof readNote>;
			try {
				note = readNote(ctx, params.path, { scope: params.scope as Scope | undefined });
			} catch (error) {
				return failure(error);
			}
			if (!note) return output({ error: "note not found", path: params.path });
			const text = serializeNote(note.meta, note.body);
			const totalChars = Array.from(text).length;
			// A positive offset past the end is an addressing error, not an empty page.
			if (typeof params.offset_chars === "number" && params.offset_chars > totalChars) {
				return output({ error: `offset_chars ${params.offset_chars} is past the end: the note has ${totalChars} chars; the largest legal offset is ${totalChars} (an empty end-read)`, path: params.path, offset_chars: params.offset_chars, total_chars: totalChars });
			}
			const created_at = localIso(note.meta.created_at);
			const updated_at = localIso(note.meta.updated_at);
			const limit_chars = Math.min(params.limit_chars ?? 12000, 50000);
			return readCharacterWindow(text, params.offset_chars, params.limit_chars, (window) => {
				const { content, ...rest } = window;
				return outputRaw(characterWindowHeader(params.path, window, ` · ${note.resolvedScope} · created ${created_at} · updated ${updated_at}`), content, { path: params.path, scope: note.resolvedScope, ...rest, limit_chars, created_at, updated_at });
			}, (result) => withinTextBudget(result.content[0].text));
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_list",
		label: "Notes list",
		description: "List note files as rows carrying path, scope, origin, status, stale, size_bytes, created_at, and updated_at, most recently updated first. Without scope, all three scopes are merged; a glob pattern (* within a path segment, ** across segments) filters the virtual paths.",
		parameters: Type.Object({ scope: SCOPE, pattern: nullableString(), cursor: cursor(), max_results: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			let rows: ReturnType<typeof listNotes>;
			try {
				rows = listNotes(ctx, { scope: params.scope as Scope | undefined, pattern: params.pattern ?? undefined });
			} catch (error) {
				return failure(error);
			}
			const files: Array<{ path: string; scope: Scope; origin: Origin; status: string; stale: boolean; size_bytes: number; created_at: string; updated_at: string; path_truncated?: boolean }> = rows.map((row) => ({
				path: row.path,
				scope: row.meta.scope,
				origin: row.meta.origin,
				status: row.meta.status,
				stale: row.meta.stale,
				size_bytes: row.sizeBytes,
				created_at: localIso(row.meta.created_at),
				updated_at: localIso(row.meta.updated_at),
			}));
			return output(page(files, params.cursor ?? 0, "files", params.max_results, (file, fits) => {
				if (fits(file)) return file;
				const path = middleTruncate(file.path, (candidate) => fits({ ...file, path: candidate, path_truncated: true }));
				return { ...file, path, path_truncated: true };
			}));
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_search",
		label: "Notes search",
		description: "Case-sensitive literal substring search over note bodies; query is one string or several (OR), each matched line appears once. Without scope, all three scopes are merged and every entry carries its scope. Each file entry carries matches_total, its full match count before capping. Each match carries line, text, offset_chars (the body-absolute code-point offset of the earliest match).",
		parameters: Type.Object({ query: searchQuery(), scope: SCOPE, pattern: nullableString(), cursor: cursor(), max_matches_per_file: positiveInteger(), max_files: positiveInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const queries = searchQueries(params.query);
			let rows: ReturnType<typeof searchNotes>;
			try {
				rows = searchNotes(ctx, queries, { scope: params.scope as Scope | undefined, pattern: params.pattern ?? undefined });
			} catch (error) {
				return failure(error);
			}
			const maxPerFile = params.max_matches_per_file ?? Number.POSITIVE_INFINITY;
			const result: Array<{ path: string; scope: Scope; created_at: string; updated_at: string; matches_total: number; matches: Array<{ line: number; text: string; truncated: boolean; total_chars: number; offset_chars: number }>; path_truncated?: boolean }> = rows.map((row) => {
				const matches = row.matches.map((match) => ({ line: match.line, text: match.text, truncated: false, total_chars: Array.from(match.text).length, offset_chars: match.offsetChars }));
				return { path: row.path, scope: row.scope, created_at: localIso(row.meta.created_at), updated_at: localIso(row.meta.updated_at), matches_total: matches.length, matches: matches.slice(0, maxPerFile) };
			});
			// Trailing matches are dropped to fit the budget, named by matches_total; a single
			// over-budget line is delivered as a flagged prefix; only a pathological path is
			// middle-truncated, and then only with a visible path_truncated flag.
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
				const prefix: (typeof result)[number] = fitted(text);
				if (fits(prefix)) return prefix;
				const path = middleTruncate(prefix.path, (candidate) => fits({ ...prefix, path: candidate, path_truncated: true }));
				return { ...prefix, path, path_truncated: true };
			};
			return output(page(result, params.cursor ?? 0, "files", params.max_files, fitFile));
		},
	}));
}
