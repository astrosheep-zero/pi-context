import { lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseNote } from "../notes/frontmatter.js";

function isOutside(notesHome: string, target: string): boolean {
	const fromHome = relative(notesHome, target);
	return fromHome === ".." || fromHome.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromHome);
}

export async function jailWritePath(notesHome: string, path: string, options: { createParent?: boolean } = {}): Promise<string> {
	let realNotesHome: string;
	try {
		realNotesHome = await realpath(notesHome);
	} catch {
		throw new Error(`write jail: cannot resolve notes home ${notesHome}`);
	}
	const target = resolve(realNotesHome, path);
	const targetParent = dirname(target);
	if (isOutside(realNotesHome, targetParent)) throw new Error(`write jail: ${path} is outside notes home ${notesHome}`);
	// write creates parent directories itself. Create only after the lexical check, then
	// canonicalize the parent so a symlink cannot lead the underlying tool out of home.
	// delete passes createParent:false: the parent must already exist for there to be anything to remove.
	if (options.createParent !== false) await mkdir(targetParent, { recursive: true });
	let realTargetParent: string;
	try {
		realTargetParent = await realpath(targetParent);
	} catch {
		throw new Error(`write jail: cannot resolve target parent in notes home ${notesHome}`);
	}
	if (isOutside(realNotesHome, realTargetParent)) throw new Error(`write jail: ${path} is outside notes home ${notesHome}`);
	let targetStats;
	try {
		targetStats = await lstat(target);
	} catch (error: any) {
		if (error.code !== "ENOENT") throw new Error(`write jail: cannot inspect target in notes home ${notesHome}`);
	}
	if (targetStats?.isSymbolicLink()) {
		let realTarget: string;
		try {
			realTarget = await realpath(target);
		} catch {
			throw new Error(`write jail: cannot resolve target in notes home ${notesHome}`);
		}
		if (isOutside(realNotesHome, realTarget)) throw new Error(`write jail: ${path} is outside notes home ${notesHome}`);
	}
	if (targetStats && targetStats.nlink > 1) throw new Error(`write jail: ${path} has hard links and is not allowed in notes home ${notesHome}`);
	return target;
}

/** Physical deletion refuses live notes even before playbook policy is consulted. */
export async function deleteCrumpledNote(notesHome: string, path: string) {
	const target = await jailWritePath(notesHome, path, { createParent: false });
	let raw: string;
	try {
		raw = await readFile(target, "utf8");
	} catch (error: any) {
		throw new Error(`delete: cannot read ${path} in notes home: ${error.message}`);
	}
	if (parseNote(raw).meta.crumpledAt === undefined) throw new Error(`delete: ${path} is not a crumpled note; only the wastebasket rule permits deletion`);
	await unlink(target);
	return { content: [{ type: "text" as const, text: `deleted ${path}` }], details: undefined };
}
