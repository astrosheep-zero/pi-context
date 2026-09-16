import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { historyFromSession } from "./history.js";
import { notesFromSession, localIso } from "./notes.js";
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
 * Recent-notes index: up to three most-recent notes. Each note shows its path, line count,
 * UTF-8 byte count and local ISO update time, followed by an indented inline preview: the
 * whole text when it fits in NOTE_PREVIEW_CHARS, otherwise its first NOTE_PREVIEW_HEAD_CHARS
 * and last NOTE_PREVIEW_TAIL_CHARS Unicode characters joined by an explicit ellipsis. The
 * two slices never overlap, so the preview never duplicates head content as tail content.
 * Empty when the session has no notes.
 */
function notesIndex(ctx: ExtensionContext): string {
	const recentNotes = [...notesFromSession(ctx)]
		.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
		.slice(0, 3);
	if (recentNotes.length === 0) return "";
	const lines = [`You find ${recentNotes.length} crumpled note${recentNotes.length === 1 ? "" : "s"} in your pocket (up to 3, most recent first):`];
	for (const [path, file] of recentNotes) {
		lines.push(`- ${path} (${file.text.split("\n").length} lines, ${Buffer.byteLength(file.text, "utf8")} UTF-8 bytes, updated ${localIso(file.updatedAt)})`);
		const chars = Array.from(file.text);
		// Short notes stay whole; long notes keep both ends. head + tail <= NOTE_PREVIEW_CHARS < chars.length,
		// so the slices are disjoint and no character is shown twice.
		const preview = chars.length <= NOTE_PREVIEW_CHARS
			? file.text
			: `${chars.slice(0, NOTE_PREVIEW_HEAD_CHARS).join("")}…${chars.slice(chars.length - NOTE_PREVIEW_TAIL_CHARS).join("")}`;
		lines.push(preview.split("\n").map((line) => `  ${line}`).join("\n"));
	}
	return lines.join("\n");
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
	parts.push(PROTOCOL_BLOCK);
	return parts.join("\n\n");
}

/**
 * Codex-equivalent low-budget reminder. The measured remaining count is frozen into
 * the text at the crossing that fires it, so each persisted copy is a snapshot true
 * at write time; get_context_remaining remains the live source for the current figure.
 */
export function tokenBudgetGuidance(remaining: number): string {
	return `${GUIDANCE_OPEN_TAG}\nYour memory is about to be erased — only ${remaining} tokens left at last count. Before it happens, write down what matters with notes_write_file: goal, decisions, open issues, next steps, plus the window ID and item ID of each user request you're still solving, so history_* can recover the details later. Call new_context when you're ready to let go and wake clean. Don't count on the automatic reset leaving you another turn to write. get_context_remaining gives the live number.\n${GUIDANCE_CLOSE_TAG}`;
}

