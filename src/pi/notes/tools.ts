import { defineTool, generateDiffString, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notesWrite, notesUpdate, notesRead, notesList, notesSearch } from "../../tools/notes.js";
import { notesIdentityFromPi } from "./adapter.js";
import type { NoteChange } from "../../notes/store.js";

function renderDiff(change: NoteChange): string {
	return change.kind === "none" ? "" : generateDiffString(change.before, change.after).diff;
}

export function registerNotesTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		...notesWrite,
		async execute(_id, params, _signal, _update, ctx) {
			return notesWrite.execute(params, notesIdentityFromPi(ctx));
		},
	}));
	pi.registerTool(defineTool({
		...notesUpdate,
		async execute(_id, params, _signal, _update, ctx) {
			return notesUpdate.execute(params, notesIdentityFromPi(ctx), renderDiff);
		},
	}));
	pi.registerTool(defineTool({
		...notesRead,
		async execute(_id, params, _signal, _update, ctx) {
			return notesRead.execute(params, notesIdentityFromPi(ctx));
		},
	}));
	pi.registerTool(defineTool({
		...notesList,
		async execute(_id, params, _signal, _update, ctx) {
			return notesList.execute(params, notesIdentityFromPi(ctx));
		},
	}));
	pi.registerTool(defineTool({
		...notesSearch,
		async execute(_id, params, _signal, _update, ctx) {
			return notesSearch.execute(params, notesIdentityFromPi(ctx));
		},
	}));
}
