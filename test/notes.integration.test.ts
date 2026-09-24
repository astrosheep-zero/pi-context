import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { internal } from "../src/index.js";
import { loadNotesSnapshot } from "../src/pi/notes/snapshot.js";
import { renderBootBlock } from "../src/context/prompts.js";
import { localIso } from "../src/notes/frontmatter.js";
import type { NoteRow, Scope } from "../src/notes/index.js";
import { listNotes, physicalPath, scopeDir } from "./helpers/notes.js";
import { TOOL_OUTPUT_MAX_BYTES } from "../src/tool-output.js";
import {
	assertWithinBudget,
	call,
	context,
	explicitBoot,
	makeExtension,
	manager,
	resultJson,
	resultRead,
	runHandlers,
} from "./helpers/extension.js";
import { installExtensionTestHooks } from "./helpers/extension-test-environment.js";

const testEnvironment = installExtensionTestHooks("pi-context-integration");

test("notes_list and notes_search are recent-first snapshots with narrowing hints", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const base = 1_700_000_000_000;
	const put = (address: string, updated: number, content = "needle") => {
		const project = address.startsWith("@project/");
		const path = physicalPath(project ? "project" : "session", address.replace(/^@project\//, ""), ctx);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `---\nscope: ${project ? "project" : "session"}\norigin: self\nstatus: active\nstale: false\ncreatedAt: ${localIso(updated - 1000)}\nupdatedAt: ${localIso(updated)}\nlastAccessed: ${localIso(updated)}\naccessCount: 0\n---\n\n${content}`);
	};
	put("old.md", base + 1);
	put("new.md", base + 3);
	put("@project/design.md", base + 2);

	const listed = resultJson<{ files: Array<{ address: string; updated_at: string }>; more: number }>(await call(captured, "notes_list", { limit: 2 }, ctx));
	assert.deepEqual(listed.files.map((file) => file.address), ["new.md", "@project/design.md"]);
	assert.equal(listed.more, 1);
	assert.deepEqual(Object.keys(listed).sort(), ["files", "more"]);

	const searched = resultJson<{ files: Array<{ address: string; updated_at: string }>; more: number }>(await call(captured, "notes_search", { query: "needle", limit: 2 }, ctx));
	assert.deepEqual(searched.files.map((file) => file.address), ["new.md", "@project/design.md"]);
	assert.equal(searched.more, 1);

	const narrowed = resultJson<{ files: Array<{ address: string }>; more: number }>(await call(captured, "notes_list", { pattern: "@project/**" }, ctx));
	assert.deepEqual(narrowed.files.map((file) => file.address), ["@project/design.md"]);
	assert.equal(narrowed.more, 0);
});

test("notes_list reports omitted files when the wire budget truncates the snapshot", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const timestamp = 1_700_000_000_000;
	for (let index = 0; index < 400; index++) {
		const address = `bulk/note-${String(index).padStart(3, "0")}.md`;
		const path = physicalPath("session", address, ctx);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `---\nscope: session\norigin: self\nstatus: active\nstale: false\ncreatedAt: ${localIso(timestamp)}\nupdatedAt: ${localIso(timestamp + index)}\nlastAccessed: ${localIso(timestamp)}\naccessCount: 0\n---\n\nbody`);
	}
	const result = resultJson<{ files: Array<{ address: string }>; more: number }>(await call(captured, "notes_list", {}, ctx));
	assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= TOOL_OUTPUT_MAX_BYTES);
	assert.ok(result.files.length > 0 && result.files.length < 400);
	assert.equal(result.more, 400 - result.files.length);
	assert.equal(result.files[0]?.address, "bulk/note-399.md", "the snapshot retains the newest rows first");
});

test("notes_list is most-recently-updated first across merged scopes", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const put = (scope: "session" | "project" | "human", path: string, updated: number) => {
		const file = physicalPath(scope, path, ctx);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `---\nscope: ${scope}\norigin: self\nstatus: active\nstale: false\ncreatedAt: ${localIso(updated - 1000)}\nupdatedAt: ${localIso(updated)}\nlastAccessed: ${localIso(updated)}\naccessCount: 0\n---\n\nbody`);
	};
	const base = 1_700_000_000_000;
	put("session", "b.md", base + 10);
	put("session", "a.md", base + 10);
	put("project", "c.md", base + 5);
	put("human", "e.md", base + 20);
	const files = async (params: Record<string, unknown>) =>
		resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_list", params, ctx)).files;
	assert.deepEqual((await files({})).map((file) => file.address), ["@human/e.md", "a.md", "b.md", "@project/c.md"], "updated_at descending with address ascending as the tiebreak");
	// A same-path pair in two scopes keeps both rows; equal timestamps tie-break by scope name.
	put("human", "a.md", base + 10);
	assert.deepEqual((await files({})).filter((file) => file.address.endsWith("a.md")).map((file) => file.address), ["@human/a.md", "a.md"], "equal timestamps tie-break by full address");
	assert.deepEqual((await files({ pattern: "*.md" })).map((file) => file.address), ["a.md", "b.md"], "a bare pattern narrows to the session home");
});

test("notes are real files that persist across sessions and round-trip Unicode", async () => {
	const original = manager();
	const captured = makeExtension(original);
	const ctx = context(original);
	await call(captured, "notes_write", { address: "@human/checkpoint/进度.md", content: "第一行\nneedle Café" }, ctx);

	// A brand-new session over the same physical root sees the human note: nothing is replayed
	// from session entries, the file itself is the durable artifact.
	const restored = manager();
	const restoredCaptured = makeExtension(restored);
	const restoredCtx = context(restored);
	const rawRead = await call(restoredCaptured, "notes_read", { address: "@human/checkpoint/进度.md", offset_chars: -4 }, restoredCtx);
	const read = resultRead(rawRead);
	assert.equal(read.details.address, "@human/checkpoint/进度.md");
	assert.equal(read.content, "Café", "a negative offset reads the body tail in one call");
	const searched = resultJson<{ files: Array<{ address: string; updated_at: unknown; matches: Array<{ line: number }> }> }>(
		await call(restoredCaptured, "notes_search", { pattern: "@human/**", query: "Café" }, restoredCtx),
	);
	assert.equal(searched.files[0]?.matches[0]?.line, 2);
	const listedFiles = resultJson<{ files: Array<{ address: string; updated_at: unknown }> }>(
		await call(restoredCaptured, "notes_list", { pattern: "@human/checkpoint/**" }, restoredCtx),
	);
	assert.equal(listedFiles.files.length, 1, "glob ** crosses into the checkpoint directory");
	assert.equal(listedFiles.files[0]?.address, "@human/checkpoint/进度.md");
	// A single-segment * never crosses `/`, so a nested-only store matches nothing at the root.
	const rootOnly = resultJson<{ files: Array<{ address: string }> }>(
		await call(restoredCaptured, "notes_list", { pattern: "@human/*" }, restoredCtx)
	);
	assert.equal(rootOnly.files.length, 0, "glob * stays within one segment");
	assert.equal(searched.files[0]?.updated_at, listedFiles.files[0]?.updated_at);
	await assert.rejects(() => call(captured, "notes_write", { address: "../escape", content: "x" }, ctx), /unsupported component/);
});

test("stale lifecycle: writes and metadata-only edits close and revive a note", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm);

	await call(captured, "notes_write", { address: "journal.md", content: "log line" }, ctx);

	// metadata-only: content unchanged, flag set, applied 0
	const markOnly = resultJson<{ address: string; applied: number; diff: string }>(await call(captured, "notes_edit", { address: "journal.md", stale: true }, ctx));
	assert.equal(markOnly.applied, 0);
	assert.equal((await listNotes(ctx, { scope: "session" }))[0]?.meta.stale, true);
	assert.equal(resultRead(await call(captured, "notes_read", { address: "journal.md" }, ctx)).content.endsWith("log line"), true, "mark-only leaves content unchanged");

	// explicit revive
	const revived = resultJson<{ address: string; applied: number; diff: string }>(await call(captured, "notes_edit", { address: "journal.md", stale: false }, ctx));
	assert.equal((await listNotes(ctx, { scope: "session" }))[0]?.meta.stale, false, "stale:false revives");

	// write+stale closure then plain write revival
	await call(captured, "notes_write", { address: "journal.md", content: "final", stale: true }, ctx);
	assert.equal((await listNotes(ctx, { scope: "session" }))[0]?.meta.stale, true);
	await call(captured, "notes_write", { address: "journal.md", content: "reopened" }, ctx);
	assert.equal((await listNotes(ctx, { scope: "session" }))[0]?.meta.stale, false, "writing without stale revives");

	// metadata-only on a missing path is the typed not-found arm
	const missing = resultJson<{ error?: string }>(await call(captured, "notes_edit", { address: "missing.md", stale: true }, ctx));
	assert.equal(missing.error, "note not found");
});

test("the filesystem notes loader treats an absent home as empty but surfaces a real directory read failure", async () => {
	const sm = manager();
	const ctx = context(sm);
	assert.deepEqual(await listNotes(ctx, { scope: "human" }), [], "a home that has not been created is empty");
	const blockedHome = scopeDir("human", ctx);
	writeFileSync(blockedHome, "not a directory");
	await assert.rejects(
		() => listNotes(ctx, { scope: "human" }),
		(error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR",
		"a non-ENOENT directory failure is not swallowed as an empty home",
	);
});

test("boot note acquisition is one closed snapshot and isolates one or all failed homes", async () => {
	const sm = manager();
	const ctx = context(sm);
	const updated = Date.now();
	const note = (scope: Scope, path: string, address: string, body: string): NoteRow => ({
		address,
		scope,
		path,
		body,
		sizeBytes: Buffer.byteLength(body, "utf8"),
		meta: {
			scope,
			origin: "self",
			status: "active",
			stale: false,
			createdAt: updated,
			updatedAt: updated,
			lastAccessed: updated,
			accessCount: 0,
		},
	});
	const rows = new Map<Scope, NoteRow[]>([
		["session", [note("session", "MAP.md", "MAP.md", "SESSION_MAP_BODY"), note("session", "session.md", "session.md", "SESSION_POCKET_BODY")]],
		["project", [note("project", "MAP.md", "@project/MAP.md", "PROJECT_MAP_BODY")]],
		["human", [note("human", "MAP.md", "@human/MAP.md", "HUMAN_MAP_BODY"), note("human", "human.md", "@human/human.md", "HUMAN_POCKET_BODY")]],
		["agent", [note("agent", "MAP.md", "@agents/root/MAP.md", "AGENT_MAP_BODY")]],
		["model", [note("model", "model.md", "@models/default/model.md", "MODEL_POCKET_BODY")]],
	]);
	const calls = new Map<Scope, number>();
	const snapshot = await loadNotesSnapshot(ctx, (_ctx, scope) => {
		calls.set(scope, (calls.get(scope) ?? 0) + 1);
		return rows.get(scope) ?? [];
	});
	assert.deepEqual([...calls.entries()], [["session", 1], ["project", 1], ["human", 1], ["agent", 1], ["model", 1]], "each selected home is loaded exactly once");
	const renderData = {
		agentName: "root",
		modelName: "default",
		firstWindowId: "pcw:test:root",
		currentWindowId: "pcw:test:next",
		previousWindowId: "pcw:test:root",
		notes: snapshot,
	};
	const rendered = renderBootBlock(renderData);
	assert.equal(renderBootBlock(renderData), rendered, "rendering the same boot data twice is deterministic");
	assert.ok(rendered.includes("HUMAN_MAP_BODY") && rendered.includes("PROJECT_MAP_BODY") && rendered.includes("AGENT_MAP_BODY") && rendered.includes("SESSION_MAP_BODY"), "all home maps, including session, are pinned");
	assert.ok(rendered.includes("session.md") && rendered.includes("@human/human.md"), "recent rows come from the same snapshot");
	assert.equal(rendered.includes("SESSION_POCKET_BODY"), false, "recent bodies stay excluded");
	assert.equal(rendered.includes("- MAP.md"), false, "a pinned session map does not take a recent seat");
	assert.match(rendered, /- session\.md \| 19 chars \| (?:just now|\d+s ago)/);
	assert.equal(rendered.includes("UTF-8 bytes"), false, "recent rows omit implementation-oriented byte counts");
	assert.ok(rendered.indexOf("<context_window_protocol>") < rendered.indexOf("# Your notes"), "the protocol explains the notes before presenting them");
	const headings = ["## The human | @human", "## You | @self → @agents/root", "## Your model | @model → @models/default", "## This project | @project", "## This session"];
	for (let i = 1; i < headings.length; i++) assert.ok(rendered.indexOf(headings[i - 1]!) < rendered.indexOf(headings[i]!), "homes proceed from durable to current session");
	assert.ok(rendered.indexOf("HUMAN_MAP_BODY") < rendered.indexOf("- @human/human.md"), "each map stays next to its own recent notes");

	const expanded = await loadNotesSnapshot(ctx, (_ctx, scope) => {
		if (scope === "project" || scope === "human" || scope === "agent" || scope === "model") {
			return Array.from({ length: 6 }, (_, i) => note(scope, `note-${i}.md`, `@${scope === "agent" ? "agents/root" : scope === "model" ? "models/default" : scope}/note-${i}.md`, `body ${i}`));
		}
		return rows.get(scope) ?? [];
	});
	const expandedText = renderBootBlock({ ...renderData, notes: expanded });
	for (const prefix of ["@project", "@human", "@agents/root"]) {
		for (let i = 0; i < 5; i++) assert.ok(expandedText.includes(`- ${prefix}/note-${i}.md | `), `${prefix} includes note ${i}`);
		assert.equal(expandedText.includes(`- ${prefix}/note-5.md | `), false, `${prefix} is capped at five`);
	}
	for (let i = 0; i < 3; i++) assert.ok(expandedText.includes(`- @models/default/note-${i}.md | `), `@model includes note ${i}`);
	assert.equal(expandedText.includes("- @models/default/note-3.md | "), false, "@model is capped at three");
	assert.equal(expandedText.includes("You find"), false, "the old pocket heading is gone");

	const empty = await loadNotesSnapshot(ctx, () => []);
	assert.match(renderBootBlock({ ...renderData, notes: empty }), /# Your notes\n\n： None yet\. A blank slate is a fine place to start — just don't finish there\./);
	const staleNote = note("session", "stale.md", "stale.md", "SHOULD_NOT_SHOW");
	const mapAndUnicode = await loadNotesSnapshot(ctx, (_ctx, scope) => scope === "session" ? [
		note("session", "MAP.md", "MAP.md", "SESSION_MAP_BODY"),
		note("session", "unicode.md", "unicode.md", "🐑字"),
		{ ...staleNote, meta: { ...staleNote.meta, stale: true } },
	] : []);
	const mapAndUnicodeText = renderBootBlock({ ...renderData, notes: mapAndUnicode });
	assert.match(mapAndUnicodeText, /SESSION_MAP_BODY[\s\S]*- unicode\.md \| 2 chars \| (?:just now|\d+s ago)/);
	assert.equal(mapAndUnicodeText.includes("stale.md"), false);
	assert.equal(mapAndUnicodeText.includes("- MAP.md"), false);
	assert.equal(mapAndUnicodeText.includes("## The human"), false, "empty sections are omitted");

	const readFailure = (code: string): NodeJS.ErrnoException => Object.assign(new Error("scripted read failure"), { code });
	const oneFailed = await loadNotesSnapshot(ctx, (_ctx, scope) => {
		if (scope === "human") throw readFailure("EIO");
		return rows.get(scope) ?? [];
	});
	assert.deepEqual(oneFailed.unavailable.map((home) => home.label), ["@human"]);
	const oneFailedText = renderBootBlock({
		agentName: "root",
		modelName: "default",
		firstWindowId: "pcw:test:root",
		currentWindowId: "pcw:test:next",
		notes: oneFailed,
	});
	assert.ok(oneFailedText.includes("PROJECT_MAP_BODY") && oneFailedText.includes("## The human | @human\n： this drawer wouldn't open — ask notes_list to try again"), "healthy homes and a per-section recovery notice survive one failure");
	assert.equal(oneFailedText.includes("HUMAN_POCKET_BODY"), false, "the failed home's index is omitted");

	const allFailed = await loadNotesSnapshot(ctx, (_ctx, scope) => {
		throw readFailure(scope === "session" ? "EACCES" : "EIO");
	});
	assert.equal(allFailed.unavailable.length, 5);
	const allFailedText = renderBootBlock({
		agentName: "root",
		modelName: "default",
		firstWindowId: "pcw:test:root",
		currentWindowId: "pcw:test:next",
		previousWindowId: "pcw:test:root",
		notes: allFailed,
	});
	assert.ok(allFailedText.includes("pcw:test:root") && allFailedText.includes("pcw:test:next"), "identity survives an all-home failure");
	assert.ok(allFailedText.includes("Your memory resets whenever the context window fills"), "protocol survives an all-home failure");
	assert.equal(allFailedText.includes("scripted read failure"), false, "the model-facing notice does not expose OS/error details");
	await assert.rejects(
		() => loadNotesSnapshot(ctx, () => { throw new TypeError("programmer failure"); }),
		(error: unknown) => error instanceof TypeError,
		"unrelated TypeError construction failures remain visible",
	);
	await assert.rejects(
		() => loadNotesSnapshot(ctx, () => { throw Object.assign(new Error("invalid argument"), { code: "ERR_INVALID_ARG_TYPE" }); }),
		(error: unknown) => (error as NodeJS.ErrnoException).code === "ERR_INVALID_ARG_TYPE",
		"Node ERR_* failures are not treated as filesystem errno failures",
	);
});

test("the boot block gives awake agents the notes-home file layout", async () => {
	const session = manager();
	const rendered = await explicitBoot(context(session), "pcw:test:root", undefined);
	assert.equal(rendered.includes(process.env.PI_NOTES_HOME ?? ""), false, "the absolute notes home is never exposed");
	assert.match(rendered, /bare <vpath>[\s\S]*@project\/<vpath>[\s\S]*@human\/<vpath>/);
});

test("an over-budget note is delivered as a prefix and resumed by next_offset_chars", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const huge = `H${"x".repeat(TOOL_OUTPUT_MAX_BYTES * 2)}`;
	const text = `${huge}\ntail line`;
	await call(captured, "notes_write", { address: "huge.md", content: text }, ctx);
	const rawFirst = await call(captured, "notes_read", { address: "huge.md" }, ctx);
	assertWithinBudget(rawFirst, "single oversized note");
	const first = resultRead(rawFirst);
	assert.ok(first.content.length > 0, "the page is not empty");
	assert.equal(first.content.includes("…"), false, "the payload is a plain prefix with no marker");
	assert.ok(first.content.startsWith("---\n"), "the frontmatter is delivered first");
	assert.equal(first.header, `--- READ WINDOW ---\naddress: huge.md\nchars: [0,${first.next_offset_chars}) of ${first.total_chars}\nnext_offset_chars: ${first.next_offset_chars}\n`, "the raw block names the address, half-open range, and resume cursor");
	assert.deepEqual(Object.keys(first.details).sort(), ["address", "next_offset_chars", "offset_chars", "total_chars"], "notes_read details carries exactly the raw window address and cursor metadata");
	assert.equal("content" in first.details, false, "details never duplicates the payload");
	assert.equal(first.offset_chars, 0, "the default window starts at the resolved offset 0");
	// Following the cursor reconstructs frontmatter + body by plain concatenation.
	const parts = [first.content];
	let offset: number | null = first.next_offset_chars;
	while (offset !== null) {
		const rawChunk = await call(captured, "notes_read", { address: "huge.md", offset_chars: offset }, ctx);
		assertWithinBudget(rawChunk, `huge note chunk at ${offset}`);
		const chunk = resultRead(rawChunk);
		assert.equal(chunk.offset_chars, offset, "the response echoes the resolved absolute offset");
		parts.push(chunk.content);
		offset = chunk.next_offset_chars;
	}
	assert.ok(parts.join("").endsWith(text), "the cursors reconstruct the body exactly");

	// A success carries structured details; an error stays a JSON envelope with no details.
	const missingResult = await call(captured, "notes_read", { address: "no-such.md" }, ctx);
	const missing = resultJson<Record<string, unknown>>(missingResult);
	assert.deepEqual(Object.keys(missing).sort(), ["address", "error"], "the read error carries exactly error and address");
	assert.equal(missing.error, "note not found");
	assert.equal(missingResult.details, undefined, "a JSON error carries no details metadata");
});

test("an over-budget note search match is a named prefix with an honest line address", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	// The query sits behind a prefix, so its address is a real body-absolute offset, not line 1.
	const hugeLine = `${'p'.repeat(500)}needle ${"y".repeat(TOOL_OUTPUT_MAX_BYTES * 2)}`;
	await call(captured, "notes_write", { address: "a.md", content: "needle small" }, ctx);
	await call(captured, "notes_write", { address: "search.md", content: hugeLine }, ctx);
	const pages: Array<{ address: string; matches_total: number; matches: Array<{ line: number; text: string; truncated: boolean; offset_chars: number }> }> = [];
	const found = resultJson<{ files: Array<{ address: string; matches_total: number; matches: Array<{ line: number; text: string; truncated: boolean; offset_chars: number }> }>; more: number }>(
		await call(captured, "notes_search", { query: "needle", limit: 10 }, ctx),
	);
	assert.ok(Buffer.byteLength(JSON.stringify(found), "utf8") <= TOOL_OUTPUT_MAX_BYTES, "match result stays within budget");
	pages.push(...found.files);
	assert.equal(found.more, 1, "the oversized result names the omitted matching file");
	assert.deepEqual(pages.map((file) => file.address), ["search.md"], "the snapshot keeps the most recently updated match");
	const oversized = pages[0]!;
	assert.equal(oversized.matches_total, 1, "the file's full match count is named even though the line was cut");
	assert.equal(oversized.matches.length, 1);
	const match = oversized.matches[0]!;
	assert.equal(match.truncated, true, "the oversized match line is flagged as truncated");
	assert.ok(hugeLine.startsWith(match.text), "the match text is a plain prefix of the line");
	assert.equal(match.text.includes("…"), false, "no marker is appended to the match text");
	assert.equal(match.line, 1, "the informational line number survives");
	const atMatch = resultRead(await call(captured, "notes_read", { address: "search.md", offset_chars: match.offset_chars }, ctx));
	assert.ok(atMatch.content.startsWith("needle"), "the search offset starts a read at the matched substring");
	// The body is reconstructible by following notes_read's cursor from the start of the file.
	const parts: string[] = [];
	let offset: number | null = 0;
	while (offset !== null) {
		const rawChunk = await call(captured, "notes_read", { address: "search.md", offset_chars: offset }, ctx);
		assertWithinBudget(rawChunk, `search.md chunk at ${offset}`);
		const chunk = resultRead(rawChunk);
		assert.equal(chunk.offset_chars, offset, "the read echoes the resolved address");
		parts.push(chunk.content);
		offset = chunk.next_offset_chars;
	}
	assert.ok(parts.join("").endsWith(hugeLine), "resuming across pages reconstructs the matched body line");
});

test("notes_search scopes by glob pattern; a non-matching pattern is an empty page, not an error", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "deep/nested/a.md", content: "needle here" }, ctx);
	await call(captured, "notes_write", { address: "top.md", content: "needle there" }, ctx);
	const scoped = resultJson<{ files: Array<{ address: string }> }>(await call(captured, "notes_search", { query: "needle", pattern: "deep/**" }, ctx));
	assert.deepEqual(scoped.files.map((file) => file.address), ["deep/nested/a.md"], "a glob scopes the search to the subtree");
	const none = resultJson<{ files: unknown[]; error?: string }>(await call(captured, "notes_search", { query: "needle", pattern: "absent/**" }, ctx));
	assert.equal(none.error, undefined, "a non-matching pattern is not an error");
	assert.deepEqual(none.files, [], "a non-matching pattern is an empty page");
});
