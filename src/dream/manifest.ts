export type Manifest = {
	merge?: { into: string; from: string[]; summary?: string }[];
	promote?: { path: string; to: string; reason: string }[];
	trash?: { path: string; reason: string }[];
	pending?: { path: string; reason: string }[];
	skillCandidates?: { title: string; rationale: string }[];
	report: string;
};

export function parseManifest(output: string): Manifest {
	const starts = [...output.matchAll(/[\{[]/g)].map((m) => m.index ?? 0).reverse();
	for (const start of starts) {
		try {
			const value = JSON.parse(output.slice(start)) as Manifest;
			if (!value || typeof value !== "object" || typeof value.report !== "string") continue;
			for (const key of ["merge", "promote", "trash", "pending", "skillCandidates"]) if (value[key as keyof Manifest] !== undefined && !Array.isArray(value[key as keyof Manifest])) throw new Error("invalid array");
			return value;
		} catch { /* try an earlier JSON start */ }
	}
	throw new Error("dreamer did not return a valid JSON manifest");
}
