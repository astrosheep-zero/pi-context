import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rootWindowId } from "./context-window.js";
import { listNotes } from "./notes/store.js";
import { CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, POCKET_AGENT_LIMIT, POCKET_HUMAN_LIMIT, POCKET_MODEL_LIMIT, POCKET_PROJECT_LIMIT, POCKET_SESSION_LIMIT, RESET_SUMMARY, PROTOCOL_BLOCK, GUIDANCE_OPEN_TAG, GUIDANCE_CLOSE_TAG } from "./protocol.js";
import { agentSlug, modelSlug } from "./notes/paths.js";

/** Codex-style <context_window> identity block: the resolved agent and model names plus first/current/previous window ids. */
function identityBlock(ctx: ExtensionContext, firstWindowId: string, currentWindowId: string, previousWindowId?: string): string {
	const lines = [
		`Agent name: ${agentSlug(ctx)} (brain: ${modelSlug(ctx)})`,
		`First context window id: ${firstWindowId}`,
		`Current context window id: ${currentWindowId}`,
	];
	if (previousWindowId) lines.push(`Previous context window id: ${previousWindowId}`);
	return `${CONTEXT_WINDOW_OPEN_TAG}\n${lines.join("\n")}\n${CONTEXT_WINDOW_CLOSE_TAG}`;
}

function relativeTime(timestamp: number, now: number): string {
	const seconds = Math.trunc((timestamp - now) / 1000);
	const [unit, size] = ([["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const)
		.find(([unit, size]) => Math.abs(seconds) >= size || unit === "s")!;
	const amount = `${Math.abs(Math.trunc(seconds / size))}${unit}`;
	return seconds > 0 ? `in ${amount}` : `${amount} ago`;
}

/**
 * Boot notes index. Map residency ("地图在场"): fresh MAP.md bodies from the human, project,
 * own-agent, and current-model homes are all injected, broadest first; stale maps are skipped
 * per home, and the session home is never peeked — a session MAP.md is an ordinary note. The
 * pocket then lists recent fresh notes under per-home quotas (POCKET_SESSION_LIMIT /
 * POCKET_PROJECT_LIMIT / POCKET_HUMAN_LIMIT / POCKET_AGENT_LIMIT / POCKET_MODEL_LIMIT),
 * most-recently-updated first within each home, one metadata line each: address, line count,
 * UTF-8 byte count, relative update time at window open. Bodies never render
 * in the pocket; stale notes are excluded; MAP.md itself never takes a pocket seat.
 */
function notesIndex(ctx: ExtensionContext): string {
	const sections: string[] = [];
	// Map residency ("地图在场"): scope-native maps, fresh ones injected broadest-first.
	// A session MAP.md is an ordinary note, never resident; stale maps skip independently.
	for (const scope of ["human", "project", "agent", "model"] as const) {
		const toc = listNotes(ctx, { scope }).find((row) => row.path === "MAP.md");
		if (toc && !toc.meta.stale) {
			if (toc.body.length > 0) sections.push(toc.body);
		}
	}
	// listNotes is most-recently-updated first within each home. Per-home quotas keep session
	// churn from evicting the durable homes; maps never take pocket seats.
	const recentNotes = [
		...listNotes(ctx, { scope: "session" }).filter((row) => !row.meta.stale && row.path !== "MAP.md").slice(0, POCKET_SESSION_LIMIT),
		...listNotes(ctx, { scope: "project" }).filter((row) => !row.meta.stale && row.path !== "MAP.md").slice(0, POCKET_PROJECT_LIMIT),
		...listNotes(ctx, { scope: "human" }).filter((row) => !row.meta.stale && row.path !== "MAP.md").slice(0, POCKET_HUMAN_LIMIT),
		...listNotes(ctx, { scope: "agent" }).filter((row) => !row.meta.stale && row.path !== "MAP.md").slice(0, POCKET_AGENT_LIMIT),
		...listNotes(ctx, { scope: "model" }).filter((row) => !row.meta.stale && row.path !== "MAP.md").slice(0, POCKET_MODEL_LIMIT),
	];
	if (recentNotes.length > 0) {
		const lines = [`You find ${recentNotes.length} crumpled note${recentNotes.length === 1 ? "" : "s"} in your pocket (by home, most recent first within each: up to ${POCKET_SESSION_LIMIT} from this session, ${POCKET_PROJECT_LIMIT} from this project, ${POCKET_HUMAN_LIMIT} from @human, ${POCKET_AGENT_LIMIT} from your @self home, ${POCKET_MODEL_LIMIT} from the current @model home). A note's content never appears here, so its name has to say what the note is about:`];
		const now = Date.now();
		for (const row of recentNotes) {
			lines.push(`- ${row.address} (${row.body.split("\n").length} lines, ${row.sizeBytes} UTF-8 bytes, updated ${relativeTime(row.meta.updated_at, now)})`);
		}
		sections.push(lines.join("\n"));
	}
	return sections.join("\n\n");
}

function notesHomeBlock(): string {
	return "Notes_* addresses have five homes: bare <vpath> is this session, @project/<vpath> is this project, @human/<vpath> is the human's cross-project home, @self/<vpath> and @agents/<name>/<vpath> are agent homes (current vs named), and @model/<vpath> and @models/<name>/<vpath> are model homes. @self and @model resolve to who is running now; listings always show resolved names. @ means leaving home; there is no cross-home fallback. Anything else after @ — or @ inside a vpath — is a hard error. Any other note is a plain file — use the file tools.";
}

/**
 * Assemble the static, once-per-window boot block: the reset line for resets, the
 * <context_window> identity block, the recent-notes index at window-open time, and
 * the <context_window_protocol> teaching block. Nothing here is re-injected, so the
 * head of the window stays cache-stable.
 */
export function bootBlock(ctx: ExtensionContext, currentId: string, previousId: string | undefined, resetLine: boolean): string {
	const firstId = rootWindowId(ctx.sessionManager.getSessionId());
	const parts: string[] = [];
	if (resetLine) parts.push(RESET_SUMMARY);
	parts.push(identityBlock(ctx, firstId, currentId, previousId));
	parts.push(notesHomeBlock());
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
	return `${GUIDANCE_OPEN_TAG}\nYour brain is almost out of room — ${remaining} tokens left, and then your memory gets wiped. The wipe is automatic: there is no final turn to write then. Grab the notebook now — the goal, decisions, progress, learnings, next steps, the skills you still need, the window ID and item ID of every relevant user request still being solved, and important actions/tool calls for future reference. Replacing an older checkpoint? Mark it stale. Then call wipe_memory yourself — anything you do after the checkpoint isn't in it.\n${GUIDANCE_CLOSE_TAG}`;
}
