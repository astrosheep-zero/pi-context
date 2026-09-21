/**
 * OWNER: pi-context (adopted).
 * STATUS: tracked acceptance spec for the real-file notes store and its five tools.
 * CLAIM: notes live as markdown files under $PI_NOTES_HOME with harness-owned frontmatter;
 *   the five tools (notes_write/edit/read/list/search) are the only note surface, and the
 *   boot index reads the physical store across scopes.
 * HERMETIC: every test points PI_NOTES_HOME at its own temp root; no real ~/.agents is touched.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { physicalPath, projectKey, scopeDir } from "../src/notes/paths.js";
import { listNotes, type Scope } from "../src/notes/store.js";
import { CONTEXT_WINDOW_PROTOCOL_OPEN_TAG, MAX_NOTE_BYTES, MAX_NOTE_PATH_BYTES } from "../src/protocol.js";
import { call, context, makeExtension, manager, resultJson, resultRead, runHandlers } from "./integration.test.js";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-context-notes-agent-"));

function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-context-notes-"));
	process.env.PI_NOTES_HOME = root;
	return root;
}

function setUpdatedAt(scope: Scope, path: string, ctx: ReturnType<typeof context>, timestamp: number): void {
	const file = physicalPath(scope, path, ctx);
	const raw = readFileSync(file, "utf8");
	writeFileSync(file, raw.replace(/^updated_at: .*$/m, `updated_at: ${new Date(timestamp).toISOString()}`));
}

type Meta = Record<string, unknown>;
type Listed = { files: Array<{ address: string; stale: boolean; updated_at: string }> };
type Searched = { files: Array<{ address: string; stale: boolean; updated_at: string; matches_total: number; matches: Array<{ line: number; text: string; offset_chars: number; truncated: boolean }> }> };

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

	const result = resultJson<{ address: string; written: true }>(
		await call(captured, "notes_write", { path: "a/b.md", content: "hello" }, ctx),
	);
	assert.deepEqual(Object.keys(result).sort(), ["address", "written"]);
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
	assert.equal(result.address, "a/b.md");
	assert.equal(result.written, true);

	// A leading YAML block in user content is stripped from the body.
	await call(captured, "notes_write", { path: "stripped.md", content: "---\nscope: human\nnonsense: true\n---\nreal body" }, ctx);
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

	const rewrite = resultJson<{ address: string; written: true }>(await call(captured, "notes_write", { path: "keep.md", content: "second" }, ctx));
	const after = readFileSync(file, "utf8");
	assert.equal(after.includes("sleep_shift_key: keep-me"), true, "an unknown key survives a rewrite");
	assert.equal(after.includes("recurrence_count: 4"), true, "a known sleep-shift key survives a rewrite");
	assert.match(after, /\n---\n\nsecond$/, "the body is replaced");
	assert.deepEqual(Object.keys(rewrite).sort(), ["address", "written"]);
	const listed = listNotes(ctx, { scope: "session" })[0]!;
	assert.equal(listed.meta.created_at, created, "created_at is preserved across an overwrite");
	assert.ok(listed.meta.updated_at >= created, "updated_at is bumped");
	assert.equal(listed.meta.stale, false, "a plain rewrite clears stale");
	assert.equal(listed.meta.status, "active");
});

test("listNotes retains each parsed body for MAP injection", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { path: "retained.md", content: "parsed once" }, ctx);
	assert.equal(listNotes(ctx, { scope: "session" })[0]?.body, "parsed once");
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

	const all = resultJson<{ address: string; applied: number; diff: string; meta: Meta }>(
		await call(captured, "notes_edit", { path: "edit.md", edits: [{ oldText: "beta", newText: "B" }], replace_all: true }, ctx),
	);
	assert.equal(all.applied, 1);
	assert.equal(all.address, "edit.md");
	assertNoPublicScope(all, "notes_edit");
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

	const bare = resultJson<{ address: string; applied: number; diff: string }>(await call(captured, "notes_edit", { path: "journal.md", stale: true }, ctx));
	assert.equal(bare.applied, 0, "a metadata-only update applies no edits");
	assert.equal(bare.address, "journal.md");
	assert.deepEqual(Object.keys(bare).sort(), ["address", "applied", "diff"]);
	assert.equal(listNotes(ctx, { scope: "session" })[0]!.meta.stale, true, "stale is set without a body edit");
	assert.equal(resultRead(await call(captured, "notes_read", { path: "journal.md" }, ctx)).content.endsWith("log line"), true, "the body is untouched");

	const revived = resultJson<{ address: string; applied: number; diff: string }>(await call(captured, "notes_edit", { path: "journal.md", stale: false }, ctx));
	assert.deepEqual(Object.keys(revived).sort(), ["address", "applied", "diff"]);
	assert.equal(listNotes(ctx, { scope: "session" })[0]!.meta.stale, false, "a later metadata-only update revives the note");
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

	await call(captured, "notes_write", { path: "shared.md", content: "human body", scope: "human" }, ctx);
	await call(captured, "notes_write", { path: "shared.md", content: "session body", scope: "session" }, ctx);

	const first = resultRead(await call(captured, "notes_read", { path: "shared.md" }, ctx));
	assert.equal(first.details.scope, "session", "session wins the precedence over human");
	const readAgain = resultRead(await call(captured, "notes_read", { path: "shared.md", scope: "session" }, ctx));
	assert.ok(readAgain.content.includes("session body"));
	const sessionMeta = listNotes(ctx, { scope: "session" })[0]!.meta;
	assert.equal(sessionMeta.access_count, 2, "each read bumps access_count");
	const humanMeta = listNotes(ctx, { scope: "human" })[0]!.meta;
	assert.equal(humanMeta.access_count, 0, "the human copy is untouched");

	// Move the session copy to project; the human copy is untouched.
	const moved = resultJson<{ meta: Meta; resolved_scope: string }>(await call(captured, "notes_edit", { path: "shared.md", edits: [{ oldText: "session", newText: "moved" }], scope: "project" }, ctx));
	assert.equal(moved.meta.scope, "project");
	assert.equal(moved.resolved_scope, "session", "resolved_scope names the layer the file moved from");
	assert.equal(existsSync(physicalPath("session", "shared.md", ctx)), false, "the source file moved away");
	assert.equal(existsSync(physicalPath("project", "shared.md", ctx)), true, "the file now lives in the project scope");

	// A move onto an existing target is refused and both files survive unchanged.
	await call(captured, "notes_write", { path: "clash.md", content: "session stay", scope: "session" }, ctx);
	await call(captured, "notes_write", { path: "clash.md", content: "human stay", scope: "human" }, ctx);
	const beforeHuman = readFileSync(physicalPath("human", "clash.md", ctx), "utf8");
	const refusal = resultJson<{ error: string }>(await call(captured, "notes_edit", { path: "clash.md", edits: [{ oldText: "stay", newText: "moved" }], scope: "human" }, ctx));
	assert.match(refusal.error, /already exists/);
	assert.equal(readFileSync(physicalPath("human", "clash.md", ctx), "utf8"), beforeHuman, "the target survives a refused move");
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

		const edited = resultJson<{ address: string }>(await call(captured, "notes_edit", { address: note.address, edits: [{ oldText: "needle", newText: "match" }] }, ctx));
		assert.equal(edited.address, note.address, `notes_edit returns ${note.address}`);
		assertNoPublicScope(edited, `notes_edit ${note.address}`);

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

	await call(captured, "notes_write", { path: "one.md", content: "needle one", scope: "session" }, ctx);
	await call(captured, "notes_write", { path: "two.md", content: "needle two", scope: "project" }, ctx);
	await call(captured, "notes_write", { path: "three.md", content: "needle three", scope: "human" }, ctx);

	const listed = resultJson<Listed>(await call(captured, "notes_list", {}, ctx));
	assert.deepEqual([...listed.files].map((file) => file.address).sort(), ["@human/three.md", "@project/two.md", "one.md"], "every merged row carries its full address");
	for (const row of listed.files) {
		assert.deepEqual(Object.keys(row).sort(), ["address", "stale", "updated_at"]);
		assert.equal(row.stale, false);
	}
	const scoped = resultJson<Listed>(await call(captured, "notes_list", { scope: "human" }, ctx));
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
	await call(captured, "notes_write", { path: "human.md", content: "human content", scope: "human" }, ctx);
	await call(captured, "notes_write", { path: "old.md", content: "stale content", stale: true }, ctx);
	runHandlers(captured, "session_start", {}, ctx);
	const text = typeof captured.sent[0]?.message.content === "string" ? captured.sent[0].message.content : "";
	assert.ok(text.includes("fresh.md"), "a fresh session note is indexed");
	assert.ok(text.includes("human.md"), "a fresh human note is indexed");
	assert.equal(text.includes("old.md"), false, "a stale note leaves the index");
	assert.equal(text.includes("stale content"), false, "the stale note's body is absent from boot");
});

test("search offsets start reads at Unicode matches across homes without mutating search results", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const notes = [
		{ address: "session.md", scope: "session" as const, body: "first line\n前置 🐉 needle-session\nend", needle: "needle-session" },
		{ address: "@project/crossing.md", scope: "project" as const, body: "prefix\nneedle-project 😀", needle: "needle-project" },
		{ address: "@human/legacy.md", scope: "human" as const, body: "legacy 😺 needle-human", needle: "needle-human" },
	];
	for (const note of notes) await call(captured, "notes_write", { address: note.address, content: note.body }, ctx);
	const crossing = physicalPath("project", "crossing.md", ctx);
	writeFileSync(crossing, readFileSync(crossing, "utf8").replace(/^access_count: 0$/m, "access_count: 9"));
	const legacy = physicalPath("human", "legacy.md", ctx);
	writeFileSync(legacy, notes[2]!.body);
	const before = new Map(notes.map((note) => [note.address, readFileSync(physicalPath(note.scope, note.address.replace(/^@(?:project|human)\//, ""), ctx), "utf8")]));
	const searched = resultJson<Searched>(await call(captured, "notes_search", { query: notes.map((note) => note.needle), pattern: "**" }, ctx));
	for (const note of notes) {
		assert.equal(readFileSync(physicalPath(note.scope, note.address.replace(/^@(?:project|human)\//, ""), ctx), "utf8"), before.get(note.address), `search leaves ${note.address} byte-identical`);
		const file = searched.files.find((candidate) => candidate.address === note.address);
		assert.ok(file, `search returns ${note.address}`);
		assert.deepEqual(Object.keys(file).sort(), ["address", "matches", "matches_total", "stale", "updated_at"]);
		const hit = file.matches[0]!;
		assert.deepEqual(Object.keys(hit).sort(), ["line", "offset_chars", "text", "truncated"]);
		const read = resultRead(await call(captured, "notes_read", { address: note.address, offset_chars: hit.offset_chars }, ctx));
		assert.ok(read.content.startsWith(note.needle), `search offset starts notes_read at ${note.needle}`);
		assert.deepEqual(Object.keys(read.details).sort(), ["address", "next_offset_chars", "offset_chars", "total_chars"]);
	}
	assert.match(readFileSync(crossing, "utf8"), /^access_count: 10$/m, "the predicted read crosses access_count from 9 to 10");
	assert.match(resultRead(await call(captured, "notes_read", { address: "@human/legacy.md" }, ctx)).content, /^---\n/, "a missing-frontmatter note is normalized only by read");
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
	assert.equal(match.offset_chars, read.content.indexOf("needle"), "offset_chars addresses the query in the serialized read stream");
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

test("fresh human and project MAP.md bodies are both resident before the pocket", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "MAP.md", content: "MAP: session" }, ctx);
	await call(captured, "notes_write", { address: "@project/MAP.md", content: "MAP: project" }, ctx);
	await call(captured, "notes_write", { address: "@human/MAP.md", content: "MAP: human\nMAP: second" }, ctx);
	await call(captured, "notes_write", { path: "recent.md", content: "recent body" }, ctx);
	runHandlers(captured, "session_start", {}, ctx);
	const boot = typeof captured.sent.at(-1)?.message.content === "string" ? (captured.sent.at(-1)!.message.content as string) : "";
	assert.ok(boot.includes("MAP: human"), "the human map is injected");
	assert.ok(boot.includes("MAP: project"), "the project map is injected");
	assert.equal(boot.includes("MAP: session"), false, "the session map is never injected");
	assert.ok(boot.indexOf("MAP: human") < boot.indexOf("MAP: project"), "the personal map precedes the project map");
	assert.ok(boot.indexOf("MAP: project") < boot.indexOf("recent.md"), "both map bodies precede the pocket");
	assert.ok(boot.includes(CONTEXT_WINDOW_PROTOCOL_OPEN_TAG), "the protocol text still rides along");
});

test("the boot pocket applies per-home quotas in session, project, personal order", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const base = Date.parse("2026-01-01T00:00:00.000Z");
	for (const [scope, count] of [["session", 6], ["project", 3], ["human", 3]] as const) {
		for (let index = 0; index < count; index++) {
			const path = `${scope}-${index}.md`;
			await call(captured, "notes_write", { path, content: `${scope} body`, scope }, ctx);
			setUpdatedAt(scope, path, ctx, base + index * 1_000);
		}
	}
	await call(captured, "notes_write", { address: "MAP.md", content: "MAP: session" }, ctx);
	await call(captured, "notes_write", { address: "@project/MAP.md", content: "MAP: project" }, ctx);
	await call(captured, "notes_write", { address: "@human/MAP.md", content: "MAP: human" }, ctx);
	runHandlers(captured, "session_start", {}, ctx);
	const boot = typeof captured.sent.at(-1)?.message.content === "string" ? (captured.sent.at(-1)!.message.content as string) : "";
	for (const name of ["session-5.md", "session-4.md", "session-3.md", "session-2.md", "session-1.md", "@project/project-2.md", "@project/project-1.md", "@human/human-2.md", "@human/human-1.md"]) {
		assert.ok(boot.includes(name), `${name} stays in the pocket`);
	}
	for (const name of ["session-0.md", "@project/project-0.md", "@human/human-0.md", "MAP.md", "MAP: session"]) {
		assert.equal(boot.includes(name), false, `${name} is not a pocket entry`);
	}
	assert.ok(boot.indexOf("session-5.md") < boot.indexOf("session-4.md"), "session notes are most-recent-first");
	assert.ok(boot.indexOf("@project/project-2.md") < boot.indexOf("@project/project-1.md"), "project notes are most-recent-first");
	assert.ok(boot.indexOf("@human/human-2.md") < boot.indexOf("@human/human-1.md"), "personal notes are most-recent-first");
	assert.ok(boot.indexOf("session-1.md") < boot.indexOf("@project/project-2.md"), "session notes precede project notes");
	assert.ok(boot.indexOf("@project/project-1.md") < boot.indexOf("@human/human-2.md"), "project notes precede personal notes");
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
	await call(captured, "notes_write", { address: "@human/same.md", content: "human" }, ctx);
	assert.ok(existsSync(physicalPath("project", "same.md", ctx)), "@project writes to the current project home");
	assert.ok(existsSync(physicalPath("human", "same.md", ctx)), "@human writes to the human home");
	assert.match(resultRead(await call(captured, "notes_read", { address: "same.md" }, ctx)).content, /session$/);
	assert.equal(resultJson<{ error?: string }>(await call(captured, "notes_read", { address: "@project/missing.md" }, ctx)).error, "note not found");
	await assert.rejects(() => call(captured, "notes_read", { address: "@glboal/same.md" }, ctx), /@project\/.*@human\/.*bare names are the session home/);
	await assert.rejects(() => call(captured, "notes_write", { address: "bad@name.md", content: "no" }, ctx), /@project\/.*@human\/.*bare names are the session home/);
	assert.equal(existsSync(join(root, "human", "bad@name.md")), false, "a bad sigil creates nothing anywhere");
});

test("full addresses drive outputs and patterns; on-disk scope is read then dropped", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "root.md", content: "needle" }, ctx);
	await call(captured, "notes_write", { address: "@project/project.md", content: "needle" }, ctx);
	await call(captured, "notes_write", { address: "@human/human.md", content: "needle" }, ctx);
	const list = resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_list", { pattern: "**" }, ctx));
	assert.deepEqual(list.files.map((file) => file.address).sort(), ["@human/human.md", "@project/project.md", "root.md"]);
	assert.deepEqual(resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_list", { pattern: "*.md" }, ctx)).files.map((file) => file.address), ["root.md"]);
	assert.deepEqual(resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_search", { query: "needle", pattern: "@project/**" }, ctx)).files.map((file) => file.address), ["@project/project.md"]);
	const read = resultRead(await call(captured, "notes_read", { address: "@human/human.md" }, ctx));
	assert.equal(read.header, "--- READ WINDOW ---\naddress: @human/human.md\nchars: [0," + read.total_chars + ") of " + read.total_chars + "\nnext_offset_chars: null\n", "the raw READ WINDOW block echoes the full address");
	const legacy = physicalPath("project", "legacy.md", ctx);
	writeFileSync(legacy, "---\nscope: personal\norigin: self\nstatus: active\nstale: false\ncreated_at: 2026-01-01T00:00:00.000+00:00\nupdated_at: 2026-01-01T00:00:00.000+00:00\nlast_accessed: 2026-01-01T00:00:00.000+00:00\naccess_count: 0\n---\n\nlegacy");
	const legacyRead = resultRead(await call(captured, "notes_read", { address: "@project/legacy.md" }, ctx));
	assert.equal(legacyRead.details.address, "@project/legacy.md", "the read keeps the requested address while deriving its home internally");
	assertNoPublicScope(legacyRead.details, "legacy notes_read");
	await call(captured, "notes_edit", { address: "@project/legacy.md", stale: true }, ctx);
	assert.equal(/^scope:/m.test(readFileSync(legacy, "utf8")), false, "the next write removes legacy scope frontmatter");
});

test("stale project and personal maps are skipped independently", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "@project/MAP.md", content: "project fresh" }, ctx);
	await call(captured, "notes_write", { address: "@human/MAP.md", content: "personal stale", stale: true }, ctx);
	runHandlers(captured, "session_start", {}, ctx);
	let boot = String(captured.sent.at(-1)?.message.content ?? "");
	assert.ok(boot.includes("project fresh"), "a fresh project map survives a stale personal map");
	assert.equal(boot.includes("personal stale"), false, "the stale personal map is skipped");
	const second = manager();
	const secondCaptured = makeExtension(second);
	const secondCtx = context(second);
	await call(secondCaptured, "notes_edit", { address: "@project/MAP.md", stale: true }, secondCtx);
	await call(secondCaptured, "notes_edit", { address: "@human/MAP.md", stale: false }, secondCtx);
	runHandlers(secondCaptured, "session_start", {}, secondCtx);
	boot = String(secondCaptured.sent.at(-1)?.message.content ?? "");
	assert.equal(boot.includes("project fresh"), false, "the stale project map is skipped");
	assert.ok(boot.includes("personal stale"), "a fresh human map survives a stale project map");
});

const FRONTMATTER = (body: string) =>
	`---\norigin: self\nstatus: active\nstale: false\ncreated_at: 2026-01-01T00:00:00.000+00:00\nupdated_at: 2026-01-01T00:00:00.000+00:00\nlast_accessed: 2026-01-01T00:00:00.000+00:00\naccess_count: 0\n---\n\n${body}`;

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

test("@self resolves to the declared agent; other agents are read-only, reachable by glob", async () => {
	const root = freshRoot();
	await withAgent("WaShi!", async () => {
		const session = manager();
		const captured = makeExtension(session);
		const ctx = context(session);

		const self = resultJson<{ address: string }>(await call(captured, "notes_write", { address: "@self/journal.md", content: "washi body" }, ctx));
		assert.equal(self.address, "@self/journal.md");
		assert.ok(existsSync(join(root, "agents", "washi", "journal.md")), "@self writes under the slugified PI_NOTES_AGENT home");

		// The absolute form naming the current agent is equally writable.
		const absolute = resultJson<{ address: string }>(await call(captured, "notes_write", { address: "@agents/washi/plan.md", content: "plan" }, ctx));
		assert.equal(absolute.address, "@agents/washi/plan.md");

		// Seed another agent's home on disk; writes and edits there are refused, reads are not.
		mkdirSync(join(root, "agents", "faye"), { recursive: true });
		writeFileSync(join(root, "agents", "faye", "secret.md"), FRONTMATTER("faye secret"));
		const refusedWrite = resultJson<{ error: string }>(await call(captured, "notes_write", { address: "@agents/faye/secret.md", content: "hacked" }, ctx));
		assert.match(refusedWrite.error, /@agents\/faye\/ is not your home/);
		const refusedEdit = resultJson<{ error: string }>(await call(captured, "notes_edit", { address: "@agents/faye/secret.md", edits: [{ oldText: "secret", newText: "x" }] }, ctx));
		assert.match(refusedEdit.error, /not your home/);
		assert.ok(readFileSync(join(root, "agents", "faye", "secret.md"), "utf8").endsWith("faye secret"), "a refused write leaves the file alone");
		const read = resultRead(await call(captured, "notes_read", { address: "@agents/faye/secret.md" }, ctx));
		assert.ok(read.content.endsWith("faye secret"), "another agent's home is readable by explicit address");
		assert.equal(read.details.address, "@agents/faye/secret.md");

		// The merged default view resolves @self but never leaks other agents.
		const listed = resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_list", {}, ctx));
		const addresses = listed.files.map((file) => file.address);
		assert.deepEqual(addresses.filter((address) => address.startsWith("@agents/")).sort(), ["@agents/washi/journal.md", "@agents/washi/plan.md"], "the merged view carries the resolved own-agent rows only");

		// Explicit patterns reach one named home or scan the whole namespace.
		const one = resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_list", { pattern: "@agents/washi/**" }, ctx));
		assert.deepEqual(one.files.map((file) => file.address).sort(), ["@agents/washi/journal.md", "@agents/washi/plan.md"]);
		const every = resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_list", { pattern: "@agents/*/**" }, ctx));
		assert.deepEqual(every.files.map((file) => file.address).sort(), ["@agents/faye/secret.md", "@agents/washi/journal.md", "@agents/washi/plan.md"], "a glob in the name segment scans the namespace");
		const searched = resultJson<Searched>(await call(captured, "notes_search", { query: "secret", pattern: "@agents/faye/**" }, ctx));
		assert.deepEqual(searched.files.map((file) => file.address), ["@agents/faye/secret.md"], "search narrows to one agent home by pattern");
	});
});

test("@model resolves live from ctx.model; other models are read-only, reachable by glob", async () => {
	const root = freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session, undefined, undefined, true, undefined, undefined, "openai/gpt-5-codex");

	const live = resultJson<{ address: string }>(await call(captured, "notes_write", { address: "@model/quirks.md", content: "gpt quirks" }, ctx));
	assert.equal(live.address, "@model/quirks.md");
	assert.ok(existsSync(join(root, "models", "gpt-5-codex", "quirks.md")), "@model writes under the provider-stripped model slug");

	// The same note reads back under its absolute address.
	const absolute = resultRead(await call(captured, "notes_read", { address: "@models/gpt-5-codex/quirks.md" }, ctx));
	assert.ok(absolute.content.endsWith("gpt quirks"), "the absolute model address names the same home");

	// Another model's home: refused writes, allowed reads.
	mkdirSync(join(root, "models", "claude-sonnet-4-5"), { recursive: true });
	writeFileSync(join(root, "models", "claude-sonnet-4-5", "habits.md"), FRONTMATTER("claude habits"));
	const refused = resultJson<{ error: string }>(await call(captured, "notes_write", { address: "@models/claude-sonnet-4-5/habits.md", content: "hacked" }, ctx));
	assert.match(refused.error, /@models\/claude-sonnet-4-5\/ is not your home/);
	const read = resultRead(await call(captured, "notes_read", { address: "@models/claude-sonnet-4-5/habits.md" }, ctx));
	assert.ok(read.content.endsWith("claude habits"), "another model's home is readable by explicit address");

	const every = resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_list", { pattern: "@models/*/**" }, ctx));
	assert.deepEqual(every.files.map((file) => file.address).sort(), ["@models/claude-sonnet-4-5/habits.md", "@models/gpt-5-codex/quirks.md"], "a glob scans the model namespace");

	// A model-less session resolves @model to the fallback home.
	const noModel = context(manager());
	assert.equal(scopeDir("model", noModel), join(root, "models", "default"), "without ctx.model the model home is 'default'");
});

test("extension activation migrates the legacy personal/ home to human/ exactly once", () => {
	const root = freshRoot();
	mkdirSync(join(root, "personal"));
	writeFileSync(join(root, "personal", "laws.md"), FRONTMATTER("legacy body"));
	makeExtension(manager());
	assert.ok(existsSync(join(root, "human", "laws.md")), "personal/ is renamed to human/ at activation");
	assert.equal(existsSync(join(root, "personal")), false, "the legacy directory is gone");
	// A second activation with no legacy dir is a no-op, not an error.
	makeExtension(manager());
	assert.ok(existsSync(join(root, "human", "laws.md")));
});

test("a personal/+human/ conflict warns at activation and never merges", () => {
	const root = freshRoot();
	mkdirSync(join(root, "personal"));
	mkdirSync(join(root, "human"));
	writeFileSync(join(root, "personal", "a.md"), FRONTMATTER("a"));
	writeFileSync(join(root, "human", "b.md"), FRONTMATTER("b"));
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (line: unknown) => warnings.push(String(line));
	try {
		makeExtension(manager());
	} finally {
		console.warn = original;
	}
	assert.ok(warnings.some((line) => line.includes("personal/") && line.includes("human/")), "the conflict is a warning, never a merge");
	assert.ok(existsSync(join(root, "personal", "a.md")), "the legacy home survives the conflict");
	assert.ok(existsSync(join(root, "human", "b.md")), "the modern home survives the conflict");
});

test("the boot identity names the declared agent and the live model", async () => {
	freshRoot();
	await withAgent("WaShi!", async () => {
		const session = manager();
		const captured = makeExtension(session);
		const ctx = context(session, undefined, undefined, true, undefined, undefined, "anthropic/claude-sonnet-4-5");
		runHandlers(captured, "session_start", {}, ctx);
		const boot = String(captured.sent.at(-1)?.message.content ?? "");
		assert.ok(boot.includes("Agent name: washi (brain: claude-sonnet-4-5)"), "the identity block resolves both the agent env and the live model");
	});
});

test("the boot pocket keeps per-home quotas across all five homes in order", async () => {
	freshRoot();
	await withAgent("washi", async () => {
		const session = manager();
		const captured = makeExtension(session);
		const ctx = context(session, undefined, undefined, true, undefined, undefined, "openai/gpt-5-codex");
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		const legacy: Array<["session" | "project" | "human", number]> = [["session", 6], ["project", 3], ["human", 3]];
		for (const [scope, count] of legacy) {
			for (let index = 0; index < count; index++) {
				const path = `${scope}-${index}.md`;
				await call(captured, "notes_write", { path, content: `${scope} body`, scope }, ctx);
				setUpdatedAt(scope, path, ctx, base + index * 1_000);
			}
		}
		// Agent and model homes have no legacy scope form; their relative addresses land there directly.
		await call(captured, "notes_write", { address: "@self/agent-0.md", content: "agent body" }, ctx);
		setUpdatedAt("agent", "agent-0.md", ctx, base);
		await call(captured, "notes_write", { address: "@self/agent-1.md", content: "agent body" }, ctx);
		setUpdatedAt("agent", "agent-1.md", ctx, base + 1_000);
		await call(captured, "notes_write", { address: "@model/model-0.md", content: "model body" }, ctx);
		setUpdatedAt("model", "model-0.md", ctx, base);
		await call(captured, "notes_write", { address: "@model/model-1.md", content: "model body" }, ctx);
		setUpdatedAt("model", "model-1.md", ctx, base + 1_000);
		runHandlers(captured, "session_start", {}, ctx);
		const boot = String(captured.sent.at(-1)?.message.content ?? "");
		for (const name of [
			"session-5.md", "session-4.md", "session-3.md", "session-2.md", "session-1.md",
			"@project/project-2.md", "@project/project-1.md",
			"@human/human-2.md", "@human/human-1.md",
			"@agents/washi/agent-1.md",
			"@models/gpt-5-codex/model-1.md",
		]) assert.ok(boot.includes(name), `${name} stays in the pocket`);
		for (const name of ["session-0.md", "@project/project-0.md", "@human/human-0.md", "@agents/washi/agent-0.md", "@models/gpt-5-codex/model-0.md"]) {
			assert.equal(boot.includes(name), false, `${name} is evicted by its home quota`);
		}
		assert.ok(boot.indexOf("session-5.md") < boot.indexOf("@project/project-2.md"), "session precedes project");
		assert.ok(boot.indexOf("@project/project-1.md") < boot.indexOf("@human/human-2.md"), "project precedes human");
		assert.ok(boot.indexOf("@human/human-1.md") < boot.indexOf("@agents/washi/agent-1.md"), "human precedes agent");
		assert.ok(boot.indexOf("@agents/washi/agent-1.md") < boot.indexOf("@models/gpt-5-codex/model-1.md"), "agent precedes model");
	});
});
