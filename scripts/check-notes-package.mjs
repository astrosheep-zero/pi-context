// Exercise the intentional host-neutral notes entry; no old-package compatibility oracle.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotesStore } from "../dist/src/notes/index.js";

const home = mkdtempSync(join(tmpdir(), "notes-domain-"));
try {
	const notes = createNotesStore({ home, sessionId: "smoke", projectKey: "example-12345678", agent: "root", model: "test" });
	await notes.write("@project/hello.md", "hello", { origin: "user" });
	await notes.update("@project/hello.md", [{ oldText: "hello", newText: "hello world" }]);
	assert.equal((await notes.read("@project/hello.md"))?.body, "hello world");
	assert.equal((await notes.search(["world"]))[0]?.address, "@project/hello.md");
	console.log("Host-neutral notes entry: CRUD/search passed.");
} finally {
	rmSync(home, { recursive: true, force: true });
}
