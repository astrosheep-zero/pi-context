import assert from "node:assert/strict";
import { main } from "../src/dream/cli.js";
import { doctor } from "../src/dream/doctor.js";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const note = "---\norigin: self\nstatus: active\nstale: false\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\nlast_accessed: 2026-01-01T00:00:00Z\naccess_count: 0\n---\n\n";

test("doctor validates without repairing files or running the dreamer", async () => {
	const root = mkdtempSync(join(tmpdir(), "dream-doctor-test-"));
	mkdirSync(join(root, "human"));
	writeFileSync(join(root, "human/a.md"), note);
	writeFileSync(join(root, "human/MAP.md"), `${note}- \`a.md\``);
	const before = readFileSync(join(root, "human/a.md"));
	assert.deepEqual(doctor(root), []);
	assert.equal(await main(["doctor", "--notes-home", root], { runDreamer: async () => { throw new Error("must not run"); } }), 0);
	assert.deepEqual(readFileSync(join(root, "human/a.md")), before);
	assert.deepEqual(readdirSync(root), ["human"]);
	const missing = join(root, "absent");
	assert.equal(await main(["doctor", "--notes-home", missing]), 1);
	assert.equal(existsSync(missing), false);
});
