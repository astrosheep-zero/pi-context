import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadNotesSnapshot, type NotesSnapshot } from "../notes/notes-snapshot.js";
import { agentSlug, modelSlug } from "../notes/paths.js";
import { BOOT_TYPE } from "../protocol.js";
import { renderBootBlock } from "./prompts.js";
import { currentReset, isWindowBoot, rootWindowId } from "./context-window.js";
import { repairResetTail } from "./reset-artifacts.js";

export type IncompleteNotesNotifier = (ctx: ExtensionContext, windowId: string, snapshot: NotesSnapshot) => void;

/** The boot custom message: identity, notes snapshot, and static protocol; never reset prose. */
export type BootMessage = {
	readonly customType: string;
	readonly content: string;
	readonly display: false;
	readonly details: { windowId: string };
};

/** Render the boot block from the live context; acquisition stays with loadNotesSnapshot. */
function bootContent(ctx: ExtensionContext, currentId: string, previousId: string | undefined, notes: NotesSnapshot): string {
	return renderBootBlock({
		agentName: agentSlug(ctx),
		modelName: modelSlug(ctx),
		firstWindowId: rootWindowId(ctx.sessionManager.getSessionId()),
		currentWindowId: currentId,
		previousWindowId: previousId,
		notes,
	});
}

/**
 * Acquire one notes snapshot and build the boot custom message for a window. The caller
 * supplies `previousId` only when a reset boundary needs the prior window identity.
 */
export function buildBootMessage(
	ctx: ExtensionContext,
	windowId: string,
	previousId: string | undefined,
	notifyIncompleteNotes?: IncompleteNotesNotifier,
): BootMessage {
	const notes = loadNotesSnapshot(ctx);
	notifyIncompleteNotes?.(ctx, windowId, notes);
	return { customType: BOOT_TYPE, content: bootContent(ctx, windowId, previousId, notes), display: false, details: { windowId } };
}

/** Persist one hidden boot message without triggering a model turn. */
export function sendBoot(pi: ExtensionAPI, boot: BootMessage): void {
	pi.sendMessage(
		{ customType: boot.customType, content: boot.content, display: boot.display, details: boot.details },
		{ triggerTurn: false },
	);
}

/**
 * Boot entry point for `session_start` / `session_tree`. Ordinary startup ensures one root
 * boot; a reset marker instead asks reset-artifact repair to complete its persisted tail.
 * Boot idempotence lives here: an already-projected root boot or a complete reset tail emits nothing.
 */
export function ensureBoot(pi: ExtensionAPI, ctx: ExtensionContext, notifyIncompleteNotes?: IncompleteNotesNotifier): void {
	const reset = currentReset(ctx);
	if (reset) {
		repairResetTail(pi, ctx, reset, notifyIncompleteNotes);
		return;
	}
	const windowId = rootWindowId(ctx.sessionManager.getSessionId());
	if (ctx.sessionManager.buildSessionProjection().messages.some((message) => isWindowBoot(message, windowId))) return;
	sendBoot(pi, buildBootMessage(ctx, windowId, undefined, notifyIncompleteNotes));
}
