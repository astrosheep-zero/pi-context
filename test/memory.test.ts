/**
 * OWNER: pi-context (adopted).
 * STATUS: tracked acceptance spec for the real-file notes store and its five tools.
 * CLAIM: notes live as markdown files under $PI_NOTES_HOME with harness-owned frontmatter;
 *   the five tools (notes_write/edit/read/list/search) are the only note surface, and the
 *   boot index reads the physical store across scopes.
 * HERMETIC: every test points PI_NOTES_HOME at its own temp root; no real ~/.agents is touched.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { physicalPath, projectKey, scopeDir } from "../src/memory/paths.js";
import { listNotes } from "../src/memory/store.js";
import { MAX_NOTE_BYTES, MAX_NOTE_PATH_BYTES, PROTOCOL_BLOCK } from "../src/protocol.js";
import { call, context, makeExtension, manager, resultJson, resultRead, runHandlers } from "./integration.test.js";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-context-memory-agent-"));

function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-context-notes-"));
	process.env.PI_NOTES_HOME = root;
	return root;
}

type Meta = Record<string, unknown>;
type Listed = { files: Array<{ path: string; scope: string; origin: string; status: string; stale: boolean; size_bytes: number; created_at: string; updated_at: string }> };
type Searched = { files: Array<{ path: string; scope: string; created_at: string; updated_at: string; matches_total: number; matches: Array<{ line: number; text: string; offset_chars: number; truncated: boolean; total_chars: number }> }> };

test("exactly the five notes tools are registered; the legacy five are gone", () => {
	const captured = makeExtension(manager());
	for (const name of ["notes_write", "notes_edit", "notes_read", "notes_list", "notes_search"]) {
		assert.ok(captured.tools.get(name), `${name} is registered`);
	}
	for (const legacy of ["notes_write_file", "notes_append_to_file", "notes_read_file", "notes_search_contents", "notes_list_files"]) {
		assert.equal(captured.tools.get(legacy), undefined, `${legacy} is unregistered`);
	}
	assert.equal(captured.tools.get("notes_write")?.executionMode, "sequential");
	assert.equal(captured.tools.get("notes_edit")?.executionMode, "sequential");
	assert.equal(captured.tools.get("notes_read")?.executionMode, undefined);
});

test("write lands a real markdown file with harness frontmatter and a pure body", async () => {
	const root = freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const sessionId = session.getSessionId();

	const result = resultJson<{ path: string; scope: string; size_bytes: number; meta: Meta }>(
		await call(captured, "notes_write", { path: "a/b.md", content: "hello" }, ctx),
	);
	assert.equal(result.scope, "session");
	assert.equal(result.size_bytes, 5);
	const file = physicalPath("session", "a/b.md", ctx);
	assert.equal(file, join(root, "pi", "session", sessionId, "a", "b.md"));
	assert.ok(existsSync(file), "the note is a real file under the session scope dir");
	const raw = readFileSync(file, "utf8");
	assert.match(raw, /^---\n/, "the file opens with frontmatter");
	assert.match(raw, /\n---\n\nhello$/, "frontmatter is followed by a blank line and the exact body");
	for (const [key, value] of [["origin", "self"], ["status", "active"], ["stale", "false"], ["access_count", "0"]]) {
		assert.match(raw, new RegExp(`^${key}: ${value}$`, "m"), `frontmatter carries ${key}=${value}`);
	}
	assert.equal(/^scope:/m.test(raw), false, "scope is derived from the file home, never persisted");
	for (const key of ["created_at", "updated_at", "last_accessed"]) {
		assert.match(raw, new RegExp(`^${key}: \\d{4}-\\d{2}-\\d{2}T`, "m"), `frontmatter renders ${key} via localIso`);
	}
	assert.equal(typeof result.meta.created_at, "string", "wire meta renders timestamps as ISO strings");

	// A leading YAML block in user content is stripped from the body.
	await call(captured, "notes_write", { path: "stripped.md", content: "---\nscope: global\nnonsense: true\n---\nreal body" }, ctx);
	const stripped = readFileSync(physicalPath("session", "stripped.md", ctx), "utf8");
	assert.match(stripped, /\n---\n\nreal body$/, "the injected block is not part of the body");
	assert.equal(stripped.includes("nonsense"), false, "the injected block never reaches the file");
});

test("overwrite preserves created_at and unknown keys, bumps updated_at, and clears stale", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const file = physicalPath("session", "keep.md", ctx);

	await call(captured, "notes_write", { path: "keep.md", content: "first", stale: true }, ctx);
	const created = listNotes(ctx, { scope: "session" })[0]!.meta.created_at;
	// Inject an unknown frontmatter key the way the sleep-shift layer will.
	const raw = readFileSync(file, "utf8");
	writeFileSync(file, raw.replace(/\n---\n\n/, "\nsleep_shift_key: \"keep-me\"\nrecurrence_count: 4\n---\n\n"));

	const rewrite = resultJson<{ meta: Meta }>(await call(captured, "notes_write", { path: "keep.md", content: "second" }, ctx));
	const after = readFileSync(file, "utf8");
	assert.equal(after.includes("sleep_shift_key: keep-me"), true, "an unknown key survives a rewrite");
	assert.equal(after.includes("recurrence_count: 4"), true, "a known sleep-shift key survives a rewrite");
	assert.match(after, /\n---\n\nsecond$/, "the body is replaced");
	assert.equal((rewrite.meta.origin as string), "self");
	const listed = listNotes(ctx, { scope: "session" })[0]!;
	assert.equal(listed.meta.created_at, created, "created_at is preserved across an overwrite");
	assert.ok(listed.meta.updated_at >= created, "updated_at is bumped");
	assert.equal(listed.meta.stale, false, "a plain rewrite clears stale");
	assert.equal(listed.meta.status, "active");
});

test("edit is body-scoped with named failures and a replace_all escape hatch", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	await call(captured, "notes_write", { path: "edit.md", content: "alpha\nbeta\nbeta\ngamma" }, ctx);
	const ambiguous = resultJson<{ error: string; line_numbers?: number[] }>(
		await call(captured, "notes_edit", { path: "edit.md", edits: [{ oldText: "beta", newText: "B" }] }, ctx),
	);
	assert.match(ambiguous.error, /occurs 2 times/);
	assert.deepEqual(ambiguous.line_numbers, [2, 3], "the multi-match error carries every match line number");

	const missing = resultJson<{ error: string; edit_index?: number }>(
		await call(captured, "notes_edit", { path: "edit.md", edits: [{ oldText: "absent", newText: "x" }] }, ctx),
	);
	assert.equal(missing.edit_index, 0, "a zero-match anchor names the failing edit index");

	const all = resultJson<{ applied: number; resolved_scope: string }>(
		await call(captured, "notes_edit", { path: "edit.md", edits: [{ oldText: "beta", newText: "B" }], replace_all: true }, ctx),
	);
	assert.equal(all.applied, 1);
	assert.equal(all.resolved_scope, "session", "the success return names the layer the file was resolved from");
	assert.equal(resultRead(await call(captured, "notes_read", { path: "edit.md" }, ctx)).content.endsWith("alpha\nB\nB\ngamma"), true, "replace_all replaces every occurrence");

	// An anchor that occurs only in frontmatter is not matched: edits are body-only.
	const frontmatterOnly = resultJson<{ edit_index?: number }>(
		await call(captured, "notes_edit", { path: "edit.md", edits: [{ oldText: "scope", newText: "x" }] }, ctx),
	);
	assert.equal(frontmatterOnly.edit_index, 0, "a frontmatter-only anchor is not a body match");
});

test("a single edit inserts newText byte-for-byte: no $-pattern substitution", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	// Each pattern is a JS String.replace replacement token. With positional splicing the whole
	// two-character (or two-dollar) sequence lands literally; with String.replace it would expand,
	// and the prefix token ($`) would splice in the entire document prefix.
	const cases = ["$&", "$`", "$'", "$1", "$$"];
	for (const token of cases) {
		const newText = `pre${token}post`;
		await call(captured, "notes_write", { path: "literal.md", content: "alpha\nbeta\ngamma" }, ctx);
		const edited = resultJson<{ applied: number }>(
			await call(captured, "notes_edit", { path: "literal.md", edits: [{ oldText: "beta", newText }] }, ctx),
		);
		assert.equal(edited.applied, 1, `the single edit for ${JSON.stringify(token)} applied`);
		const body = resultRead(await call(captured, "notes_read", { path: "literal.md" }, ctx)).content;
		assert.equal(body.endsWith(`alpha\n${newText}\ngamma`), true, `${JSON.stringify(token)} is inserted literally`);
		assert.equal(body.endsWith(`alpha\nalpha\npre${token}post\ngamma`), false, `${JSON.stringify(token)} does not splice in the document prefix`);
	}

	// The replace_all branch (split/join) is likewise literal, so both branches agree.
	await call(captured, "notes_write", { path: "literal-all.md", content: "one X two X three" }, ctx);
	await call(captured, "notes_edit", { path: "literal-all.md", edits: [{ oldText: "X", newText: "$`$&$1$$" }], replace_all: true }, ctx);
	const allBody = resultRead(await call(captured, "notes_read", { path: "literal-all.md" }, ctx)).content;
	assert.equal(allBody.endsWith("one $`$&$1$$ two $`$&$1$$ three"), true, "replace_all inserts $-patterns literally too");
});

test("metadata-only edit updates setters without touching the body", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { path: "journal.md", content: "log line" }, ctx);

	const bare = resultJson<{ applied: number; resolved_scope: string; meta: Meta }>(await call(captured, "notes_edit", { path: "journal.md", stale: true }, ctx));
	assert.equal(bare.applied, 0, "a metadata-only update applies no edits");
	assert.equal(bare.resolved_scope, "session");
	assert.equal(bare.meta.stale, true, "stale is set without a body edit");
	assert.equal(resultRead(await call(captured, "notes_read", { path: "journal.md" }, ctx)).content.endsWith("log line"), true, "the body is untouched");

	const revived = resultJson<{ meta: Meta }>(await call(captured, "notes_edit", { path: "journal.md", stale: false }, ctx));
	assert.equal(revived.meta.stale, false, "a later metadata-only update revives the note");
});

test("notes_edit returns a pi-edit-style diff of what changed", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	await call(captured, "notes_write", { path: "d.md", content: "alpha\nbeta" }, ctx);

	// Content edit → body diff.
	const bodyEdit = resultJson<{ diff: string }>(await call(captured, "notes_edit", { path: "d.md", edits: [{ oldText: "beta", newText: "B" }] }, ctx));
	assert.match(bodyEdit.diff, /- *\d+ beta/);
	assert.match(bodyEdit.diff, /\+ *\d+ B/);
	assert.equal(bodyEdit.diff.includes("scope:"), false, "a content-only diff does not drag frontmatter in");

	// Metadata-only → frontmatter diff.
	const metaOnly = resultJson<{ diff: string; applied: number }>(await call(captured, "notes_edit", { path: "d.md", stale: true }, ctx));
	assert.equal(metaOnly.applied, 0);
	assert.match(metaOnly.diff, /- *\d+ stale: false/);
	assert.match(metaOnly.diff, /\+ *\d+ stale: true/);
	assert.equal(metaOnly.diff.includes("alpha"), false, "a metadata-only diff does not drag the body in");

	// Both → one combined diff naming body and frontmatter changes, without moving homes.
	const combined = resultJson<{ diff: string }>(await call(captured, "notes_edit", { path: "d.md", edits: [{ oldText: "alpha", newText: "ALPHA" }], stale: false }, ctx));
	assert.match(combined.diff, /- *\d+ alpha/);
	assert.match(combined.diff, /\+ *\d+ ALPHA/);
	assert.match(combined.diff, /- *\d+ stale: true/);
	assert.match(combined.diff, /\+ *\d+ stale: false/);
});

test("nothing-to-do, not-found, atomic batches, and replace_all zero-match are named", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	const nameOnly = resultJson<{ error: string }>(await call(captured, "notes_edit", { path: "edit.md" }, ctx));
	assert.match(nameOnly.error, /nothing to do/, "neither edits nor setters is a named error");

	await call(captured, "notes_write", { path: "edit.md", content: "alpha\nbeta" }, ctx);
	const empty = resultJson<{ error: string }>(await call(captured, "notes_edit", { path: "edit.md", edits: [] }, ctx));
	assert.match(empty.error, /nothing to do/, "an empty edits list with no setters is also nothing to do");

	const editMissing = resultJson<{ error: string }>(await call(captured, "notes_edit", { path: "missing.md", stale: true }, ctx));
	assert.equal(editMissing.error, "note not found");
	const readMissing = resultJson<{ error: string; path: string }>(await call(captured, "notes_read", { path: "missing.md" }, ctx));
	assert.equal(readMissing.error, "note not found");
	assert.equal(readMissing.path, "missing.md");

	const file = physicalPath("session", "edit.md", ctx);
	const before = readFileSync(file, "utf8");
	const failed = resultJson<{ error: string; edit_index?: number }>(
		await call(captured, "notes_edit", { path: "edit.md", edits: [{ oldText: "alpha", newText: "A" }, { oldText: "absent", newText: "x" }] }, ctx),
	);
	assert.equal(failed.edit_index, 1, "the failing edit is named");
	assert.equal(readFileSync(file, "utf8"), before, "a failing batch leaves the file byte-identical, frontmatter included");

	const applied = resultJson<{ applied: number }>(await call(captured, "notes_edit", { path: "edit.md", edits: [{ oldText: "alpha", newText: "A" }, { oldText: "beta", newText: "B" }] }, ctx));
	assert.equal(applied.applied, 2);
	assert.equal(resultRead(await call(captured, "notes_read", { path: "edit.md" }, ctx)).content.endsWith("A\nB"), true);

	const zero = resultJson<{ error: string; edit_index?: number }>(
		await call(captured, "notes_edit", { path: "edit.md", edits: [{ oldText: "zzz", newText: "y" }], replace_all: true }, ctx),
	);
	assert.equal(zero.edit_index, 0, "replace_all with zero matches is the same zero-match error, not a silent no-op");
});

test.skip("scope resolution and movement are superseded by explicit address tests", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	await call(captured, "notes_write", { path: "shared.md", content: "global body", scope: "global" }, ctx);
	await call(captured, "notes_write", { path: "shared.md", content: "session body", scope: "session" }, ctx);

	const first = resultRead(await call(captured, "notes_read", { path: "shared.md" }, ctx));
	assert.equal(first.details.scope, "session", "session wins the precedence over global");
	const readAgain = resultRead(await call(captured, "notes_read", { path: "shared.md", scope: "session" }, ctx));
	assert.ok(readAgain.content.includes("session body"));
	const sessionMeta = listNotes(ctx, { scope: "session" })[0]!.meta;
	assert.equal(sessionMeta.access_count, 2, "each read bumps access_count");
	const globalMeta = listNotes(ctx, { scope: "global" })[0]!.meta;
	assert.equal(globalMeta.access_count, 0, "the global copy is untouched");

	// Move the session copy to project; the global copy is untouched.
	const moved = resultJson<{ meta: Meta; resolved_scope: string }>(await call(captured, "notes_edit", { path: "shared.md", edits: [{ oldText: "session", newText: "moved" }], scope: "project" }, ctx));
	assert.equal(moved.meta.scope, "project");
	assert.equal(moved.resolved_scope, "session", "resolved_scope names the layer the file moved from");
	assert.equal(existsSync(physicalPath("session", "shared.md", ctx)), false, "the source file moved away");
	assert.equal(existsSync(physicalPath("project", "shared.md", ctx)), true, "the file now lives in the project scope");

	// A move onto an existing target is refused and both files survive unchanged.
	await call(captured, "notes_write", { path: "clash.md", content: "session stay", scope: "session" }, ctx);
	await call(captured, "notes_write", { path: "clash.md", content: "global stay", scope: "global" }, ctx);
	const beforeGlobal = readFileSync(physicalPath("global", "clash.md", ctx), "utf8");
	const refusal = resultJson<{ error: string }>(await call(captured, "notes_edit", { path: "clash.md", edits: [{ oldText: "stay", newText: "moved" }], scope: "global" }, ctx));
	assert.match(refusal.error, /already exists/);
	assert.equal(readFileSync(physicalPath("global", "clash.md", ctx), "utf8"), beforeGlobal, "the target survives a refused move");
});

test("list and search merge scopes and carry scope; the path jail rejects escapes", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	await call(captured, "notes_write", { path: "one.md", content: "needle one", scope: "session" }, ctx);
	await call(captured, "notes_write", { path: "two.md", content: "needle two", scope: "project" }, ctx);
	await call(captured, "notes_write", { path: "three.md", content: "needle three", scope: "global" }, ctx);

	const listed = resultJson<Listed>(await call(captured, "notes_list", {}, ctx));
	assert.deepEqual([...listed.files].map((file) => file.scope).sort(), ["global", "project", "session"], "every merged row carries its scope");
	for (const row of listed.files) {
		assert.equal(typeof row.size_bytes, "number");
		assert.equal(row.origin, "self");
		assert.equal(row.status, "active");
		assert.equal(row.stale, false);
	}
	const scoped = resultJson<Listed>(await call(captured, "notes_list", { scope: "global" }, ctx));
	assert.deepEqual(scoped.files.map((file) => file.path), ["three.md"], "a scope filter narrows the set");

	const searched = resultJson<Searched>(await call(captured, "notes_search", { query: "needle" }, ctx));
	assert.equal(searched.files.length, 3, "literal search finds matches in every scope");
	assert.deepEqual([...searched.files].map((file) => file.scope).sort(), ["global", "project", "session"]);
	assert.equal(searched.files.every((file) => file.matches_total === 1), true);
	const hit = searched.files[0]!.matches[0]!;
	assert.equal(hit.line, 1);
	assert.equal(hit.offset_chars, 0);
	assert.equal(hit.truncated, false);
	assert.equal(hit.total_chars, searched.files[0]!.path === "three.md" ? "needle three".length : hit.text.length, "total_chars names the real line length");

	const escaped = ["../evil", "/abs", "a\\b"];
	for (const tool of ["notes_write", "notes_edit", "notes_read"] as const) {
		for (const path of escaped) {
			await assert.rejects(() => call(captured, tool, { path, content: "x", edits: [{ oldText: "a", newText: "b" }] }, ctx), `${tool} rejects ${path}`);
		}
	}
	await assert.rejects(() => call(captured, "notes_list", { pattern: "bad\\glob" }, ctx), /backslash/);
	await assert.rejects(() => call(captured, "notes_search", { query: "needle", pattern: "bad\\glob" }, ctx), /backslash/);
});

test("the boot index reads the physical store across scopes and excludes stale notes", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	await call(captured, "notes_write", { path: "fresh.md", content: "fresh content" }, ctx);
	await call(captured, "notes_write", { path: "global.md", content: "global content", scope: "global" }, ctx);
	await call(captured, "notes_write", { path: "old.md", content: "stale content", stale: true }, ctx);
	runHandlers(captured, "session_start", {}, ctx);
	const text = typeof captured.sent[0]?.message.content === "string" ? captured.sent[0].message.content : "";
	assert.ok(text.includes("fresh.md"), "a fresh session note is indexed");
	assert.ok(text.includes("global.md"), "a fresh global note is indexed");
	assert.equal(text.includes("old.md"), false, "a stale note leaves the index");
	assert.equal(text.includes("stale content"), false, "a stale preview is not rendered");
	for (const name of ["notes_write", "notes_edit", "notes_read", "notes_search", "notes_list"]) {
		assert.ok(PROTOCOL_BLOCK.includes(name), `the protocol block names ${name}`);
	}
	for (const legacy of ["notes_write_file", "notes_append_to_file", "notes_read_file", "notes_search_contents", "notes_list_files"]) {
		assert.equal(PROTOCOL_BLOCK.includes(legacy), false, `the protocol block no longer names ${legacy}`);
	}
});

test("notes_read surfaces frontmatter and search reports body lines", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { path: "compose.md", content: "line one\nneedle address\nline three" }, ctx);
	const read = resultRead(await call(captured, "notes_read", { path: "compose.md" }, ctx));
	assert.match(read.content, /^---\n/, "the model sees the frontmatter first");
	assert.ok(read.content.includes("needle address"));
	const searched = resultJson<Searched>(await call(captured, "notes_search", { query: "needle" }, ctx));
	const match = searched.files[0]!.matches[0]!;
	assert.equal(match.line, 2, "search reports the body line number");
	assert.equal(match.offset_chars, Array.from("line one\n").length, "offset_chars addresses the query within the body");
});

test("mutations are atomic, leave no temp files, and a read bumps only the access keys", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { path: "atomic.md", content: "alpha\nbeta" }, ctx);
	await call(captured, "notes_edit", { path: "atomic.md", edits: [{ oldText: "alpha", newText: "A" }] }, ctx);
	await call(captured, "notes_read", { path: "atomic.md" }, ctx);
	const first = readFileSync(physicalPath("session", "atomic.md", ctx), "utf8");
	assert.equal(first.includes("alpha"), false, "the edit landed");
	const secondRead = resultRead(await call(captured, "notes_read", { path: "atomic.md" }, ctx));
	assert.ok(secondRead.content.endsWith("A\nbeta"), "a second read still delivers the body");
	const afterRead = readFileSync(physicalPath("session", "atomic.md", ctx), "utf8");
	const lineOf = (text: string, key: string) => text.split("\n").find((line) => line.startsWith(`${key}:`));
	for (const key of ["created_at", "updated_at", "origin", "status", "scope"]) {
		assert.equal(lineOf(afterRead, key), lineOf(first, key), `${key} stays byte-stable across a read`);
	}
	assert.equal(listNotes(ctx, { scope: "session" })[0]!.meta.access_count, 2, "two reads bump access_count twice");
	// No torn-write temp files survive any mutation.
	const temps: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) walk(join(dir, entry.name));
			else if (entry.name.endsWith(".tmp")) temps.push(join(dir, entry.name));
		}
	};
	walk(process.env.PI_NOTES_HOME!);
	assert.deepEqual(temps, [], "tmp files are renamed away, never left behind");
});

test("write-time caps refuse an oversized vpath or serialized file, and edit refuses an oversized result", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const seg = "b".repeat(120);
	const okPath = [seg, seg, seg, seg, "x"].join("/");
	const overPath = `${okPath}${seg}`;
	assert.ok(Buffer.byteLength(okPath, "utf8") <= MAX_NOTE_PATH_BYTES);
	assert.ok(Buffer.byteLength(overPath, "utf8") > MAX_NOTE_PATH_BYTES);
	const refusedPath = resultJson<{ error: string }>(await call(captured, "notes_write", { path: overPath, content: "x" }, ctx));
	assert.match(refusedPath.error, new RegExp(String(MAX_NOTE_PATH_BYTES)), "an over-cap vpath names the cap");
	const accepted = resultJson<{ path: string }>(await call(captured, "notes_write", { path: okPath, content: "x" }, ctx));
	assert.equal(accepted.path, okPath, "a path at the cap is accepted");

	const refusedBody = resultJson<{ error: string }>(await call(captured, "notes_write", { path: "big.md", content: "x".repeat(MAX_NOTE_BYTES) }, ctx));
	assert.match(refusedBody.error, new RegExp(String(MAX_NOTE_BYTES)), "an over-cap body names the size cap");
	await call(captured, "notes_write", { path: "small.md", content: "small" }, ctx);
	const refusedEdit = resultJson<{ error: string }>(
		await call(captured, "notes_edit", { path: "small.md", edits: [{ oldText: "small", newText: "y".repeat(MAX_NOTE_BYTES) }] }, ctx),
	);
	assert.match(refusedEdit.error, new RegExp(String(MAX_NOTE_BYTES)), "an edit that would exceed the cap is refused");
});

test("a global TOC.md body is injected ahead of the recent-notes list", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { path: "TOC.md", content: "MAP: global\nMAP: second", scope: "global" }, ctx);
	await call(captured, "notes_write", { path: "recent.md", content: "recent body" }, ctx);
	runHandlers(captured, "session_start", {}, ctx);
	const boot = typeof captured.sent.at(-1)?.message.content === "string" ? (captured.sent.at(-1)!.message.content as string) : "";
	assert.ok(boot.includes("MAP: global"), "a global TOC is injected");
	assert.ok(boot.indexOf("MAP: global") < boot.indexOf("crumpled note"), "the TOC body precedes the recent-notes list");
	assert.ok(PROTOCOL_BLOCK.includes("notes_write"), "the protocol text still rides along");
});

test("a session TOC.md wins precedence over the global map", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { path: "TOC.md", content: "MAP: global", scope: "global" }, ctx);
	await call(captured, "notes_write", { path: "TOC.md", content: "MAP: session", scope: "session" }, ctx);
	runHandlers(captured, "session_start", {}, ctx);
	const boot = typeof captured.sent.at(-1)?.message.content === "string" ? (captured.sent.at(-1)!.message.content as string) : "";
	const injected = boot.slice(0, boot.indexOf("crumpled note") === -1 ? boot.length : boot.indexOf("crumpled note"));
	assert.ok(injected.includes("MAP: session"), "the session TOC wins the precedence");
	assert.equal(injected.includes("MAP: global"), false, "only the first-hit TOC is injected");
});

test("the boot index admits up to five fresh notes and the protocol carries the exact stale line", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	for (let index = 0; index < 6; index++) {
		await call(captured, "notes_write", { path: `fresh-${index}.md`, content: `body ${index}` }, ctx);
	}
	runHandlers(captured, "session_start", {}, ctx);
	const boot = typeof captured.sent.at(-1)?.message.content === "string" ? (captured.sent.at(-1)!.message.content as string) : "";
	assert.match(boot, /\(up to 5, most recent first\)/, "the pocket line says up to 5");
	assert.equal((boot.match(/^- /gm) ?? []).length, 5, "exactly five fresh notes are indexed, not six");
	assert.ok(PROTOCOL_BLOCK.includes("Mark outdated or unneeded notes stale — leave them, and they will keep misleading you."), "the protocol block carries the v2 stale line verbatim");
	assert.equal(PROTOCOL_BLOCK.split("Mark outdated or unneeded notes stale — leave them, and they will keep misleading you.").length - 1, 1, "the stale line appears exactly once");
});

test("project scope keys off the git root basename and sha1 prefix", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-context-proj-"));
	process.env.PI_NOTES_HOME = mkdtempSync(join(tmpdir(), "pi-context-notes-"));
	const session = manager();
	const ctx = context(session, undefined, undefined, true, root);
	const key = projectKey(root);
	assert.match(key, /^pi-context-proj-[^-]+-[0-9a-f]{8}$/, "the project key is basename plus an 8-hex sha1 prefix");
	assert.equal(scopeDir("project", ctx), join(process.env.PI_NOTES_HOME!, "project", key));
});

test("@ addresses select one home, reject illegal sigils, and never fall back", async () => {
	const root = freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "same.md", content: "session" }, ctx);
	await call(captured, "notes_write", { address: "@project/same.md", content: "project" }, ctx);
	await call(captured, "notes_write", { address: "@global/same.md", content: "global" }, ctx);
	assert.ok(existsSync(physicalPath("project", "same.md", ctx)), "@project writes to the current project home");
	assert.ok(existsSync(physicalPath("global", "same.md", ctx)), "@global writes to the global home");
	assert.match(resultRead(await call(captured, "notes_read", { address: "same.md" }, ctx)).content, /session$/);
	assert.equal(resultJson<{ error?: string }>(await call(captured, "notes_read", { address: "@project/missing.md" }, ctx)).error, "note not found");
	await assert.rejects(() => call(captured, "notes_read", { address: "@glboal/same.md" }, ctx), /@project\/.*@global\/.*bare names are the session home/);
	await assert.rejects(() => call(captured, "notes_write", { address: "bad@name.md", content: "no" }, ctx), /@project\/.*@global\/.*bare names are the session home/);
	assert.equal(existsSync(join(root, "global", "bad@name.md")), false, "a bad sigil creates nothing anywhere");
});

test("full addresses drive outputs and patterns; legacy scope is read then dropped", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "root.md", content: "needle" }, ctx);
	await call(captured, "notes_write", { address: "@project/project.md", content: "needle" }, ctx);
	await call(captured, "notes_write", { address: "@global/global.md", content: "needle" }, ctx);
	const list = resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_list", { pattern: "**" }, ctx));
	assert.deepEqual(list.files.map((file) => file.address).sort(), ["@global/global.md", "@project/project.md", "root.md"]);
	assert.deepEqual(resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_list", { pattern: "*.md" }, ctx)).files.map((file) => file.address), ["root.md"]);
	assert.deepEqual(resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_search", { query: "needle", pattern: "@project/**" }, ctx)).files.map((file) => file.address), ["@project/project.md"]);
	const read = resultRead(await call(captured, "notes_read", { address: "@global/global.md" }, ctx));
	assert.match(read.header, /^\[@global\/global\.md /, "the raw read header echoes the full address");
	const legacy = physicalPath("project", "legacy.md", ctx);
	writeFileSync(legacy, "---\nscope: global\norigin: self\nstatus: active\nstale: false\ncreated_at: 2026-01-01T00:00:00.000+00:00\nupdated_at: 2026-01-01T00:00:00.000+00:00\nlast_accessed: 2026-01-01T00:00:00.000+00:00\naccess_count: 0\n---\n\nlegacy");
	const legacyRead = resultRead(await call(captured, "notes_read", { address: "@project/legacy.md" }, ctx));
	assert.equal(legacyRead.details.scope, "project", "scope is derived from the file location");
	await call(captured, "notes_edit", { address: "@project/legacy.md", stale: true }, ctx);
	assert.equal(/^scope:/m.test(readFileSync(legacy, "utf8")), false, "the next write removes legacy scope frontmatter");
});

test("boot explicitly skips stale TOCs in session, project, then global order", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "TOC.md", content: "session stale", stale: true }, ctx);
	await call(captured, "notes_write", { address: "@global/TOC.md", content: "global fresh" }, ctx);
	runHandlers(captured, "session_start", {}, ctx);
	let boot = String(captured.sent.at(-1)?.message.content ?? "");
	assert.ok(boot.includes("global fresh"));
	assert.equal(boot.includes("session stale"), false);
	const second = manager();
	const secondCaptured = makeExtension(second);
	const secondCtx = context(second);
	await call(secondCaptured, "notes_write", { address: "TOC.md", content: "session fresh" }, secondCtx);
	await call(secondCaptured, "notes_write", { address: "@global/TOC.md", content: "global other" }, secondCtx);
	runHandlers(secondCaptured, "session_start", {}, secondCtx);
	boot = String(secondCaptured.sent.at(-1)?.message.content ?? "");
	const tocOnly = boot.slice(0, boot.indexOf("You find"));
	assert.ok(tocOnly.includes("session fresh"));
	assert.equal(tocOnly.includes("global other"), false);
	await call(secondCaptured, "notes_edit", { address: "TOC.md", stale: true }, secondCtx);
	await call(secondCaptured, "notes_edit", { address: "@global/TOC.md", stale: true }, secondCtx);
	const third = manager();
	const thirdCaptured = makeExtension(third);
	runHandlers(thirdCaptured, "session_start", {}, context(third));
	assert.equal(String(thirdCaptured.sent.at(-1)?.message.content ?? "").includes("session fresh"), false, "all stale TOCs inject none");
});
