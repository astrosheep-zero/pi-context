// Live smoke: render the REAL boot block against the REAL notes homes (~/.agents/notes),
// cwd = /Users/astrosheep/playground. Imports only src modules — no test side effects.
import { bootBlock } from "../src/prompts.ts";

const ctx = {
	cwd: "/Users/astrosheep/playground",
	sessionManager: {
		getSessionName: () => "root",
		getSessionId: () => "smoke-live-check",
		getBranch: () => [],
	},
};
const boot = bootBlock(ctx as never, "pcw:smoke:current", undefined, false);
console.log(boot);
