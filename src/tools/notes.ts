import type { NotesIdentity } from "../notes/identity.js";
import { Type, type Static } from "typebox";
import { localIso } from "../notes/frontmatter.js";
import { isFilesystemError } from "../notes/fs-error.js";
import { createNotesStore, NoteError, noteIdentity, type NoteChange, type NoteMeta, type NoteQueryStatus, type NoteRow, type Scope } from "../notes/index.js";
import { DEFAULT_READ_WINDOW_CHARS, MAX_READ_WINDOW_CHARS, prefixFit } from "./output.js";
import { failure, fitsResult, outcomeSchema, readTextWindow, renderOutcome, renderTextWindow, structuredBytes, success, TextWindowSchema, type Outcome } from "./result.js";
import { nullableString, positiveInteger, InvalidQueryError, searchQueries, searchQuery } from "./schema.js";

const ORIGIN_VALUES = [Type.Literal("user"), Type.Literal("self"), Type.Literal("external")] as const;
const ORIGIN = Type.Optional(Type.Union([...ORIGIN_VALUES], {
	description: "Where the note's content came from. user: written or dictated by the human. self: written by you, the agent (default). external: anything else — third-party text, tool output, fetched material.",
}));
const CRUMPLED_PARAMETER = Type.Optional(Type.Boolean({ description: "true crumples the note: it leaves the boot index, list, and search, stays readable by address, and appears with wastebasket: true. false smooths it back." }));
const WASTEBASKET_PARAMETER = Type.Optional(Type.Boolean({ description: "true lists only crumpled notes instead of live ones." }));
const ADDRESS_DESCRIPTION = "Address forms per the boot protocol. `@` addresses are notes, not files: feed one to read/write/edit/bash and a real directory named `@project` is born. Don't.";
const WINDOW_DESCRIPTION = "The response carries the longest fitting prefix of that window as text, plus the same window as structured fields; when characters remain, the closing line names the offset_chars to pass back to continue.";

/** The one receipt field a caller cannot derive from the address itself. */
function projectKeyField(scope: Scope, projectKey: string): { project_key?: string } {
	return scope === "project" ? { project_key: projectKey } : {};
}

const MAX_ERROR_LINE_FACTS = 20;

/**
 * Typed refusal. Edit locations keep their precise line/edit facts in `details`.
 * Convert expected refusals; unexpected errors propagate unchanged.
 */
function failureOf(error: unknown): Outcome<never> {
	if (error instanceof NoteError) {
		const details: Record<string, unknown> = {};
		let message = error.message;
		if (error.lineNumbers) {
			if (error.lineNumbers.length > MAX_ERROR_LINE_FACTS) {
				details.line_numbers = error.lineNumbers.slice(0, MAX_ERROR_LINE_FACTS);
				details.line_numbers_total = error.lineNumbers.length;
				message = `${message} (this refusal names ${MAX_ERROR_LINE_FACTS} of ${error.lineNumbers.length} match lines; the note is unchanged)`;
			} else {
				details.line_numbers = error.lineNumbers;
			}
		}
		if (error.editIndex !== undefined) details.edit_index = error.editIndex;
		return failure(error.code, message, Object.keys(details).length > 0 ? details : undefined);
	}
	// Address, pattern, and query guards raise declared types; nothing else is converted.
	if (error instanceof InvalidQueryError) return failure("invalid_query", error.message);
	if (isFilesystemError(error)) return failure("io_error", "notes operation failed");
	throw error;
}

function byRecent<T extends { address: string; meta: { updatedAt: number } }>(a: T, b: T): number {
	return b.meta.updatedAt - a.meta.updatedAt || a.address.localeCompare(b.address);
}

/** Metadata keys this layer normalizes; everything else is exposed verbatim under `extra`. */
const NORMALIZED_META_KEYS = new Set(["scope", "origin", "createdAt", "updatedAt", "lastAccessed", "accessCount", "crumpledAt", "project"]);
/** One unrecognized entry, and all of them together, are bounded; omissions are counted, never listed. */
export const MAX_METADATA_ENTRY_BYTES = 1024;
const MAX_METADATA_EXTRA_BYTES = 2048;

/** Include the key: hand-written frontmatter can have arbitrarily long keys. */
function extraEntryBytes(key: string, value: unknown): number {
	return structuredBytes(key) + 1 + structuredBytes(value);
}

export const NoteMetadataSchema = Type.Object({
	origin: Type.Union([...ORIGIN_VALUES]),
	created_at: Type.String(),
	updated_at: Type.String(),
	last_accessed: Type.String(),
	access_count: Type.Integer(),
	crumpled_at: Type.Optional(Type.String()),
	project: Type.Optional(Type.String()),
	extra: Type.Record(Type.String(), Type.Unknown()),
	/** Values left in the file but too large to show, summarized so the summary cannot grow. */
	omitted_extra: Type.Optional(Type.Object({ keys: Type.Integer(), bytes: Type.Integer() })),
});
export type NoteMetadata = Static<typeof NoteMetadataSchema>;

/** Normalize known metadata and bound extras without partially serializing their values. */
function noteMetadata(meta: NoteMeta): NoteMetadata {
	const extra: Record<string, unknown> = {};
	let extraBytes = 0;
	let omittedKeys = 0;
	let omittedBytes = 0;
	for (const [key, value] of Object.entries(meta)) {
		if (NORMALIZED_META_KEYS.has(key) || value === undefined) continue;
		const bytes = extraEntryBytes(key, value);
		if (bytes > MAX_METADATA_ENTRY_BYTES || extraBytes + bytes > MAX_METADATA_EXTRA_BYTES) {
			omittedKeys++;
			omittedBytes += bytes;
			continue;
		}
		extraBytes += bytes;
		// defineProperty keeps a hand-written `__proto__` key as ordinary data.
		Object.defineProperty(extra, key, { value, enumerable: true, writable: true, configurable: true });
	}
	return {
		origin: meta.origin,
		created_at: localIso(meta.createdAt),
		updated_at: localIso(meta.updatedAt),
		last_accessed: localIso(meta.lastAccessed),
		access_count: meta.accessCount,
		...(typeof meta.crumpledAt === "string" ? { crumpled_at: meta.crumpledAt } : {}),
		...(typeof meta.project === "string" ? { project: meta.project } : {}),
		extra,
		...(omittedKeys > 0 ? { omitted_extra: { keys: omittedKeys, bytes: omittedBytes } } : {}),
	};
}

function renderMetadata(metadata: NoteMetadata): string {
	const fields = [
		`origin ${metadata.origin}`,
		`created ${metadata.created_at}`,
		`updated ${metadata.updated_at}`,
		`accessed ${metadata.last_accessed} (${metadata.access_count} ${metadata.access_count === 1 ? "read" : "reads"})`,
		...(metadata.crumpled_at === undefined ? [] : [`crumpled ${metadata.crumpled_at}`]),
		...(metadata.project === undefined ? [] : [`project ${metadata.project}`]),
	];
	const extra = Object.keys(metadata.extra);
	if (extra.length > 0) fields.push(`extra ${JSON.stringify(metadata.extra)}`);
	if (metadata.omitted_extra !== undefined) fields.push(`${metadata.omitted_extra.keys} more metadata values (${metadata.omitted_extra.bytes} bytes) are in the note file but too large to show`);
	return fields.join(" | ");
}

/** Address plus project key in one line; the project key never replaces the address. */
function renderIdentity(identity: { address: string; project_key?: string }): string {
	return identity.project_key === undefined ? identity.address : `${identity.address} (project ${identity.project_key})`;
}

const ListedFileSchema = Type.Object({
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	updated_at: Type.String(),
	crumpled_at: Type.Optional(Type.String()),
});

const MatchSchema = Type.Object({
	line: Type.Integer(),
	text: Type.String(),
	truncated: Type.Boolean(),
	offset_chars: Type.Integer(),
});

const SearchedFileSchema = Type.Object({
	...ListedFileSchema.properties,
	matches_total: Type.Integer(),
	matches: Type.Array(MatchSchema),
});

const SnapshotSchema = {
	more: Type.Integer(),
	crumpled_excluded: Type.Integer(),
	homes_unavailable: Type.Array(Type.String()),
};

export const NotesWriteDataSchema = Type.Object({
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	outcome: Type.Union([Type.Literal("created"), Type.Literal("overwrote"), Type.Literal("uncrumpled")]),
});
export type NotesWriteData = Static<typeof NotesWriteDataSchema>;

export const NotesUpdateDataSchema = Type.Object({
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	applied: Type.Integer(),
	change_kind: Type.Union([Type.Literal("none"), Type.Literal("body"), Type.Literal("metadata"), Type.Literal("file")]),
	diff: Type.String(),
	diff_truncated: Type.Optional(Type.Literal(true)),
	rename_from: Type.Optional(Type.String()),
	rename_to: Type.Optional(Type.String()),
	replaced_crumpled_target: Type.Optional(Type.Boolean()),
});
export type NotesUpdateData = Static<typeof NotesUpdateDataSchema>;

export const NotesReadDataSchema = Type.Object({
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	metadata: NoteMetadataSchema,
	window: TextWindowSchema,
});
export type NotesReadData = Static<typeof NotesReadDataSchema>;

export const NotesListDataSchema = Type.Object({
	files: Type.Array(ListedFileSchema),
	...SnapshotSchema,
});
export type NotesListData = Static<typeof NotesListDataSchema>;

export const NotesSearchDataSchema = Type.Object({
	files: Type.Array(SearchedFileSchema),
	...SnapshotSchema,
});
export type NotesSearchData = Static<typeof NotesSearchDataSchema>;

type Snapshot<T> = Omit<NotesListData, "files"> & { files: T[] };

/** Keep identities intact. Only search previews may shrink to make the first row fit. */
function snapshot<T>(
	rows: T[],
	limit: number | undefined,
	status: NoteQueryStatus,
	renderData: (data: Snapshot<T>) => string,
	shrink?: (item: T, fits: (candidate: T) => boolean) => T,
): Outcome<Snapshot<T>> {
	const files: T[] = [];
	const data = (selected: T[]): Snapshot<T> => ({ files: selected, more: rows.length - selected.length, crumpled_excluded: status.crumpledExcluded, homes_unavailable: status.homesUnavailable });
	const render = (outcome: Outcome<Snapshot<T>>) => renderOutcome(outcome, renderData);
	const fits = (item: T) => fitsResult(success(data([...files, item])), render);
	for (const item of rows.slice(0, limit)) {
		if (fits(item)) {
			files.push(item);
			continue;
		}
		if (files.length === 0 && shrink) {
			const reduced = shrink(item, fits);
			if (fits(reduced)) files.push(reduced);
		}
		if (files.length === 0) return failure("output_too_large", "The first matching note cannot fit in a response without losing its identity.");
		break;
	}
	const outcome = success(data(files));
	return fitsResult(outcome, render) ? outcome : failure("output_too_large", "The notes snapshot metadata exceeds the response budget.");
}

function listedFile(row: Pick<NoteRow, "address" | "scope" | "meta">, identity: NotesIdentity): NotesListData["files"][number] {
	return { address: row.address, ...projectKeyField(row.scope, identity.projectKey), updated_at: localIso(row.meta.updatedAt), ...(row.meta.crumpledAt === undefined ? {} : { crumpled_at: row.meta.crumpledAt }) };
}

export const notesWriteParameters = Type.Object({ address: Type.String(), content: Type.String(), origin: ORIGIN }, { additionalProperties: false });

function renderWriteData(data: NotesWriteData): string {
	return `${data.outcome} ${renderIdentity(data)}`;
}

export const notesWrite = {
	name: "notes_write", label: "Notes write",
	description: `Create or rewrite a note, and name it for what it holds and when to reach for it: a fresh window sees only the name in the index and decides whether to open by it. Write it so the next window can pick it up: what it's for, what was decided, what's still open. Whatever git and history can hand back on their own, leave out. Keep it true when the content drifts. ${ADDRESS_DESCRIPTION} A rewrite replaces the body whole while preserving createdAt and every other frontmatter key. Writing always produces an uncrumpled note. The receipt reports the resolved address, project key when applicable, and actual create/overwrite/uncrumple outcome.`,
	parameters: notesWriteParameters, outputSchema: outcomeSchema(NotesWriteDataSchema), executionMode: "sequential",
	async execute(params: Static<typeof notesWriteParameters>, identity: NotesIdentity): Promise<Outcome<NotesWriteData>> {
		try {
			const { outcome } = await createNotesStore(identity).write(params.address, params.content, { origin: params.origin ?? "self" });
			return success({ ...noteIdentity(identity, params.address), outcome });
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesWriteData>): string => renderOutcome(result, renderWriteData),
} as const;

export const notesUpdateParameters = Type.Object({ address: Type.String(), edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }, { additionalProperties: false }))), origin: ORIGIN, crumpled: CRUMPLED_PARAMETER, replace_all: Type.Optional(Type.Boolean()), rename_to: Type.Optional(Type.String({ description: "Move the note to this address (same address rules as address), preserving createdAt and all other metadata. Used alone: never combined with edits, origin, crumpled, or replace_all. A live note at the target refuses; a crumpled target is replaced. References elsewhere do not follow the move. An empty rename_to is ignored as if omitted." })) }, { additionalProperties: false });

function renderUpdateData(data: NotesUpdateData): string {
	const head = data.rename_from === undefined
		? `${data.change_kind === "none" ? "unchanged" : "updated"} ${renderIdentity(data)}: ${data.applied} ${data.applied === 1 ? "edit" : "edits"}`
		: `moved ${data.rename_from} -> ${data.address}${data.replaced_crumpled_target === true ? " (replaced a crumpled note)" : ""}`;
	const lines = [head];
	if (data.diff_truncated === true) lines.push("diff (this receipt's diff was shortened to fit the output budget; the update itself was applied):");
	else if (data.diff.length > 0) lines.push("diff:");
	if (data.diff.length > 0) lines.push(data.diff);
	return lines.join("\n");
}

function renderUpdate(result: Outcome<NotesUpdateData>): string {
	return renderOutcome(result, renderUpdateData);
}

/** Bound a mutation receipt on both surfaces; a huge diff is cut to the longest fitting prefix. */
function boundedUpdate(data: NotesUpdateData): Outcome<NotesUpdateData> {
	if (fitsResult(success(data), renderUpdate)) return success(data);
	const shortened: NotesUpdateData = { ...data, diff_truncated: true };
	const diff = prefixFit(data.diff, (candidate) => fitsResult(success({ ...shortened, diff: candidate }), renderUpdate));
	const result = success({ ...shortened, diff });
	return fitsResult(result, renderUpdate) ? result : failure("output_too_large", "The update was applied, but its receipt metadata exceeds the response budget.");
}

export const notesUpdate = {
	name: "notes_update", label: "Notes update",
	description: `Update one note: exact-text body edits, a metadata-only change, or a rename_to move; frontmatter is never editable through edits. ${ADDRESS_DESCRIPTION} Each oldText must occur exactly once unless replace_all is set; a multi-match anchor fails with its match line numbers and a zero-match anchor names the failing edit index. edits may be omitted (or empty) for a metadata-only update, which requires at least one of origin/crumpled. rename_to moves the note to a new address preserving createdAt and every other metadata key; it is used alone, never combined with edits, origin, crumpled, or replace_all, refuses a live note at the target, and may replace a crumpled one. The receipt reports resolved identity, the number of edits that changed text, the change kind (including none), and the actual diff, shortened when it would not fit the output budget.`,
	parameters: notesUpdateParameters, outputSchema: outcomeSchema(NotesUpdateDataSchema), executionMode: "sequential",
	async execute(params: Static<typeof notesUpdateParameters>, identity: NotesIdentity, renderDiff: (change: NoteChange) => string): Promise<Outcome<NotesUpdateData>> {
		try {
			const store = createNotesStore(identity);
			// Empty filler is not a request: models that pass every parameter get the edit path.
			const renameTo = params.rename_to === "" ? undefined : params.rename_to;
			if (renameTo !== undefined) {
				if ((params.edits?.length ?? 0) > 0 || params.origin !== undefined || params.crumpled !== undefined || params.replace_all === true) {
					return failureOf(new NoteError("invalid_scope", "rename_to is used alone: do not combine it with edits, origin, crumpled, or replace_all"));
				}
				const { replacedCrumpledTarget } = await store.rename(params.address, renameTo);
				const from = noteIdentity(identity, params.address).address;
				const to = noteIdentity(identity, renameTo);
				return boundedUpdate({ ...to, rename_from: from, rename_to: to.address, applied: 0, change_kind: "file", diff: `rename ${from} -> ${to.address}`, replaced_crumpled_target: replacedCrumpledTarget });
			}
			const { applied, change } = await store.update(params.address, params.edits, { origin: params.origin, crumpled: params.crumpled, replaceAll: params.replace_all });
			return boundedUpdate({ ...noteIdentity(identity, params.address), applied, change_kind: change.kind, diff: renderDiff(change) });
		} catch (error) { return failureOf(error); }
	},
	render: renderUpdate,
} as const;

export const notesReadParameters = Type.Object({ address: Type.String(), offset_chars: Type.Optional(Type.Integer({ description: `Code-point offset into the note body (default 0; the frontmatter is metadata, never body). A negative value counts back from the end; the response echoes the resolved absolute offset. Pass the previous next_offset_chars back unchanged to continue.` })), limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: `Largest requested window in code points (default ${DEFAULT_READ_WINDOW_CHARS}). A window too large for the wire budget is cut short; next_offset_chars names where the next read resumes.` })) }, { additionalProperties: false });

function renderReadData(data: NotesReadData): string {
	return `${renderIdentity(data)}\n${renderMetadata(data.metadata)}\n\n${renderTextWindow(data.window)}`;
}

export const notesRead = {
	name: "notes_read", label: "Notes read",
	description: `Read a window of one note's body, frontmatter excluded. ${ADDRESS_DESCRIPTION} The response leads with the resolved address and the note's metadata, then delivers the body window verbatim. offset_chars is the code-point offset into the body (default 0) - a negative value counts back from the end - and limit_chars caps the window (default ${DEFAULT_READ_WINDOW_CHARS}, max ${MAX_READ_WINDOW_CHARS}). ${WINDOW_DESCRIPTION} Body text is never re-encoded, so concatenating consecutive windows reconstructs the body exactly. Metadata values too large to show are counted rather than listed; they remain in the note file.`,
	parameters: notesReadParameters, outputSchema: outcomeSchema(NotesReadDataSchema),
	async execute(params: Static<typeof notesReadParameters>, identity: NotesIdentity): Promise<Outcome<NotesReadData>> {
		try {
			const note = await createNotesStore(identity).read(params.address);
			if (!note) return failure("not_found", "note not found");
			const totalChars = Array.from(note.body).length;
			if (params.offset_chars !== undefined && params.offset_chars > totalChars) return failure("invalid_offset", `offset_chars ${params.offset_chars} is past the end of the body: the note has ${totalChars} body chars; the largest legal offset is ${totalChars} (an empty end-read)`);
			const resolved = noteIdentity(identity, params.address);
			const metadata = noteMetadata(note.meta);
			return readTextWindow(note.body, params.offset_chars, params.limit_chars, (window) => ({ ...resolved, metadata, window }), (result) => renderOutcome(result, renderReadData));
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesReadData>): string => renderOutcome(result, renderReadData),
} as const;

export const notesListParameters = Type.Object({ pattern: nullableString(), limit: positiveInteger(), wastebasket: WASTEBASKET_PARAMETER }, { additionalProperties: false });

function renderListData(data: NotesListData): string {
	const lines = [`${data.files.length} ${data.files.length === 1 ? "note" : "notes"}`];
	for (const file of data.files) {
		lines.push(`- ${renderIdentity(file)} | updated ${file.updated_at}${file.crumpled_at === undefined ? "" : ` | crumpled ${file.crumpled_at}`}`);
	}
	if (data.more > 0) lines.push(`${data.more} more matching notes omitted; narrow with pattern`);
	if (data.crumpled_excluded > 0) lines.push(`${data.crumpled_excluded} crumpled notes hidden; pass wastebasket to list them`);
	for (const home of data.homes_unavailable) lines.push(`${home} could not be read`);
	return lines.join("\n");
}

export const notesList = {
	name: "notes_list", label: "Notes list",
	description: `List note files as a recent-first snapshot carrying address and updated_at; wastebasket rows also carry crumpled_at. more is the number of matching files omitted by limit or the wire budget; use pattern to narrow the address range. ${ADDRESS_DESCRIPTION} Listings merge your five prefixes: this session, @project/, @human/, @self/, and @model/. The receipt counts hidden crumpled files and names unavailable homes; row identities and omission counts reflect the scanned result.`,
	parameters: notesListParameters, outputSchema: outcomeSchema(NotesListDataSchema),
	async execute(params: Static<typeof notesListParameters>, identity: NotesIdentity): Promise<Outcome<NotesListData>> {
		try {
			const { rows, status } = await createNotesStore(identity).listWithStatus({ pattern: params.pattern ?? undefined, wastebasket: params.wastebasket });
			return snapshot(rows.map(row => listedFile(row, identity)), params.limit, status, renderListData);
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesListData>): string => renderOutcome(result, renderListData),
} as const;

export const notesSearchParameters = Type.Object({ query: searchQuery(), pattern: nullableString(), limit: positiveInteger(), max_matches_per_file: positiveInteger(), wastebasket: WASTEBASKET_PARAMETER }, { additionalProperties: false });

function renderSearchData(data: NotesSearchData): string {
	const lines = [`${data.files.length} ${data.files.length === 1 ? "file" : "files"}`];
	for (const file of data.files) {
		lines.push(`- ${renderIdentity(file)} | updated ${file.updated_at} | ${file.matches_total} ${file.matches_total === 1 ? "match" : "matches"}${file.matches.length < file.matches_total ? ` (${file.matches.length} shown)` : ""}`);
		for (const match of file.matches) lines.push(`  line ${match.line} at offset_chars ${match.offset_chars}: ${match.text}${match.truncated ? " [line shortened]" : ""}`);
	}
	if (data.more > 0) lines.push(`${data.more} more matching files omitted; narrow with pattern`);
	if (data.crumpled_excluded > 0) lines.push(`${data.crumpled_excluded} crumpled notes hidden; pass wastebasket to search them`);
	for (const home of data.homes_unavailable) lines.push(`${home} could not be read`);
	return lines.join("\n");
}

type SearchFile = NotesSearchData["files"][number];

/** Prefer whole match lines; shorten the first line only if no whole line fits. */
function fitSearchFile(file: SearchFile, fits: (candidate: SearchFile) => boolean): SearchFile {
	let low = 0;
	let high = file.matches.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits({ ...file, matches: file.matches.slice(0, mid) })) low = mid;
		else high = mid - 1;
	}
	if (low > 0) return { ...file, matches: file.matches.slice(0, low) };
	const first = file.matches[0];
	if (!first) return file;
	const withText = (text: string): SearchFile => ({ ...file, matches: [{ ...first, text, truncated: true }] });
	return withText(prefixFit(first.text, text => fits(withText(text))));
}

export const notesSearch = {
	name: "notes_search", label: "Notes search",
	description: `Case-insensitive literal substring search over note bodies; query is one string or several (OR), each matched line appears once. Results are a recent-first snapshot, not pageable; more counts matching files omitted by limit or the wire budget. Use pattern to narrow the address range. ${ADDRESS_DESCRIPTION} Search merges the same five prefixes as notes_list. Patterns glob over full address strings. Each file entry carries matches_total, its full match count before per-file capping. Each match carries line, text, offset_chars (a code-point offset into the note body delivered by notes_read, at the earliest query match), and truncated (some line text is omitted). Pass address and offset_chars to notes_read to read from the match. The receipt counts hidden crumpled files and names unavailable homes; row identities, matches, and omission counts come from the scan.`,
	parameters: notesSearchParameters, outputSchema: outcomeSchema(NotesSearchDataSchema),
	async execute(params: Static<typeof notesSearchParameters>, identity: NotesIdentity): Promise<Outcome<NotesSearchData>> {
		try {
			const { rows, status } = await createNotesStore(identity).searchWithStatus(searchQueries(params.query), { pattern: params.pattern ?? undefined, wastebasket: params.wastebasket });
			const files: NotesSearchData["files"] = rows.sort(byRecent).map(row => ({
				...listedFile(row, identity),
				matches_total: row.matches.length,
				matches: row.matches.slice(0, params.max_matches_per_file).map(match => ({ line: match.line, text: match.text, truncated: false, offset_chars: match.offsetChars })),
			}));
			return snapshot(files, params.limit, status, renderSearchData, fitSearchFile);
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesSearchData>): string => renderOutcome(result, renderSearchData),
} as const;
