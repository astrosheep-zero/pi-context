import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { output, page, middleTruncate, withinBudget } from "./tool-output.js";
import { nullableString, nullableInteger, positiveInteger, cursor, searchQuery, searchQueries } from "./tool-schema.js";
import { notesFromSession, assertVirtualPath, assertVirtualPrefix, lineRange, localIso, type NoteOperation } from "./notes.js";
import { NOTE_TYPE, MAX_NOTE_BYTES, MAX_NOTE_PATH_BYTES } from "./protocol.js";

export function registerNoteTools(pi: ExtensionAPI) {
	const saveNote = (op: NoteOperation) => {
		// pi.appendEntry writes a custom SessionManager entry. Custom entries are persistent but excluded from LLM context.
		// ExtensionContext deliberately exposes only a readonly SessionManager, so this is the public extension write path.
		pi.appendEntry(NOTE_TYPE, op);
	};

	pi.registerTool(defineTool({
		name: "notes_list_files_by_prefix",
		label: "Notes list files",
		description: "List persistent, session-scoped virtual note files. created_at and updated_at are local-time ISO 8601 strings with an explicit UTC offset.",
		parameters: Type.Object({ prefix: nullableString(), max_results: positiveInteger(), cursor: cursor(), file_order_by: Type.Optional(Type.Union([Type.Literal("name"), Type.Literal("created_at"), Type.Literal("updated_at")])), file_order: Type.Optional(Type.Union([Type.Literal("ascending"), Type.Literal("descending")])) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const prefix = assertVirtualPrefix(params.prefix);
			let files = [...notesFromSession(ctx)].filter(([path]) => !prefix || path.startsWith(prefix));
			const key = params.file_order_by ?? "name";
			files.sort(([aPath, a], [bPath, b]) => key === "name" ? aPath.localeCompare(bPath) : (key === "created_at" ? a.createdAt - b.createdAt : a.updatedAt - b.updatedAt));
			if (params.file_order === "descending") files.reverse();
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
		description: "Read a virtual note file, optionally by inclusive 1-based line range; negative lines count from the end. Success results carry created_at and updated_at as local-time ISO 8601 strings with an explicit UTC offset.",
		parameters: Type.Object({ path: Type.String(), start_line: nullableInteger(), stop_line: nullableInteger() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const path = assertVirtualPath(params.path);
			const file = notesFromSession(ctx).get(path);
			if (!file) return output({ error: "note file not found", path });
			const range = lineRange(file.text, params.start_line, params.stop_line);
			const lines = range.content ? range.content.split("\n") : [];
			const totalLines = file.text.split("\n").length;
			const result = (content: string, count: number) => ({ path, start_line: range.start_line, stop_line: range.start_line + count - 1, content, total_lines: totalLines, next_start_line: range.start_line + count <= range.stop_line ? range.start_line + count : null, created_at: localIso(file.createdAt), updated_at: localIso(file.updatedAt) });
			let count = lines.length;
			while (count > 0 && !withinBudget(result(lines.slice(0, count).join("\n"), count))) count--;
			if (count === 0 && lines.length > 0) {
				// One indivisible line is larger than the whole budget: return it middle-truncated and
				// advance past it instead of looping on an empty page whose cursor never moves.
				return output(result(middleTruncate(lines[0], (candidate) => withinBudget(result(candidate, 1))), 1));
			}
			return output(result(lines.slice(0, count).join("\n"), count));
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_search_contents",
		label: "Notes search",
		description: "Case-sensitive literal substring search over virtual note lines; query accepts one string or an array of strings, a line matches when it contains any of them (OR), and each matched line appears once. No semantic search. Each matched file carries created_at and updated_at as local-time ISO 8601 strings with an explicit UTC offset.",
		parameters: Type.Object({ max_matches_per_file: positiveInteger(), cursor: cursor(), query: searchQuery(), recent_file_first: Type.Optional(Type.Boolean()), max_files: positiveInteger(), path_prefix: nullableString() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const queries = searchQueries(params.query);
			const prefix = assertVirtualPrefix(params.path_prefix);
			let files = [...notesFromSession(ctx)].filter(([path]) => !prefix || path.startsWith(prefix));
			if (params.recent_file_first) files.sort((a, b) => b[1].createdAt - a[1].createdAt);
			const maxPerFile = params.max_matches_per_file ?? Number.POSITIVE_INFINITY;
			const result: Array<{ path: string; created_at: string; updated_at: string; matches: Array<{ line: number; text: string }>; path_truncated?: boolean }> = files.map(([path, file]) => ({ path, created_at: localIso(file.createdAt), updated_at: localIso(file.updatedAt), matches: file.text.split("\n").flatMap((line, index) => queries.some((query) => line.includes(query)) ? [{ line: index + 1, text: line }] : []).slice(0, maxPerFile) })).filter((file) => file.matches.length > 0);
			// A file is capped by dropping whole trailing matches, but its last match is never
			// dropped: one oversized line is middle-truncated so the file still appears. Only when
			// the entry cannot fit even after that is the identity field itself truncated, and then
			// only together with a visible `path_truncated: true` flag.
			const fitFile = (file: (typeof result)[number], fits: (candidate: (typeof result)[number]) => boolean) => {
				let matches = file.matches;
				while (matches.length > 1 && !fits({ ...file, matches })) matches = matches.slice(0, -1);
				const first = matches[0];
				let fitted: (typeof result)[number] = !first ? { ...file, matches } : (() => {
					const text = middleTruncate(first.text, (candidate) => fits({ ...file, matches: [{ ...first, text: candidate }, ...matches.slice(1)] }));
					return { ...file, matches: [{ ...first, text }, ...matches.slice(1)] };
				})();
				if (fits(fitted)) return fitted;
				const path = middleTruncate(fitted.path, (candidate) => fits({ ...fitted, path: candidate, path_truncated: true }));
				return { ...fitted, path, path_truncated: true };
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
