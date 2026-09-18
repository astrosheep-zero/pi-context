import { existsSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";

export type LockState = { path: string; held: boolean; reason?: string; startedAt: number; priorMtime?: number };
const HOUR = 60 * 60 * 1000;

function live(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquireLock(path: string): LockState {
	const now = Date.now();
	let priorMtime: number | undefined;
	if (existsSync(path)) {
		const stat = statSync(path);
		priorMtime = stat.mtimeMs;
		let pid = 0;
		try { pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10); } catch { /* reclaim */ }
		if (now - stat.mtimeMs <= HOUR && live(pid)) return { path, held: false, reason: "lock gate: live process holds the lock", startedAt: now };
		try { unlinkSync(path); } catch { return { path, held: false, reason: "lock gate: lock could not be reclaimed", startedAt: now }; }
	}
	writeFileSync(path, String(process.pid), { flag: "wx" });
	return { path, held: true, startedAt: now, priorMtime };
}

export function releaseLock(lock: LockState): void {
	// The lock is also the durable last-dream timestamp. Leave the PID marker in place;
	// the next acquisition reclaims it once the PID is dead or it is older than an hour.
}

export function restoreMtime(path: string, mtimeMs: number): void {
	try { utimesSync(path, new Date(), new Date(mtimeMs)); } catch { /* advisory */ }
}

export function failLock(lock: LockState): void {
	if (!lock.held) return;
	if (lock.priorMtime === undefined) { try { unlinkSync(lock.path); } catch { /* best effort */ } }
	else restoreMtime(lock.path, lock.priorMtime);
}
