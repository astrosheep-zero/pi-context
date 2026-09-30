import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadNotesSnapshot } from "../src/boot/snapshot.js";
import { renderBootBlock } from "../src/boot/render.js";
import { deriveThresholds, remainingBudget } from "../src/budget/policy.js";
import { projectHistory } from "../src/history/history.js";
import type { NotesIdentity } from "../src/notes/identity.js";
import { notesWrite, notesUpdate, notesRead } from "../src/tools/notes.js";
import { historyList, historyRead, historySearch } from "../src/tools/history.js";

function identity(t: test.TestContext): NotesIdentity {
	const home = mkdtempSync(join(tmpdir(), "host-neutral-notes-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return { home, sessionId: "explicit-session", projectKey: "explicit-12345678", agent: "explicit-agent", model: "explicit-model" };
}

test("shared boot uses only explicit identity, loader, captured time and logical tool bindings", async (t) => {
	const notesIdentity = identity(t);
	const openedAt = 1_700_000_000_000;
	const scopes: string[] = [];
	const snapshot = await loadNotesSnapshot(notesIdentity, openedAt, (scope) => {
		scopes.push(scope);
		if (scope === "human") throw Object.assign(new Error("unavailable"), { code: "EIO" });
		return scope === "session" ? [{ address: "checkpoint.md", path: "checkpoint.md", scope, body: "😀", sizeBytes: 4, meta: { scope, origin: "self", createdAt: openedAt, updatedAt: openedAt - 60_000, lastAccessed: openedAt, accessCount: 0 } }] : [];
	});
	assert.deepEqual(scopes, ["session", "project", "human", "agent", "model"]);
	assert.equal(snapshot.openedAt, openedAt);
	const tools = { notes: "memo_*", notesList: "memo_list", history: "archive_*", historyList: "archive_list", historySearch: "archive_search", historyRead: "archive_read", remaining: "room", wipe: "forget" };
	const data = { agentName: notesIdentity.agent, modelName: notesIdentity.model, firstWindowId: "root", currentWindowId: "next", notes: snapshot, tools };
	const rendered = renderBootBlock(data);
	assert.equal(renderBootBlock(data), rendered);
	assert.ok(rendered.includes("- checkpoint.md | 1 chars | 1m ago"));
	for (const name of Object.values(tools)) assert.ok(rendered.includes(name), `renders explicit binding ${name}`);
	assert.ok(rendered.includes("ask memo_list to try again"));
	assert.equal(/notes_\*|notes_list|history_\*|history_list|history_search|history_read|get_context_remaining|wipe_memory/.test(rendered), false);
});

test("shared note business handlers run against explicit identity with a caller-supplied diff renderer", async (t) => {
	const notesIdentity = identity(t);
	const written = await notesWrite.execute({ address: "@project/test.md", content: "alpha" }, notesIdentity);
	assert.deepEqual(JSON.parse(written.content[0]!.text), { address: "@project/test.md", project_key: notesIdentity.projectKey, outcome: "created" });
	const updated = await notesUpdate.execute({ address: "@project/test.md", edits: [{ oldText: "alpha", newText: "beta" }] }, notesIdentity, (change) => {
		assert.deepEqual(change, { kind: "body", before: "alpha", after: "beta" });
		return "caller-rendered-diff";
	});
	assert.equal(JSON.parse(updated.content[0]!.text).diff, "caller-rendered-diff");
	const read = await notesRead.execute({ address: "@project/test.md" }, notesIdentity);
	assert.match(read.content[0]!.text, /READ WINDOW[\s\S]*beta$/);
});

test("shared history pairs already-decoded events and honors supplied stable addresses and visibility", async () => {
	const windowId = "native-allocated-window";
	const projection = projectHistory([{ windowId, items: [
		{ seq: 2, windowId, role: "user", content: "hello", createdAt: undefined },
		{ seq: 5, windowId, role: "tool_call", content: '{"path":"one"}', toolName: "read", toolCallId: "call", createdAt: undefined },
		{ seq: 6, windowId, role: "tool", content: "😀 needle", toolName: "read", toolCallId: "call", createdAt: undefined },
		{ seq: 9, windowId, role: "assistant", content: "done", createdAt: undefined },
	] }], 12, new Set([2, 5, 6, 9]));
	assert.deepEqual([...projection.resultAliases], [[6, 5]]);
	assert.deepEqual(projection.windows[0]!.items.map((item) => item.seq), [2, 5, 9], "projection does not allocate or renumber native addresses");
	const listed = JSON.parse((await historyList.execute({}, projection)).content[0]!.text);
	assert.ok(listed.items.some((item: { folded?: boolean; count?: number }) => item.folded && item.count === 1));
	const searched = JSON.parse((await historySearch.execute({ query: "NEEDLE" }, projection)).content[0]!.text);
	assert.equal(searched.items[0].seq, 5);
	assert.ok(searched.items[0].offset_chars > 0);
	assert.equal((await historyRead.execute({ seq: 6 }, projection)).content[0]!.text, (await historyRead.execute({ seq: 5 }, projection)).content[0]!.text, "old result seq aliases the paired event");
	assert.match((await historyRead.execute({ seq: 12 }, projection)).content[0]!.text, /another branch/);
	assert.match((await historyRead.execute({ seq: 13 }, projection)).content[0]!.text, /unknown seq/);
});

test("shared budget policy preserves the invisible warning runway and unknown countdown", () => {
	const { thresholds } = deriveThresholds(16_384, {});
	assert.deepEqual(thresholds, { reminder: 40_960, reserve: 16_384, warning: 28_672 });
	assert.equal(remainingBudget(null, thresholds.warning), null);
	assert.equal(remainingBudget(thresholds.warning + 1, thresholds.warning), 1);
	assert.equal(remainingBudget(thresholds.reserve, thresholds.warning), 0);
	assert.equal(deriveThresholds(16_384, { reminderMarginTokens: 0 }).warnings.length, 1);
});
