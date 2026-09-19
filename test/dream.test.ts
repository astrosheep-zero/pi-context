import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, failLock } from "../src/dream/lock.js";
import { materialGate, timeGate } from "../src/dream/gates.js";
import { defaultDreamerSessionFactory, dreamerWriteToolDefinitions, runDreamer, DREAMER_TOOLS } from "../src/dream/runner.js";

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

test("dreamer write jail accepts home files and refuses escapes", async () => {
	const home = fixture();
	const tools = new Map(dreamerWriteToolDefinitions(home).map((tool) => [tool.name, tool]));
	const ctx = { cwd: home } as any;
	await tools.get("write")!.execute("write", { path: "global/x.md", content: "one" }, undefined, undefined, ctx);
	assert.equal(readFileSync(join(home, "global/x.md"), "utf8"), "one");

	const rejectsOutsideHome = async (tool: "write" | "edit", path: string) => {
		const params = tool === "write" ? { path, content: "outside" } : { path, edits: [{ oldText: "one", newText: "outside" }] };
		await assert.rejects(() => tools.get(tool)!.execute("escape", params as any, undefined, undefined, ctx), (error: Error) => error.message.includes(home));
	};
	for (const tool of ["write", "edit"] as const) {
		await rejectsOutsideHome(tool, "/tmp/dream-jail-outside.md");
		await rejectsOutsideHome(tool, "../dream-jail-outside.md");
	}

	const outside = fixture();
	symlinkSync(outside, join(home, "escape"));
	await rejectsOutsideHome("write", "escape/outside.md");
	await rejectsOutsideHome("edit", "escape/outside.md");
	assert.equal(existsSync(join(outside, "outside.md")), false, "the jail does not write through an in-home symlink");

	const outsideFile = join(outside, "outside.md");
	writeFileSync(outsideFile, "outside");
	symlinkSync(outsideFile, join(home, "global/outside-link.md"));
	await rejectsOutsideHome("write", "global/outside-link.md");
	assert.equal(readFileSync(outsideFile, "utf8"), "outside", "the jail does not write through a symlinked file outside home");

	linkSync(outsideFile, join(home, "global/hardlink.md"));
	await rejectsOutsideHome("write", "global/hardlink.md");
	assert.equal(readFileSync(outsideFile, "utf8"), "outside", "the jail does not write through a hardlinked file outside home");

	const insideFile = join(home, "global/inside.md");
	writeFileSync(insideFile, "inside");
	symlinkSync(insideFile, join(home, "global/inside-link.md"));
	await tools.get("write")!.execute("write", { path: "global/inside-link.md", content: "updated" }, undefined, undefined, ctx);
	assert.equal(readFileSync(insideFile, "utf8"), "updated", "the jail permits a symlinked file that resolves inside home");
});

test("dreamer allowlist contains only the file tools and reports their writes", async () => {
	let configured: string[] = [];
	const session = {
		subscribe(handler: (event: unknown) => void) { this.handler = handler; return () => {}; },
		handler: (_event: unknown) => {},
		async prompt(_text: string) { this.handler({ type: "tool_execution_start", toolName: "write", args: { path: "global/a.md", content: "a" } }); this.handler({ type: "tool_execution_start", toolName: "edit", args: { path: "project/p.md", edits: [] } }); this.handler({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }); },
		dispose() {},
	};
	const result = await runDreamer("playbook", "/tmp/notes", { sessionFactory: async (options) => { configured = options.tools; return session as any; } });
	assert.deepEqual(configured, DREAMER_TOOLS);
	assert.deepEqual(configured, ["read", "grep", "find", "ls", "write", "edit"]);
	assert.equal(configured.some((tool) => tool.startsWith("notes_")), false);
	assert.deepEqual(result.writes, [{ tool: "write", path: "global/a.md" }, { tool: "edit", path: "project/p.md" }]);
	assert.equal(result.report, "done");
});

test("dreamer session has exactly the jailed file-tool allowlist", async () => {
	const session = await defaultDreamerSessionFactory({ cwd: fixture(), tools: DREAMER_TOOLS });
	try {
		assert.deepEqual((session as any).agent.state.tools.map((tool: { name: string }) => tool.name).sort(), [...DREAMER_TOOLS].sort());
	} finally {
		session.dispose();
	}
});

test("playbook describes plain files and the retained frontmatter", () => {
	const playbook = readFileSync(join(process.cwd(), "playbook.md"), "utf8");
	assert.equal(playbook.includes("notes_"), false);
	for (const field of ["origin", "status", "stale", "created_at", "updated_at", "last_accessed", "access_count"]) assert.match(playbook, new RegExp(`^${field}:`, "m"));
	assert.equal(/^scope:/m.test(playbook), false, "scope is derived from the address rather than persisted");
	assert.match(playbook, /Nothing is physically deleted/);
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
