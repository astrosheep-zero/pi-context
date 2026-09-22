import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WARNING_TYPE, GUIDANCE_OPEN_TAG, GUIDANCE_CLOSE_TAG, WARNING_PROMPT } from "./protocol.js";
import { thresholdsFor, resetThresholds, type ResolvedThresholds } from "./thresholds.js";
import { hasWindowMessage, currentWindowId } from "./history.js";
import { remainingTokens } from "./budget.js";

/**
 * The final checkpoint warning, steered to the model once per window. Like the early
 * reminder, the steer text is model-facing only (display: false); the human learns
 * about it from the warning-level notify, not from a chat-visible message.
 */

/** Trigger: does the steer fire at this remaining-token count? Pure. */
export function warningDue(remaining: number, thresholds: ResolvedThresholds): boolean {
	return remaining <= thresholds.warning;
}

/** Registration: once-per-window guard plus trigger+delivery on the context hook. */
export function registerWarning(pi: ExtensionAPI, isEnabled: () => boolean): void {
	let firedInWindow: string | undefined;
	let pendingBoundaryWarning: { windowId: string; content: string } | undefined;
	// Threshold resolution is owned by budget.ts; this module only consumes the shared
	// cache (lazily on the context hook) so session_start never warns twice.
	pi.on("session_start", () => { firedInWindow = undefined; pendingBoundaryWarning = undefined; });
	pi.on("session_tree", () => { firedInWindow = undefined; pendingBoundaryWarning = undefined; resetThresholds(); });
	pi.on("agent_end", () => { pendingBoundaryWarning = undefined; });
	pi.on("turn_end", (event, ctx) => {
		const pending = pendingBoundaryWarning;
		if (!pending || pending.windowId !== currentWindowId(ctx)) return undefined;
		pendingBoundaryWarning = undefined;
		return {
			entries: [
				...(event.entries ?? []),
				{ type: "custom_message", customType: WARNING_TYPE, content: pending.content, display: false },
			],
		};
	});
	pi.on("context", (event, ctx) => {
		const windowId = currentWindowId(ctx);
		if (!isEnabled() || firedInWindow === windowId || hasWindowMessage(ctx, WARNING_TYPE)) return undefined;
		const remaining = remainingTokens(ctx);
		if (remaining === null) return undefined;
		const thresholds = thresholdsFor(ctx);
		if (!warningDue(remaining, thresholds)) return undefined;
		firedInWindow = windowId;
		// Keep the warning visible in this provider request, but defer its durable
		// session entry to turn_end so it is ordered with the lifecycle's reset drafts.
		const content = `${GUIDANCE_OPEN_TAG}\n${WARNING_PROMPT}\n${GUIDANCE_CLOSE_TAG}`;
		pendingBoundaryWarning = { windowId, content };
		const warningMessage = {
			role: "custom" as const,
			customType: WARNING_TYPE,
			content,
			display: false,
			timestamp: Date.now(),
		} satisfies AgentMessage;
		ctx.ui.notify("pi-context: context budget critical — final checkpoint warning steered to the model.", "warning");
		return { messages: [...event.messages, warningMessage] };
	});
}
