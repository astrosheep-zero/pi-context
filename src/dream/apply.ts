import { mkdirSync, renameSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { editNote, peekNote, resolveNoteScope, updateNoteMeta, writeNote, type Scope } from "../memory/store.js";
import { physicalPath, scopeDir } from "../memory/paths.js";
import { parseNote } from "../memory/frontmatter.js";
import type { Manifest } from "./manifest.js";

type Target = { scope: Scope; path: string };
function target(ctx: ExtensionContext, value: string, required = true): Target | undefined {
	const m = /^(session|project|global):(.*)$/.exec(value);
	if (m) { const scope = m[1] as Scope; const path = m[2]!; const physical = physicalPath(scope, path, ctx); if (!existsSync(physical)) { if (required) throw new Error(`unknown path: ${value}`); return undefined; } return { scope, path }; }
	const found = resolveNoteScope(ctx, value);
	if (!found && required) throw new Error(`unknown path: ${value}`);
	return found ? { scope: found.scope, path: value } : undefined;
}
function body(ctx: ExtensionContext, t: Target) { return peekNote(ctx, t.scope, t.path); }
export function applyManifest(ctx: ExtensionContext, home: string, stamp: string, manifest: Manifest): string[] {
	const actions: string[] = [];
	// Resolve every referenced note and promotion destination before the first mutation.
	for (const m of manifest.merge ?? []) { target(ctx, m.into); for (const p of m.from) target(ctx, p); }
	for (const p of manifest.promote ?? []) { const from = target(ctx, p.path)!; if (p.to !== "global") { if (!["session", "project"].includes(p.to)) throw new Error(`invalid promotion scope: ${p.to}`); if (existsSync(physicalPath(p.to as Scope, p.path, ctx))) throw new Error(`promotion collision: ${p.path}`); } void from; }
	for (const p of manifest.trash ?? []) target(ctx, p.path);
	for (const merge of manifest.merge ?? []) {
		const into = target(ctx, merge.into)!;
		const sources = merge.from.map((p) => target(ctx, p)!);
		const base = body(ctx, into); const chunks = [base.body, ...sources.map((s) => body(ctx, s).body)].filter(Boolean);
		const dedup = [...new Set(chunks)].join("\n\n");
		writeNote(ctx, into.path, dedup, { scope: into.scope, origin: base.meta.origin });
		updateNoteMeta(ctx, into.path, into.scope, (meta) => { meta.recurrence_count = (meta.recurrence_count ?? 0) as number + sources.length; meta.recurrence_windows = [...new Set([...(meta.recurrence_windows ?? []), ...sources.map((s) => body(ctx, s).meta.source_window).filter((x): x is string => typeof x === "string")])]; });
		for (const source of sources) updateNoteMeta(ctx, source.path, source.scope, (meta) => { meta.status = "superseded"; meta.supersedes = merge.into; });
		actions.push(`merged ${merge.from.join(", ")} into ${merge.into}`);
	}
	for (const p of manifest.promote ?? []) {
		const from = target(ctx, p.path)!; const m = body(ctx, from); const scope = p.to as Scope;
		if (!["session", "project", "global"].includes(scope)) throw new Error(`invalid promotion scope: ${p.to}`);
		if (scope === "global") { actions.push(`proposal: promote ${p.path} to global (${p.reason})`); continue; }
		const dest = physicalPath(scope, p.path, ctx); if (existsSync(dest)) throw new Error(`promotion collision: ${p.path}`);
		editNote(ctx, from.path, undefined, { scope });
		actions.push(`promoted ${p.path} to ${scope}`);
	}
	const trashRoot = join(home, "trash", stamp); mkdirSync(trashRoot, { recursive: true });
	for (const item of manifest.trash ?? []) { const t = target(ctx, item.path)!; const source = physicalPath(t.scope, t.path, ctx); const dest = join(trashRoot, t.scope, t.path.endsWith(".md") ? t.path : `${t.path}.md`); mkdirSync(dirname(dest), { recursive: true }); renameSync(source, dest); actions.push(`trashed ${item.path}: ${item.reason}`); }
	for (const p of manifest.pending ?? []) actions.push(`pending ${p.path}: ${p.reason}`);
	for (const p of manifest.skillCandidates ?? []) actions.push(`skill proposal ${p.title}: ${p.rationale}`);
	return actions;
}
