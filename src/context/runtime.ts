import { getCurrentSystemMessage, Type } from "@earendil-works/pi-ai";
import { VERSION, defineTool, type ExtensionAPI, type ExtensionContext, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerBudget } from "./budget.js";
import { output } from "../tool-output.js";
import { migrateLegacyHomes } from "../notes/paths.js";
import { currentReset, currentWindowId, isCheckpointBackedReset, isWindowBoot, isWindowMarker, projectRootWindow, projectWindow, rootWindowId, type WindowMarker } from "./context-window.js";
import { registerResetLifecycle } from "./reset-lifecycle.js";
import { buildResetDrafts, resetTailCommitted } from "./reset-artifacts.js";
import { WARNING_CONTENT, WARNING_TYPE } from "../protocol.js";
import { ensureBoot, type IncompleteNotesNotifier } from "./boot.js";

declare const __PI_CONTEXT_BUILD__: { version: string; sourceHash: string };

// The bundle captures its identity; direct source loads must not claim a built hash.
const buildLabel = typeof __PI_CONTEXT_BUILD__ === "undefined"
	? "unbundled source (build unknown)"
	: `${__PI_CONTEXT_BUILD__.version} · build ${__PI_CONTEXT_BUILD__.sourceHash.slice(0, 12)}`;

function branchHasWindowMarker(ctx: ExtensionContext, fromId?: string): boolean {
	return ctx.sessionManager.getBranch(fromId).some((entry) => isWindowMarker(entry));
}

/** Register the context-window runtime and its context-owned commands/tools. */
export function registerContext(pi: ExtensionAPI, settingsManager?: SettingsManager): void {
	let enabled = true;
	let missingBootNotice: string | undefined;
	const incompleteNotesNotified = new Set<string>();
	const pendingResetNotices = new Set<string>();
	// Announce only a fully committed reset (marker + matching boot + continuation), not a
	// reset request or a partial boot repair.
	const notifyCommittedResets = (ctx: ExtensionContext, addedWindowId?: string) => {
		if (addedWindowId) pendingResetNotices.add(addedWindowId);
		if (pendingResetNotices.size === 0) return;
		const branch = ctx.sessionManager.getBranch();
		for (const windowId of pendingResetNotices) {
			const marker = branch.find((entry): entry is WindowMarker => isWindowMarker(entry) && entry.data.windowId === windowId);
			if (!marker || !isCheckpointBackedReset(ctx, marker) || !resetTailCommitted(ctx, marker.id, windowId)) continue;
			pendingResetNotices.delete(windowId);
			ctx.ui.notify(`pi-context: memory cleared · ${windowId}`, "info");
		}
	};
	pi.on("turn_start", (_event, ctx) => notifyCommittedResets(ctx));
	pi.on("agent_settled", (_event, ctx) => {
		notifyCommittedResets(ctx);
		pendingResetNotices.clear();
	});
	const notifyIncompleteNotes: IncompleteNotesNotifier = (ctx, windowId, snapshot) => {
		if (snapshot.unavailable.length === 0 || incompleteNotesNotified.has(windowId)) return;
		incompleteNotesNotified.add(windowId);
		const homes = snapshot.unavailable.map((home) => home.label).join(", ");
		ctx.ui.notify(`pi-context: notes index incomplete for ${homes}; notes_list can retry after recovery.`, "warning");
	};
	const migrationWarning = migrateLegacyHomes();
	if (migrationWarning) console.warn(`pi-context: ${migrationWarning}`);

	const budget = registerBudget(pi, () => enabled, settingsManager, (windowId) => resets.closeOut(windowId, "automatic"));

	pi.on("session_start", (_event, ctx) => {
		if (!enabled) return;
		missingBootNotice = undefined;
		pendingResetNotices.clear();
		ensureBoot(pi, ctx, notifyIncompleteNotes);
	});
	pi.on("session_tree", (_event, ctx) => {
		missingBootNotice = undefined;
		pendingResetNotices.clear();
		if (enabled) ensureBoot(pi, ctx, notifyIncompleteNotes);
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
			if (reset) {
				if (!event.messages.some((message) => isWindowBoot(message, windowId))) throw new Error(`Missing boot for context window ${windowId}`);
				return { messages: isCheckpointBackedReset(ctx, reset) ? event.messages : projectWindow(event.messages, windowId) };
			}
			return { messages: projectRootWindow(event.messages, windowId) };
		} catch (error) {
			if (missingBootNotice !== windowId) {
				missingBootNotice = windowId;
				ctx.ui.notify(`pi-context: active context window ${windowId} has no visible boot; request cancelled safely. Use /wipe-memory to start another window.`, "error");
			}
			ctx.abort();
			const safeHead = getCurrentSystemMessage(event.messages);
			return { messages: safeHead ? [safeHead] : [] };
		}
	});

	pi.registerCommand("pi-context", {
		description: "Show loaded version/build and toggle pi-context context windows",
		getArgumentCompletions: (prefix) =>
			["on", "off"].filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
		handler: async (args, cmdCtx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				enabled = true;
				ensureBoot(pi, cmdCtx, notifyIncompleteNotes);
			} else if (arg === "off") {
				enabled = false;
				budget.clear();
				resets.clear();
			} else if (arg !== "") {
				cmdCtx.ui.notify("Usage: /pi-context [on|off]", "error");
				return;
			}
			cmdCtx.ui.notify(`pi-context: ${enabled ? "on" : "off"} · ${buildLabel} · Pi ${VERSION}`, "info");
		},
	});

	pi.registerCommand("wipe-memory", {
		description: "Ask the agent to close out its notes, then start a fresh context window",
		handler: async (_args, cmdCtx) => {
			if (!enabled) {
				cmdCtx.ui.notify("pi-context: /wipe-memory requires /pi-context on.", "error");
				return;
			}
			const requestedWindowId = currentWindowId(cmdCtx);
			await cmdCtx.waitForIdle();
			if (!enabled || currentWindowId(cmdCtx) !== requestedWindowId) return;
			const armed = resets.closeOut(requestedWindowId, "manual");
			if (armed === "already-pending") return;
			try {
				pi.sendMessage({ customType: WARNING_TYPE, content: WARNING_CONTENT, display: false }, { triggerTurn: true });
			} catch (error) {
				resets.clear();
				cmdCtx.ui.notify(`pi-context: could not start manual close-out (${String(error)}).`, "error");
				return;
			}
			await cmdCtx.waitForIdle();
		},
	});

	pi.registerTool(defineTool({
		name: "wipe_memory",
		label: "Wipe memory",
		description: "Wipe your in-context memory and start a fresh context window. Your session, notes, and history survive.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _update, ctx) {
			if (!enabled) return output({ error: "pi-context is off (/pi-context on to enable)" });
			return output({ status: resets.request(currentWindowId(ctx)) }, undefined, true);
		},
	}));

	const resets = registerResetLifecycle(pi, {
		isEnabled: () => enabled,
		buildReset: (ctx) => {
			const drafts = buildResetDrafts(ctx, notifyIncompleteNotes);
			pendingResetNotices.add(drafts[2].details.windowId);
			return drafts;
		},
		budget,
	});
}
