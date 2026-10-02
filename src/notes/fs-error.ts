/** The store's own errno classification: a filesystem refusal, never a Node `ERR_*` code. */
export function isFilesystemError(error: unknown): boolean {
	const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
	return typeof code === "string" && /^E[A-Z0-9_]+$/.test(code) && !code.startsWith("ERR_");
}
