import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WARNING_TYPE, GUIDANCE_OPEN_TAG, GUIDANCE_CLOSE_TAG, WARNING_PROMPT } from "./protocol.js";
import { thresholdsFor, resetThresholds, type ResolvedThresholds } from "./thresholds.js";
import { hasWindowMessage, currentWindowId } from "./history.js";

/**
 * The final checkpoint warning, steered to the model once per window. Like the early
 * reminder, the steer text is model-facing only (display: false); the human learns
 * about it from the warning-level notify, not from a chat-visible message.
 */

/** Trigger: does the steer fire at this remaining-token count? Pure. */
export function warningDue(remaining: number, thresholds: ResolvedThresholds): boolean {
	return remaining <= thresholds.warning;
}

/** Delivery: what happens when it fires. */
export function steerWarning(pi: ExtensionAPI, ctx: ExtensionContext, thresholds: ResolvedThresholds, remaining: number): void {
	pi.sendMessage({ customType: WARNING_TYPE, content: `${GUIDANCE_OPEN_TAG}\n${WARNING_PROMPT}\n${GUIDANCE_CLOSE_TAG}`, display: false }, { triggerTurn: true });
	ctx.ui.notify(`pi-context: context budget critical (${Math.max(0, remaining - thresholds.reserve)} tokens before reserve) — final checkpoint warning steered to the model.`, "warning");
}

/** Registration: once-per-window guard plus trigger+delivery on the context hook. */
export function registerWarning(pi: ExtensionAPI, isEnabled: () => boolean): void {
	let firedInWindow: string | undefined;
	// Threshold resolution is owned by budget.ts; this module only consumes the shared
	// cache (lazily on the context hook) so session_start never warns twice.
	pi.on("session_start", () => { firedInWindow = undefined; });
	pi.on("session_tree", () => { firedInWindow = undefined; resetThresholds(); });
	pi.on("context", (_event, ctx) => {
		const windowId = currentWindowId(ctx);
		if (!isEnabled() || firedInWindow === windowId || hasWindowMessage(ctx, WARNING_TYPE)) return undefined;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return undefined;
		const remaining = Math.max(0, usage.contextWindow - usage.tokens);
		const thresholds = thresholdsFor(ctx);
		if (!warningDue(remaining, thresholds)) return undefined;
		firedInWindow = windowId;
		// The steer reaches the model at the next sampling step with
		// ~WARNING_TRIGGER_TOKENS of runway left. After it, the model decides for
		// itself: end the window, or ride it into Pi's automatic compaction, which
		// resets on the spot with no turn (see reset-lifecycle).
		steerWarning(pi, ctx, thresholds, remaining);
		return undefined;
	});
}
