import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { loadPlaybook } from "../src/dream/runner.js";

function packageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (!existsSync(join(dir, "package.json"))) {
		const parent = dirname(dir);
		if (parent === dir) throw new Error("could not locate package root");
		dir = parent;
	}
	return dir;
}

function discoverDreamSkill(skillsDir: string) {
	const result = loadSkillsFromDir({ dir: skillsDir, source: "path" });
	assert.deepEqual(result.diagnostics, []);
	const skill = result.skills.find((candidate) => candidate.name === "dream");
	assert.ok(skill, "Pi's public skill loader discovers dream");
	assert.ok(skill.description.length > 0);
	return skill;
}

test("dream skill is publicly discoverable and resolves the CLI's shared playbook", () => {
	const root = packageRoot();
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.skills, ["./skills"]);
	assert.deepEqual(manifest.pi.extensions, ["./dist/extension.js"]);
	assert.equal(manifest.bin.dream, "dist/src/dream/cli.js");
	assert.ok(manifest.files.includes("skills"));

	const skill = discoverDreamSkill(join(root, "skills"));
	const skillPlaybook = resolve(skill.baseDir, "../../playbook.md");
	const packagePlaybook = resolve(root, "playbook.md");
	assert.equal(skillPlaybook, packagePlaybook);
	const playbook = readFileSync(packagePlaybook, "utf8");
	assert.equal(loadPlaybook(skillPlaybook), playbook);

});

test("npm tarball keeps the skill's relative playbook path portable after extraction", () => {
	const root = packageRoot();
	const fixture = mkdtempSync(join(tmpdir(), "dream-skill-pack-"));
	try {
		const packed = JSON.parse(execFileSync("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", fixture], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}))[0] as { filename: string; files: Array<{ path: string }> };
		const packedPaths = packed.files.map((file) => file.path);
		assert.ok(packedPaths.includes("skills/dream/SKILL.md"));
		assert.ok(packedPaths.includes("playbook.md"));
		assert.ok(packedPaths.includes("dist/extension.js"));
		assert.ok(packedPaths.includes("dist/src/dream/cli.js"));

		const extracted = join(fixture, "extracted");
		execFileSync("mkdir", ["-p", extracted]);
		execFileSync("tar", ["-xzf", join(fixture, packed.filename), "-C", extracted]);
		const installedRoot = join(extracted, "package");
		const installedSkill = discoverDreamSkill(join(installedRoot, "skills"));
		const referencedPlaybook = resolve(installedSkill.baseDir, "../../playbook.md");
		assert.equal(referencedPlaybook, resolve(installedRoot, "playbook.md"));
		assert.equal(loadPlaybook(referencedPlaybook), readFileSync(referencedPlaybook, "utf8"));
		assert.equal(loadPlaybook(referencedPlaybook), readFileSync(join(root, "playbook.md"), "utf8"));
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
