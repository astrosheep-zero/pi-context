import { build } from "esbuild";
import { copyFileSync } from "node:fs";

const projections = [
	["skills/dream/SKILL.md", "mods/pi-context/skills/dream/SKILL.md"],
	["playbook.md", "mods/pi-context/playbook.md"],
];
for (const [source, projection] of projections) copyFileSync(source, projection);

await build({
	entryPoints: ["src/claude/helper.ts"],
	outfile: "mods/pi-context/dist/claude/helper.js",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
});
