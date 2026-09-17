import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { output, page, middleTruncate, prefixFit, earliestMatchOffsetChars, readCharacterWindow } from "./tool-output.js";
import { nullableString, positiveInteger, cursor, searchQuery, searchQueries } from "./tool-schema.js";
import { notesFromSession, assertVirtualPath, assertVirtualPrefix, assertGlobPattern, globToRegExp, localIso, type NoteOperation } from "./notes.js";
import { NOTE_TYPE, MAX_NOTE_BYTES, MAX_NOTE_PATH_BYTES } from "./protocol.js";

export function registerNoteTools(pi: ExtensionAPI) {
	const saveNote = (op: NoteOperation) => {
		// pi.appendEntry writes a custom SessionManager entry. Custom entries are persistent but excluded from LLM context.
		// ExtensionContext deliberately exposes only a readonly SessionManager, so this is the public extension write path.
		pi.appendEntry(NOTE_TYPE, op);
	};

	pi.registerTool(defineTool({
		name: "notes_list_files",
		label: "Notes list files",
		description: "List persistent, session-scoped virtual note files, optionally filtered by a glob pattern: * matches within a path segment, ** matches across segments (a leading **/ also matches the root), ? matches one character within a segment; an omitted or empty pattern lists every file. The default order is most recently updated first; file_order_by (name, created_at, updated_at) and file_order (ascending, descending) select another. Each entry carries its stale flag, and created_at/updated_at are local-time ISO 8601 strings with an explicit UTC offset.",
		parameters: Type.Object({ pattern: nullableString(), max_results: positiveInteger(), cursor: cursor(), file_order_by: Type.Optional(Type.Union([Type.Literal("name"), Type.Literal("created_at"), Type.Literal("updated_at")])), file_order: Type.Optional(Type.Union([Type.Literal("ascending"), Type.Literal("descending")])) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const pattern = assertGlobPattern(params.pattern);
			const matcher = pattern ? globToRegExp(pattern) : undefined;
			let files = [...notesFromSession(ctx)].filter(([path]) => !matcher || matcher.test(path));
			const key = params.file_order_by ?? "updated_at";
			// Deterministic total order: (axis key, createdAt, path) ascending. Paths are unique, so
			// this never depends on map iteration order; descending reverses the whole comparator.
			files.sort(([aPath, a], [bPath, b]) => {
				const primary = key === "name" ? aPath.localeCompare(bPath) : key === "created_at" ? a.createdAt - b.createdAt : a.updatedAt - b.updatedAt;
				if (primary !== 0) return primary;
				if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
				return aPath.localeCompare(bPath);
			});
			// An explicit file_order always wins; otherwise the axis's natural direction applies
			// (descending for the time axes, ascending for name).
			if (params.file_order ? params.file_order === "descending" : key !== "name") files.reverse();
			const listed: Array<{ path: string; size_bytes: number; stale: boolean; created_at: string; updated_at: string; path_truncated?: boolean }> = files.map(([path, file]) => ({ path, size_bytes: Buffer.byteLength(file.text, "utf8"), stale: file.stale, created_at: localIso(file.createdAt), updated_at: localIso(file.updatedAt) }));
			// `path` is the entry's identity: return it intact whenever the entry fits, and only
			// ever alter it together with a visible `path_truncated: true` flag. A pathological
			// legacy path predating the write cap is the one case that cannot fit at all.
			return output(page(listed, params.cursor ?? 0, "files", params.max_results, (file, fits) => {
				if (fits(file)) return file;
				const path = middleTruncate(file.path, (candidate) => fits({ ...file, path: candidate, path_truncated: true }));
				return { ...file, path, path_truncated: true };
			}));
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_read_file",
		label: "Notes read file",
		description: "Read a bounded character window from a virtual note file: offset_chars is the code-point offset to start from (default 0), where a negative value counts back from the end (offset_chars: -2000 reads the last 2000 code points) and the response always echoes the resolved absolute offset, while limit_chars caps the window (default 12000, max 50000). Each response delivers the longest fitting prefix of that window with no marker: next_offset_chars is exactly offset_chars plus the delivered code-point count and is null only once the note ends, so pass it back unchanged and concatenate the pages in order to reconstruct the note exactly. Success results carry created_at and updated_at as local-time ISO 8601 strings with an explicit UTC offset.",
		parameters: Type.Object({ path: Type.String(), offset_chars: Type.Optional(Type.Integer({ description: "Code-point offset to start from (default 0). A negative value counts back from the end; the response echoes the resolved absolute offset. Pass the previous next_offset_chars back unchanged to continue." })), limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: "Largest requested window in code points (default 12000). A window too large for the wire budget is cut short; next_offset_chars names where the next read resumes." })) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const path = assertVirtualPath(params.path);
			const file = notesFromSession(ctx).get(path);
			if (!file) return output({ error: "note file not found", path });
			const created_at = localIso(file.createdAt);
			const updated_at = localIso(file.updatedAt);
			return output(readCharacterWindow(file.text, params.offset_chars, params.limit_chars, (window) => ({ path, ...window, created_at, updated_at })));
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_search_contents",
		label: "Notes search",
		description: "Case-sensitive literal substring search over virtual note lines; query accepts one string or an array of strings, a line matches when it contains any of them (OR), and each matched line appears once. No semantic search. Every file entry carries matches_total, its full match count before any capping: when matches are dropped to fit the response budget, matches_total minus matches.length is exactly how many were dropped, never silent. Each match carries line plus offset_chars, that line's file-absolute code-point offset of the earliest match, so notes_read_file at offset_chars shows the query; a match whose line is over budget is a plain prefix and carries truncated plus total_chars (the line's full code-point length), so read the rest at the same offset_chars. Each entry also carries created_at and updated_at as local-time ISO 8601 strings with an explicit UTC offset.",
		parameters: Type.Object({ max_matches_per_file: positiveInteger(), cursor: cursor(), query: searchQuery(), recent_file_first: Type.Optional(Type.Boolean()), max_files: positiveInteger(), path_prefix: nullableString() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const queries = searchQueries(params.query);
			const prefix = assertVirtualPrefix(params.path_prefix);
			let files = [...notesFromSession(ctx)].filter(([path]) => !prefix || path.startsWith(prefix));
			if (params.recent_file_first) files.sort((a, b) => b[1].createdAt - a[1].createdAt);
			const maxPerFile = params.max_matches_per_file ?? Number.POSITIVE_INFINITY;
			const result: Array<{ path: string; created_at: string; updated_at: string; matches_total: number; matches: Array<{ line: number; text: string; truncated: boolean; total_chars: number; offset_chars: number }>; path_truncated?: boolean }> = files
				.map(([path, file]) => {
					// A match's offset_chars is file-absolute: the code points before its line, plus the
					// earliest occurrence of any query inside that line. Search then composes with
					// notes_read_file exactly like history_search_contents composes with history_read_item.
					let baseChars = 0;
					const allMatches = file.text.split("\n").flatMap((line, index) => {
						const match = queries.some((query) => line.includes(query))
							? [{ line: index + 1, text: line, truncated: false, total_chars: Array.from(line).length, offset_chars: baseChars + earliestMatchOffsetChars(line, queries) }]
							: [];
						baseChars += Array.from(line).length + 1;
						return match;
					});
					return { path, created_at: localIso(file.createdAt), updated_at: localIso(file.updatedAt), matches_total: allMatches.length, matches: allMatches.slice(0, maxPerFile) };
				})
				.filter((file) => file.matches.length > 0);
			// Trailing matches are dropped to fit the budget (bounded by a monotone binary search),
			// and the entry's matches_total keeps naming the drop. Only when a single intact match is
			// over budget is its line delivered as a plain prefix, flagged and counted. Only when the
			// entry cannot fit even then is the identity field itself truncated, and then only together
			// with a visible `path_truncated: true` flag.
			const fitFile = (file: (typeof result)[number], fits: (candidate: (typeof result)[number]) => boolean) => {
				if (fits(file)) return file;
				const matches = file.matches;
				// First, drop whole trailing matches: the largest prefix that fits intact is kept, so an
				// entry only truncates a line when that single line alone is over budget.
				let low = 0;
				let high = matches.length;
				while (low < high) {
					const mid = Math.ceil((low + high) / 2);
					if (mid >= 1 && fits({ ...file, matches: matches.slice(0, mid) })) low = mid;
					else high = mid - 1;
				}
				if (low >= 1) return { ...file, matches: matches.slice(0, low) };
				// Even one intact match is over budget: keep the first match as a plain, named prefix.
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

	for (const [name, op] of [["notes_append_to_file", "append"], ["notes_write_file", "write"]] as const) {
		pi.registerTool(defineTool({
			name,
			label: name === "notes_append_to_file" ? "Notes append" : "Notes write",
			description: name === "notes_append_to_file"
				? "Append exact text to a persistent virtual note file. Appending suits chronological logs; for current-state notes, replace the whole file with notes_write_file instead. Accepts the same mark_stale flag to close a note."
				: "Create or replace a persistent virtual note file. Keep notes small and split by topic; replace outdated notes whole. With mark_stale: true, flag the note as stale instead — optionally writing its final content in the same call: stale notes leave the boot index but stay readable and searchable, and rewriting revives them.",
			parameters: Type.Object({ text: Type.Optional(Type.String()), path: Type.String(), mark_stale: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
			// Codex sets supports_parallel_tool_calls = false on notes.write_file/append_to_file.
			// Pi's per-tool equivalent is executionMode "sequential": a batch containing either
			// tool runs its calls one at a time, so note read-modify-write cannot race.
			executionMode: "sequential",
			async execute(_id, params, _signal, _update, ctx) {
				const path = assertVirtualPath(params.path);
				const pathBytes = Buffer.byteLength(path, "utf8");
				// The cap lives here, at the tool boundary, and never in assertVirtualPath: note
				// replay validates persisted ops through that helper and must keep loading sessions
				// that already contain a longer legacy path (reads stay un-capped too).
				if (pathBytes > MAX_NOTE_PATH_BYTES) return output({ error: `note path exceeds ${MAX_NOTE_PATH_BYTES} UTF-8 bytes`, path_bytes: pathBytes });
				const hasText = params.text !== undefined;
				const hasStale = params.mark_stale !== undefined;
				if (!hasText && !hasStale) return output({ error: "provide text, mark_stale, or both", path });
				const old = notesFromSession(ctx).get(path);
				if (!hasText && !old) return output({ error: "note file not found", path });
				const next = hasText ? (op === "append" ? `${old?.text ?? ""}${params.text}` : params.text as string) : old!.text;
				const bytes = Buffer.byteLength(next, "utf8");
				if (hasText && bytes > MAX_NOTE_BYTES) return output({ error: `note exceeds ${MAX_NOTE_BYTES} UTF-8 bytes`, path, size_bytes: bytes });
				const now = Date.now();
				const operation: NoteOperation = { op, path, createdAt: old?.createdAt ?? now, updatedAt: now };
				if (hasText) operation.text = params.text;
				if (hasStale) operation.stale = params.mark_stale;
				saveNote(operation);
				return output({ path, size_bytes: bytes, operation: op, stale: hasStale ? params.mark_stale : false });
			},
		}));
	}
}
