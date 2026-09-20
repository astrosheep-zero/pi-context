import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { historyFromSession } from "./history.js";
import { localIso } from "./notes/model.js";
import { listNotes } from "./notes/store.js";
import { CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, RESET_SUMMARY, PROTOCOL_BLOCK, GUIDANCE_OPEN_TAG, GUIDANCE_CLOSE_TAG } from "./protocol.js";

/** Codex-style <context_window> identity block: agent name and first/current/previous window ids only. */
function identityBlock(agentName: string, firstWindowId: string, currentWindowId: string, previousWindowId?: string): string {
	const lines = [
		`Agent name: ${agentName}`,
		`First context window id: ${firstWindowId}`,
		`Current context window id: ${currentWindowId}`,
	];
	if (previousWindowId) lines.push(`Previous context window id: ${previousWindowId}`);
	return `${CONTEXT_WINDOW_OPEN_TAG}\n${lines.join("\n")}\n${CONTEXT_WINDOW_CLOSE_TAG}`;
}

/**
 * Recent-notes index: up to five most-recent fresh (non-stale) notes, one metadata line each —
 * address, line count, UTF-8 byte count, and local ISO update time. Note bodies are never
 * rendered here. Stale notes are excluded entirely; empty when no fresh notes remain.
 */
function notesIndex(ctx: ExtensionContext): string {
	const sections: string[] = [];
	const notes = listNotes(ctx, {});
	// TOC residency ("地图在场"): explicit ordered home lookup is the one deliberate
	// precedence operation. Stale maps are skipped rather than injected.
	for (const scope of ["session", "project", "global"] as const) {
		const toc = notes.find((row) => row.scope === scope && row.path === "TOC.md");
		if (toc && !toc.meta.stale) {
			if (toc.body.length > 0) sections.push(toc.body);
			break;
		}
	}
	// listNotes is already most-recently-updated first; stale notes never reach the index.
	const recentNotes = notes
		.filter((row) => !row.meta.stale)
		.slice(0, 5);
	if (recentNotes.length > 0) {
		const lines = [`You find ${recentNotes.length} crumpled note${recentNotes.length === 1 ? "" : "s"} in your pocket (up to 5, most recent first). A note's content never appears here, so its name has to say what the note is about:`];
		for (const row of recentNotes) {
			lines.push(`- ${row.address} (${row.body.split("\n").length} lines, ${row.sizeBytes} UTF-8 bytes, updated ${localIso(row.meta.updated_at)})`);
		}
		sections.push(lines.join("\n"));
	}
	return sections.join("\n\n");
}

function notesHomeBlock(): string {
	return "Notes_* addresses have three homes: bare <vpath> is this session, @project/<vpath> is this project, and @global/<vpath> is global. @ means leaving home; there is no cross-home fallback. Any other note is a plain file — use the file tools.";
}

/**
 * Assemble the static, once-per-window boot block: the reset line for resets, the
 * <context_window> identity block, the recent-notes index at window-open time, and
 * the <context_window_protocol> teaching block. Nothing here is re-injected, so the
 * head of the window stays cache-stable.
 */
export function bootBlock(ctx: ExtensionContext, currentId: string, previousId: string | undefined, resetLine: boolean): string {
	const firstId = historyFromSession(ctx)[0]?.windowId ?? currentId;
	const parts: string[] = [];
	if (resetLine) parts.push(RESET_SUMMARY);
	parts.push(identityBlock(ctx.sessionManager.getSessionName() ?? "root", firstId, currentId, previousId));
	const index = notesIndex(ctx);
	if (index) parts.push(index);
	parts.push(notesHomeBlock());
	parts.push(PROTOCOL_BLOCK);
	return parts.join("\n\n");
}

/**
 * Codex-equivalent low-budget reminder. The measured remaining count is frozen into
 * the text at the crossing that fires it, so each persisted copy is a snapshot true
 * at write time; get_context_remaining remains the live source for the current figure.
 */
export function tokenBudgetGuidance(remaining: number): string {
	return `${GUIDANCE_OPEN_TAG}\nYour brain is almost out of room — ${remaining} tokens left, and then your memory gets wiped. The wipe is automatic: there is no final turn to write then. Grab the notebook now — the goal, decisions, progress, learnings, next steps, the skills you still need, the window ID and item ID of every relevant user request still being solved, and important actions/tool calls for future reference. Replacing an older checkpoint? Mark it stale. Then end the window yourself — anything you do after the checkpoint isn't in it.\n${GUIDANCE_CLOSE_TAG}`;
}
