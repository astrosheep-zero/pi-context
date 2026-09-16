import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { output, page, TOOL_OUTPUT_MAX_BYTES } from "./tool-output.js";
import { nullableString, nullableInteger, positiveInteger } from "./tool-schema.js";
import { notesFromSession, assertVirtualPath, assertVirtualPrefix, lineRange, localIso, type NoteOperation } from "./notes.js";
import { NOTE_TYPE, MAX_NOTE_BYTES } from "./protocol.js";

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
		parameters: Type.Object({ prefix: nullableString(), max_results: positiveInteger(), offset: Type.Optional(Type.Integer({ minimum: 0 })), file_order_by: Type.Optional(Type.Union([Type.Literal("name"), Type.Literal("created_at"), Type.Literal("updated_at")])), file_order: Type.Optional(Type.Union([Type.Literal("ascending"), Type.Literal("descending")])) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const prefix = assertVirtualPrefix(params.prefix);
			let files = [...notesFromSession(ctx)].filter(([path]) => !prefix || path.startsWith(prefix));
			const key = params.file_order_by ?? "name";
			files.sort(([aPath, a], [bPath, b]) => key === "name" ? aPath.localeCompare(bPath) : (key === "created_at" ? a.createdAt - b.createdAt : a.updatedAt - b.updatedAt));
			if (params.file_order === "descending") files.reverse();
			const listed = files.map(([path, file]) => ({ path, size_bytes: Buffer.byteLength(file.text, "utf8"), created_at: localIso(file.createdAt), updated_at: localIso(file.updatedAt) }));
			return output(page(listed, params.offset ?? 0, "files", params.max_results));
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
			let count = lines.length;
			while (count > 0 && Buffer.byteLength(JSON.stringify({ path, ...range, content: lines.slice(0, count).join("\n"), total_lines: file.text.split("\n").length, next_start_line: range.start_line + count < range.stop_line ? range.start_line + count : null, created_at: localIso(file.createdAt), updated_at: localIso(file.updatedAt) }), "utf8") > TOOL_OUTPUT_MAX_BYTES) count--;
			return output({ path, start_line: range.start_line, stop_line: range.start_line + count - 1, content: lines.slice(0, count).join("\n"), total_lines: file.text.split("\n").length, next_start_line: range.start_line + count < range.stop_line ? range.start_line + count : null, created_at: localIso(file.createdAt), updated_at: localIso(file.updatedAt) });
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_search_contents",
		label: "Notes search",
		description: "Case-sensitive literal substring search over virtual note lines; no semantic search. Each matched file carries created_at and updated_at as local-time ISO 8601 strings with an explicit UTC offset.",
		parameters: Type.Object({ max_matches_per_file: positiveInteger(), offset: Type.Optional(Type.Integer({ minimum: 0 })), query: Type.String(), recent_file_first: Type.Optional(Type.Boolean()), max_files: positiveInteger(), path_prefix: nullableString() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const prefix = assertVirtualPrefix(params.path_prefix);
			let files = [...notesFromSession(ctx)].filter(([path]) => !prefix || path.startsWith(prefix));
			if (params.recent_file_first) files.sort((a, b) => b[1].createdAt - a[1].createdAt);
			const maxPerFile = params.max_matches_per_file ?? Number.POSITIVE_INFINITY;
			const result = files.map(([path, file]) => ({ path, created_at: localIso(file.createdAt), updated_at: localIso(file.updatedAt), matches: file.text.split("\n").flatMap((line, index) => line.includes(params.query) ? [{ line: index + 1, text: line }] : []).slice(0, maxPerFile) })).filter((file) => file.matches.length > 0).map((file) => {
				while (file.matches.length > 0 && Buffer.byteLength(JSON.stringify({ files: [file] }), "utf8") > TOOL_OUTPUT_MAX_BYTES) file.matches.pop();
				return file;
			}).filter((file) => file.matches.length > 0);
			return output(page(result.slice(0, params.max_files ?? result.length), params.offset ?? 0, "files"));
		},
	}));

	for (const [name, op] of [["notes_append_to_file", "append"], ["notes_write_file", "write"]] as const) {
		pi.registerTool(defineTool({
			name,
			label: name === "notes_append_to_file" ? "Notes append" : "Notes write",
			description: name === "notes_append_to_file" ? "Append exact text to a persistent virtual note file." : "Create or replace a persistent virtual note file.",
			parameters: Type.Object({ text: Type.String(), path: Type.String() }, { additionalProperties: false }),
			async execute(_id, params, _signal, _update, ctx) {
				const path = assertVirtualPath(params.path);
				const old = notesFromSession(ctx).get(path);
				const next = op === "append" ? `${old?.text ?? ""}${params.text}` : params.text;
				const bytes = Buffer.byteLength(next, "utf8");
				if (bytes > MAX_NOTE_BYTES) return output({ error: `note exceeds ${MAX_NOTE_BYTES} UTF-8 bytes`, path, size_bytes: bytes });
				const now = Date.now();
				saveNote({ op, path, text: params.text, createdAt: old?.createdAt ?? now, updatedAt: now });
				return output({ path, size_bytes: bytes, operation: op });
			},
		}));
	}
}
