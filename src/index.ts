import { getCurrentSystemMessage, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { registerHistoryTools } from "./history-tools.js";
import { registerNotesTools } from "./notes/tools.js";
import { registerBudget } from "./budget.js";
import { output } from "./tool-output.js";
import { automaticResetEnabled, deriveThresholds, mergePiContextSettings } from "./thresholds.js";
import { NOTE_TYPE, BOOT_TYPE, GUIDANCE_TYPE, WARNING_TYPE, RESET_MARKER_TYPE, CONTINUATION_TYPE, MAX_NOTE_BYTES, CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, CONTEXT_WINDOW_PROTOCOL_OPEN_TAG, CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG, GUIDANCE_OPEN_TAG, PI_CONTEXT_SETTINGS_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, WARNING_RUNWAY_TOKENS, RESET_SUMMARY, CONTINUATION, WARNING_PROMPT } from "./protocol.js";
import { currentReset, currentWindowId, isWindowMarker, rootWindowId } from "./history.js";
import { assertVirtualPath } from "./notes/model.js";
import { migrateLegacyHomes } from "./notes/paths.js";
import { bootBlock } from "./prompts.js";
import { isWindowBoot, projectRootWindow, projectWindow } from "./context-window.js";
import { registerResetLifecycle } from "./reset-lifecycle.js";
import { registerWarning } from "./warning.js";
export { historyFromSession } from "./history.js";
export { notesFromSession } from "./notes/model.js";

function buildResetDrafts(ctx: ExtensionContext) {
	const sessionPrefix = ctx.sessionManager.getSessionId().slice(0, 8);
	const usedWindowIds = new Set(
		ctx.sessionManager.getBranch().filter(isWindowMarker).map((entry) => entry.data.windowId),
	);
	let windowId: string;
	do {
		windowId = `pcw:${sessionPrefix}:${randomUUID().slice(0, 8)}`;
	} while (usedWindowIds.has(windowId));
	return [
		{ type: "custom", customType: RESET_MARKER_TYPE, data: { windowId } },
		{
			type: "custom_message",
			customType: BOOT_TYPE,
			content: bootBlock(ctx, windowId, currentWindowId(ctx), true),
			display: false,
			details: { windowId },
		},
		{
			type: "custom_message",
			customType: CONTINUATION_TYPE,
			content: CONTINUATION,
			display: false,
		},
	] satisfies [SessionBoundaryDraft, SessionBoundaryDraft, SessionBoundaryDraft];
}

function ensureBoot(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const reset = currentReset(ctx);
	const sessionId = ctx.sessionManager.getSessionId();
	const windowId = reset?.data?.windowId ?? rootWindowId(sessionId);
	if (ctx.sessionManager.buildSessionProjection().messages.some((message) => isWindowBoot(message, windowId))) return;
	let previousId: string | undefined = reset ? rootWindowId(sessionId) : undefined;
	if (reset) {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.id === reset.id) break;
			if (isWindowMarker(entry)) previousId = entry.data.windowId;
		}
	}
	pi.sendMessage(
		{ customType: BOOT_TYPE, content: bootBlock(ctx, windowId, previousId, reset !== undefined), display: false, details: { windowId } },
		{ triggerTurn: false },
	);
}

function persistManualReset(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const [marker, boot] = buildResetDrafts(ctx);
	pi.appendEntry(marker.customType, marker.data);
	pi.sendMessage(
		{ customType: boot.customType, content: boot.content, display: boot.display, details: boot.details },
		{ triggerTurn: false },
	);
}

function branchHasWindowMarker(ctx: ExtensionContext, fromId?: string): boolean {
	return ctx.sessionManager.getBranch(fromId).some((entry) => isWindowMarker(entry));
}

export default function piContext(pi: ExtensionAPI) {
	let enabled = true;
	let missingBootNotice: string | undefined;
	const migrationWarning = migrateLegacyHomes();
	if (migrationWarning) console.warn(`pi-context: ${migrationWarning}`);

	registerBudget(pi, () => enabled);
	registerWarning(pi, () => enabled);

	pi.on("session_start", (_event, ctx) => {
		if (!enabled) return;
		missingBootNotice = undefined;
		ensureBoot(pi, ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		missingBootNotice = undefined;
		if (enabled) ensureBoot(pi, ctx);
	});

	// Pi's branch summarizer receives raw entries and bypasses context_with_system. Do not
	// let a summary of a reset branch smuggle erased history back into the destination.
	pi.on("session_before_tree", (event, ctx) => {
		if (!event.preparation.userWantsSummary) return undefined;
		if (!branchHasWindowMarker(ctx) && !branchHasWindowMarker(ctx, event.preparation.targetId)) return undefined;
		ctx.ui.notify("pi-context: skipped branch summary across a reset window; navigation continues without erased history.", "info");
		return { summary: { summary: "" } };
	});

	// This is the final provider-facing projection. Reset windows cut at their matching boot;
	// root windows only refresh a forked boot identity and retain the copied root transcript.
	pi.on("context_with_system", (event, ctx) => {
		const reset = currentReset(ctx);
		const windowId = reset?.data.windowId ?? rootWindowId(ctx.sessionManager.getSessionId());
		try {
			return { messages: reset ? projectWindow(event.messages, windowId) : projectRootWindow(event.messages, windowId) };
		} catch (error) {
			if (missingBootNotice !== windowId) {
				missingBootNotice = windowId;
				ctx.ui.notify(`pi-context: missing boot for active context window ${windowId}; request cancelled until startup/tree repair completes.`, "error");
			}
			ctx.abort();
			const safeHead = getCurrentSystemMessage(event.messages);
			return { messages: safeHead ? [safeHead] : [] };
		}
	});

	pi.registerCommand("pi-context", {
		description: "Toggle pi-context: context_window boot block, low-budget guidance, and reset-style context windows",
		getArgumentCompletions: (prefix) =>
			["on", "off"].filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
		handler: async (args, cmdCtx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				enabled = true;
				ensureBoot(pi, cmdCtx);
			} else if (arg === "off") {
				enabled = false;
				resets.clear();
			} else if (arg !== "") {
				cmdCtx.ui.notify("Usage: /pi-context [on|off]", "error");
				return;
			}
			cmdCtx.ui.notify(`pi-context: ${enabled ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("clear-context", {
		description: "Persist a fresh context window without calling the model",
		handler: async (_args, cmdCtx) => {
			if (!enabled) {
				cmdCtx.ui.notify("pi-context: /clear-context requires /pi-context on.", "error");
				return;
			}
			await cmdCtx.waitForIdle();
			if (!enabled) return;
			resets.clear();
			persistManualReset(pi, cmdCtx);
			cmdCtx.ui.notify("pi-context: context cleared; the next prompt starts in a fresh window.", "info");
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
		automaticResetEnabled,
		buildReset: buildResetDrafts,
	});
}

export const internal = { MAX_NOTE_BYTES, NOTE_TYPE, BOOT_TYPE, GUIDANCE_TYPE, WARNING_TYPE, CONTINUATION_TYPE, WARNING_PROMPT, WARNING_RUNWAY_TOKENS, RESET_MARKER_TYPE, RESET_SUMMARY, CONTINUATION, CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, CONTEXT_WINDOW_PROTOCOL_OPEN_TAG, CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG, GUIDANCE_OPEN_TAG, PI_CONTEXT_SETTINGS_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, deriveThresholds, mergePiContextSettings, assertVirtualPath };
