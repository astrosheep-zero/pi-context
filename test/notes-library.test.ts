import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNotesStore, NoteError, type NotesContext } from "../src/notes/index.js";

function fixture(t: test.TestContext) {
	const home = mkdtempSync(join(tmpdir(), "notes-library-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const context: NotesContext = { home, sessionId: "session-a", projectKey: "project-12345678", agent: "root", model: "test-model" };
	return { home, context, notes: createNotesStore(context) };
}

test("standalone notes API persists metadata, edits, lists and searches full results", (t) => {
	const { home, notes } = fixture(t);
	const first = notes.write("checkpoint", "alpha\nneedle 😀", { origin: "user" });
	assert.equal(first.meta.project, "project-12345678");
	const read = notes.read("checkpoint.md")!;
	assert.equal(read.body, "alpha\nneedle 😀");
	assert.equal(read.meta.origin, "user");
	assert.equal(read.meta.access_count, 1);
	assert.equal(notes.read("missing.md"), undefined);
	const edited = notes.edit("checkpoint", [{ oldText: "alpha", newText: "beta" }]);
	assert.deepEqual(edited.change, { kind: "body", before: "alpha\nneedle 😀", after: "beta\nneedle 😀" });
	assert.equal(edited.resolvedScope, read.resolvedScope);
	assert.equal(edited.applied, 1);
	const metadataEdit = notes.edit("checkpoint", undefined, { stale: true });
	assert.equal(metadataEdit.change.kind, "metadata");
	assert.match(metadataEdit.change.before, /\nstale: false\n/);
	assert.match(metadataEdit.change.after, /\nstale: true\n/);
	assert.equal(metadataEdit.change.after.includes("needle"), false, "metadata-only diff excludes body");
	assert.equal(notes.list()[0]?.meta.stale, true);
	const matches = notes.search(["needle"]);
	assert.equal(matches[0]?.matches[0]?.line, 2);
	const text = notes.read("checkpoint")!.text;
	assert.equal(Array.from(text).slice(matches[0]!.matches[0]!.offsetChars).join(""), "needle 😀");

	// An existing hand-written extra field and original ownership survive a new caller.
	const path = join(home, "pi/session/session-a/checkpoint.md");
	writeFileSync(path, readFileSync(path, "utf8").replace("\n---\n\n", "\ncustom: preserved\n---\n\n"));
	const moved = createNotesStore({ home, sessionId: "session-a", projectKey: "other-12345678", agent: "root", model: "test-model" });
	const rewritten = moved.write("checkpoint", "new body");
	assert.equal(rewritten.meta.created_at, first.meta.created_at);
	assert.equal(rewritten.meta.project, "project-12345678");
	assert.equal(rewritten.meta.custom, "preserved");
	assert.equal(rewritten.meta.stale, false);
	const combined = moved.edit("checkpoint", [{ oldText: "new", newText: "final" }], { stale: true });
	assert.equal(combined.change.kind, "file");
	assert.match(combined.change.after, /\nstale: true\n/);
	assert.match(combined.change.after, /final body$/);
	assert.deepEqual(moved.edit("checkpoint", undefined, { stale: true }).change, { kind: "none", before: "", after: "" });
});

test("stores snapshot explicit identity and do not leak homes across instances", (t) => {
	const { home, context } = fixture(t);
	const mutable = { ...context };
	const notes = createNotesStore(mutable);
	const other = createNotesStore({ ...context, home: join(home, "other"), agent: "other-agent", model: "other-model" });
	assert.equal(existsSync(join(home, "other")), false, "construction does not create the supplied home");
	mutable.agent = "changed-after-construction";
	notes.write("@self/private", "first");
	other.write("@self/private", "second");
	assert.equal(notes.read("@self/private")?.body, "first");
	assert.equal(other.read("@self/private")?.body, "second");
	assert.equal(notes.list()[0]?.address, "@agents/root/private.md");
	assert.equal(other.list()[0]?.address, "@agents/other-agent/private.md");

	mkdirSync(join(home, "agents/visitor"), { recursive: true });
	writeFileSync(join(home, "agents/visitor/hello.md"), "visiting");
	assert.equal(notes.read("@agents/visitor/hello")?.body, "visiting");
	assert.throws(() => notes.write("@agents/visitor/hello", "overwrite"), (error: unknown) => error instanceof NoteError && error.code === "invalid_scope");
});

test("invalid addressing and failed edits leave stored bytes untouched", (t) => {
	const { home, context, notes } = fixture(t);
	assert.throws(() => createNotesStore({ ...context, sessionId: "../escape" }));
	assert.throws(() => notes.write("@project/../escape", "bad"));
	assert.throws(() => notes.list({ scope: "agent", who: "../escape" }));
	// The typed API disallows this; JavaScript callers must still receive a refusal.
	// @ts-expect-error who cannot accompany project scope
	assert.throws(() => notes.list({ scope: "project", who: "root" }), (error: unknown) => error instanceof NoteError && error.code === "invalid_scope");
	notes.write("edit", "alpha\nbeta\nbeta");
	const path = join(home, "pi/session/session-a/edit.md");
	const before = readFileSync(path, "utf8");
	assert.throws(() => notes.edit("edit", [{ oldText: "beta", newText: "B" }]), (error: unknown) => error instanceof NoteError && error.code === "ambiguous_edit" && error.lineNumbers?.join(",") === "2,3");
	assert.throws(() => notes.edit("edit", [{ oldText: "alpha", newText: "A" }, { oldText: "absent", newText: "X" }]), (error: unknown) => error instanceof NoteError && error.code === "no_match" && error.editIndex === 1);
	assert.equal(readFileSync(path, "utf8"), before);
	assert.throws(() => notes.edit("absent", undefined, { stale: true }), (error: unknown) => error instanceof NoteError && error.code === "not_found");
});
