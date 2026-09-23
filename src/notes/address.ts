import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ADDRESS_FORMS,
	assertAddress,
	assertGlobPattern,
	assertVirtualPath,
	addressFor as libraryAddressFor,
	globToRegExp,
	type NoteAddress,
	type Scope,
} from "./lib/index.js";
import { notesContextFromPi } from "./pi-adapter.js";

export { ADDRESS_FORMS, assertAddress, assertGlobPattern, assertVirtualPath, globToRegExp, type NoteAddress };
export type { Scope };

/** Compatibility adapter for callers which still pass a live Pi context. */
export function addressFor(ctx: ExtensionContext, scope: Scope, path: string, who?: string): string {
	return libraryAddressFor(notesContextFromPi(ctx), scope, path, who);
}
