#!/usr/bin/env node
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireLock, failLock, releaseLock } from "./lock.js";
import { materialGate, timeGate } from "./gates.js";
import { loadPlaybook, runDreamer } from "./runner.js";
import { notesRoot } from "../memory/paths.js";

function args(argv: string[]) { const out: Record<string, string | boolean> = {}; for (let i=0;i<argv.length;i++) { const a=argv[i]!; if (a === "--force" || a === "--help") out[a.slice(2)] = true; else if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? ""; } return out; }
function packageRoot(): string {
	let dir = dirname(new URL(import.meta.url).pathname);
	while (true) { if (existsSync(join(dir, "package.json"))) return dir; const parent = dirname(dir); if (parent === dir) throw new Error("could not locate installed package root"); dir = parent; }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const a = args(argv); if (a.help) { console.log("dream --notes-home <dir> [--min-hours 24] [--min-sessions 3] [--force] [--dreamer <model pattern>] [--playbook <path>]\nDefault dreamer: in-process pi SDK session with jailed file tools. Default playbook: <installed package root>/playbook.md; --playbook overrides it."); return 0; }
	const home = resolve(String(a["notes-home"] ?? notesRoot())); process.env.PI_NOTES_HOME = home; mkdirSync(home, { recursive: true });
	const lockPath = join(home, ".dream.lock"); const minHours = Number(a["min-hours"] ?? 24); const minSessions = Number(a["min-sessions"] ?? 3);
	const time = timeGate(lockPath, minHours); console.log(time.reason); if (!a.force && !time.ok) return 0;
	const material = materialGate(home, existsSync(lockPath) ? statSync(lockPath).mtimeMs : 0, minSessions); console.log(material.reason); if (!a.force && !material.ok) return 0;
	let lock; try { lock = acquireLock(lockPath); } catch (e) { console.log(`lock gate: ${e instanceof Error ? e.message : e}`); return 0; } if (!lock.held) { console.log(lock.reason); return 0; }
	const stamp = new Date(lock.startedAt).toISOString().replace(/[:.]/g, "-"); const reportPath = join(home, "dreams", `${stamp}.md`);
	try {
		const defaultBook = join(packageRoot(), "playbook.md");
		const playbookPath = String(a.playbook ?? defaultBook);
		const playbook = loadPlaybook(playbookPath); const result = await runDreamer(playbook, home, { modelPattern: a.dreamer ? String(a.dreamer) : undefined });
		const writes = result.writes.length ? result.writes.map((w) => `- ${w.tool}: ${w.path}`).join("\n") : "- no changes";
		mkdirSync(join(home, "dreams"), { recursive: true }); writeFileSync(reportPath, `# Dream ${stamp}\n\n${result.report}\n\n${writes}\n`); console.log(reportPath); return 0;
	} catch (e) { failLock(lock); console.error(e instanceof Error ? e.message : e); return 1; } finally { releaseLock(lock); }
}
main().then((code) => { process.exitCode = code; });
