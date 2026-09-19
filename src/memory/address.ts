import { assertVirtualPath } from "../notes.js";
import type { Scope } from "./paths.js";

export type NoteAddress = { scope: Scope; path: string };

const ADDRESS_FORMS = "legal prefixes are @project/ and @global/; bare names are the session home";

/**
 * Decode the one public note address into its physical home and virtual path. This is a
 * tool-boundary rule: replay paths keep using assertVirtualPath directly and are untouched.
 */
export function assertAddress(value: unknown): NoteAddress {
	if (typeof value !== "string") throw new Error(`invalid note address: ${ADDRESS_FORMS}`);
	let scope: Scope = "session";
	let path = value;
	if (value.startsWith("@project/")) {
		scope = "project";
		path = value.slice("@project/".length);
	} else if (value.startsWith("@global/")) {
		scope = "global";
		path = value.slice("@global/".length);
	} else if (value.startsWith("@")) {
		throw new Error(`invalid note address: ${ADDRESS_FORMS}`);
	}
	if (path.includes("@")) throw new Error(`invalid note address: ${ADDRESS_FORMS}`);
	assertVirtualPath(path);
	return { scope, path };
}

/** Render a virtual path in its one unambiguous public address form. */
export function addressFor(scope: Scope, path: string): string {
	return scope === "session" ? path : `@${scope}/${path}`;
}
