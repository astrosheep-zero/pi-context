import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { NotesContext } from "./context.js";

export type Scope = "session" | "project" | "human" | "agent" | "model";

/** The one legal home-name shape: lowercase [a-z0-9-] runs separated by single dashes. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Slugify a caller-declared identity; identity is never inferred from note content. */
export function slugify(value: string): string {
	const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "root";
}

/** `<basename(absGitRoot)-sha1(absGitRoot)[:8]>`, or the same formula over cwd with no git root. */
export function projectKey(cwd: string): string {
	const absolute = resolve(cwd);
	const root = gitRoot(absolute) ?? absolute;
	const digest = createHash("sha1").update(root).digest("hex").slice(0, 8);
	return `${basename(root)}-${digest}`;
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

/** Absolute repository root for cwd, walking upward until a directory holds a `.git` entry. */
function gitRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return repositoryRoot(dir);
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Absolute directory holding the per-session note homes. */
export function sessionHomesRoot(home: string): string {
	return join(home, "pi", "session");
}

/** Absolute directory holding one scope's notes. The context's home is already resolved. */
export function scopeDir(scope: Scope, context: NotesContext, who?: string): string {
	if (!["session", "project", "human", "agent", "model"].includes(scope)) throw new TypeError("invalid notes scope");
	if (who !== undefined && (scope !== "agent" && scope !== "model" || !SLUG_PATTERN.test(who))) throw new TypeError("who must be a canonical agent/model slug");
	if (scope === "human") return join(context.home, "human");
	if (scope === "project") return join(context.home, "project", context.projectKey);
	if (scope === "agent") return join(context.home, "agents", who ?? context.agent);
	if (scope === "model") return join(context.home, "models", who ?? context.model);
	return join(sessionHomesRoot(context.home), context.sessionId);
}

/** Every existing home directory of the agents/ or models/ namespace, as names. */
export async function namespaceSlugs(namespace: "agents" | "models", home: string): Promise<string[]> {
	try {
		return (await readdir(join(home, namespace), { withFileTypes: true }))
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
export function physicalPath(scope: Scope, vpath: string, context: NotesContext, who?: string): string {
	if (typeof vpath !== "string" || vpath.length === 0 || vpath.includes("\0") || vpath.includes("\\") || vpath.startsWith("/")) throw new TypeError("path must be a safe virtual relative path");
	if (vpath.split("/").some((part) => part.length === 0 || part === "." || part === "..")) throw new TypeError("path contains an unsupported component");
	return join(scopeDir(scope, context, who), ...noteFileName(vpath).split("/"));
}
