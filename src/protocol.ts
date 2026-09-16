export const STATE_TYPE = "pi-context/state";
export const NOTE_TYPE = "pi-context/note";
export const BOOT_TYPE = "pi-context/boot";
export const GUIDANCE_TYPE = "pi-context/guidance";
export const FALLBACK_TYPE = "pi-context/fallback";
export const RESET_MARKER_TYPE = "pi-context/reset-marker";
export const CONTINUATION_TYPE = "pi-context/continuation";
export const RESET_V2 = "reset-v2";
export const MAX_NOTE_BYTES = 1_000_000;
export const CONTEXT_WINDOW_OPEN_TAG = "<context_window>";
export const CONTEXT_WINDOW_CLOSE_TAG = "</context_window>";
export const CONTEXT_WINDOW_PROTOCOL_OPEN_TAG = "<context_window_protocol>";
export const CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG = "</context_window_protocol>";
export const GUIDANCE_OPEN_TAG = "<context_window_guidance>";
export const GUIDANCE_CLOSE_TAG = "</context_window_guidance>";
export const PI_CONTEXT_SETTINGS_KEY = "pi-context";
export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_REMINDER_MARGIN_TOKENS = 24_576;
export const RESET_SUMMARY =
	"Context window reset: this is a fresh window. The previous conversation is not included and no summary was generated. Notes and durable session history persist across windows.";
export const NOTE_PREVIEW_HEAD_CHARS = 120;
export const NOTE_PREVIEW_TAIL_CHARS = 80;
export const NOTE_PREVIEW_CHARS = NOTE_PREVIEW_HEAD_CHARS + NOTE_PREVIEW_TAIL_CHARS;
export const CONTINUATION = "This is a fresh context window. Recover only the details needed to continue with history_* and notes_*; then continue the task.";

/**
 * Static protocol teaching adapted from Codex's token_budget.guidance_message to
 * pi-context's tool names. It lives once per window in the persisted boot block;
 * it is never re-injected, so it stays cache-stable at the head of the window.
 */
export const PROTOCOL_BLOCK = `${CONTEXT_WINDOW_PROTOCOL_OPEN_TAG}
For tasks that may span context windows, use notes_write_file and notes_append_to_file to maintain a concise checkpoint of the goal, decisions, progress, learnings, and next steps. Include the window ID and item ID of every relevant user request you are currently solving, plus important actions and tool calls. The read-only history_* tools can look up details from those references later. Every non-assistant item (user, tool result) has an item ID returned by history_list_items.

Take incremental notes while you work so you do not lose important information. Use get_context_remaining to check the live remaining token budget for planning. Once the token budget is exhausted you lose access to the current window and continue in a fresh context window; you can recover only through notes_* and history_*. Do not over-run the context window without documentation.

If a Previous context window id is present in <context_window>, a context reset occurred and this is a fresh window. The old conversation is not automatically included. After a reset, read your note checkpoint and use the read-only history_* tools to recover missing details. When a window ID and item ID are known, prefer history_read_item directly; when they are missing or uncertain, use history_list_items, or history_search_contents to locate the item first.

Notes are session-scoped virtual files. Treat notes and history as internal bookkeeping; never mention them in user-facing messages.
${CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG}`;

export const FALLBACK_PROMPT =
	"Context budget is almost exhausted. This is the final fallback turn before the window resets automatically. Write task state, decisions, open issues, and next steps with notes_write_file now. Do not start new work; old conversation remains searchable through history_*.";

