export { createNotesStore, noteIdentity } from "./store.js";
export { NoteError, type NoteErrorCode } from "./errors.js";
export { projectKey, slugify } from "./paths.js";
export type { NotesIdentity } from "./identity.js";
export type {
	EditOperation,
	EditOptions,
	NoteChange,
	NoteEditResult,
	NoteMatch,
	NoteMeta,
	NoteQueryResult,
	NoteQueryStatus,
	NoteReadResult,
	NoteRenameResult,
	NoteRow,
	NoteSearchRow,
	NoteWriteResult,
	NotesQuery,
	NotesStore,
	Origin,
	Scope,
	WriteOptions,
} from "./store.js";
