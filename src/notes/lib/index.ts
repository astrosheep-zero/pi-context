export { snapshotNotesContext, type NotesContext } from "./context.js";
export { ADDRESS_FORMS, assertAddress, assertGlobPattern, assertVirtualPath, addressFor, globToRegExp, type NoteAddress } from "./address.js";
export { MAX_NOTE_BYTES, MAX_NOTE_PATH_BYTES } from "./constants.js";
export * from "./frontmatter.js";
export {
	namespaceSlugs,
	noteFileName,
	physicalPath,
	projectKey,
	scopeDir,
	sessionHomesRoot,
	slugify,
	SLUG_PATTERN,
} from "./paths.js";
export {
	createNotesStore,
	NoteError,
	type EditOperation,
	type EditOptions,
	type ListOptions,
	type NoteEditResult,
	type NoteErrorCode,
	type NoteMatch,
	type NoteReadResult,
	type NoteRow,
	type NoteSearchRow,
	type NoteMeta,
	type Origin,
	type Scope,
	type NoteWriteResult,
	type NotesStore,
	type SearchOptions,
	type WriteOptions,
} from "./store.js";
