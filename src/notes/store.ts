import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { assertAddress, assertGlobPattern, addressFor, globToRegExp } from "./address.js";
import { snapshotNotesContext, type NotesContext } from "./context.js";
import { MAX_NOTE_BYTES, MAX_NOTE_PATH_BYTES } from "./constants.js";
import { isOrigin, isScope, parseNote, serializeNote, stripLeadingFrontmatter, type NoteMeta, type NoteStatus, type Origin } from "./frontmatter.js";
import { namespaceSlugs, physicalPath, scopeDir, SLUG_PATTERN, type Scope } from "./paths.js";

export type { NoteMeta, NoteStatus, Origin, Scope };

export type NoteErrorCode = "not_found" | "ambiguous_edit" | "no_match" | "nothing_to_do" | "too_large" | "invalid_scope" | "invalid_origin";

/** Typed store refusal. Edit locations are exposed in camelCase. */
export class NoteError extends Error {
	readonly code: NoteErrorCode;
	readonly lineNumbers?: number[];
	readonly editIndex?: number;
	constructor(code: NoteErrorCode, message: string, extra: { lineNumbers?: number[]; editIndex?: number } = {}) {
		super(message);
		this.name = "NoteError";
		this.code = code;
		this.lineNumbers = extra.lineNumbers;
		this.editIndex = extra.editIndex;
	}
}

export type NoteRow = { address: string; scope: Scope; path: string; meta: NoteMeta; body: string; sizeBytes: number };
export type NoteMatch = { line: number; text: string; offsetChars: number };
export type NoteSearchRow = { address: string; scope: Scope; path: string; meta: NoteMeta; matches: NoteMatch[] };
export type EditOperation = { oldText: string; newText: string };
export type WriteOptions = { origin?: Origin; stale?: boolean };
export type EditOptions = { origin?: Origin; stale?: boolean; replaceAll?: boolean };
export type NotesQuery = (
	| { scope?: undefined; who?: never }
	| { scope: "session" | "project" | "human"; who?: never }
	| { scope: "agent" | "model"; who?: string }
) & { pattern?: string };
export type NoteReadResult = { meta: NoteMeta; body: string; text: string; resolvedScope: Scope };
export type NoteWriteResult = { meta: NoteMeta };
export type NoteChange =
	| { kind: "none"; before: ""; after: "" }
	| { kind: "body" | "metadata" | "file"; before: string; after: string };
export type NoteEditResult = { meta: NoteMeta; applied: number; resolvedScope: Scope; change: NoteChange };

/** Host-neutral, filesystem-backed notes API. */
export interface NotesStore {
	write(address: string, content: string, options?: WriteOptions): NoteWriteResult;
	read(address: string): NoteReadResult | undefined;
	edit(address: string, edits?: EditOperation[], options?: EditOptions): NoteEditResult;
	list(options?: NotesQuery): NoteRow[];
	search(queries: string[], options?: NotesQuery): NoteSearchRow[];
}

const SCOPE_ORDER: readonly Scope[] = ["session", "project", "human", "agent", "model"];

function assertScope(value: unknown): Scope {
	if (!isScope(value)) throw new NoteError("invalid_scope", `scope must be one of session, project, human, agent, model (got ${JSON.stringify(value)})`);
	return value;
}

function assertOrigin(value: unknown): Origin {
	if (!isOrigin(value)) throw new NoteError("invalid_origin", `origin must be one of user, self, external (got ${JSON.stringify(value)})`);
	return value;
}

function assertWho(value: unknown): string {
	if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
		throw new NoteError("invalid_scope", "who must be a canonical lowercase slug");
	}
	return value;
}

/** Recursively list `.md` files under `dir` as forward-slash virtual paths relative to `base`. */
function walkMarkdown(dir: string, base = dir): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		// A home that has never been created is normal. Other failures must reach the
		// boot snapshot boundary instead of masquerading as an empty home.
		if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const paths: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const child = join(dir, entry.name);
		if (entry.isDirectory()) paths.push(...walkMarkdown(child, base));
		else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(child.slice(base.length + 1).split("\\").join("/"));
	}
	return paths;
}

function matcherFor(pattern: unknown): RegExp | undefined {
	const normalized = assertGlobPattern(pattern);
	return normalized === undefined ? undefined : globToRegExp(normalized);
}

/**
 * Which homes one call iterates. A pattern whose head is a reserved home narrows the set
 * before any file is read; a glob in an agents/models name scans that namespace.
 */
type HomeRef = { scope: Scope; who?: string };

function homesForPattern(pattern: string | undefined, context: NotesContext): HomeRef[] | undefined {
	if (!pattern || !pattern.startsWith("@")) return undefined;
	const head = /^@([^/]+)\//.exec(pattern)?.[1];
	if (head === "project") return [{ scope: "project" }];
	if (head === "human") return [{ scope: "human" }];
	if (head === "self") return [{ scope: "agent" }];
	if (head === "model") return [{ scope: "model" }];
	if (head === "agents" || head === "models") {
		const scope: Scope = head === "agents" ? "agent" : "model";
		const name = pattern.slice(head.length + 2).split("/")[0] ?? "";
		if (name.length > 0 && !/[*?]/.test(name)) return [{ scope, who: assertWho(name) }];
		return namespaceSlugs(head, context.home).map((who) => ({ scope, who }));
	}
	return [];
}

/** Relative pattern heads resolve to canonical names, so they match rendered addresses. */
function normalizePattern(pattern: string | undefined, context: NotesContext): string | undefined {
	if (!pattern) return pattern;
	if (pattern.startsWith("@self/")) return `@agents/${context.agent}/${pattern.slice("@self/".length)}`;
	if (pattern.startsWith("@model/")) return `@models/${context.model}/${pattern.slice("@model/".length)}`;
	return pattern;
}

function homesFor(context: NotesContext, opts: NotesQuery): HomeRef[] {
	if (opts.scope !== undefined) {
		const scope = assertScope(opts.scope);
		if (opts.who !== undefined) {
			const who = assertWho(opts.who);
			if (scope !== "agent" && scope !== "model") throw new NoteError("invalid_scope", "who is only valid with agent or model scope");
			return [{ scope, who }];
		}
		return [{ scope }];
	}
	if (opts.who !== undefined) throw new NoteError("invalid_scope", "who requires agent or model scope");
	return homesForPattern(normalizePattern(opts.pattern, context), context) ?? SCOPE_ORDER.map((scope) => ({ scope }));
}

/** Line numbers (1-based) of every occurrence of `needle` in `body`. */
function matchLineNumbers(body: string, needle: string): number[] {
	const lines: number[] = [];
	let cursor = 0;
	for (;;) {
		const index = body.indexOf(needle, cursor);
		if (index === -1) break;
		lines.push(body.slice(0, index).split("\n").length);
		cursor = index + Math.max(needle.length, 1);
	}
	return lines;
}

/** Code-point offset of the earliest query occurrence, matching the serialized read text. */
function earliestMatchOffsetChars(text: string, queries: string[]): number {
	let earliest = -1;
	for (const query of queries) {
		const index = text.indexOf(query);
		if (index < 0) continue;
		if (earliest < 0 || index < earliest) earliest = index;
	}
	return earliest <= 0 ? 0 : Array.from(text.slice(0, earliest)).length;
}

/** Every mutation uses a tmp file renamed into place in the same directory. */
function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tmp, content);
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/** The byte cap is a write-time boundary rule, never a path-jail rule. */
function assertWritablePath(vpath: string): void {
	const bytes = Buffer.byteLength(vpath, "utf8");
	if (bytes > MAX_NOTE_PATH_BYTES) throw new NoteError("too_large", `note path exceeds ${MAX_NOTE_PATH_BYTES} UTF-8 bytes (got ${bytes})`);
}

function assertSerializedSize(content: string): void {
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_NOTE_BYTES) throw new NoteError("too_large", `note exceeds ${MAX_NOTE_BYTES} UTF-8 bytes (serialized ${bytes})`);
}

/** Frontmatter block only (the body separator stripped), for metadata-only change inputs. */
function frontmatterOf(meta: NoteMeta): string {
	return serializeNote(meta, "").slice(0, -2);
}

/** Named agent/model homes are read-only to whoever is not running there. */
function assertWritableHome(scope: Scope, who: string | undefined, context: NotesContext): void {
	if (who === undefined) return;
	const current = scope === "agent" ? context.agent : context.model;
	if (who === current) return;
	const home = scope === "agent" ? `@agents/${who}/` : `@models/${who}/`;
	throw new NoteError("invalid_scope", `${home} is not your home: writable homes are this session, @project/, @human/, @self/, and the current @model/ home`);
}

/** Normalize parsed metadata exactly as a read does, including its access mutation. */
function accessedMeta(meta: NoteMeta, scope: Scope, now: number): NoteMeta {
	const next = { ...meta, scope };
	next.last_accessed = now;
	next.access_count = (typeof next.access_count === "number" ? next.access_count : 0) + 1;
	return next;
}

/** Create a store over one validated, immutable snapshot of the supplied explicit identity. */
export function createNotesStore(input: NotesContext): NotesStore {
	const context = snapshotNotesContext(input);

	function write(address: string, content: string, options: WriteOptions = {}): NoteWriteResult {
		const destination = assertAddress(address);
		assertWritablePath(destination.path);
		const scope = assertScope(destination.scope);
		assertWritableHome(scope, destination.who, context);
		const origin = assertOrigin(options.origin ?? "self");
		const path = physicalPath(scope, destination.path, context, destination.who);
		const now = Date.now();
		const cleanBody = stripLeadingFrontmatter(content);
		const existing = existsSync(path) ? parseNote(readFileSync(path, "utf8"), now).meta : undefined;
		const meta: NoteMeta = existing ?? {
			scope,
			origin,
			status: "active",
			stale: false,
			created_at: now,
			updated_at: now,
			last_accessed: now,
			access_count: 0,
			...(scope === "session" ? { project: context.projectKey } : {}),
		};
		meta.scope = scope;
		meta.origin = origin;
		meta.status = "active";
		meta.stale = options.stale ?? false;
		meta.updated_at = now;
		const serialized = serializeNote(meta, cleanBody);
		assertSerializedSize(serialized);
		atomicWrite(path, serialized);
		return { meta };
	}

	function read(address: string): NoteReadResult | undefined {
		const destination = assertAddress(address);
		const scope = assertScope(destination.scope);
		const path = physicalPath(scope, destination.path, context, destination.who);
		if (!existsSync(path)) return undefined;
		const now = Date.now();
		const parsed = parseNote(readFileSync(path, "utf8"), now);
		const meta = accessedMeta(parsed.meta, scope, now);
		const text = serializeNote(meta, parsed.body);
		atomicWrite(path, text);
		return { meta, body: parsed.body, text, resolvedScope: scope };
	}

	function edit(address: string, edits?: EditOperation[], options: EditOptions = {}): NoteEditResult {
		const destination = assertAddress(address);
		assertWritablePath(destination.path);
		const scope = assertScope(destination.scope);
		assertWritableHome(scope, destination.who, context);
		const operations = edits ?? [];
		if (operations.length === 0 && options.origin === undefined && options.stale === undefined) {
			throw new NoteError("nothing_to_do", "nothing to do: provide edits or at least one of origin, stale");
		}
		const path = physicalPath(scope, destination.path, context, destination.who);
		if (!existsSync(path)) throw new NoteError("not_found", "note not found");
		const raw = readFileSync(path, "utf8");
		const { meta, body } = parseNote(raw);
		meta.scope = scope;
		const beforeMeta: NoteMeta = { ...meta };
		let next = body;
		operations.forEach((operation, index) => {
			const oldText = operation?.oldText;
			const newText = operation?.newText;
			if (typeof oldText !== "string" || oldText.length === 0) throw new NoteError("no_match", `edit ${index}: oldText must be a non-empty string`, { editIndex: index });
			if (typeof newText !== "string") throw new NoteError("no_match", `edit ${index}: newText must be a string`, { editIndex: index });
			const lines = matchLineNumbers(next, oldText);
			if (lines.length === 0) throw new NoteError("no_match", `edit ${index}: oldText does not occur in the note body`, { editIndex: index });
			if (lines.length > 1 && !options.replaceAll) {
				throw new NoteError("ambiguous_edit", `edit ${index}: oldText occurs ${lines.length} times (lines ${lines.join(", ")}); pass replace_all to replace every occurrence`, { lineNumbers: lines, editIndex: index });
			}
			// Positional splicing preserves user replacement text byte-for-byte.
			if (options.replaceAll) next = next.split(oldText).join(newText);
			else {
				const matchIndex = next.indexOf(oldText);
				next = next.substring(0, matchIndex) + newText + next.substring(matchIndex + oldText.length);
			}
		});
		if (options.origin !== undefined) meta.origin = assertOrigin(options.origin);
		if (options.stale !== undefined) meta.stale = options.stale;
		meta.updated_at = Date.now();
		const serialized = serializeNote(meta, next);
		assertSerializedSize(serialized);
		const bodyChanged = body !== next;
		const metadataChanged = beforeMeta.origin !== meta.origin || beforeMeta.stale !== meta.stale;
		let change: NoteChange;
		if (bodyChanged && metadataChanged) change = { kind: "file", before: raw, after: serialized };
		else if (bodyChanged) change = { kind: "body", before: body, after: next };
		else if (metadataChanged) change = { kind: "metadata", before: frontmatterOf(beforeMeta), after: frontmatterOf(meta) };
		else change = { kind: "none", before: "", after: "" };
		atomicWrite(path, serialized);
		return { meta, applied: operations.length, resolvedScope: scope, change };
	}

	function list(options: NotesQuery = {}): NoteRow[] {
		const matcher = matcherFor(normalizePattern(options.pattern, context));
		const rows: NoteRow[] = [];
		for (const home of homesFor(context, options)) {
			const scope = home.scope;
			const root = scopeDir(scope, context, home.who);
			for (const path of walkMarkdown(root)) {
				const address = addressFor(context, scope, path, home.who);
				if (matcher && !matcher.test(address)) continue;
				const { meta, body } = parseNote(readFileSync(join(root, path), "utf8"));
				meta.scope = scope;
				rows.push({ address, scope, path, meta, body, sizeBytes: Buffer.byteLength(body, "utf8") });
			}
		}
		rows.sort((a, b) => b.meta.updated_at - a.meta.updated_at || a.address.localeCompare(b.address));
		return rows;
	}

	function search(queries: string[], options: NotesQuery = {}): NoteSearchRow[] {
		const matcher = matcherFor(normalizePattern(options.pattern, context));
		const rows: NoteSearchRow[] = [];
		for (const home of homesFor(context, options)) {
			const scope = home.scope;
			const root = scopeDir(scope, context, home.who);
			for (const path of walkMarkdown(root)) {
				const address = addressFor(context, scope, path, home.who);
				if (matcher && !matcher.test(address)) continue;
				const { meta, body } = parseNote(readFileSync(join(root, path), "utf8"));
				meta.scope = scope;
				const serializedBodyOffset = Array.from(serializeNote(accessedMeta(meta, scope, Date.now()), "")).length;
				let baseChars = 0;
				const matches: NoteMatch[] = [];
				for (const [index, line] of body.split("\n").entries()) {
					if (queries.some((query) => line.includes(query))) {
						matches.push({ line: index + 1, text: line, offsetChars: serializedBodyOffset + baseChars + earliestMatchOffsetChars(line, queries) });
					}
					baseChars += Array.from(line).length + 1;
				}
				if (matches.length > 0) rows.push({ address, path, scope, meta, matches });
			}
		}
		rows.sort((a, b) => a.address.localeCompare(b.address));
		return rows;
	}

	return { write, read, edit, list, search };
}
