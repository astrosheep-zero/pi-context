import type { NotesHome, NotesSnapshot } from "../pi/notes/snapshot.js";
import { CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, POCKET_AGENT_LIMIT, POCKET_HUMAN_LIMIT, POCKET_MODEL_LIMIT, POCKET_PROJECT_LIMIT, POCKET_SESSION_LIMIT, PROTOCOL_BLOCK, GUIDANCE_OPEN_TAG, GUIDANCE_CLOSE_TAG } from "../protocol.js";

/** Codex-style <context_window> identity block: the resolved agent and model names plus first/current/previous window ids. */
function identityBlock(agentName: string, modelName: string, firstWindowId: string, currentWindowId: string, previousWindowId?: string): string {
	const lines = [
		`Agent name: ${agentName} (brain: ${modelName})`,
		`First context window id: ${firstWindowId}`,
		`Current context window id: ${currentWindowId}`,
	];
	if (previousWindowId) lines.push(`Previous context window id: ${previousWindowId}`);
	return `${CONTEXT_WINDOW_OPEN_TAG}\n${lines.join("\n")}\n${CONTEXT_WINDOW_CLOSE_TAG}`;
}

function relativeTime(timestamp: number, now: number): string {
	const seconds = Math.trunc((timestamp - now) / 1000);
	if (seconds === 0) return "just now";
	const [unit, size] = ([["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const)
		.find(([unit, size]) => Math.abs(seconds) >= size || unit === "s")!;
	const amount = `${Math.abs(Math.trunc(seconds / size))}${unit}`;
	return seconds > 0 ? `in ${amount}` : `${amount} ago`;
}

function rowsFor(snapshot: NotesSnapshot, scope: NotesHome["scope"]) {
	return snapshot.homes.get(scope) ?? [];
}

/** One closed boot snapshot, grouped by who or what the notes belong to. */
function notesIndex(snapshot: NotesSnapshot, agentName: string, modelName: string): string {
	const homes: ReadonlyArray<{ scope: NotesHome["scope"]; label: string; limit: number }> = [
		{ scope: "human", label: "The human | @human", limit: POCKET_HUMAN_LIMIT },
		{ scope: "agent", label: `You | @self → @agents/${agentName}`, limit: POCKET_AGENT_LIMIT },
		{ scope: "model", label: `Your model | @model → @models/${modelName}`, limit: POCKET_MODEL_LIMIT },
		{ scope: "project", label: "This project | @project", limit: POCKET_PROJECT_LIMIT },
		{ scope: "session", label: "This session", limit: POCKET_SESSION_LIMIT },
	];
	const sections: string[] = [];
	for (const home of homes) {
		if (snapshot.unavailable.some((failed) => failed.scope === home.scope)) {
			sections.push(`## ${home.label}\n： this drawer wouldn't open — ask notes_list to try again`);
			continue;
		}
		const rows = rowsFor(snapshot, home.scope);
		const map = rows.find((row) => row.path === "MAP.md" && row.meta.crumpledAt === undefined);
		const recent = rows.filter((row) => row.meta.crumpledAt === undefined && row.path !== "MAP.md").slice(0, home.limit);
		if (!map?.body && recent.length === 0) continue;
		const contents = [`## ${home.label}`];
		if (map?.body) contents.push(`●  MAP.md\n${map.body}`);
		if (recent.length > 0) {
			contents.push(`●  Recent notes\n${recent.map((row) =>
				`- ${row.address} | ${Array.from(row.body).length} chars | ${relativeTime(row.meta.updatedAt, snapshot.openedAt)}`
			).join("\n")}`);
		}
		sections.push(contents.join("\n\n"));
	}
	return `# Your notes\n\n${sections.length > 0
		? sections.join("\n\n")
		: "： None yet. A blank slate is a fine place to start — just don't finish there."}`;
}

/**
 * Render a static, once-per-window boot block from explicit data. This function does not read
 * notes or call runtime UI APIs; acquisition belongs to loadNotesSnapshot and its caller.
 */
export type BootRenderData = {
	readonly agentName: string;
	readonly modelName: string;
	readonly firstWindowId: string;
	readonly currentWindowId: string;
	readonly previousWindowId?: string;
	readonly notes: NotesSnapshot;
};

export function renderBootBlock(data: BootRenderData): string {
	const parts: string[] = [];
	parts.push(identityBlock(data.agentName, data.modelName, data.firstWindowId, data.currentWindowId, data.previousWindowId));
	parts.push(PROTOCOL_BLOCK);
	parts.push(notesIndex(data.notes, data.agentName, data.modelName));
	return parts.join("\n\n");
}

/**
 * Codex-equivalent low-budget reminder. The measured remaining count is frozen into
 * the text at the crossing that fires it, so each persisted copy is a snapshot true
 * at write time; get_context_remaining remains the live source for the current figure.
 */
export function tokenBudgetGuidance(remaining: number): string {
	return `${GUIDANCE_OPEN_TAG}\nYour brain is almost out of room — ${remaining} tokens left, and then your memory gets wiped. The wipe is automatic: there is no final turn to write then. Grab the notebook now — the goal, decisions, progress, learnings, next steps, the skills you still need, the seq of every relevant history item still being solved, and important actions/tool calls for future reference. Bookmark expensive history with seq; a fork starts a new session and renumbers seqs. Replacing an older checkpoint? Crumple it. Then call wipe_memory yourself — anything you do after the checkpoint isn't in it.\n${GUIDANCE_CLOSE_TAG}`;
}
