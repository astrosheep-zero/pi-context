import { registerHistoryTools } from "./history-tools.js";
import { registerNotesTools } from "./notes/tools.js";
import { registerBudget } from "./budget.js";
import { output } from "./tool-output.js";
import { deriveThresholds, mergePiContextSettings } from "./thresholds.js";
import { STATE_TYPE, NOTE_TYPE, BOOT_TYPE, GUIDANCE_TYPE, WARNING_TYPE, RESET_MARKER_TYPE, CONTINUATION_TYPE, RESET_V2, MAX_NOTE_BYTES, CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, CONTEXT_WINDOW_PROTOCOL_OPEN_TAG, CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG, GUIDANCE_OPEN_TAG, PI_CONTEXT_SETTINGS_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, WARNING_RUNWAY_TOKENS, RESET_SUMMARY, CONTINUATION, WARNING_PROMPT } from "./protocol.js";
import { historyFromSession, hasWindowMessage, currentWindowId, resetV2WindowId, rootWindowId, windowIdOf } from "./history.js";
import { assertVirtualPath } from "./notes/model.js";
import { migrateLegacyHomes } from "./notes/paths.js";
import { bootBlock } from "./prompts.js";
export { historyFromSession } from "./history.js";
export { notesFromSession } from "./notes/model.js";
import { registerResetLifecycle } from "./reset-lifecycle.js";
import { registerWarning } from "./warning.js";
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piContext(pi: ExtensionAPI) {
	let enabled = true;
	// One-time layout migration (pre-v0.25 personal/ → human/); a conflict warning goes to
	// the debug log, never into a prompt, so the boot head stays cache-stable.
	const migrationWarning = migrateLegacyHomes();
	if (migrationWarning) console.warn(`pi-context: ${migrationWarning}`);
	registerBudget(pi, () => enabled);
	registerWarning(pi, () => enabled);

	pi.on("session_start", (_event, ctx) => {
		if (!enabled) return;
		// The root window has no compaction entry to carry the boot block, so persist
		// it once as a hidden custom message. Reset windows already carry theirs at
		// position 0 in the compaction summary, so a resumed session adds nothing.
		const rootId = rootWindowId(ctx.sessionManager.getSessionId());
		if (currentWindowId(ctx) !== rootId || hasWindowMessage(ctx, BOOT_TYPE)) return;
		pi.sendMessage({ customType: BOOT_TYPE, content: bootBlock(ctx, rootId, undefined, false), display: false }, { triggerTurn: false });
	});

	pi.registerCommand("pi-context", {
		description: "Toggle pi-context: context_window boot block, low-budget guidance, and reset-style compaction",
		getArgumentCompletions: (prefix) =>
			["on", "off"].filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
		handler: async (args, cmdCtx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") enabled = true;
			else if (arg === "off") { enabled = false; resets.clear(); }
			else if (arg !== "") {
				cmdCtx.ui.notify("Usage: /pi-context [on|off]", "error");
				return;
			}
			cmdCtx.ui.notify(`pi-context: ${enabled ? "on" : "off"}`, "info");
		},
	});

	registerHistoryTools(pi);
	registerNotesTools(pi);

	pi.registerTool(defineTool({
		name: "wipe_memory",
		label: "Wipe memory",
		description: "Wipe your in-context memory and start a fresh context window. Your session, notes, and history survive.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			if (!enabled) return output({ error: "pi-context is off (/pi-context on to enable)" });
			return output({ status: resets.request() }, undefined, true);
		},
	}));

	const resets = registerResetLifecycle(pi, {
		isEnabled: () => enabled,
		continuation: { customType: CONTINUATION_TYPE, content: CONTINUATION, display: false },
		isCurrentReset: (entryId, ctx) => {
			const entry = ctx.sessionManager.getEntry(entryId);
			return entry?.type === "compaction" && resetV2WindowId(entry.details) === currentWindowId(ctx);
		},
		onReset: (entryId) => pi.appendEntry(STATE_TYPE, { version: 1, lastResetEntryId: entryId }),
		buildReset: (event, ctx, explicit) => {
			const sessionId = ctx.sessionManager.getSessionId();
			// Window IDs are independent of Pi entry IDs. Avoid reusing a window
			// identity already present on this branch.
			const windows = historyFromSession(ctx);
			const usedIds = new Set(windows.map((window) => window.windowId));
			let minted = { id: randomUUID().slice(0, 8) };
			while (usedIds.has(windowIdOf(sessionId, minted))) minted = { id: randomUUID().slice(0, 8) };
			const windowId = windowIdOf(sessionId, minted);
			const previousId = windows[windows.length - 1]?.windowId ?? rootWindowId(sessionId);
			// The reset marker stays as firstKeptEntryId; it no longer names the window.
			pi.appendEntry(RESET_MARKER_TYPE, { version: 1, reason: event.reason, requested: explicit });
			const markerId = ctx.sessionManager.getLeafId();
			if (!markerId) return { cancel: true };
			return {
				compaction: {
					summary: bootBlock(ctx, windowId, previousId, true),
					firstKeptEntryId: markerId,
					tokensBefore: event.preparation.tokensBefore,
					details: { piContext: RESET_V2, windowId },
				},
			};
		},
	});
}

export const internal = { MAX_NOTE_BYTES, NOTE_TYPE, BOOT_TYPE, GUIDANCE_TYPE, WARNING_TYPE, WARNING_PROMPT, WARNING_RUNWAY_TOKENS, RESET_MARKER_TYPE, RESET_SUMMARY, CONTINUATION, CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, CONTEXT_WINDOW_PROTOCOL_OPEN_TAG, CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG, GUIDANCE_OPEN_TAG, PI_CONTEXT_SETTINGS_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, deriveThresholds, mergePiContextSettings, assertVirtualPath };
