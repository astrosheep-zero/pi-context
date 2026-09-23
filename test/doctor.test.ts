import assert from "node:assert/strict";
import { main } from "../src/dream/cli.js";
import { doctor } from "../src/dream/doctor.js";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const note = "---\norigin: self\nstatus: active\nstale: false\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\nlastAccessed: 2026-01-01T00:00:00Z\naccessCount: 0\n---\n\n";

test("doctor identifies legacy metadata as requiring manual migration", (t) => {
	const root = mkdtempSync(join(tmpdir(), "dream-doctor-legacy-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "human"));
	writeFileSync(join(root, "human/legacy.md"), note.replace("createdAt", "created_at"));
	const issues = doctor(root);
	assert.ok(issues.some((issue) => issue.includes("legacy metadata key created_at; manually migrate to createdAt")));
});

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
