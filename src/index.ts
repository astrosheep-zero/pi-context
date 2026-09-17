import { registerHistoryTools } from "./history-tools.js";
import { registerNoteTools } from "./note-tools.js";
import { registerBudget, deriveThresholds, mergePiContextSettings } from "./budget.js";
import { output } from "./tool-output.js";
export { deriveThresholds, mergePiContextSettings } from "./budget.js";
import { STATE_TYPE, NOTE_TYPE, BOOT_TYPE, GUIDANCE_TYPE, FALLBACK_TYPE, RESET_MARKER_TYPE, CONTINUATION_TYPE, RESET_V2, MAX_NOTE_BYTES, CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, CONTEXT_WINDOW_PROTOCOL_OPEN_TAG, CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG, GUIDANCE_OPEN_TAG, GUIDANCE_CLOSE_TAG, PI_CONTEXT_SETTINGS_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, RESET_SUMMARY, CONTINUATION, FALLBACK_PROMPT } from "./protocol.js";
import { historyFromSession, hasWindowMessage, currentWindowId, resetV2WindowId } from "./history.js";
import { assertVirtualPath, lineRange } from "./notes.js";
import { bootBlock } from "./prompts.js";
export { historyFromSession } from "./history.js";
export { notesFromSession } from "./notes.js";
import { registerResetLifecycle } from "./reset-lifecycle.js";
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piContext(pi: ExtensionAPI) {
	let enabled = true;
	registerBudget(pi, () => enabled);

	pi.on("session_start", (_event, ctx) => {
		if (!enabled) return;
		// The root window has no compaction entry to carry the boot block, so persist
		// it once as a hidden custom message. Reset windows already carry theirs at
		// position 0 in the compaction summary, so a resumed session adds nothing.
		const sessionId = ctx.sessionManager.getSessionId();
		const rootId = `pcw:${sessionId.slice(0, 8)}:root`;
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
	registerNoteTools(pi);

	const fallbackGuidance = () => `${GUIDANCE_OPEN_TAG}\n${FALLBACK_PROMPT}\n${GUIDANCE_CLOSE_TAG}`;

	pi.registerTool(defineTool({
		name: "new_context",
		label: "New context",
		description: "Clear your mind and start a new context window. Your session, notes, and history survive.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			if (!enabled) return output({ error: "pi-context is off (/pi-context on to enable)" });
			return output({ status: resets.request() }, undefined, true);
		},
	}));

	const resets = registerResetLifecycle(pi, {
		isEnabled: () => enabled,
		fallback: { customType: FALLBACK_TYPE, content: fallbackGuidance(), display: true },
		continuation: { customType: CONTINUATION_TYPE, content: CONTINUATION, display: false },
		isCurrentReset: (entryId, ctx) => {
			const entry = ctx.sessionManager.getEntry(entryId);
			return entry?.type === "compaction" && resetV2WindowId(entry.details) === currentWindowId(ctx);
		},
		onReset: (entryId) => pi.appendEntry(STATE_TYPE, { version: 1, lastResetEntryId: entryId }),
		buildReset: (event, ctx, explicit) => {
			const session8 = ctx.sessionManager.getSessionId().slice(0, 8);
			// Window IDs are independent of Pi entry IDs. Avoid reusing a window
			// identity already present on this branch.
			const windows = historyFromSession(ctx);
			const usedIds = new Set(windows.map((window) => window.windowId));
			let minted = randomUUID().slice(0, 8);
			while (usedIds.has(`pcw:${session8}:${minted}`)) minted = randomUUID().slice(0, 8);
			const windowId = `pcw:${session8}:${minted}`;
			const previousId = windows[windows.length - 1]?.windowId ?? `pcw:${session8}:root`;
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

export const internal = { MAX_NOTE_BYTES, NOTE_TYPE, BOOT_TYPE, GUIDANCE_TYPE, FALLBACK_TYPE, FALLBACK_PROMPT, RESET_MARKER_TYPE, RESET_SUMMARY, CONTINUATION, CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, CONTEXT_WINDOW_PROTOCOL_OPEN_TAG, CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG, GUIDANCE_OPEN_TAG, PI_CONTEXT_SETTINGS_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, deriveThresholds, mergePiContextSettings, lineRange, assertVirtualPath };
