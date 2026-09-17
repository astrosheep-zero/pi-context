import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { output, page, middleTruncate, prefixFit, withinBudget } from "./tool-output.js";
import { nullableString, nullableInteger, positiveInteger, cursor, searchQuery, searchQueries } from "./tool-schema.js";
import { notesFromSession, assertVirtualPath, assertVirtualPrefix, assertGlobPattern, globToRegExp, lineRange, localIso, type NoteOperation } from "./notes.js";
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
		description: "List persistent, session-scoped virtual note files, optionally filtered by a glob pattern: * matches within a path segment, ** matches across segments (a leading **/ also matches the root), ? matches one character within a segment; an omitted or empty pattern lists every file. Each entry carries its stale flag. created_at and updated_at are local-time ISO 8601 strings with an explicit UTC offset.",
		parameters: Type.Object({ pattern: nullableString(), max_results: positiveInteger(), cursor: cursor(), file_order_by: Type.Optional(Type.Union([Type.Literal("name"), Type.Literal("created_at"), Type.Literal("updated_at")])), file_order: Type.Optional(Type.Union([Type.Literal("ascending"), Type.Literal("descending")])) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const pattern = assertGlobPattern(params.pattern);
			const matcher = pattern ? globToRegExp(pattern) : undefined;
			let files = [...notesFromSession(ctx)].filter(([path]) => !matcher || matcher.test(path));
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
		description: "Read a virtual note file, optionally by inclusive 1-based line range; negative lines count from the end. Whole lines are delivered while they fit the wire budget; a line too large comes back as a plain prefix, and start_char (a code-point offset within start_line, default 0) resumes it. next_start_line/next_start_char address the next undelivered character: next_start_char is 0 when it begins a new line, so pages reconstruct exactly (insert a newline between pages only when next_start_char is 0). next_start_line is null only when the requested range is fully delivered, and stop_line is never less than start_line. Success results carry created_at and updated_at as local-time ISO 8601 strings with an explicit UTC offset.",
		parameters: Type.Object({ path: Type.String(), start_line: nullableInteger(), stop_line: nullableInteger(), start_char: Type.Optional(Type.Integer({ minimum: 0, description: "Code-point offset within start_line to resume from (default 0). Pass the previous next_start_char back unchanged when next_start_line has not advanced." })) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const path = assertVirtualPath(params.path);
			const file = notesFromSession(ctx).get(path);
			if (!file) return output({ error: "note file not found", path });
			const allLines = file.text.split("\n");
			const totalLines = allLines.length;
			const range = lineRange(file.text, params.start_line, params.stop_line);
			let startLine = range.start_line;
			let stopLine = Math.max(startLine, range.stop_line);
			let startChar = params.start_char ?? 0;
			const lineChars = (line: number) => Array.from(allLines[line - 1]!);
			const response = (content: string, pageStopLine: number, nextLine: number | null, nextChar: number) => ({
				path, start_line: startLine, stop_line: pageStopLine, content, total_lines: totalLines,
				next_start_line: nextLine, next_start_char: nextChar,
				created_at: localIso(file.createdAt), updated_at: localIso(file.updatedAt),
			});
			// Beyond the file, or an explicitly inverted range: nothing to deliver, but the range
			// contract still holds and the cursor terminates instead of self-feeding.
			if (range.start_line > range.stop_line || startLine > totalLines) {
				return output(response("", startLine, null, 0));
			}
			// A cursor always lands inside a line; a non-zero start_char at or past its end belongs
			// to the next line. An empty line at offset 0 is its own delivery, not a skip.
			while (startLine <= stopLine && startChar > 0 && startChar >= lineChars(startLine).length) {
				startChar = 0;
				startLine += 1;
			}
			if (startLine > stopLine) return output(response("", startLine, null, 0));
			const totalContentChars = (() => {
				let total = 0;
				for (let line = startLine; line <= stopLine; line++) {
					if (line > startLine) total += 1; // the newline joining two delivered lines
					total += lineChars(line).length - (line === startLine ? startChar : 0);
				}
				return total;
			})();
			// Deliver the first `budget` content characters as whole lines plus at most one prefix.
			// The join convention is the cursor's: a separator is only charged when a line is added,
			// and never trailing. Serialized size is non-decreasing in `budget`, so the largest
			// fitting page is one monotone binary search instead of the old line-count shrink loop.
			const deliver = (budget: number) => {
				const chunks: string[] = [];
				let line = startLine;
				let char = startChar;
				let remaining = budget;
				let lastLine = startLine;
				while (line <= stopLine && remaining > 0) {
					const chars = lineChars(line);
					const available = chars.length - char;
					if (chunks.length > 0) {
						if (remaining < (available > 0 ? 2 : 1)) break; // separator plus at least one character
						remaining -= 1;
					}
					const take = Math.min(available, remaining);
					chunks.push(chars.slice(char, char + take).join(""));
					remaining -= take;
					char += take;
					lastLine = line;
					if (char === chars.length) { line += 1; char = 0; }
				}
				return { content: chunks.join("\n"), stopLine: chunks.length > 0 ? lastLine : startLine, line, char };
			};
			const render = (page: ReturnType<typeof deliver>, complete: boolean) => response(page.content, page.stopLine, complete ? null : page.line, complete ? 0 : page.char);
			const full = render(deliver(totalContentChars), true);
			if (withinBudget(full)) return output(full);
			let low = 0;
			let high = totalContentChars - 1;
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				if (withinBudget(render(deliver(mid), false))) low = mid;
				else high = mid - 1;
			}
			return output(render(deliver(low), false));
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_search_contents",
		label: "Notes search",
		description: "Case-sensitive literal substring search over virtual note lines; query accepts one string or an array of strings, a line matches when it contains any of them (OR), and each matched line appears once. No semantic search. Every file entry carries matches_total, its full match count before any capping: when matches are dropped to fit the response budget, matches_total minus matches.length is exactly how many were dropped, never silent. A match whose line is over budget is a plain prefix and carries truncated plus total_chars (the line's full code-point length); read the rest with notes_read_file at that line. Each entry also carries created_at and updated_at as local-time ISO 8601 strings with an explicit UTC offset.",
		parameters: Type.Object({ max_matches_per_file: positiveInteger(), cursor: cursor(), query: searchQuery(), recent_file_first: Type.Optional(Type.Boolean()), max_files: positiveInteger(), path_prefix: nullableString() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const queries = searchQueries(params.query);
			const prefix = assertVirtualPrefix(params.path_prefix);
			let files = [...notesFromSession(ctx)].filter(([path]) => !prefix || path.startsWith(prefix));
			if (params.recent_file_first) files.sort((a, b) => b[1].createdAt - a[1].createdAt);
			const maxPerFile = params.max_matches_per_file ?? Number.POSITIVE_INFINITY;
			const result: Array<{ path: string; created_at: string; updated_at: string; matches_total: number; matches: Array<{ line: number; text: string; truncated: boolean; total_chars: number }>; path_truncated?: boolean }> = files
				.map(([path, file]) => {
					const allMatches = file.text.split("\n").flatMap((line, index) => queries.some((query) => line.includes(query)) ? [{ line: index + 1, text: line, truncated: false, total_chars: Array.from(line).length }] : []);
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
