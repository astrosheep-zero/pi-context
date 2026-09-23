import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notesContextFromPi } from "../pi/notes/adapter.js";
import { loadNotesSnapshot, type NotesSnapshot } from "../pi/notes/snapshot.js";
import { BOOT_TYPE } from "../protocol.js";
import { renderBootBlock } from "./prompts.js";
import { currentReset, currentWindowId, isWindowBoot, rootWindowId } from "./context-window.js";
import { repairResetTail } from "./reset-artifacts.js";

export type IncompleteNotesNotifier = (ctx: ExtensionContext, windowId: string, snapshot: NotesSnapshot) => void;

/** The boot custom message: identity, notes snapshot, and static protocol; never reset prose. */
export type BootMessage = {
	readonly customType: string;
	readonly content: string;
	readonly display: false;
	readonly details: { windowId: string };
};

/** Render the boot block from one pre-await identity and acquired notes snapshot. */
function bootContent(
	agentName: string,
	modelName: string,
	firstWindowId: string,
	currentId: string,
	previousId: string | undefined,
	notes: NotesSnapshot,
): string {
	return renderBootBlock({ agentName, modelName, firstWindowId, currentWindowId: currentId, previousWindowId: previousId, notes });
}

/**
 * Acquire one notes snapshot and build the boot custom message for a window. All identity
 * fields are captured synchronously before the first filesystem await.
 */
export async function buildBootMessage(
	ctx: ExtensionContext,
	windowId: string,
	previousId: string | undefined,
	notifyIncompleteNotes?: IncompleteNotesNotifier,
	isCurrent: () => boolean = () => true,
): Promise<BootMessage> {
	const identity = notesContextFromPi(ctx);
	const notes = await loadNotesSnapshot(ctx, undefined, identity);
	if (isCurrent()) notifyIncompleteNotes?.(ctx, windowId, notes);
	return {
		customType: BOOT_TYPE,
		content: bootContent(identity.agent, identity.model, rootWindowId(identity.sessionId), windowId, previousId, notes),
		display: false,
		details: { windowId },
	};
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
 */
export async function ensureBoot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	notifyIncompleteNotes?: IncompleteNotesNotifier,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	const sessionId = ctx.sessionManager.getSessionId();
	const reset = currentReset(ctx);
	const windowId = reset?.data.windowId ?? rootWindowId(sessionId);
	const stillCurrent = () => isCurrent() &&
		ctx.signal?.aborted !== true &&
		ctx.sessionManager.getSessionId() === sessionId &&
		currentWindowId(ctx) === windowId;
	if (reset) {
		await repairResetTail(pi, ctx, reset, notifyIncompleteNotes, stillCurrent);
		return;
	}
	if (ctx.sessionManager.buildSessionProjection().messages.some((message) => isWindowBoot(message, windowId))) return;
	const boot = await buildBootMessage(ctx, windowId, undefined, notifyIncompleteNotes, stillCurrent);
	if (!stillCurrent()) return;
	if (ctx.sessionManager.buildSessionProjection().messages.some((message) => isWindowBoot(message, windowId))) return;
	sendBoot(pi, boot);
}
