// Live smoke: render the REAL boot block against the REAL notes homes (~/.agents/notes),
// cwd = /Users/astrosheep/playground. Imports only src modules — no test side effects.
import { renderBootBlock } from "../src/context/prompts.ts";
import { loadNotesSnapshot } from "../src/pi/notes/snapshot.ts";
import { agentSlug, modelSlug } from "../src/pi/notes/adapter.ts";
import { rootWindowId } from "../src/context/context-window.ts";

const ctx = {
	cwd: process.argv[2] ?? "/Users/astrosheep/playground",
	sessionManager: {
		getSessionName: () => "root",
		getSessionId: () => "smoke-live-check",
		getBranch: () => [],
	},
};
const boot = renderBootBlock({
	agentName: agentSlug(ctx as never),
	modelName: modelSlug(ctx as never),
	firstWindowId: rootWindowId(ctx.sessionManager.getSessionId()),
	currentWindowId: "pcw:smoke:current",
	notes: await loadNotesSnapshot(ctx as never),
});
console.log(boot);
