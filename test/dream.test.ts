import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, failLock } from "../src/dream/lock.js";
import { materialGate, timeGate } from "../src/dream/gates.js";
import { defaultDreamerSessionFactory, memoryToolDefinitions, runDreamer, DREAMER_TOOLS } from "../src/dream/runner.js";

function fixture() { return mkdtempSync(join(tmpdir(), "dream-")); }
function old(path: string) { const d = new Date(Date.now() - 48 * 3600_000); utimesSync(path, d, d); }

test("time and material gates preserve skip decisions and reasons", () => {
	const home = fixture();
	const lock = join(home, ".dream.lock");
	writeFileSync(lock, "999999");
	const fresh = timeGate(lock, 24);
	assert.equal(fresh.ok, false);
	assert.equal(fresh.reason, "time gate: lock is too fresh");
	old(lock);
	assert.deepEqual(timeGate(lock, 24).ok, true);
	mkdirSync(join(home, "pi/session/one"), { recursive: true });
	writeFileSync(join(home, "pi/session/one/a.md"), "a");
	const material = materialGate(home, statSync(lock).mtimeMs, 1);
	assert.equal(material.ok, true);
	assert.match(material.reason, /material gate: 1 changed sessions/);
	assert.equal(materialGate(home, Date.now(), 2).ok, false);
});

test("live lock is excluded, dead lock is reclaimed, and failures restore mtime", () => {
	const home = fixture();
	const lock = join(home, ".dream.lock");
	writeFileSync(lock, String(process.pid));
	const live = acquireLock(lock);
	assert.equal(live.held, false);
	assert.equal(live.reason, "lock gate: live process holds the lock");
	writeFileSync(lock, "999999");
	old(lock);
	const prior = statSync(lock).mtimeMs;
	const reclaimed = acquireLock(lock);
	assert.equal(reclaimed.held, true);
	utimesSync(lock, new Date(), new Date());
	failLock(reclaimed);
	assert.ok(Math.abs(statSync(lock).mtimeMs - prior) < 2000);
});

test("real notes custom tools write and edit fixture files on disk", async () => {
	const home = fixture();
	process.env.PI_NOTES_HOME = home;
	const ctx = { cwd: home, sessionManager: { getSessionId: () => "dream" } } as any;
	const tools = new Map(memoryToolDefinitions().map((tool: any) => [tool.name, tool]));
	await tools.get("notes_write")!.execute("write", { path: "survivor.md", content: "one", scope: "session" }, undefined, undefined, ctx);
	await tools.get("notes_write")!.execute("write", { path: "absorbed.md", content: "two", scope: "session" }, undefined, undefined, ctx);
	await tools.get("notes_edit")!.execute("edit", { path: "survivor.md", edits: [{ oldText: "one", newText: "one\ntwo" }] }, undefined, undefined, ctx);
	await tools.get("notes_edit")!.execute("stale", { path: "absorbed.md", stale: true }, undefined, undefined, ctx);
	const survivor = readFileSync(join(home, "pi/session/dream/survivor.md"), "utf8");
	const absorbed = readFileSync(join(home, "pi/session/dream/absorbed.md"), "utf8");
	assert.match(survivor, /one\ntwo/);
	assert.match(absorbed, /stale: true/);
	assert.equal(existsSync(join(home, "pi/session/dream/survivor.md")), true);
	assert.equal(existsSync(join(home, "pi/session/dream/absorbed.md")), true);
});

test("dreamer allowlist contains only read tools and notes writes", async () => {
	let configured: string[] = [];
	const session = {
		subscribe(handler: (event: unknown) => void) { this.handler = handler; return () => {}; },
		handler: (_event: unknown) => {},
		async prompt(_text: string) { this.handler({ type: "tool_execution_start", toolName: "notes_write", args: { path: "a.md", scope: "global", stale: false } }); this.handler({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }); },
		dispose() {},
	};
	const result = await runDreamer("playbook", "/tmp/notes", { sessionFactory: async (options) => { configured = options.tools; return session as any; } });
	assert.deepEqual(configured, DREAMER_TOOLS);
	assert.equal(configured.includes("write"), false);
	assert.equal(configured.includes("edit"), false);
	assert.deepEqual(result.writes, [{ tool: "notes_write", path: "a.md", scope: "global", stale: false }]);
	assert.equal(result.report, "done");
});

test("provider errors propagate without parsing a response", async () => {
	const session = {
		subscribe(handler: (event: unknown) => void) { this.handler = handler; return () => {}; },
		handler: (_event: unknown) => {},
		async prompt(_text: string) { this.handler({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Insufficient Balance" } }); },
		dispose() {},
	};
	await assert.rejects(() => runDreamer("playbook", "/tmp/notes", { sessionFactory: async () => session as any }), /Insufficient Balance/);
});

test("default dreamer rejects an unresolvable model pattern", async () => {
	await assert.rejects(() => defaultDreamerSessionFactory({ cwd: "/tmp/notes", modelPattern: "definitely-not-a-real-model", tools: DREAMER_TOOLS }), /definitely-not-a-real-model/);
});
