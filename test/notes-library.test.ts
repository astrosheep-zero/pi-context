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

test("standalone notes API persists camelCase metadata, edits, lists and searches full results", async (t) => {
	const { home, notes } = fixture(t);
	const first = await notes.write("checkpoint", "alpha\nneedle 😀", { origin: "user" });
	assert.equal(first.meta.project, "project-12345678");
	const read = (await notes.read("checkpoint.md"))!;
	assert.equal(read.body, "alpha\nneedle 😀");
	assert.equal(read.meta.origin, "user");
	assert.equal(read.meta.accessCount, 1);
	assert.equal(await notes.read("missing.md"), undefined);
	const edited = await notes.edit("checkpoint", [{ oldText: "alpha", newText: "beta" }]);
	assert.deepEqual(edited.change, { kind: "body", before: "alpha\nneedle 😀", after: "beta\nneedle 😀" });
	assert.equal(edited.resolvedScope, read.resolvedScope);
	assert.equal(edited.applied, 1);
	const updatedBefore = (await notes.read("checkpoint"))!.meta.updatedAt;
	const metadataEdit = await notes.edit("checkpoint", undefined, { crumpled: true });
	assert.equal(metadataEdit.change.kind, "metadata");
	assert.equal(metadataEdit.change.before.includes("crumpledAt"), false);
	assert.match(metadataEdit.change.after, /\ncrumpledAt: \d{4}-\d{2}-\d{2}T/);
	assert.equal(metadataEdit.change.after.includes("needle"), false, "metadata-only diff excludes body");
	assert.equal((await notes.list()).some((row) => row.address === "checkpoint.md"), false, "a crumpled note leaves the live list");
	assert.equal((await notes.search(["needle"])).length, 0, "search also skips crumpled notes");
	const basket = (await notes.list({ wastebasket: true }))[0]!;
	assert.equal(basket.address, "checkpoint.md");
	assert.ok(basket.meta.crumpledAt);
	assert.equal(basket.meta.updatedAt, updatedBefore, "crumpling does not bump updatedAt");
	const crumpledAt = basket.meta.crumpledAt;
	await notes.edit("checkpoint", undefined, { crumpled: true });
	assert.equal((await notes.list({ wastebasket: true }))[0]?.meta.crumpledAt, crumpledAt, "re-crumpling keeps the original time");
	await notes.edit("checkpoint", undefined, { crumpled: false });
	assert.equal((await notes.list()).some((row) => row.address === "checkpoint.md"), true, "smoothing returns the note to the live list");
	assert.equal((await notes.list({ wastebasket: true })).length, 0);
	const matches = await notes.search(["needle"]);
	assert.equal(matches[0]?.matches[0]?.line, 2);
	const text = (await notes.read("checkpoint"))!.text;
	assert.equal(Array.from(text).slice(matches[0]!.matches[0]!.offsetChars).join(""), "needle 😀");

	// An existing hand-written extra field and original ownership survive a new caller.
	const path = join(home, "pi/session/session-a/checkpoint.md");
	writeFileSync(path, readFileSync(path, "utf8").replace("\n---\n\n", "\nsourceWindow: pcw:test\nrecurrenceCount: 2\nrecurrenceWindows:\n  - pcw:one\n  - pcw:two\n__proto__: {\"sentinel\":true}\ncustom: preserved\n---\n\n"));
	const moved = createNotesStore({ home, sessionId: "session-a", projectKey: "other-12345678", agent: "root", model: "test-model" });
	const rewritten = await moved.write("checkpoint", "new body");
	assert.equal(rewritten.meta.createdAt, first.meta.createdAt);
	assert.equal(rewritten.meta.project, "project-12345678");
	assert.equal(rewritten.meta.custom, "preserved");
	assert.deepEqual(rewritten.meta["__proto__"], { sentinel: true });
	assert.deepEqual((await moved.read("checkpoint"))?.meta["__proto__"], { sentinel: true }, "unknown __proto__ metadata survives persistence and reread");
	assert.equal(rewritten.meta.sourceWindow, "pcw:test");
	assert.equal(rewritten.meta.recurrenceCount, 2);
	assert.deepEqual(rewritten.meta.recurrenceWindows, ["pcw:one", "pcw:two"]);
	assert.equal(rewritten.meta.crumpledAt, undefined, "writing always produces an uncrumpled note");
	const combined = await moved.edit("checkpoint", [{ oldText: "new", newText: "final" }], { crumpled: true });
	assert.equal(combined.change.kind, "file");
	assert.match(combined.change.after, /\ncrumpledAt: \d{4}-\d{2}-\d{2}T/);
	assert.match(combined.change.after, /final body$/);
	assert.deepEqual((await moved.edit("checkpoint", undefined, { crumpled: true })).change, { kind: "none", before: "", after: "" });
	assert.equal((await moved.write("checkpoint", "revived body")).meta.crumpledAt, undefined, "writing a crumpled address smooths it");
});

test("same-file read/modify/write operations serialize across stores and markdown aliases", async (t) => {
	const { home, context, notes } = fixture(t);
	const other = createNotesStore(context);
	await notes.write("shared", "alpha\nbeta");

	const firstEdit = notes.edit("shared", [{ oldText: "alpha", newText: "A" }]);
	const secondEdit = other.edit("shared.md", [{ oldText: "beta", newText: "B" }]);
	await Promise.all([firstEdit, secondEdit]);
	assert.equal((await notes.read("shared"))?.body, "A\nB", "edits through address aliases retain both changes");

	const before = (await notes.read("shared"))!.meta.accessCount;
	const [readA, readB] = await Promise.all([notes.read("shared.md"), other.read("shared")]);
	assert.ok(readA && readB);
	assert.equal((await notes.list({ scope: "session" }))[0]?.meta.accessCount, before + 2, "parallel reads do not lose access-counter updates");

	const file = join(home, "pi/session/session-a/shared.md");
	const stableEdits = [{ oldText: "A", newText: "first" }];
	const operation = notes.edit("shared", stableEdits);
	stableEdits[0]!.newText = "mutated after call";
	await operation;
	assert.equal((await notes.read("shared"))?.body, "first\nB", "edit arguments are snapshotted at method entry");
	assert.equal(readFileSync(file, "utf8").includes("mutated after call"), false);
});

test("stores snapshot explicit identity and do not leak homes across instances", async (t) => {
	const { home, context } = fixture(t);
	const mutable = { ...context };
	const notes = createNotesStore(mutable);
	const other = createNotesStore({ ...context, home: join(home, "other"), agent: "other-agent", model: "other-model" });
	assert.equal(existsSync(join(home, "other")), false, "construction does not create the supplied home");
	mutable.agent = "changed-after-construction";
	await notes.write("@self/private", "first");
	await other.write("@self/private", "second");
	assert.equal((await notes.read("@self/private"))?.body, "first");
	assert.equal((await other.read("@self/private"))?.body, "second");
	assert.equal((await notes.list())[0]?.address, "@agents/root/private.md");
	assert.equal((await other.list())[0]?.address, "@agents/other-agent/private.md");

	mkdirSync(join(home, "agents/visitor"), { recursive: true });
	writeFileSync(join(home, "agents/visitor/hello.md"), "visiting");
	assert.equal((await notes.read("@agents/visitor/hello"))?.body, "visiting");
	await assert.rejects(() => notes.write("@agents/visitor/hello", "overwrite"), (error: unknown) => error instanceof NoteError && error.code === "invalid_scope");
});

test("list and search share scoped pattern scans and search offsets count Unicode code points", async (t) => {
	const { notes } = fixture(t);
	await notes.write("shared.md", "😀 needle in session");
	await notes.write("@project/shared.md", "needle in project");
	await notes.write("@human/shared.md", "needle in human");
	await notes.write("@project/elsewhere.md", "unrelated");

	const pattern = "**/shared.md";
	const listed = await notes.list({ pattern });
	const searched = await notes.search(["needle"], { pattern });
	const listedAddresses = listed.map((row) => row.address).sort();
	const searchedAddresses = searched.map((row) => row.address).sort();
	assert.deepEqual(searchedAddresses, ["@human/shared.md", "@project/shared.md", "shared.md"]);
	assert.deepEqual(searchedAddresses, listedAddresses, "list and search traverse the same filtered homes and files");

	const sessionMatch = searched.find((row) => row.address === "shared.md")!.matches[0]!;
	const serialized = (await notes.read("shared.md"))!.text;
	assert.ok(Array.from(serialized).slice(sessionMatch.offsetChars).join("").startsWith("needle"), "the absolute offset counts the emoji as one code point");
});

test("invalid addressing and failed edits leave stored bytes untouched without poisoning the queue", async (t) => {
	const { home, context, notes } = fixture(t);
	assert.throws(() => createNotesStore({ ...context, sessionId: "../escape" }));
	await assert.rejects(() => notes.write("@project/../escape", "bad"));
	await assert.rejects(() => notes.list({ scope: "agent", who: "../escape" }));
	// The typed API disallows this; JavaScript callers must still receive a refusal.
	// @ts-expect-error who cannot accompany project scope
	await assert.rejects(() => notes.list({ scope: "project", who: "root" }), (error: unknown) => error instanceof NoteError && error.code === "invalid_scope");
	await notes.write("edit", "alpha\nbeta\nbeta");
	const path = join(home, "pi/session/session-a/edit.md");
	const before = readFileSync(path, "utf8");
	await assert.rejects(() => notes.edit("edit", [{ oldText: "beta", newText: "B" }]), (error: unknown) => error instanceof NoteError && error.code === "ambiguous_edit" && error.lineNumbers?.join(",") === "2,3");
	await assert.rejects(() => notes.edit("edit", [{ oldText: "alpha", newText: "A" }, { oldText: "absent", newText: "X" }]), (error: unknown) => error instanceof NoteError && error.code === "no_match" && error.editIndex === 1);
	assert.equal(readFileSync(path, "utf8"), before);
	await assert.rejects(() => notes.edit("absent", undefined, { crumpled: true }), (error: unknown) => error instanceof NoteError && error.code === "not_found");
	await notes.edit("edit", [{ oldText: "alpha", newText: "A" }]);
	assert.equal((await notes.read("edit"))?.body, "A\nbeta\nbeta", "failed operations do not poison later queue work");
});
