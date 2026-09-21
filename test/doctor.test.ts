import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../src/dream/doctor.js";
import { main } from "../src/dream/cli.js";

const note = (body = "") => `---\norigin: self\nstatus: active\nstale: false\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\nlast_accessed: 2026-01-01T00:00:00Z\naccess_count: 0\n---\n\n${body}`;
const home = () => mkdtempSync(join(tmpdir(), "dream-doctor-"));

test("doctor validates note homes and references without changing files", async () => {
	const root = home();
	mkdirSync(join(root, "human"));
	writeFileSync(join(root, "human/a.md"), note());
	writeFileSync(join(root, "human/MAP.md"), note("- `a.md`\n- `@human/a.md`"));
	const before = readFileSync(join(root, "human/a.md"));
	assert.deepEqual(doctor(root), []);
	assert.equal(await main(["doctor", "--notes-home", root], { runDreamer: async () => { throw new Error("must not run"); } }), 0);
	assert.deepEqual(readFileSync(join(root, "human/a.md")), before);
	assert.deepEqual(readdirSync(root), ["human"]);
});

test("doctor reports layout, metadata, links and locks; never repairs", () => {
	const root = home();
	mkdirSync(join(root, "global"));
	mkdirSync(join(root, "project/bad"), { recursive: true });
	writeFileSync(join(root, "project/bad/MAP.md"), note("`missing.md` `@global/old.md`"));
	writeFileSync(join(root, "project/bad/broken.md"), "---\norigin: nope\n---\n");
	writeFileSync(join(root, ".dream.lock"), "garbage");
	symlinkSync(join(root, "project"), join(root, "project/bad/link"));
	const output = doctor(root).join("\n");
	for (const expected of ["legacy home", "invalid project key", "target missing", "invalid address", "invalid origin", "invalid created_at", "malformed lock", "symlink"]) assert.ok(output.includes(expected), expected);
	assert.equal(readFileSync(join(root, ".dream.lock"), "utf8"), "garbage");
	assert.ok(existsSync(join(root, "global")));
});

test("doctor reports missing homes without creating them, including CLI", async () => {
	const missing = join(home(), "absent");
	assert.equal(await main(["doctor", "--notes-home", missing]), 1);
	assert.equal(existsSync(missing), false);
});

test("doctor reports valid lock presence without claiming it is stale", () => {
	const root = home();
	writeFileSync(join(root, ".dream.lock"), "123 12345678-1234-1234-1234-123456789abc");
	assert.match(doctor(root).join("\n"), /lock present.*liveness not inferred/);
});
