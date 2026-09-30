export const GUIDANCE_OPEN_TAG = "<context_window_guidance>";
export const GUIDANCE_CLOSE_TAG = "</context_window_guidance>";

/**
 * Codex-equivalent low-budget reminder. The measured remaining count is frozen into
 * the text at the crossing that fires it, so each persisted copy is a snapshot true
 * at write time; get_context_remaining remains the live source for the current figure.
 */
export function tokenBudgetGuidance(remaining: number, wipeTool: string): string {
	return `${GUIDANCE_OPEN_TAG}\nOnly ${remaining} tokens left before you get wiped. While you still have room, update your notes, rescue anything still only in your head, crumple the notes that stopped telling the truth, and keep any \`MAP.md\` honest. If you're ready, call \`${wipeTool}\` and go out on your own terms.\n${GUIDANCE_CLOSE_TAG}`;
}
