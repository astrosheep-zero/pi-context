import { notesIdentityFromPi } from "../src/pi/notes/adapter.ts";
import { PI_TOOL_NAMES } from "../src/pi/tool-names.ts";
// Live smoke: render the REAL boot block against the REAL notes homes (~/.agents/notes),
// cwd = /Users/astrosheep/playground. Imports only src modules — no test side effects.
import { renderBootBlock } from "../src/boot/render.ts";
import { loadNotesSnapshot } from "../src/boot/snapshot.ts";
import { agentSlug, modelSlug } from "../src/pi/notes/adapter.ts";
import { rootWindowId } from "../src/pi/window.ts";

const ctx = {
	cwd: process.argv[2] ?? "/Users/astrosheep/playground",
	sessionManager: {
		getSessionName: () => "root",
		getSessionId: () => "smoke-live-check",
		getBranch: () => [],
	},
};
const boot = renderBootBlock({
		tools: PI_TOOL_NAMES,
	agentName: agentSlug(ctx as never),
	modelName: modelSlug(ctx as never),
	firstWindowId: rootWindowId(ctx.sessionManager.getSessionId()),
	currentWindowId: "pcw:smoke:current",
	notes: await loadNotesSnapshot(notesIdentityFromPi(ctx as never), Date.now()),
});
console.log(boot);
