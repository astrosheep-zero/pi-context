import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionReader } from "../src/session-reader.js";
import { BOOT_TYPE, RESET_MARKER_TYPE } from "../src/protocol.js";
import { contentText, historyFromSession, visibleItem } from "../src/history.js";
import { currentReset, currentWindowId, hasWindowMessage, isWindowMarker, rootWindowId } from "../src/context-window.js";

const timestamp = "2026-09-22T00:00:00.000Z";

function entry<T extends object>(id: string, value: T): SessionEntry {
	return { id, parentId: null, timestamp, ...value } as unknown as SessionEntry;
}

function textMessage(id: string, role: "user" | "assistant", text: string): SessionEntry {
	return entry(id, { type: "message", message: { role, content: [{ type: "text", text }] } });
}

function compaction(id: string, summary: string, details?: unknown): SessionEntry {
	return entry(id, { type: "compaction", summary, firstKeptEntryId: id, tokensBefore: 1, ...(details === undefined ? {} : { details }) });
}

function marker(id: string, windowId: string): SessionEntry {
	return entry(id, { type: "custom", customType: RESET_MARKER_TYPE, data: { windowId } });
}

function boot(id: string, windowId: string): SessionEntry {
	return entry(id, { type: "custom_message", customType: BOOT_TYPE, content: `boot ${windowId}`, details: { windowId }, display: false });
}

function reader(sessionId: string, branch: SessionEntry[], globalTail: SessionEntry[] = branch): SessionReader {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
			// Deliberately present only to prove history never falls back to a global tail.
			getEntries: () => globalTail,
		} as SessionReader["sessionManager"] & { getEntries: () => SessionEntry[] },
	};
}

test("visibleItem reports a plain fitting prefix and names the full length", () => {
	const item = visibleItem({ windowId: "w", itemId: "i", role: "user", content: "abcdef", createdAt: undefined }, 4);
	assert.equal(Array.from(item.truncated_content).length, 4);
	assert.equal(item.truncated_content, "abcd");
	assert.equal(item.truncated_content.includes("…"), false, "no marker is appended to the payload");
	assert.equal(item.truncated, true);
	assert.equal(item.total_chars, 6);
	const whole = visibleItem({ windowId: "w", itemId: "i", role: "user", content: "abcdef", createdAt: undefined }, 6);
	assert.equal(whole.truncated, false);
	assert.equal(whole.total_chars, 6);
	assert.equal(whole.truncated_content, "abcdef");
});
test("window markers are the only durable window boundary", () => {
	const valid = marker("marker", "opaque-window-id");
	assert.equal(isWindowMarker(valid), true);
	assert.equal(isWindowMarker(entry("wrong-type", { type: "custom", customType: "other/reset-marker", data: { windowId: "opaque-window-id" } })), false);
	assert.equal(isWindowMarker(entry("bad-data", { type: "custom", customType: RESET_MARKER_TYPE, data: { windowId: 123 } })), false);
	assert.equal(isWindowMarker(entry("empty-data", { type: "custom", customType: RESET_MARKER_TYPE, data: { windowId: "" } })), false);
	assert.equal(isWindowMarker(compaction("legacy", "legacy summary", { piContext: "reset-v2", windowId: "legacy-window" })), false);
});

test("text content projection and root window IDs have stable shared forms", () => {
	const content = [{ type: "text", text: "first" }, { type: "toolCall", name: "ignored" }, { type: "text", text: "second" }];
	assert.equal(contentText(content), "first\nsecond");
	assert.equal(rootWindowId("12345678-abcd"), "pcw:12345678:root");
});

test("history uses the active branch and retains pre-marker history", () => {
	const active = [
		textMessage("root-user", "user", "before reset"),
		compaction("native-summary", "native summary stays in the root window"),
		marker("marker-a", "window-a"),
		boot("boot-a", "window-a"),
		textMessage("after-a", "user", "after first reset"),
		marker("marker-b", "window-b"),
		boot("boot-b", "window-b"),
		textMessage("after-b", "assistant", "after second reset"),
	];
	const sibling = [marker("sibling-marker", "sibling-window"), textMessage("sibling-user", "user", "sibling branch")];
	const ctx = reader("12345678-session", active, [...active, ...sibling]);

	assert.equal(currentReset(ctx)?.data.windowId, "window-b");
	assert.equal(currentWindowId(ctx), "window-b");
	assert.equal(hasWindowMessage(ctx, BOOT_TYPE), true);

	const windows = historyFromSession(ctx);
	assert.deepEqual(windows.map((window) => window.windowId), ["pcw:12345678:root", "window-a", "window-b"]);
	assert.deepEqual(windows[0]?.items.map((item) => item.content), ["before reset", "native summary stays in the root window"]);
	assert.equal(windows[0]?.items.every((item) => item.windowId === "pcw:12345678:root"), true);
	assert.deepEqual(windows[1]?.items.map((item) => item.content), ["boot window-a", "after first reset"]);
	assert.deepEqual(windows[2]?.items.map((item) => item.content), ["boot window-b", "after second reset"]);
	assert.equal(windows.some((window) => window.items.some((item) => item.content === "sibling branch")), false);
	assert.equal(windows.some((window) => window.items.some((item) => item.content === "legacy summary")), false);
});

test("an empty later marker cannot replace the active valid boundary", () => {
	const active = [
		marker("marker-a", "window-a"),
		boot("boot-a", "window-a"),
		textMessage("after-a", "user", "after valid reset"),
		entry("empty-marker", { type: "custom", customType: RESET_MARKER_TYPE, data: { windowId: "" } }),
	];
	const ctx = reader("12345678-session", active);

	assert.equal(currentReset(ctx)?.data.windowId, "window-a");
	assert.equal(currentWindowId(ctx), "window-a");
	assert.deepEqual(historyFromSession(ctx).map((window) => window.windowId), ["pcw:12345678:root", "window-a"]);
});
