import { build } from "esbuild";
import { copyFileSync } from "node:fs";

const projections = [
	["skills/dream/SKILL.md", "mods/notesoup/skills/dream/SKILL.md"],
	["playbook.md", "mods/notesoup/playbook.md"],
];
for (const [source, projection] of projections) copyFileSync(source, projection);

await build({
	entryPoints: ["src/claude/helper.ts"],
	outfile: "mods/notesoup/dist/claude/helper.js",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
});
