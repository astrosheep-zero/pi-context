import { getCurrentSystemMessage, Type } from "@earendil-works/pi-ai";
import { VERSION, defineTool, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { registerBudget } from "./budget.js";
import { output } from "../tool-output.js";
import { BOOT_TYPE, RESET_MARKER_TYPE, CONTINUATION_TYPE, CONTINUATION } from "../protocol.js";
import { agentSlug, migrateLegacyHomes, modelSlug } from "../notes/paths.js";
import { loadNotesSnapshot, type NotesSnapshot } from "../notes/notes-snapshot.js";
import { renderBootBlock } from "./prompts.js";
import { currentReset, currentWindowId, isWindowBoot, isWindowMarker, projectRootWindow, projectWindow, rootWindowId } from "./context-window.js";
import { registerResetLifecycle } from "./reset-lifecycle.js";

declare const __PI_CONTEXT_BUILD__: { version: string; sourceHash: string };

// The bundle captures its identity; direct source loads must not claim a built hash.
const buildLabel = typeof __PI_CONTEXT_BUILD__ === "undefined"
	? "unbundled source (build unknown)"
	: `${__PI_CONTEXT_BUILD__.version} · build ${__PI_CONTEXT_BUILD__.sourceHash.slice(0, 12)}`;

type IncompleteNotesNotifier = (ctx: ExtensionContext, windowId: string, snapshot: NotesSnapshot) => void;

function bootContent(ctx: ExtensionContext, currentId: string, previousId: string | undefined, resetLine: boolean, notes: NotesSnapshot): string {
	return renderBootBlock({
		agentName: agentSlug(ctx),
		modelName: modelSlug(ctx),
		firstWindowId: rootWindowId(ctx.sessionManager.getSessionId()),
		currentWindowId: currentId,
		previousWindowId: previousId,
		resetLine,
		notes,
	});
}

function buildResetDrafts(ctx: ExtensionContext, notifyIncompleteNotes?: IncompleteNotesNotifier) {
	const sessionPrefix = ctx.sessionManager.getSessionId().slice(0, 8);
	const usedWindowIds = new Set(
		ctx.sessionManager.getBranch().filter(isWindowMarker).map((entry) => entry.data.windowId),
	);
	let windowId: string;
	do {
		windowId = `pcw:${sessionPrefix}:${randomUUID().slice(0, 8)}`;
	} while (usedWindowIds.has(windowId));
	const notes = loadNotesSnapshot(ctx);
	notifyIncompleteNotes?.(ctx, windowId, notes);
	return [
		{ type: "custom", customType: RESET_MARKER_TYPE, data: { windowId } },
		{
			type: "custom_message",
			customType: BOOT_TYPE,
			content: bootContent(ctx, windowId, currentWindowId(ctx), true, notes),
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

function ensureBoot(pi: ExtensionAPI, ctx: ExtensionContext, notifyIncompleteNotes?: IncompleteNotesNotifier): void {
	const reset = currentReset(ctx);
	const sessionId = ctx.sessionManager.getSessionId();
	const windowId = reset?.data?.windowId ?? rootWindowId(sessionId);
	if (ctx.sessionManager.buildSessionProjection().messages.some((message) => isWindowBoot(message, windowId))) return;
	if (reset && !resetBootMayBeRepaired(ctx, reset.id, windowId)) return;
	let previousId: string | undefined = reset ? rootWindowId(sessionId) : undefined;
	if (reset) {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.id === reset.id) break;
			if (isWindowMarker(entry)) previousId = entry.data.windowId;
		}
	}
	const notes = loadNotesSnapshot(ctx);
	notifyIncompleteNotes?.(ctx, windowId, notes);
	pi.sendMessage(
		{ customType: BOOT_TYPE, content: bootContent(ctx, windowId, previousId, reset !== undefined, notes), display: false, details: { windowId } },
		{ triggerTurn: false },
	);
}

function persistManualReset(pi: ExtensionAPI, ctx: ExtensionContext, notifyIncompleteNotes?: IncompleteNotesNotifier): string {
	const [marker, boot] = buildResetDrafts(ctx, notifyIncompleteNotes);
	pi.appendEntry(marker.customType, marker.data);
	pi.sendMessage(
		{ customType: boot.customType, content: boot.content, display: boot.display, details: boot.details },
		{ triggerTurn: false },
	);
	return boot.details.windowId;
}

function resetBootMayBeRepaired(ctx: ExtensionContext, markerId: string, windowId: string): boolean {
	const branch = ctx.sessionManager.getBranch();
	const markerIndex = branch.findIndex((entry) => entry.id === markerId);
	if (markerIndex < 0) return false;
	const afterMarker = branch.slice(markerIndex + 1);
	// A raw boot is authoritative even when a later context_edit hides it from the
	// projection. Appending another boot at the tail would move the boundary.
	if (afterMarker.some((entry) => isWindowBootEntry(entry, windowId))) return false;
	// Only a genuinely incomplete marker tail can be repaired. Once conversation or
	// a context-bearing custom message follows it, refusing is safer than guessing.
	return !afterMarker.some((entry) => entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary");
}

function isWindowBootEntry(entry: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number], windowId: string): boolean {
	return entry.type === "custom_message" && entry.customType === BOOT_TYPE &&
		typeof entry.details === "object" && entry.details !== null &&
		typeof (entry.details as { windowId?: unknown }).windowId === "string" &&
		(entry.details as { windowId: string }).windowId === windowId;
}

function branchHasWindowMarker(ctx: ExtensionContext, fromId?: string): boolean {
	return ctx.sessionManager.getBranch(fromId).some((entry) => isWindowMarker(entry));
}

/** Register the context-window runtime and its context-owned commands/tools. */
export function registerContext(pi: ExtensionAPI, settingsManager?: SettingsManager): void {
	let enabled = true;
	let missingBootNotice: string | undefined;
	const incompleteNotesNotified = new Set<string>();
	const pendingResetNotices = new Set<string>();
	const notifyCommittedResets = (ctx: ExtensionContext, addedWindowId?: string) => {
		if (addedWindowId) pendingResetNotices.add(addedWindowId);
		if (pendingResetNotices.size === 0) return;
		const branch = ctx.sessionManager.getBranch();
		for (const windowId of pendingResetNotices) {
			if (!branch.some((entry) => isWindowMarker(entry) && entry.data.windowId === windowId) ||
				!branch.some((entry) => isWindowBootEntry(entry, windowId))) continue;
			pendingResetNotices.delete(windowId);
			ctx.ui.notify(`pi-context: memory cleared · ${windowId}`, "info");
		}
	};
	// Announce only a committed reset (marker + boot), not a reset request or boot repair.
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

	const budget = registerBudget(pi, () => enabled, settingsManager);

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
			return { messages: reset ? projectWindow(event.messages, windowId) : projectRootWindow(event.messages, windowId) };
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
		description: "Persist a fresh context window without calling the model",
		handler: async (_args, cmdCtx) => {
			if (!enabled) {
				cmdCtx.ui.notify("pi-context: /wipe-memory requires /pi-context on.", "error");
				return;
			}
			await cmdCtx.waitForIdle();
			if (!enabled) return;
			resets.clear();
			notifyCommittedResets(cmdCtx, persistManualReset(pi, cmdCtx, notifyIncompleteNotes));
		},
	});

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
		buildReset: (ctx) => {
			const drafts = buildResetDrafts(ctx, notifyIncompleteNotes);
			pendingResetNotices.add(drafts[1].details.windowId);
			return drafts;
		},
		budget,
	});
}
