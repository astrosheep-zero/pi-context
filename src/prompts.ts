import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { historyFromSession } from "./history.js";
import { localIso } from "./notes/model.js";
import { listNotes } from "./notes/store.js";
import { CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, NOTE_PREVIEW_CHARS, NOTE_PREVIEW_HEAD_CHARS, NOTE_PREVIEW_TAIL_CHARS, RESET_SUMMARY, PROTOCOL_BLOCK, GUIDANCE_OPEN_TAG, GUIDANCE_CLOSE_TAG } from "./protocol.js";

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
 * Recent-notes index: up to three most-recent fresh (non-stale) notes. Each note shows its
 * path, line count, UTF-8 byte count and local ISO update time, followed by an indented inline
 * preview: the whole text when it fits in NOTE_PREVIEW_CHARS, otherwise its first
 * NOTE_PREVIEW_HEAD_CHARS and last NOTE_PREVIEW_TAIL_CHARS Unicode characters joined by an
 * explicit ellipsis. The two slices never overlap, so the preview never duplicates head content
 * as tail content. Stale notes are excluded entirely; empty when no fresh notes remain.
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
		const lines = [`You find ${recentNotes.length} crumpled note${recentNotes.length === 1 ? "" : "s"} in your pocket (up to 5, most recent first):`];
		for (const row of recentNotes) {
			const body = row.body;
			lines.push(`- ${row.address} (${body.split("\n").length} lines, ${row.sizeBytes} UTF-8 bytes, updated ${localIso(row.meta.updated_at)})`);
			const chars = Array.from(body);
			// Short notes stay whole; long notes keep both ends. head + tail <= NOTE_PREVIEW_CHARS < chars.length,
			// so the slices are disjoint and no character is shown twice.
			const preview = chars.length <= NOTE_PREVIEW_CHARS
				? body
				: `${chars.slice(0, NOTE_PREVIEW_HEAD_CHARS).join("")}…${chars.slice(chars.length - NOTE_PREVIEW_TAIL_CHARS).join("")}`;
			lines.push(preview.split("\n").map((line) => `  ${line}`).join("\n"));
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
