import type { SessionReader } from "../../session-reader.js";
import { MAX_NOTE_BYTES, NOTE_TYPE } from "../../protocol.js";
import { assertVirtualPath } from "../../notes/address.js";

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
