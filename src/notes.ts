import type { SessionReader } from "./session-reader.js";
import { MAX_NOTE_BYTES, NOTE_TYPE } from "./protocol.js";

export type NoteFile = { text: string; stale: boolean; createdAt: number; updatedAt: number };
export type NoteOperation = {
	op: "write" | "append";
	path: string;
	// Both are optional on the wire so mark-only and explicit-revive operations replay:
	// at least one of text/stale is present, enforced by the note tools and isNoteOperation.
	text?: string;
	stale?: boolean;
	createdAt: number;
	updatedAt: number;
};
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

/** Glob patterns are not virtual paths (`*` is legal), so they get their own guard: no NUL, no backslashes. */
export function assertGlobPattern(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new Error("glob pattern must be a string");
	if (value.includes("\0") || value.includes("\\")) throw new Error("glob pattern must not contain NUL or backslashes");
	return value;
}

/** Replays only pi-context note operations from session custom entries. */
function isNoteOperation(data: unknown): data is NoteOperation {
	if (typeof data !== "object" || data === null) return false;
	const op = data as Partial<NoteOperation>;
	return (
		(op.op === "write" || op.op === "append") &&
		typeof op.path === "string" &&
		(op.text === undefined || typeof op.text === "string") &&
		(op.stale === undefined || typeof op.stale === "boolean") &&
		(op.text !== undefined || op.stale !== undefined) &&
		typeof op.createdAt === "number" && Number.isFinite(new Date(op.createdAt).getTime()) &&
		typeof op.updatedAt === "number" && Number.isFinite(new Date(op.updatedAt).getTime())
	);
}

export function notesFromSession(ctx: SessionReader): Map<string, NoteFile> {
	const files = new Map<string, NoteFile>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== NOTE_TYPE || !isNoteOperation(entry.data)) continue;
		const op = entry.data;
		try {
			assertVirtualPath(op.path);
		} catch {
			continue;
		}
		const previous = files.get(op.path);
		const hasText = op.text !== undefined;
		// A mark-only operation needs an existing note to change; without one it is a no-op.
		if (!hasText && !previous) continue;
		const text = hasText ? (op.op === "append" ? `${previous?.text ?? ""}${op.text}` : op.text as string) : previous!.text;
		if (Buffer.byteLength(text, "utf8") > MAX_NOTE_BYTES) continue;
		// Carrying text revives unless the call also marks stale; a mark-only op keeps its flag.
		const stale = hasText ? op.stale ?? false : op.stale ?? previous!.stale;
		files.set(op.path, { text, stale, createdAt: previous?.createdAt ?? op.createdAt, updatedAt: op.updatedAt });
	}
	return files;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/**
 * Format epoch milliseconds as an ISO 8601 string in the host's local time zone with an
 * explicit numeric offset (e.g. 2026-09-15T17:31:45.392+08:00). A UTC host renders
 * "+00:00"; the "Z" designator is never used, and Date.parse round-trips the value.
 */
export function localIso(epochMs: number): string {
	const date = new Date(epochMs);
	const offsetMinutes = -date.getTimezoneOffset();
	const absOffset = Math.abs(offsetMinutes);
	const offset = `${offsetMinutes < 0 ? "-" : "+"}${pad2(Math.floor(absOffset / 60))}:${pad2(absOffset % 60)}`;
	const wallClock = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
	return `${wallClock}${offset}`;
}
