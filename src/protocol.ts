export const STATE_TYPE = "pi-context/state";
export const NOTE_TYPE = "pi-context/note";
export const BOOT_TYPE = "pi-context/boot";
export const GUIDANCE_TYPE = "pi-context/guidance";
export const WARNING_TYPE = "pi-context/warning";
export const RESET_MARKER_TYPE = "pi-context/reset-marker";
export const CONTINUATION_TYPE = "pi-context/continuation";
export const RESET_V2 = "reset-v2";
export const MAX_NOTE_BYTES = 1_000_000;
// Write-time cap on a virtual note path. Deliberately NOT enforced by assertVirtualPath:
// notesFromSession replays already-persisted operations, which must keep loading sessions
// that contain a longer legacy path. Reads and replay stay un-capped.
export const MAX_NOTE_PATH_BYTES = 512;
export const CONTEXT_WINDOW_OPEN_TAG = "<context_window>";
export const CONTEXT_WINDOW_CLOSE_TAG = "</context_window>";
export const CONTEXT_WINDOW_PROTOCOL_OPEN_TAG = "<context_window_protocol>";
export const CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG = "</context_window_protocol>";
export const GUIDANCE_OPEN_TAG = "<context_window_guidance>";
export const GUIDANCE_CLOSE_TAG = "</context_window_guidance>";
export const PI_CONTEXT_SETTINGS_KEY = "pi-context";
export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_REMINDER_MARGIN_TOKENS = 24_576;
/**
 * The runway: the budget between the final warning and the wipe, deliberately
 * invisible to the model. get_context_remaining counts down to zero at the warning
 * line (reserve + WARNING_RUNWAY_TOKENS); what lies below is overdraft the model
 * never sees — Codex's fallback buffer, relocated above the line.
 */
export const WARNING_RUNWAY_TOKENS = 8_192;
export const RESET_SUMMARY =
	"You wake up. Your head is empty — no memories, the past a blank. But nothing is lost: the notes you wrote and the recorded history still remember for you.";
export const NOTE_PREVIEW_HEAD_CHARS = 80;
export const NOTE_PREVIEW_TAIL_CHARS = 240;
export const NOTE_PREVIEW_CHARS = NOTE_PREVIEW_HEAD_CHARS + NOTE_PREVIEW_TAIL_CHARS;
export const CONTINUATION = "Your memory was just erased. Pull only the details you need from history_* and notes_*, then get back to work.";

/**
 * Static protocol teaching adapted from Codex's token_budget.guidance_message to
 * pi-context's tool names. It lives once per window in the persisted boot block;
 * it is never re-injected, so it stays cache-stable at the head of the window.
 */
export const PROTOCOL_BLOCK = `${CONTEXT_WINDOW_PROTOCOL_OPEN_TAG}
Your memory resets whenever the context window fills; only what you wrote down survives. Two things remember for you, and both outlive every window in this session: your notes, and this session's recorded history. Write notes with notes_write_file / notes_append_to_file, read them back with notes_read_file / notes_search_contents; history is read-only through the history_* tools. Everything else wakes blank.

Keep a running checkpoint while you work, not at the last minute — the next window wakes knowing nothing about the work: the goal, decisions, progress, learnings, next steps, the skills you still need, the window ID and item ID of every relevant user request still being solved, and important actions/tool calls for future reference. history_list_items returns those IDs; history_read_item pulls the exact item back out. Bookmark anything expensive the same way — a window/item ID beats re-running or re-searching.

Use get_context_remaining to see how much of the window is left. When it runs out, this window is gone — with no final turn at the limit — and you continue in a fresh one, recovering only through notes_* and history_*. Once your checkpoint is written, you can end the window yourself with new_context instead of waiting for the erase. Do not let a window die undocumented.

If <context_window> lists a Previous context window id, a reset just happened and the old conversation is not included. Read your note checkpoint first, then recover details through history_*: history_read_item directly when you know the window and item IDs, history_list_items or history_search_contents to find them when you don't.

Notes are session-scoped virtual files. Treat notes and history as internal bookkeeping; never mention them in user-facing messages.
${CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG}`;

export const WARNING_PROMPT =
	"Memory wipe incoming — this turn is all you get. Write exactly one checkpoint note now: the goal, decisions, progress, learnings, next steps, the skills you still need, the window ID and item ID of every relevant user request still being solved, and important actions/tool calls for future reference. Then call new_context and go out clean — anything not in the note is gone.";

