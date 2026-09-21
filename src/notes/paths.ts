import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Scope = "session" | "project" | "personal";

/** Physical home of the on-disk note store: $PI_NOTES_HOME or ~/.agents/notes. */
export function notesRoot(): string {
	const override = process.env.PI_NOTES_HOME;
	return override && override.length > 0 ? resolve(override) : join(homedir(), ".agents", "notes");
}

/** Absolute directory holding the per-session note homes. */
export function sessionHomesRoot(home = notesRoot()): string {
	return join(home, "pi", "session");
}

/**
 * Absolute git root for `cwd`, walking upward until a directory holds a `.git` entry.
 * No git root yields undefined, which projectKey then replaces with the cwd itself.
 */
function gitRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** `<basename(absGitRoot)-sha1(absGitRoot)[:8]>`, or the same formula over cwd with no git root. */
export function projectKey(cwd: string): string {
	const absolute = resolve(cwd);
	const root = gitRoot(absolute) ?? absolute;
	const digest = createHash("sha1").update(root).digest("hex").slice(0, 8);
	return `${basename(root)}-${digest}`;
}

/** Session identity comes from the pi session manager; ids are filesystem-safe by construction. */
function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

/** Absolute directory holding every note of one scope. */
export function scopeDir(scope: Scope, ctx: ExtensionContext): string {
	if (scope === "personal") return join(notesRoot(), "personal");
	if (scope === "project") return join(notesRoot(), "project", projectKey(ctx.cwd));
	return join(sessionHomesRoot(), sessionId(ctx));
}

/**
 * Notes are markdown files: a virtual path without an `.md` suffix gains one, an explicit
 * `.md` is kept as-is, so `a/b` and `a/b.md` name the same physical file.
 */
export function noteFileName(vpath: string): string {
	return vpath.endsWith(".md") ? vpath : `${vpath}.md`;
}

/** Absolute file path for a virtual path in a scope. Callers validate the vpath first. */
export function physicalPath(scope: Scope, vpath: string, ctx: ExtensionContext): string {
	return join(scopeDir(scope, ctx), ...noteFileName(vpath).split("/"));
}
