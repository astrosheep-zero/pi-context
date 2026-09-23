import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { notesContextFromPi, notesRoot } from "./pi-adapter.js";
import {
	namespaceSlugs as libraryNamespaceSlugs,
	noteFileName,
	physicalPath as libraryPhysicalPath,
	projectKey,
	scopeDir as libraryScopeDir,
	sessionHomesRoot as librarySessionHomesRoot,
	slugify,
	SLUG_PATTERN,
	type Scope,
} from "./lib/index.js";

export type { Scope };
export { noteFileName, projectKey, slugify, SLUG_PATTERN };

/** Pi's notes root is resolved from the live host environment. */
export { notesRoot };

export function sessionHomesRoot(home = notesRoot()): string {
	return librarySessionHomesRoot(home);
}

/** Current Pi agent identity, translated into the library's canonical slug form. */
export function agentSlug(_ctx: ExtensionContext): string {
	return slugify(process.env.PI_NOTES_AGENT ?? "root");
}

/** Current Pi model identity, resolved live so mid-session model changes retarget @model. */
export function modelSlug(ctx: ExtensionContext): string {
	const id = ctx.model?.id;
	if (!id) return "default";
	return slugify(id.split("/").pop() ?? id);
}

/** Pi-context physical directory adapter for legacy host callers. */
export function scopeDir(scope: Scope, ctx: ExtensionContext, who?: string): string {
	return libraryScopeDir(scope, notesContextFromPi(ctx), who);
}

/** One-time activation migration remains host-side and never runs at library construction. */
export function migrateLegacyHomes(home = notesRoot()): string | undefined {
	const legacy = join(home, "personal");
	const modern = join(home, "human");
	if (!existsSync(legacy)) return undefined;
	if (existsSync(modern)) return "both personal/ and human/ exist under the notes home; migrate by hand, no automatic merge";
	renameSync(legacy, modern);
	return undefined;
}

/** Host compatibility helper; namespace enumeration uses the current explicit root. */
export function namespaceSlugs(namespace: "agents" | "models", home = notesRoot()): string[] {
	return libraryNamespaceSlugs(namespace, home);
}

/** Pi-context physical file path adapter for existing boot, doctor, and tests. */
export function physicalPath(scope: Scope, vpath: string, ctx: ExtensionContext, who?: string): string {
	return libraryPhysicalPath(scope, vpath, notesContextFromPi(ctx), who);
}
