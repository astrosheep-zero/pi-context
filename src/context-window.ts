import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BOOT_TYPE } from "./protocol.js";
import { currentReset } from "./history.js";

function hasWindowId(details: unknown, windowId: string): boolean {
	return typeof details === "object" && details !== null &&
		typeof (details as { windowId?: unknown }).windowId === "string" &&
		(details as { windowId: string }).windowId === windowId;
}

/** Match a provider-facing boot message, optionally by window identity. */
export function isWindowBoot(message: AgentMessage, windowId?: string): boolean {
	return message.role === "custom" && message.customType === BOOT_TYPE && (windowId === undefined || hasWindowId(message.details, windowId));
}

/**
 * The durable marker selects a boot message by identity, never by wall-clock time.
 * The boot is the first conversation message of the window. Folding only its prefix
 * preserves later prompt/tool patches in place, including their cacheable ordering.
 */
export function projectWindow(messages: AgentMessage[], windowId: string): AgentMessage[] {
	const cut = messages.findIndex((message) => isWindowBoot(message, windowId));
	if (cut < 0) throw new Error(`Missing boot for context window ${windowId}`);
	const head = getCurrentSystemMessage(messages.slice(0, cut));
	const suffix = messages.slice(cut);
	return head ? [head, ...suffix] : suffix;
}

/**
 * Root windows are not reset boundaries. A forked session can copy a root boot whose
 * details name the source session; refresh that boot in-place in the provider projection
 * while retaining every user/assistant/tool message from the copied root transcript.
 */
export function projectRootWindow(messages: AgentMessage[], windowId: string): AgentMessage[] {
	const matching = messages.filter((message) => isWindowBoot(message, windowId));
	if (matching.length === 0) return messages;
	const activeBoot = matching[matching.length - 1];
	const firstBoot = messages.findIndex((message) => isWindowBoot(message));
	const withoutBoots = messages.filter((message) => !isWindowBoot(message));
	return [...withoutBoots.slice(0, firstBoot), activeBoot, ...withoutBoots.slice(firstBoot)];
}

/** Usage for the selected window, excluding provider usage recorded before its marker. */
export function windowUsage(ctx: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "model">) {
	const reset = currentReset(ctx);
	if (!reset) return ctx.getContextUsage();
	const contextWindow = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow;
	if (!contextWindow) return undefined;
	const windowId = reset.data.windowId;
	try {
		const messages: AgentMessage[] = projectWindow(ctx.sessionManager.buildSessionProjection().messages, windowId);
		const { tokens } = estimateContextTokens(convertToLlm(messages));
		return { tokens, contextWindow, percent: tokens / contextWindow * 100 };
	} catch {
		// A marker can be durable before its boot when a process stops between the two
		// public writes. Startup/tree repair will append the missing boot; until then the
		// budget hook must not turn a recoverable partial append into a swallowed error.
		return undefined;
	}
}
