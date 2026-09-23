import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import {
	addressFor,
	createNotesStore,
	NoteError,
	type EditOperation,
	type EditOptions,
	type NoteMatch,
	type NoteMeta,
	type NoteRow,
	type NoteSearchRow,
	type Origin,
	type Scope,
} from "./lib/index.js";
import { notesContextFromPi } from "./pi-adapter.js";

export { NoteError };
export type { EditOperation, EditOptions, NoteMatch, NoteMeta, NoteRow, NoteSearchRow, Origin, Scope };

/** Legacy host-call shape retained as an adapter; storage lives only in notes/lib. */
export type WriteOptions = { scope: Scope; who?: string; origin: Origin; stale?: boolean };

export function writeNote(ctx: ExtensionContext, vpath: string, body: string, opts: WriteOptions): { meta: NoteMeta } {
	const context = notesContextFromPi(ctx);
	const notes = createNotesStore(context);
	const address = addressFor(context, opts.scope, vpath, opts.who);
	return notes.write(address, body, { origin: opts.origin, stale: opts.stale });
}

export function editNote(
	ctx: ExtensionContext,
	vpath: string,
	scope: Scope,
	edits: EditOperation[] | undefined,
	opts: EditOptions = {},
	who?: string,
): { meta: NoteMeta; applied: number; resolved_scope: Scope; diff: string } {
	const context = notesContextFromPi(ctx);
	const result = createNotesStore(context).edit(addressFor(context, scope, vpath, who), edits, opts);
	const { change, ...rest } = result;
	const diff = change.before === "" && change.after === "" ? "" : generateDiffString(change.before, change.after).diff;
	return { ...rest, diff };
}

export function readNote(ctx: ExtensionContext, vpath: string, scope: Scope, who?: string) {
	const context = notesContextFromPi(ctx);
	return createNotesStore(context).read(addressFor(context, scope, vpath, who));
}

export function listNotes(ctx: ExtensionContext, opts: { scope?: Scope; who?: string; pattern?: string } = {}): NoteRow[] {
	return createNotesStore(notesContextFromPi(ctx)).list(opts);
}

export function searchNotes(ctx: ExtensionContext, queries: string[], opts: { scope?: Scope; who?: string; pattern?: string } = {}): NoteSearchRow[] {
	return createNotesStore(notesContextFromPi(ctx)).search(queries, opts);
}
