import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseManifest, type Manifest } from "./manifest.js";

export function runWorker(command: string, playbook: string, cwd: string): Manifest {
	const result = spawnSync(command, { shell: true, cwd, input: playbook, encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error(`worker failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
	return parseManifest(result.stdout);
}
export function loadPlaybook(path: string): string { return readFileSync(path, "utf8"); }
