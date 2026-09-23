import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Scope = "session" | "project" | "human" | "agent" | "model";

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
 * Repository root behind one `.git` entry. A `.git` directory is the main checkout
 * itself. A `.git` file is a worktree or submodule pointer: a linked worktree names
 * `<main>/.git/worktrees/<name>` and resolves to `<main>`, so every worktree of one
 * repository shares one project identity. Submodules, bare repositories, and separate
 * git dirs keep the current directory.
 */
function repositoryRoot(dir: string): string {
	let stats;
	try {
		stats = statSync(join(dir, ".git"));
	} catch {
		return dir;
	}
	if (stats.isDirectory()) return dir;
	let pointer: string;
	try {
		pointer = readFileSync(join(dir, ".git"), "utf8");
	} catch {
		return dir;
	}
	const match = /^gitdir:\s*(.+)$/m.exec(pointer);
	if (!match) return dir;
	const parts = resolve(dir, match[1]!.trim()).split(sep);
	const worktrees = parts.lastIndexOf("worktrees");
	if (worktrees <= 0 || worktrees !== parts.length - 2) return dir;
	const common = parts.slice(0, worktrees).join(sep);
	return basename(common) === ".git" ? dirname(common) : dir;
}

/**
 * Absolute repository root for `cwd`, walking upward until a directory holds a `.git`
 * entry and then resolving that entry to the main checkout.
 * No git root yields undefined, which projectKey then replaces with the cwd itself.
 */
function gitRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return repositoryRoot(dir);
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

/** The one legal home-name shape: lowercase [a-z0-9-] runs separated by single dashes. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Identity slugs: one declared name per home, never detected from prompt content.
 * `PI_NOTES_AGENT` declares who is running (default "root"); the model slug derives
 * from the live model id, provider prefix stripped. Both slugified to [a-z0-9-].
 */
export function slugify(value: string): string {
	const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "root";
}

/** The current agent's home name: the launch-declared identity, defaulting to "root". */
export function agentSlug(_ctx: ExtensionContext): string {
	return slugify(process.env.PI_NOTES_AGENT ?? "root");
}

/** The current model's home name, live-resolved from ctx.model; "default" when unknown. */
export function modelSlug(ctx: ExtensionContext): string {
	const id = ctx.model?.id;
	if (!id) return "default";
	return slugify(id.split("/").pop() ?? id);
}

/**
 * Absolute directory holding every note of one scope. `who` names an agent or model
 * home absolutely; omitted, the current one resolves (agent from PI_NOTES_AGENT,
 * model live from ctx.model).
 */
export function scopeDir(scope: Scope, ctx: ExtensionContext, who?: string): string {
	if (scope === "human") return join(notesRoot(), "human");
	if (scope === "project") return join(notesRoot(), "project", projectKey(ctx.cwd));
	if (scope === "agent") return join(notesRoot(), "agents", who ?? agentSlug(ctx));
	if (scope === "model") return join(notesRoot(), "models", who ?? modelSlug(ctx));
	return join(sessionHomesRoot(), sessionId(ctx));
}

/**
 * One-time migration of the pre-v0.25 `personal/` home to `human/`. Runs at extension
 * activation; returns a warning string when both directories exist (no auto-merge),
 * undefined otherwise. Old note bodies are history, not addresses, and stay untouched.
 */
export function migrateLegacyHomes(home = notesRoot()): string | undefined {
	const legacy = join(home, "personal");
	const modern = join(home, "human");
	if (!existsSync(legacy)) return undefined;
	if (existsSync(modern)) return "both personal/ and human/ exist under the notes home; migrate by hand, no automatic merge";
	renameSync(legacy, modern);
	return undefined;
}

/** Every existing home directory of the agents/ or models/ namespace, as slugs. */
export function namespaceSlugs(namespace: "agents" | "models", home = notesRoot()): string[] {
	try {
		return readdirSync(join(home, namespace), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/**
 * Notes are markdown files: a virtual path without an `.md` suffix gains one, an explicit
 * `.md` is kept as-is, so `a/b` and `a/b.md` name the same physical file.
 */
export function noteFileName(vpath: string): string {
	return vpath.endsWith(".md") ? vpath : `${vpath}.md`;
}

/** Absolute file path for a virtual path in a scope. Callers validate the vpath first. */
export function physicalPath(scope: Scope, vpath: string, ctx: ExtensionContext, who?: string): string {
	return join(scopeDir(scope, ctx, who), ...noteFileName(vpath).split("/"));
}
