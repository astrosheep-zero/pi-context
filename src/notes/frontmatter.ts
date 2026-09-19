import { localIso } from "./model.js";
import type { Scope } from "./paths.js";

export type NoteStatus = "active" | "superseded" | "pending" | "archived";
export type Origin = "user" | "self" | "external";

/**
 * Harness-owned note metadata. The eight required keys are always written; the four optional
 * sleep-shift keys survive this layer untouched when present. `[key: string]: unknown` carries
 * any frontmatter key this layer does not know, preserved verbatim across rewrites.
 */
export type NoteMeta = {
	scope: Scope;
	origin: Origin;
	status: NoteStatus;
	stale: boolean;
	created_at: number;
	updated_at: number;
	last_accessed: number;
	access_count: number;
	source_window?: string;
	supersedes?: string;
	recurrence_count?: number;
	recurrence_windows?: string[];
	[key: string]: unknown;
};

const SCOPES: readonly Scope[] = ["session", "project", "global"];
const ORIGINS: readonly Origin[] = ["user", "self", "external"];
const STATUSES: readonly NoteStatus[] = ["active", "superseded", "pending", "archived"];
const TIMESTAMP_KEYS = ["created_at", "updated_at", "last_accessed"] as const;
/** Emission order, exactly the Design's key list. */
const KNOWN_KEYS = ["origin", "status", "stale", "created_at", "updated_at", "last_accessed", "access_count", "source_window", "supersedes", "recurrence_count", "recurrence_windows"] as const;

export function isScope(value: unknown): value is Scope {
	return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

export function isOrigin(value: unknown): value is Origin {
	return typeof value === "string" && (ORIGINS as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is NoteStatus {
	return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function toEpoch(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

/** A frontmatter scalar encoded as JSON, falling back to a plain string for hand-written YAML. */
function parseScalar(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed === "") return "";
	try {
		return JSON.parse(trimmed);
	} catch {
		if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
		return trimmed;
	}
}

/**
 * Split raw file text into its frontmatter fields and body. When the file does not open with
 * a closed `---` block, the whole text is body and the field map is empty.
 */
function parseFrontmatter(raw: string): { fields: Record<string, unknown>; body: string } {
	const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
	const lines = stripped.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	if (lines[0]?.trim() !== "---") return { fields: {}, body: raw };
	let close = -1;
	for (let index = 1; index < lines.length; index++) {
		if (lines[index]?.trim() === "---") {
			close = index;
			break;
		}
	}
	if (close === -1) return { fields: {}, body: raw };
	const fields: Record<string, unknown> = {};
	for (let index = 1; index < close; index++) {
		const line = lines[index]!;
		const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1]!;
		const rest = match[2]!;
		if (rest.trim() === "") {
			// A bare key opens a block sequence of `- item` lines, the only multi-line shape we parse.
			const items: unknown[] = [];
			while (index + 1 < close && /^\s*-\s+/.test(lines[index + 1]!)) {
				index++;
				items.push(parseScalar(lines[index]!.replace(/^\s*-\s+/, "")));
			}
			fields[key] = items;
		} else {
			fields[key] = parseScalar(rest);
		}
	}
	const rest = lines.slice(close + 1);
	if (rest[0] === "") rest.shift();
	return { fields, body: rest.join("\n") };
}

/**
 * Parse a note file. Missing known keys take the Design defaults (status active, stale false,
 * access_count 0, timestamps now); unknown keys are carried through untouched.
 */
export function parseNote(raw: string, now = Date.now()): { meta: NoteMeta; body: string } {
	const { fields, body } = parseFrontmatter(raw);
	const meta = { ...fields } as Record<string, unknown>;
	meta.scope = isScope(meta.scope) ? meta.scope : "global";
	meta.origin = isOrigin(meta.origin) ? meta.origin : "self";
	meta.status = isStatus(meta.status) ? meta.status : "active";
	meta.stale = meta.stale === true;
	for (const key of TIMESTAMP_KEYS) meta[key] = toEpoch(meta[key], now);
	meta.access_count = typeof meta.access_count === "number" && Number.isFinite(meta.access_count) ? meta.access_count : 0;
	return { meta: meta as NoteMeta, body };
}

/** Emit a YAML scalar: bare for safe strings and JSON literals, JSON-quoted otherwise. */
function yamlScalar(value: unknown): string {
	if (typeof value === "string") {
		const reserved = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);
		if (/^[A-Za-z0-9_.+\-:/]+$/.test(value) && !reserved.has(value.toLowerCase())) return value;
	}
	return JSON.stringify(value);
}

/** Serialize frontmatter + blank line + body. Known keys emit in Design order, extras after. */
export function serializeNote(meta: NoteMeta, body: string): string {
	const lines: string[] = [];
	for (const key of KNOWN_KEYS) {
		const value = meta[key];
		if (value === undefined) continue;
		if ((TIMESTAMP_KEYS as readonly string[]).includes(key)) lines.push(`${key}: ${yamlScalar(localIso(value as number))}`);
		else lines.push(`${key}: ${yamlScalar(value)}`);
	}
	for (const key of Object.keys(meta)) {
		// scope is a legacy on-disk field. Store callers derive it from the home's location,
		// but serialization intentionally drops it on the next write.
		if (key === "scope" || (KNOWN_KEYS as readonly string[]).includes(key)) continue;
		if (meta[key] === undefined) continue;
		lines.push(`${key}: ${yamlScalar(meta[key])}`);
	}
	return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

/** Strip a leading frontmatter block from user content, so a note body is pure content. */
export function stripLeadingFrontmatter(content: string): string {
	return parseFrontmatter(content).body;
}
