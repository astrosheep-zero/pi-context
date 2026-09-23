import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BOOT_TYPE, CONTINUATION, CONTINUATION_TYPE, RESET_MARKER_TYPE } from "../protocol.js";
import { currentWindowId, isWindowBootEntry, isWindowMarker, previousWindowId, type WindowMarker } from "./context-window.js";
import { buildBootMessage, sendBoot, type IncompleteNotesNotifier } from "./boot.js";

export type ResetTailState = { readonly boot: boolean; readonly continuation: boolean };

/** Match the hidden continuation entry that carries the one reset message. */
export function isWindowContinuationEntry(entry: SessionEntry): boolean {
	return entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE;
}

/** The single continuation sender: the only reset prose persisted for a window. */
export function sendContinuation(pi: ExtensionAPI): void {
	pi.sendMessage(
		{ customType: CONTINUATION_TYPE, content: CONTINUATION, display: false },
		{ triggerTurn: false },
	);
}

/**
 * The closed, ordered reset shape: retain-none native checkpoint, marker, matching boot,
 * continuation. This is the one source of the reset message and new window identity.
 */
export function buildResetDrafts(ctx: ExtensionContext, notifyIncompleteNotes?: IncompleteNotesNotifier) {
	const sessionPrefix = ctx.sessionManager.getSessionId().slice(0, 8);
	const usedWindowIds = new Set(
		ctx.sessionManager.getBranch().filter(isWindowMarker).map((entry) => entry.data.windowId),
	);
	let windowId: string;
	do {
		windowId = `pcw:${sessionPrefix}:${randomUUID().slice(0, 8)}`;
	} while (usedWindowIds.has(windowId));
	const boot = buildBootMessage(ctx, windowId, currentWindowId(ctx), notifyIncompleteNotes);
	return [
		{ type: "compaction", summary: "", firstKeptEntryId: null },
		{ type: "custom", customType: RESET_MARKER_TYPE, data: { windowId } },
		{ type: "custom_message", customType: BOOT_TYPE, content: boot.content, display: false, details: { windowId } },
		{ type: "custom_message", customType: CONTINUATION_TYPE, content: CONTINUATION, display: false },
	] satisfies [SessionBoundaryDraft, SessionBoundaryDraft, SessionBoundaryDraft, SessionBoundaryDraft];
}

/**
 * Inspect the persisted tail of a reset marker. It reports which reset messages are present
 * only while the tail stays repairable: metadata may follow the marker, but real conversation,
 * a foreign message, a later marker, or a misordered/duplicate reset artifact refuses repair.
 */
export function inspectResetTail(ctx: ExtensionContext, markerId: string, windowId: string): ResetTailState | undefined {
	const branch = ctx.sessionManager.getBranch();
	const markerIndex = branch.findIndex((entry) => entry.id === markerId);
	if (markerIndex < 0) return undefined;
	let boot = false;
	let continuation = false;
	for (const entry of branch.slice(markerIndex + 1)) {
		if (isWindowBootEntry(entry, windowId)) {
			// The boot is unique and must precede the continuation; a repeat or a late
			// boot would move the provider boundary or misorder the reset shape.
			if (boot || continuation) return undefined;
			boot = true;
			continue;
		}
		if (isWindowContinuationEntry(entry)) {
			if (continuation || !boot) return undefined;
			continuation = true;
			continue;
		}
		if (isWindowMarker(entry) || entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary") {
			return undefined;
		}
	}
	return { boot, continuation };
}

/** True once the marker's tail already carries its boot and continuation in a valid order. */
export function resetTailCommitted(ctx: ExtensionContext, markerId: string, windowId: string): boolean {
	const tail = inspectResetTail(ctx, markerId, windowId);
	return tail?.boot === true && tail.continuation === true;
}

/** Emit only the reset artifacts an incomplete tail is missing, in the closed order. */
export function repairResetTail(pi: ExtensionAPI, ctx: ExtensionContext, marker: WindowMarker, notifyIncompleteNotes?: IncompleteNotesNotifier): void {
	const tail = inspectResetTail(ctx, marker.id, marker.data.windowId);
	if (!tail || (tail.boot && tail.continuation)) return;
	if (!tail.boot) sendBoot(pi, buildBootMessage(ctx, marker.data.windowId, previousWindowId(ctx, marker.id), notifyIncompleteNotes));
	if (!tail.continuation) sendContinuation(pi);
}
