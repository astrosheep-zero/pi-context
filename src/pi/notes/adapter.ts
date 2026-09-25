import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { NotesContext } from "../../notes/context.js";
import { projectKey, slugify } from "../../notes/paths.js";

/** Pi's default notes root; environment access stays on the host side of the library boundary. */
export function notesRoot(): string {
	const override = process.env.PI_NOTES_HOME;
	return override && override.length > 0 ? resolve(override) : join(homedir(), ".agents", "notes");
}

/** Translate the current Pi runtime into a fresh, explicit identity snapshot. */
export function agentSlug(_ctx: ExtensionContext): string {
	return slugify(process.env.PI_NOTES_AGENT ?? "anonymous");
}

/** Pi's active model identity is resolved live so a mid-session switch retargets @model. */
export function modelSlug(ctx: ExtensionContext): string {
	const id = ctx.model?.id;
	return id ? slugify(id.split("/").pop() ?? id) : "default";
}

/** Translate the current Pi runtime into one explicit notes identity snapshot. */
export function notesContextFromPi(ctx: ExtensionContext, home = notesRoot()): NotesContext {
	return {
		home,
		sessionId: ctx.sessionManager.getSessionId(),
		projectKey: projectKey(ctx.cwd),
		agent: agentSlug(ctx),
		model: modelSlug(ctx),
	};
}

/** One-time host activation migration from the legacy personal/ directory. */
export function migrateLegacyHomes(home = notesRoot()): string | undefined {
	const legacy = join(home, "personal");
	const modern = join(home, "human");
	if (!existsSync(legacy)) return undefined;
	if (existsSync(modern)) return "both personal/ and human/ exist under the notes home; migrate by hand, no automatic merge";
	renameSync(legacy, modern);
	return undefined;
}
