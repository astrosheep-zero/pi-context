/**
 * OWNER: pi-context (adopted).
 * STATUS: tracked acceptance spec for the real-file notes store and its five tools.
 * CLAIM: notes live as markdown files under $PI_NOTES_HOME with harness-owned frontmatter;
 *   the five tools (notes_write/update/read/list/search) are the only note surface, and the
 *   boot index reads the physical store across scopes.
 * HERMETIC: every test points PI_NOTES_HOME at its own temp root; no real ~/.agents is touched.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { parseNote } from "../src/notes/frontmatter.js";
import { projectKey } from "../src/notes/paths.js";
import type { Scope } from "../src/notes/index.js";
import { listNotes, physicalPath, scopeDir } from "./helpers/notes.js";
import { CONTEXT_WINDOW_PROTOCOL_OPEN_TAG, MAX_NOTE_BYTES, MAX_NOTE_PATH_BYTES } from "../src/protocol.js";
import { call, context, explicitBoot, makeExtension, manager, resultJson, resultRead, runHandlers } from "./helpers/extension.js";
import { installExtensionTestHooks } from "./helpers/extension-test-environment.js";

const testEnvironment = installExtensionTestHooks("pi-context-notes");

function freshRoot(): string {
	return testEnvironment.newNotesRoot();
}

function setUpdatedAt(scope: Scope, path: string, ctx: ReturnType<typeof context>, timestamp: number): void {
	const file = physicalPath(scope, path, ctx);
	const raw = readFileSync(file, "utf8");
	writeFileSync(file, raw.replace(/^updatedAt: .*$/m, `updatedAt: ${new Date(timestamp).toISOString()}`));
}

type Meta = Record<string, unknown>;
type Listed = { files: Array<{ address: string; updated_at: string; crumpled_at?: string }> };
type Searched = { files: Array<{ address: string; updated_at: string; crumpled_at?: string; matches_total: number; matches: Array<{ line: number; text: string; offset_chars: number; truncated: boolean }> }> };

function assertNoPublicScope(value: unknown, label: string): void {
	if (Array.isArray(value)) {
		for (const item of value) assertNoPublicScope(item, label);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		assert.notEqual(key, "scope", `${label} does not expose scope`);
		assert.notEqual(key, "resolved_scope", `${label} does not expose resolved_scope`);
		assertNoPublicScope(child, label);
	}
}

test("exactly the five notes tools are registered; the legacy five are gone", () => {
	const captured = makeExtension(manager());
	for (const name of ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search"]) {
		assert.ok(captured.tools.get(name), `${name} is registered`);
	}
	for (const legacy of ["notes_write_file", "notes_append_to_file", "notes_read_file", "notes_search_contents", "notes_list_files"]) {
		assert.equal(captured.tools.get(legacy), undefined, `${legacy} is unregistered`);
	}
	assert.equal(captured.tools.get("notes_write")?.executionMode, "sequential");
	assert.equal(captured.tools.get("notes_update")?.executionMode, "sequential");
	assert.equal(captured.tools.get("notes_read")?.executionMode, undefined);
});

test("note schemas drop status/stale and expose crumpled plus wastebasket", () => {
	const captured = makeExtension(manager());
	const schema = (name: string): TSchema => captured.tools.get(name)!.parameters as TSchema;
	const write = schema("notes_write");
	assert.equal(Check(write, { address: "a.md", content: "x" }), true);
	assert.equal(Check(write, { address: "a.md", content: "x", stale: true }), false, "notes_write no longer accepts stale");
	assert.equal(Check(write, { address: "a.md", content: "x", crumpled: true }), false, "notes_write does not accept crumpled");
	const edit = schema("notes_update");
	assert.equal(Check(edit, { address: "a.md", crumpled: true }), true);
	assert.equal(Check(edit, { address: "a.md", stale: true }), false, "notes_update no longer accepts stale");
	assert.equal(Check(edit, { address: "a.md", status: "archived" }), false, "status is gone");
	for (const name of ["notes_list", "notes_search"]) {
		const base = name === "notes_search" ? { query: "x" } : {};
		assert.equal(Check(schema(name), { ...base, wastebasket: true }), true, `${name} accepts wastebasket`);
		assert.equal(Check(schema(name), { ...base, status: "active" }), false, `${name} rejects status`);
	}
});

test("write lands a real markdown file with harness frontmatter and a pure body", async () => {
	const root = freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const sessionId = session.getSessionId();

	const result = resultJson<{ address: string; written: true }>(
		await call(captured, "notes_write", { address: "a/b.md", content: "hello" }, ctx),
	);
	assert.deepEqual(Object.keys(result).sort(), ["address", "written"]);
	const file = physicalPath("session", "a/b.md", ctx);
	assert.equal(file, join(root, "pi", "session", sessionId, "a", "b.md"));
	assert.ok(existsSync(file), "the note is a real file under the session scope dir");
	const raw = readFileSync(file, "utf8");
	assert.match(raw, /^---\n/, "the file opens with frontmatter");
	assert.match(raw, /\n---\n\nhello$/, "frontmatter is followed by a blank line and the exact body");
	for (const [key, value] of [["origin", "self"], ["accessCount", "0"]]) {
		assert.match(raw, new RegExp(`^${key}: ${value}$`, "m"), `frontmatter carries ${key}=${value}`);
	}
	assert.equal(/^scope:/m.test(raw), false, "scope is derived from the file home, never persisted");
	assert.equal(/^status:/m.test(raw), false, "status is gone from persisted notes");
	assert.equal(/^stale:/m.test(raw), false, "the boolean stale flag is gone from persisted notes");
	assert.equal(/^crumpledAt:/m.test(raw), false, "a fresh note is uncrumpled");
	for (const key of ["createdAt", "updatedAt", "lastAccessed"]) {
		assert.match(raw, new RegExp(`^${key}: \\d{4}-\\d{2}-\\d{2}T`, "m"), `frontmatter renders ${key} via localIso`);
	}
	assert.equal(parseNote(raw).meta.project, projectKey(ctx.cwd), "a newly-created session note records its existing project key");
	assert.equal(result.address, "a/b.md");
	assert.equal(result.written, true);
	assert.equal(existsSync(join(scopeDir("session", ctx), ".session.json")), false, "ownership is stored in note frontmatter, not a sidecar");

	// A leading YAML block in user content is stripped from the body.
	await call(captured, "notes_write", { address: "stripped.md", content: "---\nscope: human\nnonsense: true\n---\nreal body" }, ctx);
	const stripped = readFileSync(physicalPath("session", "stripped.md", ctx), "utf8");
	assert.match(stripped, /\n---\n\nreal body$/, "the injected block is not part of the body");
	assert.equal(stripped.includes("nonsense"), false, "the injected block never reaches the file");
});

test("session-note project ownership is per note, persistent across sessions, and not reassigned by cwd", async () => {
	freshRoot();
	const cwdA = join(testEnvironment.cwd, "project-a");
	const cwdB = join(testEnvironment.cwd, "project-b");
	mkdirSync(cwdA, { recursive: true });
	mkdirSync(cwdB, { recursive: true });
	const projectA = projectKey(cwdA);
	const projectB = projectKey(cwdB);
	assert.notEqual(projectA, projectB);

	const firstSession = manager();
	const firstCaptured = makeExtension(firstSession);
	const firstCtx = context(firstSession, undefined, undefined, true, cwdA);
	await call(firstCaptured, "notes_write", { address: "first.md", content: "first project session" }, firstCtx);
	const firstFile = physicalPath("session", "first.md", firstCtx);
	assert.equal(parseNote(readFileSync(firstFile, "utf8")).meta.project, projectA);

	const secondSession = manager();
	const secondCaptured = makeExtension(secondSession);
	const secondCtx = context(secondSession, undefined, undefined, true, cwdA);
	await call(secondCaptured, "notes_write", { address: "second.md", content: "same project, another session" }, secondCtx);
	const secondFile = physicalPath("session", "second.md", secondCtx);
	assert.equal(parseNote(readFileSync(secondFile, "utf8")).meta.project, projectA, "another session in the same project carries the matching key");

	const thirdSession = manager();
	const thirdCaptured = makeExtension(thirdSession);
	const thirdCtx = context(thirdSession, undefined, undefined, true, cwdB);
	await call(thirdCaptured, "notes_write", { address: "third.md", content: "different project" }, thirdCtx);
	const thirdFile = physicalPath("session", "third.md", thirdCtx);
	assert.equal(parseNote(readFileSync(thirdFile, "utf8")).meta.project, projectB);
	const projectASessions = [firstFile, secondFile, thirdFile].filter((file) => parseNote(readFileSync(file, "utf8")).meta.project === projectA);
	assert.deepEqual(projectASessions.sort(), [firstFile, secondFile].sort(), "exact frontmatter project matching recognizes only sessions from the same project");

	const movedContext = context(firstSession, undefined, undefined, true, cwdB);
	await call(firstCaptured, "notes_write", { address: "first.md", content: "overwritten from another cwd" }, movedContext);
	assert.equal(parseNote(readFileSync(firstFile, "utf8")).meta.project, projectA, "overwriting an existing note does not silently reassign it");
	await call(firstCaptured, "notes_update", { address: "first.md", edits: [{ oldText: "overwritten", newText: "edited" }] }, movedContext);
	assert.equal(parseNote(readFileSync(firstFile, "utf8")).meta.project, projectA, "editing an existing note preserves its original project key");
	await call(firstCaptured, "notes_read", { address: "first.md" }, movedContext);
	assert.equal(parseNote(readFileSync(firstFile, "utf8")).meta.project, projectA, "reading preserves existing project ownership");

	await call(firstCaptured, "notes_write", { address: "new-from-project-b.md", content: "new note" }, movedContext);
	assert.equal(parseNote(readFileSync(physicalPath("session", "new-from-project-b.md", movedContext), "utf8")).meta.project, projectB, "only a newly-created session note uses the current project key");
	await call(firstCaptured, "notes_write", { address: "@project/project-note.md", content: "project home note" }, movedContext);
	assert.equal(parseNote(readFileSync(physicalPath("project", "project-note.md", movedContext), "utf8")).meta.project, undefined, "project-home notes do not receive session ownership metadata");
	assert.equal((await listNotes(movedContext, { scope: "session" })).length, 2, "project ownership remains frontmatter, not a separate note");
});

test("linked git worktrees share the main checkout's project key", () => {
	freshRoot();
	// realpath keeps the fixture's gitdir pointer and the asserted paths on one spelling
	// (macOS temp roots live under the /var -> /private/var symlink).
	const root = realpathSync(testEnvironment.cwd);
	const main = join(root, "repo");
	mkdirSync(main, { recursive: true });
	const git = (args: string[]): void => {
		execFileSync("git", ["-c", "user.email=test@test", "-c", "user.name=test", ...args], { cwd: main, stdio: "ignore" });
	};
	git(["init", "-q"]);
	git(["commit", "-q", "--allow-empty", "-m", "init"]);
	const worktree = join(root, "wt");
	git(["worktree", "add", "-q", "--detach", worktree]);
	assert.equal(projectKey(worktree), projectKey(main), "a linked worktree resolves to the main checkout's key");
	assert.equal(projectKey(join(worktree, "gone", "deeper")), projectKey(main), "a nonexistent subdirectory still resolves through its worktree");
	assert.equal(scopeDir("project", context(manager(), undefined, undefined, true, worktree)), scopeDir("project", context(manager(), undefined, undefined, true, main)), "@project uses the same physical home from both checkouts");
});

test("unrecognized metadata remains ordinary frontmatter; invalid project ownership stays unknown", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const legacyFile = physicalPath("session", "legacy.md", ctx);
	mkdirSync(scopeDir("session", ctx), { recursive: true });
	writeFileSync(legacyFile, `---
origin: self
created_at: 2026-01-01T00:00:00.000+00:00
updated_at: 2026-01-01T00:00:00.000+00:00
last_accessed: 2026-01-01T00:00:00.000+00:00
access_count: 0
source_window: old-window
recurrence_count: 2
recurrence_windows: old-window
---

legacy body`);
	const parsed = parseNote(readFileSync(legacyFile, "utf8"), Date.parse("2026-02-01T00:00:00Z"));
	assert.equal(parsed.meta.createdAt, Date.parse("2026-02-01T00:00:00Z"), "missing canonical timestamp takes the normal default");
	assert.equal(parsed.meta.created_at, "2026-01-01T00:00:00.000+00:00", "unrecognized fields remain ordinary extras");
	assert.equal((await listNotes(ctx, { scope: "session" }))[0]?.address, "legacy.md");
	assert.match(resultRead(await call(captured, "notes_read", { address: "legacy.md" }, ctx)).content, /legacy body$/);
	await call(captured, "notes_update", { address: "legacy.md", edits: [{ oldText: "legacy body", newText: "edited body" }] }, ctx);
	await call(captured, "notes_write", { address: "legacy.md", content: "overwritten body" }, ctx);
	const rewritten = parseNote(readFileSync(legacyFile, "utf8"));
	assert.equal(rewritten.body, "overwritten body");
	for (const key of ["created_at", "updated_at", "last_accessed", "access_count", "source_window", "recurrence_count", "recurrence_windows"]) {
		assert.deepEqual(rewritten.meta[key], parsed.meta[key], `${key} is preserved as unrecognized frontmatter, not migrated`);
	}

	const invalidFile = physicalPath("session", "invalid.md", ctx);
	writeFileSync(invalidFile, `---
origin: self
createdAt: 2026-01-01T00:00:00.000+00:00
updatedAt: 2026-01-01T00:00:00.000+00:00
lastAccessed: 2026-01-01T00:00:00.000+00:00
accessCount: 0
project: 17
---

invalid owner`);
	assert.equal(parseNote(readFileSync(invalidFile, "utf8")).meta.project, 17);
	assert.notEqual(parseNote(readFileSync(invalidFile, "utf8")).meta.project, projectKey(ctx.cwd), "invalid ownership does not match the current project key");
	await call(captured, "notes_write", { address: "invalid.md", content: "still invalid" }, ctx);
	assert.equal(parseNote(readFileSync(invalidFile, "utf8")).meta.project, 17, "an invalid value remains unknown and is not replaced with cwd-derived ownership");
	assert.equal(existsSync(join(scopeDir("session", ctx), ".session.json")), false, "new notes use no ownership sidecar");
});

test("edit is body-scoped with named failures and a replace_all escape hatch", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	await call(captured, "notes_write", { address: "edit.md", content: "alpha\nbeta\nbeta\ngamma" }, ctx);
	const ambiguous = resultJson<{ error: string; line_numbers?: number[] }>(
		await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "beta", newText: "B" }] }, ctx),
	);
	assert.match(ambiguous.error, /occurs 2 times/);
	assert.deepEqual(ambiguous.line_numbers, [2, 3], "the multi-match error carries every match line number");

	const missing = resultJson<{ error: string; edit_index?: number }>(
		await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "absent", newText: "x" }] }, ctx),
	);
	assert.equal(missing.edit_index, 0, "a zero-match anchor names the failing edit index");

	const all = resultJson<{ address: string; applied: number; diff: string; meta: Meta }>(
		await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "beta", newText: "B" }], replace_all: true }, ctx),
	);
	assert.equal(all.applied, 1);
	assert.equal(all.address, "edit.md");
	assertNoPublicScope(all, "notes_update");
	assert.equal(resultRead(await call(captured, "notes_read", { address: "edit.md" }, ctx)).content.endsWith("alpha\nB\nB\ngamma"), true, "replace_all replaces every occurrence");

	// An anchor that occurs only in frontmatter is not matched: edits are body-only.
	const frontmatterOnly = resultJson<{ edit_index?: number }>(
		await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "scope", newText: "x" }] }, ctx),
	);
	assert.equal(frontmatterOnly.edit_index, 0, "a frontmatter-only anchor is not a body match");
});

test("nothing-to-do, not-found, atomic batches, and replace_all zero-match are named", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	const nameOnly = resultJson<{ error: string }>(await call(captured, "notes_update", { address: "edit.md" }, ctx));
	assert.match(nameOnly.error, /nothing to do/, "neither edits nor setters is a named error");

	await call(captured, "notes_write", { address: "edit.md", content: "alpha\nbeta" }, ctx);
	const empty = resultJson<{ error: string }>(await call(captured, "notes_update", { address: "edit.md", edits: [] }, ctx));
	assert.match(empty.error, /nothing to do/, "an empty edits list with no setters is also nothing to do");

	const editMissing = resultJson<{ error: string }>(await call(captured, "notes_update", { address: "missing.md", crumpled: true }, ctx));
	assert.equal(editMissing.error, "note not found");
	const readMissing = resultJson<{ error: string; address: string }>(await call(captured, "notes_read", { address: "missing.md" }, ctx));
	assert.equal(readMissing.error, "note not found");
	assert.equal(readMissing.address, "missing.md");

	const file = physicalPath("session", "edit.md", ctx);
	const before = readFileSync(file, "utf8");
	const failed = resultJson<{ error: string; edit_index?: number }>(
		await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "alpha", newText: "A" }, { oldText: "absent", newText: "x" }] }, ctx),
	);
	assert.equal(failed.edit_index, 1, "the failing edit is named");
	assert.equal(readFileSync(file, "utf8"), before, "a failing batch leaves the file byte-identical, frontmatter included");

	const applied = resultJson<{ applied: number }>(await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "alpha", newText: "A" }, { oldText: "beta", newText: "B" }] }, ctx));
	assert.equal(applied.applied, 2);
	assert.equal(resultRead(await call(captured, "notes_read", { address: "edit.md" }, ctx)).content.endsWith("A\nB"), true);

	const zero = resultJson<{ error: string; edit_index?: number }>(
		await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "zzz", newText: "y" }], replace_all: true }, ctx),
	);
	assert.equal(zero.edit_index, 0, "replace_all with zero matches is the same zero-match error, not a silent no-op");
});

test("notes_update rename_to moves a note and refuses combinations and live targets", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	await call(captured, "notes_write", { address: "move-me.md", content: "body" }, ctx);
	const combined = resultJson<{ error: string }>(
		await call(captured, "notes_update", { address: "move-me.md", rename_to: "moved.md", edits: [{ oldText: "body", newText: "x" }] }, ctx),
	);
	assert.match(combined.error, /rename_to is used alone/, "rename_to rejects being combined with edits");

	await call(captured, "notes_write", { address: "occupied.md", content: "live target" }, ctx);
	const conflict = resultJson<{ error: string }>(await call(captured, "notes_update", { address: "move-me.md", rename_to: "occupied.md" }, ctx));
	assert.match(conflict.error, /live note/, "a live target refuses the move");

	const renamed = resultJson<{ address: string; rename_to: string; replaced_crumpled_target: boolean }>(
		await call(captured, "notes_update", { address: "move-me.md", rename_to: "moved.md" }, ctx),
	);
	assert.equal(renamed.address, "move-me.md");
	assert.equal(renamed.rename_to, "moved.md");
	assert.equal(renamed.replaced_crumpled_target, false);
	assertNoPublicScope(renamed, "notes_update rename_to");

	const gone = resultJson<{ error: string }>(await call(captured, "notes_read", { address: "move-me.md" }, ctx));
	assert.equal(gone.error, "note not found", "the old address is gone");
	assert.equal(resultRead(await call(captured, "notes_read", { address: "moved.md" }, ctx)).content.endsWith("body"), true);
});

test("all notes tool results use address as the only home identity", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const notes = [
		{ address: "session.md", body: "session needle" },
		{ address: "@project/project.md", body: "project needle" },
		{ address: "@human/human.md", body: "human needle" },
	] as const;

	for (const note of notes) {
		const written = resultJson<{ address: string }>(await call(captured, "notes_write", { address: note.address, content: note.body }, ctx));
		assert.equal(written.address, note.address, `notes_write returns ${note.address}`);
		assertNoPublicScope(written, `notes_write ${note.address}`);

		const edited = resultJson<{ address: string }>(await call(captured, "notes_update", { address: note.address, edits: [{ oldText: "needle", newText: "match" }] }, ctx));
		assert.equal(edited.address, note.address, `notes_update returns ${note.address}`);
		assertNoPublicScope(edited, `notes_update ${note.address}`);

		const rawRead = await call(captured, "notes_read", { address: note.address }, ctx);
		const read = resultRead(rawRead);
		assert.equal(read.details.address, note.address, `notes_read details returns ${note.address}`);
		assert.equal(read.header.startsWith("--- READ WINDOW ---\naddress: "), true, `notes_read starts a READ WINDOW block for ${note.address}`);
		assert.equal(read.header.includes("scope"), false, `notes_read header omits scope for ${note.address}`);
		assert.equal(read.header.includes("resolved_scope"), false, `notes_read header omits resolved_scope for ${note.address}`);
		assertNoPublicScope(read.details, `notes_read ${note.address}`);
	}

	const listed = resultJson<Listed>(await call(captured, "notes_list", { pattern: "**" }, ctx));
	assert.deepEqual(listed.files.map((file) => file.address).sort(), notes.map((note) => note.address).sort(), "notes_list returns each full address");
	assertNoPublicScope(listed, "notes_list");

	const searched = resultJson<Searched>(await call(captured, "notes_search", { query: "match", pattern: "**" }, ctx));
	assert.deepEqual(searched.files.map((file) => file.address), notes.map((note) => note.address).sort(), "notes_search returns each full address");
	assertNoPublicScope(searched, "notes_search");
});

test("list and search merge scopes and carry addresses; the path jail rejects escapes", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	await call(captured, "notes_write", { address: "one.md", content: "needle one" }, ctx);
	await call(captured, "notes_write", { address: "@project/two.md", content: "needle two" }, ctx);
	await call(captured, "notes_write", { address: "@human/three.md", content: "needle three" }, ctx);

	const listed = resultJson<Listed>(await call(captured, "notes_list", {}, ctx));
	assert.deepEqual([...listed.files].map((file) => file.address).sort(), ["@human/three.md", "@project/two.md", "one.md"], "every merged row carries its full address");
	for (const row of listed.files) {
		assert.deepEqual(Object.keys(row).sort(), ["address", "updated_at"]);
	}
	const scoped = resultJson<Listed>(await call(captured, "notes_list", { pattern: "@human/**" }, ctx));
	assert.deepEqual(scoped.files.map((file) => file.address), ["@human/three.md"], "an address-pattern filter narrows the set");

	const searched = resultJson<Searched>(await call(captured, "notes_search", { query: "needle" }, ctx));
	assert.equal(searched.files.length, 3, "literal search finds matches in every scope");
	assert.deepEqual([...searched.files].map((file) => file.address).sort(), ["@human/three.md", "@project/two.md", "one.md"]);
	for (const row of [...listed.files, ...searched.files]) assertNoPublicScope(row, "notes_list/search");
	assert.equal(searched.files.every((file) => file.matches_total === 1), true);
	const hit = searched.files[0]!.matches[0]!;
	assert.equal(hit.line, 1);
	assert.ok(hit.offset_chars > 0, "the offset includes serialized frontmatter");
	assert.equal(hit.truncated, false);
	assert.deepEqual(Object.keys(hit).sort(), ["line", "offset_chars", "text", "truncated"]);

	const escaped = ["../evil", "/abs", "a\\b"];
	for (const tool of ["notes_write", "notes_update", "notes_read"] as const) {
		for (const path of escaped) {
			await assert.rejects(() => call(captured, tool, { address: path, content: "x", edits: [{ oldText: "a", newText: "b" }] }, ctx), `${tool} rejects ${path}`);
		}
	}
	await assert.rejects(() => call(captured, "notes_list", { pattern: "bad\\glob" }, ctx), /backslash/);
	await assert.rejects(() => call(captured, "notes_search", { query: "needle", pattern: "bad\\glob" }, ctx), /backslash/);
});

test("@ addresses select one home, reject illegal sigils, and never fall back", async () => {
	const root = freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "same.md", content: "session" }, ctx);
	await call(captured, "notes_write", { address: "@project/same.md", content: "project" }, ctx);
	await call(captured, "notes_write", { address: "@human/same.md", content: "human" }, ctx);
	assert.ok(existsSync(physicalPath("project", "same.md", ctx)), "@project writes to the current project home");
	assert.ok(existsSync(physicalPath("human", "same.md", ctx)), "@human writes to the human home");
	assert.match(resultRead(await call(captured, "notes_read", { address: "same.md" }, ctx)).content, /session$/);
	assert.equal(resultJson<{ error?: string }>(await call(captured, "notes_read", { address: "@project/missing.md" }, ctx)).error, "note not found");
	await assert.rejects(() => call(captured, "notes_read", { address: "@glboal/same.md" }, ctx), /@project\/.*@human\/.*bare names are this session/);
	await assert.rejects(() => call(captured, "notes_write", { address: "bad@name.md", content: "no" }, ctx), /@project\/.*@human\/.*bare names are this session/);
	assert.equal(existsSync(join(root, "human", "bad@name.md")), false, "a bad sigil creates nothing anywhere");
});

test("Pi adapter defaults to anonymous agent identity", async () => {
	const root = freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await withAgent(undefined, async () => {
		await call(captured, "notes_write", { address: "@self/private.md", content: "anonymous agent note" }, ctx);
		const listed = resultJson<Listed>(await call(captured, "notes_list", {}, ctx));
		assert.deepEqual(listed.files.map((row) => row.address), ["@agents/anonymous/private.md"]);
		assert.equal(existsSync(join(root, "agents", "anonymous", "private.md")), true);
	});
});

test("Pi adapter resolves agent and switched model identity on each notes call and boot", async () => {
	const root = freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session, undefined, undefined, true, testEnvironment.cwd, true, "provider/First.Model");
	await withAgent("Test Agent", async () => {
		await call(captured, "notes_write", { address: "@self/private.md", content: "agent note" }, ctx);
		await call(captured, "notes_write", { address: "@model/private.md", content: "first model note" }, ctx);
		ctx.model = context(session, undefined, undefined, true, testEnvironment.cwd, true, "other/Second.Model").model;
		assert.equal(resultJson<{ error: string }>(await call(captured, "notes_read", { address: "@model/private.md" }, ctx)).error, "note not found", "switched model does not fall back to previous home");
		await call(captured, "notes_write", { address: "@model/private.md", content: "second model note" }, ctx);
		const listed = resultJson<Listed>(await call(captured, "notes_list", {}, ctx));
		assert.deepEqual(listed.files.map((row) => row.address).sort(), ["@agents/test-agent/private.md", "@models/second-model/private.md"]);
		const boot = await explicitBoot(ctx, "test-window", undefined);
		assert.ok(boot.includes("@models/second-model/private.md"));
		assert.equal(boot.includes("@models/first-model/private.md"), false);
		assert.match(resultRead(await call(captured, "notes_read", { address: "@models/first-model/private.md" }, ctx)).content, /first model note$/);
		const refused = resultJson<{ error: string }>(await call(captured, "notes_update", { address: "@models/first-model/private.md", crumpled: true }, ctx));
		assert.match(refused.error, /not your home/);
		assert.match(readFileSync(join(root, "models/first-model/private.md"), "utf8"), /first model note$/);
	});
});

const FRONTMATTER = (body: string) =>
	`---\norigin: self\ncreatedAt: 2026-01-01T00:00:00.000+00:00\nupdatedAt: 2026-01-01T00:00:00.000+00:00\nlastAccessed: 2026-01-01T00:00:00.000+00:00\naccessCount: 0\n---\n\n${body}`;

async function withAgent(name: string | undefined, run: () => Promise<void>): Promise<void> {
	const previous = process.env.PI_NOTES_AGENT;
	if (name === undefined) delete process.env.PI_NOTES_AGENT;
	else process.env.PI_NOTES_AGENT = name;
	try {
		// A plain `return run()` would run the finally block the moment the promise pends,
		// restoring the env while the callback still has awaits ahead of it.
		await run();
	} finally {
		if (previous === undefined) delete process.env.PI_NOTES_AGENT;
		else process.env.PI_NOTES_AGENT = previous;
	}
}
