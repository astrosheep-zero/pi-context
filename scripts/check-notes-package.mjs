// Exercise the published boundary outside this checkout: default npm peer resolution,
// Node ESM, and strict declaration checking, with no Pi packages installed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "pi-context-package-"));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
try {
	const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], repo))[0];
	const consumer = join(temporary, "consumer");
	mkdirSync(consumer);
	writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "notes-consumer", private: true, type: "module" }));
	// Do not omit peers or use legacy-peer-deps: optional peer metadata must do the work.
	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, packed.filename)], consumer);
	const installed = join(consumer, "node_modules", "@astrosheep", "pi-context");
	const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
	for (const name of Object.keys(manifest.peerDependencies)) {
		assert.equal(existsSync(join(consumer, "node_modules", ...name.split("/"))), false, `${name} must not be installed`);
	}
	assert.ok(existsSync(join(installed, manifest.pi.extensions[0])), "Pi-discovered extension ships");
	assert.ok(existsSync(join(installed, manifest.bin.dream)), "dream executable ships");
	writeFileSync(join(consumer, "consumer.ts"), `import * as api from "@astrosheep/pi-context/notes";
import { createNotesStore, NoteError, type NotesContext, type NotesStore, type NotesQuery, type NoteChange } from "@astrosheep/pi-context/notes";
if (Object.keys(api).sort().join(",") !== "NoteError,createNotesStore,projectKey,slugify") throw new Error("unexpected public exports");
const invalidQueries: NotesQuery[] = [
  // @ts-expect-error who requires an agent/model scope
  { who: "root" },
  // @ts-expect-error project scope has no named owner
  { scope: "project", who: "root" },
];
void invalidQueries;
const context: NotesContext = { home: "./notes", sessionId: "consumer", projectKey: "example-12345678", agent: "root", model: "test" };
const notes: NotesStore = createNotesStore(context);
await notes.write("@project/hello.md", "hello", { origin: "user" });
const edited = await notes.update("@project/hello.md", [{ oldText: "hello", newText: "hello world" }]);
const before: string = edited.change.before;
const change: NoteChange = edited.change;
if (change.kind === "none") { const empty: "" = change.before; void empty; }
if (edited.resolvedScope !== "project" || edited.change.kind !== "body") throw new Error("incorrect edit result");
await notes.list({ scope: "project" });
await notes.search(["world"], { scope: "agent", who: "root" });
const body: string | undefined = (await notes.read("@project/hello.md"))?.body;
const matches: number = (await notes.search(["world"]))[0]?.matches.length ?? 0;
const address: string | undefined = (await notes.list())[0]?.address;
const error = new NoteError("not_found", "missing", { editIndex: 0, lineNumbers: [1] });
if (error.editIndex !== 0 || error.lineNumbers?.[0] !== 1) throw error;
if (body !== "hello world" || before !== "hello" || matches !== 1 || address !== "@project/hello.md") throw error;
`);
	// Only TypeScript and Node's types are borrowed from devDependencies. The consumer's
	// module lookup cannot reach this repository; all library declarations must stand alone.
	run(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--strict", "--skipLibCheck", "false", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--typeRoots", join(repo, "node_modules/@types"), "--types", "node", "--outDir", "out", "consumer.ts"], consumer);
	run(process.execPath, ["out/consumer.js"], consumer);
	const root = manifest.exports["."].import;
	assert.equal(manifest.exports["./dist/src/index.js"].import, root, "documented SDK deep import remains mapped");
	console.log("Packed notes library: clean install without Pi, strict TypeScript consumer, and CRUD/search passed.");
} catch (error) {
	if (error.stdout) process.stderr.write(error.stdout);
	if (error.stderr) process.stderr.write(error.stderr);
	throw error;
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
