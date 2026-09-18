import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type GateResult = { ok: boolean; reason: string };
export function timeGate(lockPath: string, minHours: number, now = Date.now()): GateResult {
	if (!existsSync(lockPath)) return { ok: true, reason: "time gate: no prior lock" };
	const age = now - statSync(lockPath).mtimeMs;
	return age >= minHours * 3600000 ? { ok: true, reason: "time gate: stale" } : { ok: false, reason: "time gate: lock is too fresh" };
}
export function materialGate(home: string, lockMtime: number, minSessions: number): GateResult {
	const root = join(home, "pi", "session");
	let changed = 0;
	if (existsSync(root)) for (const dir of readdirSync(root, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const files = readdirSync(join(root, dir.name), { withFileTypes: true });
		if (files.some((f) => f.isFile() && statSync(join(root, dir.name, f.name)).mtimeMs > lockMtime)) changed++;
	}
	return changed >= minSessions ? { ok: true, reason: `material gate: ${changed} changed sessions` } : { ok: false, reason: `material gate: only ${changed} changed sessions` };
}
