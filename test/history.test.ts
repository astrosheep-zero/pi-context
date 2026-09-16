import assert from "node:assert/strict";
import test from "node:test";
import { resetV2WindowId, visibleItem } from "../src/history.js";

test("visibleItem counts the ellipsis within max_chars_per_item", () => {
	const item = visibleItem({ windowId: "w", itemId: "i", role: "user", content: "abcdef", createdAt: undefined }, 4);
	assert.equal(Array.from(item.truncated_content).length, 4);
	assert.equal(item.truncated_content, "abc…");
});
test("persisted reset IDs are opaque within the supported protocol version", () => {
	assert.equal(resetV2WindowId({ piContext: "reset-v2", windowId: "opaque-window-id" }), "opaque-window-id");
	assert.equal(resetV2WindowId({ piContext: "reset-v1", windowId: "opaque-window-id" }), undefined);
	assert.equal(resetV2WindowId({ piContext: "reset-v2", windowId: 123 }), undefined);
	assert.equal(resetV2WindowId(null), undefined);
});
