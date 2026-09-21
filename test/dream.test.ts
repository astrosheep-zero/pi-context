import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, failLock, lastRunPath, releaseLock } from "../src/dream/lock.js";
import { materialGate, timeGate } from "../src/dream/gates.js";
import { defaultDreamerSessionFactory, dreamerWriteToolDefinitions, runDreamer, DREAMER_TOOLS, type DreamerSession, type DreamerSessionFactory } from "../src/dream/runner.js";
import { gitCommit } from "../src/dream/git.js";
import { main } from "../src/dream/cli.js";
import { deriveDreamer, mergePiContextSettings, readDreamerSettings } from "../src/thresholds.js";
import { PI_CONTEXT_DREAMER_KEY, PI_CONTEXT_SETTINGS_KEY } from "../src/protocol.js";
import { contentText } from "../src/history.js";

function fixture() { return mkdtempSync(join(tmpdir(), "dream-")); }
function old(path: string) { const d = new Date(Date.now() - 48 * 3600_000); utimesSync(path, d, d); }

/** A session whose prompt runs a scripted interaction with the recorded event handler. */
function scriptedSession(run: (handler: (event: any) => void, cwd: string) => void): DreamerSessionFactory {
	return async ({ cwd }) => {
		let handler: (event: any) => void = () => {};
		const session: DreamerSession = {
			subscribe(next: (event: any) => void) { handler = next; return () => {}; },
			async prompt() { run(handler, cwd); },
			dispose() {},
		};
		return session;
	};
}

function successSession(): DreamerSessionFactory {
	return scriptedSession((handler) => handler({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }));
}

/** Capture console.error lines without letting CLI chatter pollute the test output. */
async function captureErrors(run: () => Promise<number>): Promise<{ code: number; errors: string[] }> {
	const errors: string[] = [];
	const original = console.error;
	console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
	try { return { code: await run(), errors }; } finally { console.error = original; }
}

test("time and material gates preserve skip decisions and reasons", () => {
	const home = fixture();
	const lock = join(home, ".dream.lock");
	const stamp = lastRunPath(lock);
	assert.deepEqual(timeGate(stamp, 24).ok, true, "no prior dream passes");
	writeFileSync(stamp, new Date().toISOString());
	const fresh = timeGate(stamp, 24);
	assert.equal(fresh.ok, false);
	assert.equal(fresh.reason, "time gate: last dream is too recent");
	old(stamp);
	assert.equal(timeGate(stamp, 24).ok, true);
	mkdirSync(join(home, "pi/session/one"), { recursive: true });
	writeFileSync(join(home, "pi/session/one/a.md"), "a");
	const material = materialGate(home, statSync(stamp).mtimeMs, 1);
	assert.equal(material.ok, true);
	assert.match(material.reason, /material gate: 1 changed sessions/);
	assert.equal(materialGate(home, Date.now(), 2).ok, false);
	// The lock file's own mtime no longer carries the scheduler timestamp.
	writeFileSync(lock, "1");
	old(lock);
	assert.equal(timeGate(stamp, 24).ok, true, "the sidecar survives an old lock file");
});

test("failure restores the last-run timestamp and cleanup is idempotent", () => {
	const home = fixture();
	const lock = join(home, ".dream.lock");
	const stamp = lastRunPath(lock);
	writeFileSync(stamp, new Date(Date.now() - 48 * 3600_000).toISOString());
	old(stamp);
	const prior = statSync(stamp).mtimeMs;
	const held = acquireLock(lock);
	assert.equal(held.held, true);
	assert.equal(readFileSync(lock, "utf8").trim(), `${process.pid} ${held.token}`, "the lock records its owner and token");
	assert.ok(statSync(stamp).mtimeMs > prior + 1000, "a held lock advances the last-run sidecar, not itself");
	failLock(held);
	assert.equal(held.held, false, "failure marks the state released");
	assert.ok(Math.abs(statSync(stamp).mtimeMs - prior) < 2000, "a failed run restores the last-run timestamp");
	assert.equal(existsSync(lock), false, "a failed run releases its lock");
	// Repeated cleanup on an already-released state is harmless.
	const settled = statSync(stamp).mtimeMs;
	failLock(held);
	releaseLock(held);
	assert.ok(Math.abs(statSync(stamp).mtimeMs - settled) < 1000, "repeated failure cleanup changes nothing");

	const released = acquireLock(lock);
	assert.equal(released.held, true);
	releaseLock(released);
	releaseLock(released);
	assert.equal(released.held, false, "release marks the state released");
	assert.equal(existsSync(lock), false, "release removes the PID marker");
	assert.equal(existsSync(stamp), true, "the timestamp sidecar survives release");
});

test("any existing lock refuses acquisition and is left byte-identical", () => {
	const home = fixture();
	const lock = join(home, ".dream.lock");
	const stamp = lastRunPath(lock);
	const markers = [
		`${process.pid} live-owner`, // a live owner's marker
		"999999",                    // a dead PID
		"999999 dead-token",         // a dead PID with a token
		"",                          // empty
		"not-a-pid",                 // malformed
	];
	for (const marker of markers) {
		writeFileSync(lock, marker);
		old(lock);
		const result = acquireLock(lock);
		assert.equal(result.held, false, `refuses an existing marker ${JSON.stringify(marker)}`);
		assert.equal(result.reason, "lock gate: lock already exists");
		assert.equal(readFileSync(lock, "utf8"), marker, "the existing marker is byte-identical");
	}
	assert.equal(existsSync(stamp), false, "a refused acquisition writes no timestamp");
});

test("an acquired lock blocks every later contender until released", () => {
	const home = fixture();
	const lock = join(home, ".dream.lock");
	const first = acquireLock(lock);
	assert.equal(first.held, true);
	const second = acquireLock(lock);
	assert.equal(second.held, false);
	assert.equal(second.reason, "lock gate: lock already exists");
	assert.equal(readFileSync(lock, "utf8").trim(), `${process.pid} ${first.token}`, "the holder's marker is untouched");
});

test("cleanup never removes a successor's lock, even repeated", () => {
	const home = fixture();
	const lock = join(home, ".dream.lock");
	const stamp = lastRunPath(lock);
	const mine = acquireLock(lock);
	assert.equal(mine.held, true);
	// A successor acquires after ours is externally gone (human/supported protocol).
	unlinkSync(lock);
	const successor = acquireLock(lock);
	assert.equal(successor.held, true);
	const successorStamp = Date.now() - 5000;
	utimesSync(stamp, new Date(), new Date(successorStamp));
	failLock(mine);
	releaseLock(mine);
	assert.equal(mine.held, false, "the old state is marked released by the first cleanup");
	assert.equal(readFileSync(lock, "utf8").trim(), `${process.pid} ${successor.token}`, "the successor's lock survives");
	assert.ok(Math.abs(statSync(stamp).mtimeMs - successorStamp) < 1000, "the successor's timestamp survives");
});

/** Each child makes one actual acquisition attempt; a holder stays alive so later attempts see it. */
async function acquireRaceOutcomes(lock: string, contenders: number): Promise<string[]> {
	const moduleUrl = new URL("../src/dream/lock.js", import.meta.url).href;
	const script = [
		`import { acquireLock, releaseLock } from ${JSON.stringify(moduleUrl)};`,
		`const result = acquireLock(${JSON.stringify(lock)});`,
		`if (result.held) await new Promise((resolve) => setTimeout(resolve, 1200));`,
		`process.stdout.write(result.held ? "held" : "lost");`,
		`if (result.held) releaseLock(result);`,
	].join("\n");
	const contender = () => new Promise<string>((resolve, reject) => {
		execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
	});
	return Promise.all(Array.from({ length: contenders }, contender));
}

test("concurrent acquisitions of an absent lock yield exactly one held:true", async () => {
	const home = fixture();
	const lock = join(home, ".dream.lock");
	assert.equal(existsSync(lock), false, "the lock starts absent");
	const outcomes = await acquireRaceOutcomes(lock, 8);
	assert.equal(outcomes.filter((outcome) => outcome === "held").length, 1, "exactly one actual held:true return");
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

	// The jail has no `.git` special case: an in-home `.git` path is written like any other.
	await tools.get("write")!.execute("write", { path: ".git/config", content: "not protected" }, undefined, undefined, ctx);
	assert.equal(readFileSync(join(home, ".git/config"), "utf8"), "not protected", "the dream write jail does not protect .git");
});

test("dreamer allowlist contains only the file tools and reports their writes", async () => {
	let configured: string[] = [];
	const session = {
		subscribe(handler: (event: unknown) => void) { this.handler = handler; return () => {}; },
		handler: (_event: unknown) => {},
		async prompt(_text: string) { this.handler({ type: "tool_execution_start", toolName: "write", args: { path: "global/a.md", content: "a" } }); this.handler({ type: "tool_execution_start", toolName: "edit", args: { path: "project/p.md", edits: [] } }); this.handler({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }, { type: "text", text: "again" }] } }); },
		dispose() {},
	};
	const result = await runDreamer("playbook", "/tmp/notes", { sessionFactory: async (options) => { configured = options.tools; return session as any; } });
	assert.deepEqual(configured, DREAMER_TOOLS);
	assert.deepEqual(configured, ["read", "grep", "find", "ls", "write", "edit"]);
	assert.equal(configured.some((tool) => tool.startsWith("notes_")), false);
	assert.deepEqual(result.writes, [{ tool: "write", path: "global/a.md" }, { tool: "edit", path: "project/p.md" }]);
	assert.equal(result.report, "done\nagain");
	assert.equal(result.report, contentText([{ type: "text", text: "done" }, { type: "text", text: "again" }]), "dream and history share the text projection");
	assert.equal(result.error, undefined);
});

test("dreamer session has exactly the jailed file-tool allowlist", async () => {
	const session = await defaultDreamerSessionFactory({ cwd: fixture(), tools: DREAMER_TOOLS });
	try {
		assert.deepEqual((session as any).agent.state.tools.map((tool: { name: string }) => tool.name).sort(), [...DREAMER_TOOLS].sort());
	} finally {
		session.dispose();
	}
});

test("playbook describes plain files, retained frontmatter, and the read-only session WAL", () => {
	const playbook = readFileSync(join(process.cwd(), "playbook.md"), "utf8");
	assert.equal(playbook.includes("notes_"), false);
	for (const field of ["origin", "status", "stale", "created_at", "updated_at", "last_accessed", "access_count"]) assert.match(playbook, new RegExp(`^${field}:`, "m"));
	assert.equal(/^scope:/m.test(playbook), false, "scope is derived from the address rather than persisted");
	assert.match(playbook, /`pi\/session\/\*\*` is a live agent's write-ahead log/);
	assert.match(playbook, /never write or edit anything there/);
	assert.match(playbook, /Session notes remain untouched even when promoted/);
	assert.match(playbook, /Nothing is physically deleted/);
});

test("CLI finds its package root when the installed file URL contains spaces", () => {
	const install = mkdtempSync(join(tmpdir(), "dream install "));
	const home = fixture();
	try {
		cpSync(join(process.cwd(), "dist/src"), join(install, "dist/src"), { recursive: true });
		symlinkSync(join(process.cwd(), "node_modules"), join(install, "node_modules"), process.platform === "win32" ? "junction" : "dir");
		cpSync(join(process.cwd(), "playbook.md"), join(install, "playbook.md"));
		writeFileSync(join(install, "package.json"), JSON.stringify({ type: "module" }));
		const result = spawnSync(process.execPath, [join(install, "dist/src/dream/cli.js"), "--notes-home", home, "--force", "--dreamer", "definitely-not-a-real-model"], { encoding: "utf8" });
		assert.equal(result.status, 1, result.stderr);
		assert.doesNotMatch(result.stderr, /could not locate installed package root/);
		assert.match(result.stderr, /definitely-not-a-real-model/);
	} finally {
		rmSync(install, { recursive: true, force: true });
	}
});

test("provider errors are reported with partial writes instead of parsing a response", async () => {
	const factory = scriptedSession((handler) => {
		handler({ type: "tool_execution_start", toolName: "write", args: { path: "global/partial.md", content: "half" } });
		handler({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Insufficient Balance" } });
	});
	const result = await runDreamer("playbook", "/tmp/notes", { sessionFactory: factory });
	assert.match(result.error ?? "", /Insufficient Balance/);
	assert.deepEqual(result.writes, [{ tool: "write", path: "global/partial.md" }]);
});

test("default dreamer rejects an unresolvable model pattern", async () => {
	await assert.rejects(() => defaultDreamerSessionFactory({ cwd: "/tmp/notes", modelPattern: "definitely-not-a-real-model", tools: DREAMER_TOOLS }), /definitely-not-a-real-model/);
});

test("git audit layer commits baseline and dream, stays silent when clean, keeps file content", () => {
	const home = fixture();
	writeFileSync(join(home, "a.md"), "one");
	const baseline = gitCommit(home, "baseline t");
	assert.equal(baseline.ok, true);
	const clean = gitCommit(home, "dream t"); // clean tree — no empty commit
	assert.equal(clean.ok, true);
	assert.equal(clean.empty, true);
	const log1 = execFileSync("git", ["log", "--format=%s"], { cwd: home, encoding: "utf8" }).trim();
	assert.equal(log1, "baseline t");
	writeFileSync(join(home, "a.md"), "two");
	const second = gitCommit(home, "dream t2");
	assert.equal(second.ok, true);
	assert.equal(second.empty, false);
	const log2 = execFileSync("git", ["log", "--format=%s"], { cwd: home, encoding: "utf8" }).trim();
	assert.equal(log2, "dream t2\nbaseline t");
	assert.equal(readFileSync(join(home, "a.md"), "utf8"), "two"); // notes themselves untouched by the layer
	const before = execFileSync("git", ["show", "HEAD~1:a.md"], { cwd: home, encoding: "utf8" }).trim();
	assert.equal(before, "one"); // rollback information actually recorded
});

test("git audit layer gives a newly initialized empty repository a real baseline snapshot", () => {
	const home = fixture();
	const baseline = gitCommit(home, "baseline empty");
	assert.equal(baseline.ok, true);
	if (baseline.ok) {
		assert.notEqual(baseline.commit, "", "the baseline carries a real commit, not an empty marker");
		assert.equal(baseline.empty, true, "no files changed");
	}
	assert.equal(execFileSync("git", ["log", "--format=%s"], { cwd: home, encoding: "utf8" }).trim(), "baseline empty");
});

test("git audit layer reports its failure instead of swallowing it", () => {
	const missing = gitCommit(join(fixture(), "missing", "home"), "x");
	assert.equal(missing.ok, false);
	const broken = fixture();
	writeFileSync(join(broken, ".git"), "not a git directory");
	const result = gitCommit(broken, "x");
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.error.length > 0, "the audit failure names its cause");
});

test("CLI: a failed final audit is recorded in the report and in the exit status", async () => {
	const home = fixture();
	const sessionFactory = scriptedSession((_handler, cwd) => {
		mkdirSync(join(cwd, "global"), { recursive: true });
		writeFileSync(join(cwd, "global/ok.md"), "ok");
		// Break the repository after the baseline so only the final audit fails.
		rmSync(join(cwd, ".git"), { recursive: true, force: true });
		writeFileSync(join(cwd, ".git"), "broken");
	});
	const { code, errors } = await captureErrors(() => main(["--notes-home", home, "--force"], { sessionFactory, dreamerSettings: () => ({ warnings: [] }) }));
	assert.notEqual(code, 0, "a dream with no final snapshot is not a success");
	assert.ok(errors.some((line) => /final audit failed/.test(line)), "the audit failure is named");
	const reports = readdirSync(join(home, "dreams"));
	assert.equal(reports.length, 1);
	assert.match(readFileSync(join(home, "dreams", reports[0]!), "utf8"), /Final audit failed/, "the success report records the audit failure");
});

test("CLI: a report-write failure does not prevent the final failure audit", async () => {
	const home = fixture();
	writeFileSync(join(home, "dreams"), "not a directory");
	const sessionFactory = scriptedSession((handler, cwd) => {
		mkdirSync(join(cwd, "global"), { recursive: true });
		writeFileSync(join(cwd, "global/partial.md"), "half");
		handler({ type: "tool_execution_start", toolName: "write", args: { path: "global/partial.md", content: "half" } });
		handler({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Insufficient Balance" } });
	});
	const { code, errors } = await captureErrors(() => main(["--notes-home", home, "--force"], { sessionFactory, dreamerSettings: () => ({ warnings: [] }) }));
	assert.notEqual(code, 0);
	assert.ok(errors.some((line) => /could not write report/.test(line)), "the report failure is surfaced");
	assert.match(execFileSync("git", ["log", "--format=%s"], { cwd: home, encoding: "utf8" }).trim(), /\(failed\)/, "the final failure audit still ran");
	assert.equal(execFileSync("git", ["show", "HEAD:global/partial.md"], { cwd: home, encoding: "utf8" }), "half", "the partial write is still committed");
});

test("CLI: an unwritable report is a failure even when the dreamer succeeds", async () => {
	const home = fixture();
	writeFileSync(join(home, "dreams"), "not a directory");
	const { code, errors } = await captureErrors(() => main(["--notes-home", home, "--force"], { sessionFactory: successSession(), dreamerSettings: () => ({ warnings: [] }) }));
	assert.notEqual(code, 0, "a missing report is not a success");
	assert.ok(errors.some((line) => /could not write report/.test(line)), "the report failure is surfaced");
	assert.notEqual(execFileSync("git", ["log", "--format=%s"], { cwd: home, encoding: "utf8" }).trim(), "", "the final audit still ran");
});

test("CLI: a failed baseline audit aborts before the dreamer and preserves the notes bytes", async () => {
	const home = fixture();
	writeFileSync(join(home, "keep.md"), "keep me");
	writeFileSync(join(home, ".git"), "not a git directory"); // every git command fails
	let started = false;
	const { code } = await captureErrors(() => main(["--notes-home", home, "--force"], {
		sessionFactory: async () => { started = true; return {} as DreamerSession; },
		dreamerSettings: () => ({ warnings: [] }),
	}));
	assert.notEqual(code, 0, "a missing baseline is a failed run");
	assert.equal(started, false, "the dreamer never starts without a baseline");
	assert.equal(readFileSync(join(home, "keep.md"), "utf8"), "keep me", "the notes bytes survive");
	assert.equal(existsSync(join(home, "dreams")), false, "no dream report is written");
});

test("CLI: a dreamer failure records the failure and the partial write in a final commit", async () => {
	const home = fixture();
	const sessionFactory = scriptedSession((handler, cwd) => {
		mkdirSync(join(cwd, "global"), { recursive: true });
		writeFileSync(join(cwd, "global/partial.md"), "half");
		handler({ type: "tool_execution_start", toolName: "write", args: { path: "global/partial.md", content: "half" } });
		handler({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Insufficient Balance" } });
	});
	const { code } = await captureErrors(() => main(["--notes-home", home, "--force"], { sessionFactory, dreamerSettings: () => ({ warnings: [] }) }));
	assert.notEqual(code, 0);
	const reports = readdirSync(join(home, "dreams"));
	assert.equal(reports.length, 1, "one failure report");
	const report = readFileSync(join(home, "dreams", reports[0]!), "utf8");
	assert.match(report, /Insufficient Balance/, "the report contains the failure");
	assert.match(report, /global\/partial\.md/, "the report names the partial write");
	const log = execFileSync("git", ["log", "--format=%s"], { cwd: home, encoding: "utf8" }).trim();
	assert.match(log, /\(failed\)/, "the partial state is committed as a failure");
	assert.equal(execFileSync("git", ["show", "HEAD:global/partial.md"], { cwd: home, encoding: "utf8" }), "half");
});

test("CLI: a successful run commits its report and leaves the audited tree clean", async () => {
	const home = fixture();
	writeFileSync(join(home, "seed.md"), "seed");
	const { code } = await captureErrors(() => main(["--notes-home", home, "--force"], { sessionFactory: successSession(), dreamerSettings: () => ({ warnings: [] }) }));
	assert.equal(code, 0);
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: home, encoding: "utf8" }).trim(), "", "the audited tree is clean after the lock is released");
	const tracked = execFileSync("git", ["ls-files"], { cwd: home, encoding: "utf8" }).trim().split("\n");
	assert.equal(tracked.some((file) => file.startsWith(".dream.lock")), false, "lock artifacts stay out of the snapshot");
	assert.equal(tracked.includes("seed.md"), true);
});

test("CLI: --force does not bypass an existing lock", async () => {
	const home = fixture();
	writeFileSync(join(home, ".dream.lock"), "999999 dead-owner");
	let started = false;
	const { code } = await captureErrors(() => main(["--notes-home", home, "--force"], {
		sessionFactory: async () => { started = true; return {} as DreamerSession; },
		dreamerSettings: () => ({ warnings: [] }),
	}));
	assert.equal(code, 0, "an existing lock skips the run rather than failing");
	assert.equal(started, false, "--force never reaches the dreamer while the lock exists");
	assert.equal(readFileSync(join(home, ".dream.lock"), "utf8"), "999999 dead-owner", "the existing lock is byte-identical");
	assert.equal(existsSync(join(home, "dreams")), false, "no dream report is written");
});

test("dreamer setting is a non-empty string; project overrides global; invalid values warn and fall back", () => {
	assert.deepEqual(deriveDreamer({}), { warnings: [] }, "absent setting falls back silently");
	assert.deepEqual(deriveDreamer({ dreamer: "openai/gpt-x" }), { pattern: "openai/gpt-x", warnings: [] });
	const merged = mergePiContextSettings(
		{ [PI_CONTEXT_SETTINGS_KEY]: { [PI_CONTEXT_DREAMER_KEY]: "global/model" } },
		{ [PI_CONTEXT_SETTINGS_KEY]: { [PI_CONTEXT_DREAMER_KEY]: "project/model" } },
	);
	assert.equal(deriveDreamer(merged).pattern, "project/model", "project wins per key");
	for (const invalid of ["", "   ", 42, null]) {
		const result = deriveDreamer({ dreamer: invalid });
		assert.equal(result.pattern, undefined, `invalid ${JSON.stringify(invalid)} is ignored`);
		assert.equal(result.warnings.length, 1, "one warning per invalid value");
		assert.match(result.warnings[0]!, /dreamer/);
	}
});

test("readDreamerSettings reads the project setting over the global one through SettingsManager", () => {
	const cwd = mkdtempSync(join(tmpdir(), "dream-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "dream-agent-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ [PI_CONTEXT_SETTINGS_KEY]: { [PI_CONTEXT_DREAMER_KEY]: "global/model" } }));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ [PI_CONTEXT_SETTINGS_KEY]: { [PI_CONTEXT_DREAMER_KEY]: "project/model" } }));
		assert.equal(readDreamerSettings(cwd).pattern, "project/model");
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({}));
		assert.equal(readDreamerSettings(cwd).pattern, "global/model", "global applies when the project does not set the key");
	} finally {
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
	}
});

test("CLI: --dreamer wins over settings, settings win over the automatic fallback", async () => {
	const home = fixture();
	const seen: Array<string | undefined> = [];
	const success = successSession();
	const run = (argv: string[], settings: { pattern?: string; warnings: string[] }) => main(["--notes-home", home, "--force", ...argv], {
		sessionFactory: async (options) => { seen.push(options.modelPattern); return success({ cwd: home, tools: DREAMER_TOOLS }); },
		dreamerSettings: () => settings,
	});
	await captureErrors(() => run([], { pattern: "settings/model", warnings: [] }));
	await captureErrors(() => run(["--dreamer", "cli/model"], { pattern: "settings/model", warnings: [] }));
	await captureErrors(() => run([], { warnings: [] }));
	assert.deepEqual(seen, ["settings/model", "cli/model", undefined]);
});
