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
import { call, context, installExtensionTestEnvironment, makeExtension, manager, resultJson, resultRead, runHandlers } from "./helpers/extension.js";

const testEnvironment = installExtensionTestEnvironment("pi-context-notes");
test.beforeEach(() => testEnvironment.beforeEach());
test.afterEach(() => testEnvironment.afterEach());
test.after(() => testEnvironment.dispose());

function freshRoot(): string {
	return testEnvironment.newNotesRoot();
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
