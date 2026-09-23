import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type NotesContext } from "./lib/context.js";
import { projectKey, slugify } from "./lib/paths.js";

/** Pi's default notes root; environment access stays on the host side of the library boundary. */
export function notesRoot(): string {
	const override = process.env.PI_NOTES_HOME;
	return override && override.length > 0 ? resolve(override) : join(homedir(), ".agents", "notes");
}

/** Translate the current Pi runtime into a fresh, explicit identity snapshot. */
export function notesContextFromPi(ctx: ExtensionContext, home = notesRoot()): NotesContext {
	const modelId = ctx.model?.id;
	return {
		home,
		sessionId: ctx.sessionManager.getSessionId(),
		projectKey: projectKey(ctx.cwd),
		agent: slugify(process.env.PI_NOTES_AGENT ?? "root"),
		model: modelId ? slugify(modelId.split("/").pop() ?? modelId) : "default",
	};
}
