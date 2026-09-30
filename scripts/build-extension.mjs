import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const projections = [
	["skills/dream/SKILL.md", "mods/pi-context/skills/dream/SKILL.md"],
	["playbook.md", "mods/pi-context/playbook.md"],
];
for (const [source, projection] of projections) copyFileSync(source, projection);

function sourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = `${directory}/${entry.name}`;
		return entry.isDirectory() ? sourceFiles(path) : [path];
	});
}

const hash = createHash("sha256");
for (const path of [...sourceFiles("src"), "package.json", "package-lock.json", "tsconfig.json", "scripts/build-extension.mjs"].sort()) {
	const content = readFileSync(path);
	hash.update(`${path}\0${content.length}\0`).update(content);
}
const buildInfo = {
	version: JSON.parse(readFileSync("package.json", "utf8")).version,
	sourceHash: hash.digest("hex"),
};

// Pi aliases package roots while loading extensions, which also catches pi-ai's
// public utility subpaths. Inline that utility; keep host-owned APIs external.
await build({
	entryPoints: ["src/index.ts"],
	outfile: "dist/extension.js",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	define: { __PI_CONTEXT_BUILD__: JSON.stringify(buildInfo) },
	plugins: [{
		name: "host-dependencies",
		setup(builder) {
			builder.onResolve({ filter: /^[^./]/ }, ({ path }) =>
				path === "@earendil-works/pi-ai/utils/estimate" ? undefined : { path, external: true });
		},
	}],
});
writeFileSync("dist/build-info.json", `${JSON.stringify(buildInfo, null, 2)}\n`);

await build({
	entryPoints: ["src/claude/helper.ts"],
	outfile: "mods/pi-context/dist/claude/helper.js",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
});
