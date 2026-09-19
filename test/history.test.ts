import assert from "node:assert/strict";
import test from "node:test";
import { contentText, resetV2WindowId, rootWindowId, visibleItem } from "../src/history.js";

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
test("persisted reset IDs are opaque within the supported protocol version", () => {
	assert.equal(resetV2WindowId({ piContext: "reset-v2", windowId: "opaque-window-id" }), "opaque-window-id");
	assert.equal(resetV2WindowId({ piContext: "reset-v1", windowId: "opaque-window-id" }), undefined);
	assert.equal(resetV2WindowId({ piContext: "reset-v2", windowId: 123 }), undefined);
	assert.equal(resetV2WindowId(null), undefined);
});

test("text content projection and root window IDs have stable shared forms", () => {
	const content = [{ type: "text", text: "first" }, { type: "toolCall", name: "ignored" }, { type: "text", text: "second" }];
	assert.equal(contentText(content), "first\nsecond");
	assert.equal(rootWindowId("12345678-abcd"), "pcw:12345678:root");
});
