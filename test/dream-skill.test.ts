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

	const wrapper = readFileSync(skill.filePath, "utf8");
	assert.match(wrapper, /does not install those protections/);
	assert.match(wrapper, /does not authorize starting the `dream` CLI, calling another model/);
	assert.match(wrapper, /Record the invocation working directory before changing directories/);
	assert.match(wrapper, /session notes whose project metadata matches/);
	assert.match(playbook, /five kinds of home/);
	for (const home of ["pi/session/<session-id>/", "project/<project-key>/", "human/", "agents/<agent-name>/", "models/<model-name>/"]) {
		assert.ok(playbook.includes(home), `playbook includes ${home}`);
	}
	assert.match(playbook, /## Choose scope before reading/);
	assert.match(playbook, /Use the working directory where this dream was invoked, not a directory you enter later/);
	assert.match(playbook, /Resolve it and the notes-store root to real paths before checking containment/);
	assert.match(playbook, /\*\*Inside the notes store:\*\* you may inspect the store across homes/);
	assert.match(playbook, /all session notes whose frontmatter `project` field exactly matches this project's key/);
	assert.match(playbook, /inspect session note frontmatter to find matching notes, but read bodies only for matching notes/);
	assert.match(playbook, /Missing or invalid project metadata means unknown ownership: skip those notes and report the coverage gap/);
	for (const forbidden of ["do not infer ownership from note contents, session IDs, or old Pi session records", "Do not create, repair, or backfill metadata", "Do not read other projects' notes, human notes, or agent/model notes", "do not write or promote into those homes"]) {
		assert.ok(playbook.includes(forbidden), `scope policy includes ${forbidden}`);
	}
	assert.match(playbook, /Changing directories to read notes or run tools never upgrades a project-only dream to a store-wide dream/);
	assert.match(playbook, /The current project is its enclosing Git root, or the invocation directory if there is no Git root/);
	assert.match(playbook, /using pi-context's project identity, not a guessed basename/);
	assert.match(playbook, /If the home cannot be identified unambiguously, ask before writing/);
	assert.match(playbook, /A project-only dream also reads session notes with matching project metadata/);
	assert.ok(playbook.includes("`pi/session/**` is a live agent's write-ahead log: never write or edit anything there"));
	assert.doesNotMatch(playbook, /@personal\b/);

	const readme = readFileSync(join(root, "README.md"), "utf8");
	assert.match(readme, /Scope comes from the invocation directory: inside the notes store, dream may inspect across homes/);
	assert.match(readme, /all session notes with matching project metadata/);
	assert.match(readme, /frontmatter `project` field/);
	assert.match(readme, /There is no migration or backfill/);
	assert.match(readme, /Changing directories later does not broaden the scope/);
	const cli = readFileSync(join(root, "src/dream/cli.ts"), "utf8");
	assert.match(cli, /const defaultBook = join\(packageRoot\(\), "playbook\.md"\)/);
	assert.match(cli, /const playbookPath = String\(a\.playbook \?\? defaultBook\)/);
	assert.match(cli, /const playbook = loadPlaybook\(playbookPath\)/);
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
