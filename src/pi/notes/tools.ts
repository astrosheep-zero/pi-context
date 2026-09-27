import { Type } from "@earendil-works/pi-ai";
import { defineTool, generateDiffString, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { localIso } from "../../notes/frontmatter.js";
import { createNotesStore, NoteError, noteIdentity, type NoteChange, type NoteReadResult, type NoteRow, type NoteSearchRow, type Origin, type Scope } from "../../notes/index.js";
import { DEFAULT_READ_WINDOW_CHARS, MAX_READ_WINDOW_CHARS, middleTruncate, output, outputRaw, prefixFit, readCharacterWindow, readWindowBlock, withinBudget, withinTextBudget } from "../../tool-output.js";
import { nullableString, positiveInteger, searchQueries, searchQuery } from "../../tool-schema.js";
import { notesContextFromPi } from "./adapter.js";

const ORIGIN = Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("self"), Type.Literal("external")], {
	description: "Where the note's content came from. user: written or dictated by the human. self: written by you, the agent (default). external: anything else — third-party text, tool output, fetched material.",
}));
const CRUMPLED_PARAMETER = Type.Optional(Type.Boolean({ description: "true crumples the note: it leaves the boot index, list, and search, stays readable by address, and appears with wastebasket: true. false smooths it back." }));
const WASTEBASKET_PARAMETER = Type.Optional(Type.Boolean({ description: "true lists only crumpled notes instead of live ones." }));
const ADDRESS_DESCRIPTION = "Address forms are bare `<vpath>` for this session, `@project/<vpath>` for this project, `@human/<vpath>` for the human's cross-project notes, `@self/<vpath>` for your own, and `@model/<vpath>` for the current model's. `@self` and `@model` mean whoever is running now. Any other `@` prefix, or `@` inside a vpath, is refused. There is no fallback across prefixes. Paths reject `..`, absolute paths, and backslashes. `@` addresses belong to the notes namespace, not the filesystem: never pass them to general read/write/edit/bash tools.";

/** The one receipt field a caller cannot derive from the address itself. */
function projectKeyField(scope: Scope, projectKey: string): { project_key?: string } {
	return scope === "project" ? { project_key: projectKey } : {};
}

function failure(error: unknown) {
	if (error instanceof NoteError) {
		const payload: Record<string, unknown> = { error: error.message, code: error.code };
		if (error.lineNumbers) payload.line_numbers = error.lineNumbers;
		if (error.editIndex !== undefined) payload.edit_index = error.editIndex;
		return output(payload);
	}
	const message = error instanceof Error ? error.message : "notes operation failed";
	const code = /^(invalid note address|path )/.test(message) ? "invalid_address"
		: /^glob pattern/.test(message) ? "invalid_pattern"
		: /^query /.test(message) ? "invalid_query"
		: typeof error === "object" && error !== null && /^E[A-Z0-9_]+$/.test(String((error as NodeJS.ErrnoException).code)) ? "io_error" : "internal_error";
	return output({ error: code === "io_error" || code === "internal_error" ? "notes operation failed" : message, code });
}

function renderDiff(change: NoteChange): string {
	if (change.kind === "none") return "";
	return generateDiffString(change.before, change.after).diff;
}

function snapshot<T>(rows: T[], limit: number | undefined, truncate: (item: T, fits: (candidate: T) => boolean) => T, status?: { crumpledExcluded: number; homesUnavailable: string[] }): { files: T[]; more: number; crumpled_excluded: number; homes_unavailable: string[] } {
	const selected: T[] = [];
	const maxItems = Math.min(rows.length, limit ?? rows.length);
	const response = (files: T[]) => ({ files, more: rows.length - files.length, crumpled_excluded: status?.crumpledExcluded ?? 0, homes_unavailable: status?.homesUnavailable ?? [] });
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
		description: `Create or rewrite a note, and name it for what it holds and when to reach for it: a fresh window sees only the name in the index and decides whether to open by it. Write it for a reader who arrives knowing nothing, and keep it true when the content drifts. ${ADDRESS_DESCRIPTION} A rewrite replaces the body whole while preserving createdAt and every other frontmatter key. Writing always produces an uncrumpled note. The receipt reports the resolved address, project key when applicable, and actual create/overwrite/uncrumple outcome.`,
		parameters: Type.Object({ address: Type.String(), content: Type.String(), origin: ORIGIN }, { additionalProperties: false }), executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const content = params.content;
			try {
				const storeContext = notesContextFromPi(ctx);
				const { outcome } = await createNotesStore(storeContext).write(params.address, content, { origin: (params.origin ?? "self") as Origin });
				return output({ ...noteIdentity(storeContext, params.address), outcome });
			} catch (error) { return failure(error); }
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_update", label: "Notes update",
		description: `Update one note: exact-text body edits, a metadata-only change, or a rename_to move; frontmatter is never editable through edits. ${ADDRESS_DESCRIPTION} Each oldText must occur exactly once unless replace_all is set; a multi-match anchor fails with its match line numbers and a zero-match anchor names the failing edit index. edits may be omitted (or empty) for a metadata-only update, which requires at least one of origin/crumpled. rename_to moves the note to a new address preserving createdAt and every other metadata key; it is used alone, never combined with edits, origin, crumpled, or replace_all, refuses a live note at the target, and may replace a crumpled one. The receipt reports resolved identity, the number of edits that changed text, the change kind (including none), and the actual diff.`,
		parameters: Type.Object({ address: Type.String(), edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }, { additionalProperties: false }))), origin: ORIGIN, crumpled: CRUMPLED_PARAMETER, replace_all: Type.Optional(Type.Boolean()), rename_to: Type.Optional(Type.String({ description: "Move the note to this address (same address rules as address), preserving createdAt and all other metadata. Used alone: never combined with edits, origin, crumpled, or replace_all. A live note at the target refuses; a crumpled target is replaced. References elsewhere do not follow the move. An empty rename_to is ignored as if omitted." })) }, { additionalProperties: false }), executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const storeContext = notesContextFromPi(ctx);
				const store = createNotesStore(storeContext);
				// Empty filler is not a request: models that pass every parameter get the edit path.
				const renameTo = params.rename_to === "" ? undefined : params.rename_to;
				if (renameTo !== undefined) {
					if ((params.edits?.length ?? 0) > 0 || params.origin !== undefined || params.crumpled !== undefined || params.replace_all === true) {
						return failure(new NoteError("invalid_scope", "rename_to is used alone: do not combine it with edits, origin, crumpled, or replace_all"));
					}
					const { replacedCrumpledTarget } = await store.rename(params.address, renameTo);
					const from = noteIdentity(storeContext, params.address).address;
					const to = noteIdentity(storeContext, renameTo);
					return output({ ...to, rename_from: from, rename_to: to.address, applied: 0, change_kind: "file", diff: `rename ${from} -> ${to.address}`, replaced_crumpled_target: replacedCrumpledTarget });
				}
				const { applied, change } = await store.update(params.address, params.edits, { origin: params.origin as Origin | undefined, crumpled: params.crumpled, replaceAll: params.replace_all });
				const diff = renderDiff(change);
				return output({ ...noteIdentity(storeContext, params.address), applied, change_kind: change.kind, diff });
			} catch (error) { return failure(error); }
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_read", label: "Notes read",
		description: `Read a character window of a note file, frontmatter included. ${ADDRESS_DESCRIPTION} offset_chars is the code-point offset to start from (default 0) - a negative value counts back from the end - and limit_chars caps the window (default ${DEFAULT_READ_WINDOW_CHARS}, max ${MAX_READ_WINDOW_CHARS}). Each response delivers the longest fitting prefix of that window in the shared READ WINDOW block: concatenate only the content after the block to reconstruct the note. The header and details identify the resolved address (project key when applicable); offsets and content reflect the actual read.`,
		parameters: Type.Object({ address: Type.String(), offset_chars: Type.Optional(Type.Integer({ description: "Code-point offset to start from (default 0). A negative value counts back from the end; the response echoes the resolved absolute offset. Pass the previous next_offset_chars back unchanged to continue." })), limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: `Largest requested window in code points (default ${DEFAULT_READ_WINDOW_CHARS}). A window too large for the wire budget is cut short; next_offset_chars names where the next read resumes.` })) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			let note: NoteReadResult | undefined;
			let storeContext: ReturnType<typeof notesContextFromPi>;
			try {
				storeContext = notesContextFromPi(ctx);
				note = await createNotesStore(storeContext).read(params.address);
			} catch (error) { return failure(error); }
			if (!note) return failure(new NoteError("not_found", "note not found"));
			const text = note.text;
			const totalChars = Array.from(text).length;
			if (typeof params.offset_chars === "number" && params.offset_chars > totalChars) return failure(new NoteError("invalid_offset", `offset_chars ${params.offset_chars} is past the end: the note has ${totalChars} chars; the largest legal offset is ${totalChars} (an empty end-read)`));
			const resolved = noteIdentity(storeContext, params.address);
			return readCharacterWindow(text, params.offset_chars, params.limit_chars, (window) => {
				const { content, ...rest } = window;
				return outputRaw(readWindowBlock([["address", resolved.address]], window), content, { ...resolved, ...rest });
			}, (result) => withinTextBudget(result.content[0].text));
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_list", label: "Notes list",
		description: `List note files as a recent-first snapshot carrying address and updated_at; wastebasket rows also carry crumpled_at. more is the number of matching files omitted by limit or the wire budget; use pattern to narrow the address range. ${ADDRESS_DESCRIPTION} Listings merge your five prefixes: this session, @project/, @human/, @self/, and @model/. The receipt counts hidden crumpled files and names unavailable homes; row identities and omission counts reflect the scanned result.`,
		parameters: Type.Object({ pattern: nullableString(), limit: positiveInteger(), wastebasket: WASTEBASKET_PARAMETER }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			let rows: NoteRow[];
			let status: { crumpledExcluded: number; homesUnavailable: string[] };
			let projectKey: string;
			try {
				const storeContext = notesContextFromPi(ctx);
				projectKey = storeContext.projectKey;
				({ rows, status } = await createNotesStore(storeContext).listWithStatus({ pattern: params.pattern ?? undefined, wastebasket: params.wastebasket }));
			} catch (error) { return failure(error); }
			const files: Array<{ address: string; project_key?: string; updated_at: string; crumpled_at?: string; address_truncated?: boolean }> = rows.map((row) => ({ address: row.address, ...projectKeyField(row.scope, projectKey), updated_at: localIso(row.meta.updatedAt), ...(row.meta.crumpledAt === undefined ? {} : { crumpled_at: row.meta.crumpledAt }) }));
			return output(snapshot(files, params.limit, (file, fits) => {
				const address = middleTruncate(file.address, (candidate) => fits({ ...file, address: candidate, address_truncated: true }));
				return { ...file, address, address_truncated: true };
			}, status));
		},
	}));

	pi.registerTool(defineTool({
		name: "notes_search", label: "Notes search",
		description: `Case-insensitive literal substring search over note bodies; query is one string or several (OR), each matched line appears once. Results are a recent-first snapshot, not pageable; more counts matching files omitted by limit or the wire budget. Use pattern to narrow the address range. ${ADDRESS_DESCRIPTION} Search merges the same five prefixes as notes_list. Patterns glob over full address strings. Each file entry carries matches_total, its full match count before per-file capping. Each match carries line, text, offset_chars (a code-point offset into the serialized note returned by notes_read, at the earliest query match), and truncated (some line text is omitted). Pass address and offset_chars to notes_read to read from the match. The receipt counts hidden crumpled files and names unavailable homes; row identities, matches, and omission counts come from the scan.`,
		parameters: Type.Object({ query: searchQuery(), pattern: nullableString(), limit: positiveInteger(), max_matches_per_file: positiveInteger(), wastebasket: WASTEBASKET_PARAMETER }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			let rows: NoteSearchRow[];
			let status: { crumpledExcluded: number; homesUnavailable: string[] };
			let projectKey: string;
			try {
				const storeContext = notesContextFromPi(ctx);
				projectKey = storeContext.projectKey;
				({ rows, status } = await createNotesStore(storeContext).searchWithStatus(searchQueries(params.query), { pattern: params.pattern ?? undefined, wastebasket: params.wastebasket }));
			} catch (error) { return failure(error); }
			const maxPerFile = params.max_matches_per_file ?? Number.POSITIVE_INFINITY;
			rows.sort(byRecent);
			const result: Array<{ address: string; updated_at: string; crumpled_at?: string; matches_total: number; matches: Array<{ line: number; text: string; truncated: boolean; offset_chars: number }>; address_truncated?: boolean }> = rows.map((row) => {
				const matches = row.matches.map((match) => ({ line: match.line, text: match.text, truncated: false, offset_chars: match.offsetChars }));
				return { address: row.address, ...projectKeyField(row.scope, projectKey), updated_at: localIso(row.meta.updatedAt), ...(row.meta.crumpledAt === undefined ? {} : { crumpled_at: row.meta.crumpledAt }), matches_total: matches.length, matches: matches.slice(0, maxPerFile) };
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
			return output(snapshot(result, params.limit, fitFile, status));
		},
	}));
}
