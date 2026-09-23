import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNotesStore, type NoteRow, type Scope } from "./lib/index.js";
import { notesContextFromPi } from "./pi-adapter.js";

const NOTES_HOMES = [
	{ scope: "session", label: "this session" },
	{ scope: "project", label: "@project" },
	{ scope: "human", label: "@human" },
	{ scope: "agent", label: "@self" },
	{ scope: "model", label: "@model" },
] as const satisfies ReadonlyArray<{ scope: Scope; label: string }>;

export type NotesHome = (typeof NOTES_HOMES)[number];
export type NotesLoader = (ctx: ExtensionContext, scope: Scope) => NoteRow[];
export type NotesSnapshot = {
	/** Wall-clock instant captured when this boot began; rendering never consults Date.now(). */
	readonly openedAt: number;
	readonly homes: ReadonlyMap<Scope, readonly NoteRow[]>;
	readonly unavailable: readonly NotesHome[];
};

/**
 * Acquire the five homes once for one boot. Only filesystem-style errno failures are isolated;
 * malformed note data and unrelated construction errors remain visible to the caller.
 */
export function loadNotesSnapshot(ctx: ExtensionContext, loadHome?: NotesLoader): NotesSnapshot {
	const openedAt = Date.now();
	const store = createNotesStore(notesContextFromPi(ctx));
	const load = loadHome ?? ((_context: ExtensionContext, scope: Scope) => store.list({ scope }));
	const homes = new Map<Scope, readonly NoteRow[]>();
	const unavailable: NotesHome[] = [];
	for (const home of NOTES_HOMES) {
		try {
			homes.set(home.scope, load(ctx, home.scope));
		} catch (error) {
			const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
			if (typeof code !== "string" || !/^E[A-Z0-9_]+$/.test(code) || code.startsWith("ERR_")) throw error;
			homes.set(home.scope, []);
			unavailable.push(home);
		}
	}
	return { openedAt, homes, unavailable };
}
