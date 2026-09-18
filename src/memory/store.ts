import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { assertGlobPattern, assertVirtualPath, globToRegExp } from "../notes.js";
import { MAX_NOTE_BYTES, MAX_NOTE_PATH_BYTES } from "../protocol.js";
import { isOrigin, isScope, parseNote, serializeNote, stripLeadingFrontmatter, type NoteMeta, type Origin } from "./frontmatter.js";
import { physicalPath, scopeDir, type Scope } from "./paths.js";

export type { NoteMeta, Origin, Scope };

export type NoteErrorCode = "not_found" | "ambiguous_edit" | "no_match" | "nothing_to_do" | "target_exists" | "too_large" | "invalid_scope" | "invalid_origin";

/** Typed store refusal. `line_numbers` and `edit_index` are the edit error's addressing fields. */
export class NoteError extends Error {
	readonly code: NoteErrorCode;
	readonly line_numbers?: number[];
	readonly edit_index?: number;
	constructor(code: NoteErrorCode, message: string, extra: { line_numbers?: number[]; edit_index?: number } = {}) {
		super(message);
		this.name = "NoteError";
		this.code = code;
		this.line_numbers = extra.line_numbers;
		this.edit_index = extra.edit_index;
	}
}

export type NoteRow = { path: string; meta: NoteMeta; sizeBytes: number };
export type NoteMatch = { line: number; text: string; offsetChars: number };
export type NoteSearchRow = { path: string; scope: Scope; meta: NoteMeta; matches: NoteMatch[] };

const SCOPE_ORDER: readonly Scope[] = ["session", "project", "global"];

function assertScope(value: unknown): Scope {
	if (!isScope(value)) throw new NoteError("invalid_scope", `scope must be one of session, project, global (got ${JSON.stringify(value)})`);
	return value;
}

function assertOrigin(value: unknown): Origin {
	if (!isOrigin(value)) throw new NoteError("invalid_origin", `origin must be one of user, self, external (got ${JSON.stringify(value)})`);
	return value;
}

function scopeList(scope?: unknown): Scope[] {
	if (scope === undefined || scope === null) return [...SCOPE_ORDER];
	return [assertScope(scope)];
}

type Resolved = { scope: Scope; path: string; raw: string };

/** First existing file by precedence session → project → global, or only `scope` when given. */
function resolve(ctx: ExtensionContext, vpath: string, scope?: unknown): Resolved | undefined {
	for (const candidate of scopeList(scope)) {
		const path = physicalPath(candidate, vpath, ctx);
		if (existsSync(path)) return { scope: candidate, path, raw: readFileSync(path, "utf8") };
	}
	return undefined;
}

/** Recursively list `.md` files under `dir` as forward-slash virtual paths relative to `base`. */
function walkMarkdown(dir: string, base = dir): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const paths: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const child = `${dir}/${entry.name}`;
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
 * Every mutation lands through a tmp file renamed into place in the same directory, so a crash
 * never leaves a torn note. No cross-process locking: out of scope by decision.
 */
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

/** Write-time vpath guard: the byte cap is a tool-boundary rule, never a jail rule. */
function assertWritablePath(vpath: string): void {
	const bytes = Buffer.byteLength(vpath, "utf8");
	if (bytes > MAX_NOTE_PATH_BYTES) throw new NoteError("too_large", `note path exceeds ${MAX_NOTE_PATH_BYTES} UTF-8 bytes (got ${bytes})`);
}

/** Serialized-size guard applied after the frontmatter is merged, before any bytes are written. */
function assertSerializedSize(content: string): void {
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_NOTE_BYTES) throw new NoteError("too_large", `note exceeds ${MAX_NOTE_BYTES} UTF-8 bytes (serialized ${bytes})`);
}

/** Frontmatter block only (the body separator stripped), for the metadata-only diff. */
function frontmatterOf(meta: NoteMeta): string {
	return serializeNote(meta, "").slice(0, -2);
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

export type WriteOptions = { scope: Scope; origin: Origin; stale?: boolean };

/** Create or overwrite a note; overwrite keeps created_at and every unknown key. */
export function writeNote(ctx: ExtensionContext, vpath: string, body: string, opts: WriteOptions): { meta: NoteMeta } {
	assertVirtualPath(vpath);
	assertWritablePath(vpath);
	const scope = assertScope(opts.scope);
	const origin = assertOrigin(opts.origin);
	const path = physicalPath(scope, vpath, ctx);
	const now = Date.now();
	const cleanBody = stripLeadingFrontmatter(body);
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
	};
	meta.scope = scope;
	meta.origin = origin;
	meta.status = "active";
	meta.stale = opts.stale ?? false;
	meta.updated_at = now;
	const serialized = serializeNote(meta, cleanBody);
	assertSerializedSize(serialized);
	atomicWrite(path, serialized);
	return { meta };
}

export type EditOperation = { oldText: string; newText: string };
export type EditOptions = { scope?: Scope; origin?: Origin; stale?: boolean; replaceAll?: boolean };

/** Apply body-only edits against one snapshot, then optionally move via the scope/origin/stale setters. */
export function editNote(ctx: ExtensionContext, vpath: string, edits: EditOperation[] | undefined, opts: EditOptions = {}): { meta: NoteMeta; applied: number; resolved_scope: Scope; diff: string } {
	assertVirtualPath(vpath);
	assertWritablePath(vpath);
	const operations = edits ?? [];
	if (operations.length === 0 && opts.scope === undefined && opts.origin === undefined && opts.stale === undefined) {
		throw new NoteError("nothing_to_do", "nothing to do: provide edits or at least one of scope, origin, stale");
	}
	const found = resolve(ctx, vpath);
	if (!found) throw new NoteError("not_found", "note not found");
	const { meta, body } = parseNote(found.raw);
	// Snapshot the pre-edit frontmatter so the diff can name exactly what the setters changed.
	const beforeMeta: NoteMeta = { ...meta };
	// Every edit runs against this one snapshot; nothing is written until all of them succeed,
	// so a failing edit leaves the file byte-identical (frontmatter included).
	let next = body;
	operations.forEach((edit, index) => {
		const oldText = edit?.oldText;
		const newText = edit?.newText;
		if (typeof oldText !== "string" || oldText.length === 0) throw new NoteError("no_match", `edit ${index}: oldText must be a non-empty string`, { edit_index: index });
		if (typeof newText !== "string") throw new NoteError("no_match", `edit ${index}: newText must be a string`, { edit_index: index });
		const lines = matchLineNumbers(next, oldText);
		if (lines.length === 0) throw new NoteError("no_match", `edit ${index}: oldText does not occur in the note body`, { edit_index: index });
		if (lines.length > 1 && !opts.replaceAll) {
			throw new NoteError("ambiguous_edit", `edit ${index}: oldText occurs ${lines.length} times (lines ${lines.join(", ")}); pass replace_all to replace every occurrence`, { line_numbers: lines, edit_index: index });
		}
		next = opts.replaceAll ? next.split(oldText).join(newText) : next.replace(oldText, newText);
	});
	const destScope = opts.scope === undefined ? found.scope : assertScope(opts.scope);
	if (opts.origin !== undefined) meta.origin = assertOrigin(opts.origin);
	if (opts.stale !== undefined) meta.stale = opts.stale;
	meta.scope = destScope;
	meta.updated_at = Date.now();
	const dest = physicalPath(destScope, vpath, ctx);
	const moving = dest !== found.path;
	if (moving && existsSync(dest)) {
		throw new NoteError("target_exists", `a note already exists at ${vpath} in scope ${destScope}; the move was refused and both files are unchanged`);
	}
	const serialized = serializeNote(meta, next);
	assertSerializedSize(serialized);
	// pi-edit-style diff: body only for a content edit, frontmatter only for a metadata-only
	// update, one combined file diff when both moved.
	const bodyChanged = body !== next;
	const metadataChanged = beforeMeta.scope !== meta.scope || beforeMeta.origin !== meta.origin || beforeMeta.stale !== meta.stale;
	const diff = bodyChanged && metadataChanged
		? generateDiffString(found.raw, serialized).diff
		: bodyChanged
			? generateDiffString(body, next).diff
			: metadataChanged
				? generateDiffString(frontmatterOf(beforeMeta), frontmatterOf(meta)).diff
				: "";
	atomicWrite(dest, serialized);
	if (moving) rmSync(found.path);
	return { meta, applied: operations.length, resolved_scope: found.scope, diff };
}

/** Read a note and, as a side effect, bump last_accessed/access_count in the file. */
export function readNote(ctx: ExtensionContext, vpath: string, opts: { scope?: Scope } = {}): { meta: NoteMeta; body: string; resolvedScope: Scope } | undefined {
	assertVirtualPath(vpath);
	const found = resolve(ctx, vpath, opts.scope);
	if (!found) return undefined;
	const now = Date.now();
	const { meta, body } = parseNote(found.raw, now);
	meta.scope = found.scope;
	// Only the two access keys move; updated_at and every other key keep their bytes.
	meta.last_accessed = now;
	meta.access_count = (typeof meta.access_count === "number" ? meta.access_count : 0) + 1;
	atomicWrite(found.path, serializeNote(meta, body));
	return { meta, body, resolvedScope: found.scope };
}

/** The scope that holds `vpath` first by precedence, without reading or mutating the file. */
export function resolveNoteScope(ctx: ExtensionContext, vpath: string, scope?: Scope): { scope: Scope; path: string } | undefined {
	const found = resolve(ctx, vpath, scope);
	return found ? { scope: found.scope, path: found.path } : undefined;
}

/** Read a note's meta and body without the read side effect (used by the boot index). */
export function peekNote(ctx: ExtensionContext, scope: Scope, vpath: string): { meta: NoteMeta; body: string } {
	const path = physicalPath(scope, vpath, ctx);
	const { meta, body } = parseNote(readFileSync(path, "utf8"));
	meta.scope = scope;
	return { meta, body };
}

/** Merged rows across scopes, most recently updated first (path then scope break ties). */
export function listNotes(ctx: ExtensionContext, opts: { scope?: Scope; pattern?: string } = {}): NoteRow[] {
	const matcher = matcherFor(opts.pattern);
	const rows: NoteRow[] = [];
	for (const scope of scopeList(opts.scope)) {
		const root = scopeDir(scope, ctx);
		for (const path of walkMarkdown(root)) {
			if (matcher && !matcher.test(path)) continue;
			const { meta, body } = parseNote(readFileSync(`${root}/${path}`, "utf8"));
			meta.scope = scope;
			rows.push({ path, meta, sizeBytes: Buffer.byteLength(body, "utf8") });
		}
	}
	rows.sort((a, b) => b.meta.updated_at - a.meta.updated_at || a.path.localeCompare(b.path) || a.meta.scope.localeCompare(b.meta.scope));
	return rows;
}

/** Case-sensitive literal substring search over note bodies, with a match address per line. */
export function searchNotes(ctx: ExtensionContext, queries: string[], opts: { scope?: Scope; pattern?: string } = {}): NoteSearchRow[] {
	const matcher = matcherFor(opts.pattern);
	const rows: NoteSearchRow[] = [];
	for (const scope of scopeList(opts.scope)) {
		const root = scopeDir(scope, ctx);
		for (const path of walkMarkdown(root)) {
			if (matcher && !matcher.test(path)) continue;
			const { meta, body } = parseNote(readFileSync(`${root}/${path}`, "utf8"));
			meta.scope = scope;
			let baseChars = 0;
			const matches: NoteMatch[] = [];
			for (const [index, line] of body.split("\n").entries()) {
				if (queries.some((query) => line.includes(query))) {
					let earliest = -1;
					for (const query of queries) {
						const found = line.indexOf(query);
						if (found >= 0 && (earliest < 0 || found < earliest)) earliest = found;
					}
					matches.push({ line: index + 1, text: line, offsetChars: baseChars + (earliest <= 0 ? 0 : Array.from(line.slice(0, earliest)).length) });
				}
				baseChars += Array.from(line).length + 1;
			}
			if (matches.length > 0) rows.push({ path, scope, meta, matches });
		}
	}
	rows.sort((a, b) => a.path.localeCompare(b.path) || a.scope.localeCompare(b.scope));
	return rows;
}
