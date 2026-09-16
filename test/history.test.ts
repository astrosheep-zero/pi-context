import assert from "node:assert/strict";
import test from "node:test";
import { resetV2WindowId } from "../src/history.js";

test("persisted reset IDs are opaque within the supported protocol version", () => {
	assert.equal(resetV2WindowId({ piContext: "reset-v2", windowId: "opaque-window-id" }), "opaque-window-id");
	assert.equal(resetV2WindowId({ piContext: "reset-v1", windowId: "opaque-window-id" }), undefined);
	assert.equal(resetV2WindowId({ piContext: "reset-v2", windowId: 123 }), undefined);
	assert.equal(resetV2WindowId(null), undefined);
});
