#!/usr/bin/env node
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock, failLock, releaseLock } from "./lock.js";
import { materialGate, timeGate } from "./gates.js";
import { loadPlaybook, runWorker } from "./runner.js";
import { applyManifest } from "./apply.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function args(argv: string[]) { const out: Record<string, string | boolean> = {}; for (let i=0;i<argv.length;i++) { const a=argv[i]!; if (a === "--force" || a === "--help") out[a.slice(2)] = true; else if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? ""; } return out; }
export function main(argv = process.argv.slice(2)): number {
	const a = args(argv); if (a.help) { console.log("dream --notes-home <dir> [--min-hours 24] [--min-sessions 3] [--force] [--worker <cmd>] [--playbook <path>]"); return 0; }
	const home = resolve(String(a["notes-home"] ?? process.env.PI_NOTES_HOME ?? join(homedir(), ".agents", "notes"))); process.env.PI_NOTES_HOME = home; mkdirSync(home, { recursive: true });
	const lockPath = join(home, ".dream.lock"); const minHours = Number(a["min-hours"] ?? 24); const minSessions = Number(a["min-sessions"] ?? 3);
	const time = timeGate(lockPath, minHours); console.log(time.reason); if (!a.force && !time.ok) return 0;
	const material = materialGate(home, existsSync(lockPath) ? statSync(lockPath).mtimeMs : 0, minSessions); console.log(material.reason); if (!a.force && !material.ok) return 0;
	let lock; try { lock = acquireLock(lockPath); } catch (e) { console.log(`lock gate: ${e instanceof Error ? e.message : e}`); return 0; } if (!lock.held) { console.log(lock.reason); return 0; }
	const stamp = new Date(lock.startedAt).toISOString().replace(/[:.]/g, "-"); const reportPath = join(home, "dreams", `${stamp}.md`);
	try {
		const defaultBook = resolve(new URL("../../playbook.md", import.meta.url).pathname);
		const playbookPath = String(a.playbook ?? (existsSync(defaultBook) ? defaultBook : resolve("playbook.md")));
		const playbook = loadPlaybook(playbookPath); const manifest = runWorker(String(a.worker ?? "cat"), playbook, home);
		const ctx = { cwd: home, sessionManager: { getSessionId: () => "dream" } } as unknown as ExtensionContext; const actions = applyManifest(ctx, home, stamp, manifest);
		mkdirSync(join(home, "dreams"), { recursive: true }); writeFileSync(reportPath, `# Dream ${stamp}\n\n${manifest.report}\n\n${actions.map((x) => `- ${x}`).join("\n")}\n`); console.log(reportPath); return 0;
	} catch (e) { failLock(lock); console.error(e instanceof Error ? e.message : e); return 1; } finally { releaseLock(lock); }
}
process.exitCode = main();
