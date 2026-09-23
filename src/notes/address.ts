import type { NotesContext } from "./context.js";
import { SLUG_PATTERN, type Scope } from "./paths.js";

export type NoteAddress = { scope: Scope; path: string; who?: string };

export const ADDRESS_FORMS = "legal prefixes are @project/, @human/, @self/, and @model/; bare names are this session";

export function assertVirtualPath(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new Error("path must be a non-empty virtual relative path");
	if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) throw new Error("path must be a safe virtual relative path");
	const parts = value.split("/");
	if (parts.some((part) => part.length === 0 || part === "." || part === "..")) throw new Error("path contains an unsupported component");
	return value;
}

/**
 * Minimal glob over virtual note paths: `*` matches any run within a segment (never
 * `/`), `**` matches any run across segments (a leading double-star followed by a
 * slash also matches zero segments, so it covers the root too), `?` matches exactly
 * one non-`/` character. Everything else is literal and the match is anchored to the
 * whole path.
 */
export function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index]!;
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				const followedBySlash = pattern[index + 2] === "/";
				source += followedBySlash ? "(?:[^]*\\/)?" : "[^]*";
				index += followedBySlash ? 2 : 1;
			} else {
				source += "[^/]*";
			}
		} else {
			source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`);
}

/** Glob patterns are not virtual paths (`*` is legal), so they get their own guard. */
export function assertGlobPattern(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new Error("glob pattern must be a string");
	if (value.includes("\0") || value.includes("\\")) throw new Error("glob pattern must not contain NUL or backslashes");
	return value;
}

/**
 * Decode one public note address into its physical home and virtual path. @self and @model
 * are relative; explicit agents/models addresses always name a canonical slug.
 */
export function assertAddress(value: unknown): NoteAddress {
	if (typeof value !== "string") throw new Error(`invalid note address: ${ADDRESS_FORMS}`);
	let scope: Scope = "session";
	let path = value;
	let who: string | undefined;
	if (value.startsWith("@")) {
		const rest = value.slice(1);
		const headEnd = rest.indexOf("/");
		const head = headEnd === -1 ? rest : rest.slice(0, headEnd);
		const tail = headEnd === -1 ? "" : rest.slice(headEnd + 1);
		path = tail;
		if (head === "project") scope = "project";
		else if (head === "human") scope = "human";
		else if (head === "self") scope = "agent";
		else if (head === "model") scope = "model";
		else if (head === "agents" || head === "models") {
			const nameEnd = tail.indexOf("/");
			who = nameEnd === -1 ? tail : tail.slice(0, nameEnd);
			if (!SLUG_PATTERN.test(who)) throw new Error(`invalid note address: ${ADDRESS_FORMS}`);
			scope = head === "agents" ? "agent" : "model";
			path = nameEnd === -1 ? "" : tail.slice(nameEnd + 1);
		} else {
			throw new Error(`invalid note address: ${ADDRESS_FORMS}`);
		}
		if (path === "" && scope !== "agent" && scope !== "model") throw new Error(`invalid note address: ${ADDRESS_FORMS}`);
		if (path === "" && who === undefined) throw new Error(`invalid note address: ${ADDRESS_FORMS}`);
	}
	if (path.includes("@")) throw new Error(`invalid note address: ${ADDRESS_FORMS}`);
	assertVirtualPath(path);
	return { scope, path, who };
}

/** Render a virtual path in its one unambiguous public address form. */
export function addressFor(context: NotesContext, scope: Scope, path: string, who?: string): string {
	if (scope === "session") return path;
	if (scope === "project") return `@project/${path}`;
	if (scope === "human") return `@human/${path}`;
	if (scope === "agent") return `@agents/${who ?? context.agent}/${path}`;
	return `@models/${who ?? context.model}/${path}`;
}
