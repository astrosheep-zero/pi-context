export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_REMINDER_MARGIN_TOKENS = 24_576;
/**
 * The runway: the budget between the final warning and the wipe, deliberately
 * invisible to the model. get_context_remaining counts down to zero at the warning
 * line (reserve + WARNING_RUNWAY_TOKENS); what lies below is overdraft the model
 * never sees — Codex's fallback buffer, relocated above the line.
 */
export const WARNING_RUNWAY_TOKENS = 12_288;
