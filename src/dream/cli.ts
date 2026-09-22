#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, failLock, lastRunPath, releaseLock } from "./lock.js";
import { materialGate, timeGate } from "./gates.js";
import { loadPlaybook, runDreamer, type DreamerSessionFactory, type DreamResult, type DreamWrite } from "./runner.js";
import { gitCommit } from "./git.js";
import { readDreamerSettings, type DreamerSetting } from "./settings.js";
import { doctor } from "./doctor.js";
import { notesRoot } from "../notes/paths.js";

function args(argv: string[]) { const out: Record<string, string | boolean> = {}; for (let i=0;i<argv.length;i++) { const a=argv[i]!; if (a === "--force" || a === "--help") out[a.slice(2)] = true; else if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? ""; } return out; }
function packageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) { if (existsSync(join(dir, "package.json"))) return dir; const parent = dirname(dir); if (parent === dir) throw new Error("could not locate installed package root"); dir = parent; }
}

/** Injection seams used by tests; production uses the defaults. */
export type DreamDependencies = {
	sessionFactory?: DreamerSessionFactory;
	dreamerSettings?: (cwd?: string) => DreamerSetting;
	runDreamer?: typeof runDreamer;
};

function writeList(writes: DreamWrite[]): string {
	return writes.length ? writes.map((w) => `- ${w.tool}: ${w.path}`).join("\n") : "- no changes";
}

/** Best-effort text write; returns the failure message instead of throwing. */
function writeText(path: string, content: string): string | undefined {
	try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return undefined; }
	catch (error) { return error instanceof Error ? error.message : String(error); }
}

function appendText(path: string, content: string): string | undefined {
	try { appendFileSync(path, content); return undefined; }
	catch (error) { return error instanceof Error ? error.message : String(error); }
}

/**
 * Close one dream: record the report, then run the final audit commit. The audit always
 * runs even when the report cannot be written, and a failed audit is appended to the
 * report (when it exists) as well as named on stderr, so neither failure hides the other.
 */
function finishDream(home: string, stamp: string, reportPath: string, failed: boolean, body: string, writes: DreamWrite[]): number {
	const header = failed ? `# Dream ${stamp} (failed)` : `# Dream ${stamp}`;
	let reportError = writeText(reportPath, `${header}\n\n${body}\n\n${writeList(writes)}\n`);
	const audit = gitCommit(home, `dream ${stamp}${failed ? " (failed)" : ""}`);
	if (!audit.ok) {
		console.error(`dream: final audit failed: ${audit.error}`);
		reportError ??= appendText(reportPath, `\n## Final audit failed\n\n${audit.error}\n`);
	}
	if (reportError) console.error(`dream: could not write report at ${reportPath}: ${reportError}`);
	return failed || !audit.ok || reportError !== undefined ? 1 : 0;
}

export async function main(argv = process.argv.slice(2), deps: DreamDependencies = {}): Promise<number> {
	if (argv[0] === "doctor") {
		const options = args(argv.slice(1));
		if (options.help) { console.log("dream doctor [--notes-home <dir>] — read-only diagnostics; no model or repairs"); return 0; }
		const home = resolve(String(options["notes-home"] ?? notesRoot()));
		const issues = doctor(home);
		console.log(issues.length ? issues.join("\n") : `dream doctor: OK (${home})`);
		return issues.length ? 1 : 0;
	}
	const a = args(argv); if (a.help) { console.log("dream doctor [--notes-home <dir>] — read-only diagnostics\ndream --notes-home <dir> [--min-hours 24] [--min-sessions 3] [--force] [--dreamer <model pattern>] [--playbook <path>]\nDreamer model: --dreamer wins, else pi-context.dreamer from settings, else the automatic model. Default playbook: <installed package root>/playbook.md; --playbook overrides it."); return 0; }
	const home = resolve(String(a["notes-home"] ?? notesRoot())); process.env.PI_NOTES_HOME = home; mkdirSync(home, { recursive: true });
	const lockPath = join(home, ".dream.lock"); const stampPath = lastRunPath(lockPath);
	const minHours = Number(a["min-hours"] ?? 24); const minSessions = Number(a["min-sessions"] ?? 3);
	const time = timeGate(stampPath, minHours); console.log(time.reason); if (!a.force && !time.ok) return 0;
	const since = existsSync(stampPath) ? statSync(stampPath).mtimeMs : 0;
	const material = materialGate(home, since, minSessions); console.log(material.reason); if (!a.force && !material.ok) return 0;
	let lock; try { lock = acquireLock(lockPath); } catch (e) { console.log(`lock gate: ${e instanceof Error ? e.message : e}`); return 0; } if (!lock.held) { console.log(lock.reason); return 0; }
	const stamp = new Date(lock.startedAt).toISOString().replace(/[:.]/g, "-"); const reportPath = join(home, "dreams", `${stamp}.md`);
	let succeeded = false;
	try {
		// CLI --dreamer wins over settings; settings win over the automatic model fallback.
		let modelPattern: string | undefined;
		if (a.dreamer) modelPattern = String(a.dreamer);
		else {
			const settings = (deps.dreamerSettings ?? readDreamerSettings)();
			for (const warning of settings.warnings) console.error(warning);
			modelPattern = settings.pattern;
		}

		// The baseline snapshot is required: without it the human gate has nothing to inspect.
		const baseline = gitCommit(home, `baseline ${stamp}`);
		if (!baseline.ok) { console.error(`dream: baseline audit failed: ${baseline.error}`); return 1; }

		const defaultBook = join(packageRoot(), "playbook.md");
		const playbookPath = String(a.playbook ?? defaultBook);
		let result: DreamResult;
		try {
			const playbook = loadPlaybook(playbookPath);
			result = await (deps.runDreamer ?? runDreamer)(playbook, home, { modelPattern, sessionFactory: deps.sessionFactory });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			console.error(message);
			return finishDream(home, stamp, reportPath, true, message, []);
		}
		if (result.error) {
			console.error(result.error);
			return finishDream(home, stamp, reportPath, true, result.error, result.writes);
		}
		const code = finishDream(home, stamp, reportPath, false, result.report, result.writes);
		if (code === 0) { succeeded = true; console.log(reportPath); }
		return code;
	} finally {
		// Only the holder's own lock is released; a successor's lock is never touched.
		if (succeeded) releaseLock(lock); else failLock(lock);
	}
}

function isEntryPoint(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try { return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isEntryPoint()) main().then((code) => { process.exitCode = code; });
