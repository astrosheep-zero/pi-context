import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNotesStore, type NoteRow, type NotesQuery, type Scope } from "../../src/notes/index.js";
import { notesContextFromPi } from "../../src/pi/notes/adapter.js";
import { physicalPath as corePhysicalPath, scopeDir as coreScopeDir } from "../../src/notes/paths.js";

/** Test-only conveniences for fixtures that still model notes through a live Pi context. */
export function physicalPath(scope: Scope, path: string, ctx: ExtensionContext, who?: string): string {
	return corePhysicalPath(scope, path, notesContextFromPi(ctx), who);
}

export function scopeDir(scope: Scope, ctx: ExtensionContext, who?: string): string {
	return coreScopeDir(scope, notesContextFromPi(ctx), who);
}

export function listNotes(ctx: ExtensionContext, query: NotesQuery = {}): Promise<NoteRow[]> {
	return createNotesStore(notesContextFromPi(ctx)).list(query);
}
