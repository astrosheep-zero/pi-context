import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Git audit layer for a dream run: one commit before (baseline) and one after
 * (dream), so the human gate reviews `git show` instead of trusting a report,
 * and rollback is `git revert`. This layer is a garnish, never load-bearing:
 * every failure is logged and swallowed — a notes home without git, or a
 * broken repo, still dreams. Nothing is committed when the tree is clean.
 */
export function gitCommit(home: string, message: string): void {
	try {
		if (!existsSync(join(home, ".git"))) {
			execFileSync("git", ["init", "-q"], { cwd: home, stdio: "ignore" });
		}
		execFileSync("git", ["add", "-A"], { cwd: home, stdio: "ignore" });
		try {
			execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: home, stdio: "ignore" });
			return; // clean tree — no empty commit
		} catch { /* staged changes exist — fall through to commit */ }
		execFileSync("git", ["commit", "-q", "-m", message], { cwd: home, stdio: "ignore" });
		console.log(`git: committed "${message}"`);
	} catch (error) {
		console.log(`git audit layer skipped: ${error instanceof Error ? error.message : error}`);
	}
}
