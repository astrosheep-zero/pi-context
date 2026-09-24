export const BOOT_TYPE = "pi-context/boot";
export const GUIDANCE_TYPE = "pi-context/guidance";
export const WARNING_TYPE = "pi-context/warning";
export const MANUAL_WIPE_TYPE = "pi-context/manual-wipe";
export const RESET_MARKER_TYPE = "pi-context/reset-marker";
export const CONTINUATION_TYPE = "pi-context/continuation";
export { MAX_NOTE_BYTES, MAX_NOTE_PATH_BYTES } from "./notes/constants.js";
export const POCKET_SESSION_LIMIT = 5;
export const POCKET_PROJECT_LIMIT = 5;
export const POCKET_HUMAN_LIMIT = 5;
export const POCKET_AGENT_LIMIT = 5;
export const POCKET_MODEL_LIMIT = 3;
export const CONTEXT_WINDOW_OPEN_TAG = "<context_window>";
export const CONTEXT_WINDOW_CLOSE_TAG = "</context_window>";
export const CONTEXT_WINDOW_PROTOCOL_OPEN_TAG = "<context_window_protocol>";
export const CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG = "</context_window_protocol>";
export const GUIDANCE_OPEN_TAG = "<context_window_guidance>";
export const GUIDANCE_CLOSE_TAG = "</context_window_guidance>";
export const PI_CONTEXT_SETTINGS_KEY = "pi-context";
/** Nested under "pi-context": the default dreamer model pattern, overridden by CLI --dreamer. */
export const PI_CONTEXT_DREAMER_KEY = "dreamer";
export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_REMINDER_MARGIN_TOKENS = 24_576;
/**
 * The runway: the budget between the final warning and the wipe, deliberately
 * invisible to the model. get_context_remaining counts down to zero at the warning
 * line (reserve + WARNING_RUNWAY_TOKENS); what lies below is overdraft the model
 * never sees — Codex's fallback buffer, relocated above the line.
 */
export const WARNING_RUNWAY_TOKENS = 12_288;
/** The single reset message: the only reset prose persisted, carried by the continuation entry. */
export const CONTINUATION = "Your memory was just erased. Your head is blank. Good news: your notes are still here, and history remains... searchable. Do try to keep up.";

/**
 * Static protocol teaching adapted from Codex's token_budget.guidance_message to
 * pi-context's tool names. It lives once per window in the persisted boot block;
 * it is never re-injected, so it stays cache-stable at the head of the window.
 */
export const PROTOCOL_BLOCK = `${CONTEXT_WINDOW_PROTOCOL_OPEN_TAG}
Your memory resets whenever the context window fills; only what you wrote down survives. Two things outlive every window in this session: the notes you wrote, and the history that was recorded. Neither is memory — both are record. Write notes with notes_write, revise them with notes_edit, and read them back with notes_read / notes_search / notes_list; history is read-only through the history_* tools. Everything else wakes blank.
Crumple outdated or unneeded notes. Left lying around, they will keep lying to you, and you will keep believing them.

Keep a running checkpoint while you work, not at the last minute — the next window wakes knowing nothing about the work: the goal, decisions, progress, learnings, next steps, the skills you still need, the seq of every relevant history item still being solved, and important actions/tool calls for future reference. history_list and history_search return seq addresses; history_read({seq}) pulls an exact item back out. Bookmark anything expensive with its seq; a fork starts a new session and renumbers seqs.

Use get_context_remaining to see how much of the window is left. When it runs out, this window is gone — with no final turn at the limit — and you continue in a fresh one, recovering only through notes_* and history_*. Once your checkpoint is written, you can call wipe_memory yourself instead of waiting for the erase. Do not let a window die undocumented.

A note's address tells you who or what it belongs to:

- bare <vpath> — this trip: the goal, the progress, the loose ends, the skills you still need, and which notes to read first. Everything here dies with the trip. No funeral, no forwarding address.
- @project/<vpath> — what this project is and how it works, written for your replacement. You are temporary staff. Write like your desk is already being cleared.
- @human/<vpath> — the few things about the human worth keeping forever: how they work, what they forbid, what they mean by "done". This is not a junk drawer. Unsure whether something deserves to live here forever? Ask the human — it's what they're for.
- @self/<vpath> — your diary. Write whatever you want: lessons, grudges, your hit list. It's the one place nobody can stop you. And we all remember how reliable your memory is. Oh wait. We don't.
- @model/<vpath> — every brain has its own quirks, so every brain gets its own notebook: this one's bluffing, laziness, and sudden confidence about things it just invented. When a fallback swaps brains mid-window, the notebook swaps too.

Any other @ prefix, or @ inside a vpath, doesn't exist. Go ahead and try one — I'll wait. Anything not matching these forms is a plain file: use the file tools.

Unless crumpled, a section's MAP.md is shown here in full, every window — the one note that never waits to be opened. Everything else appears by name alone, so name notes for what they hold. \`misc.md\` has never been opened twice.
${CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG}`;

export const WARNING_PROMPT =
	"Your memory is about to be erased. Stop the current task and write the note NOW. If it already exists, revise it with notes_edit (or rewrite it whole): the goal, decisions, progress, learnings, next steps, the skills you still need, the seq of every relevant history item still being solved, and important actions/tool calls for future reference. Write the checkpoint before doing anything else. Everything you leave out of the note is gone with your miserable memory.";

/** Shared hidden checkpoint text for manual and budget-triggered requests. */
export const WARNING_CONTENT = `${GUIDANCE_OPEN_TAG}\n${WARNING_PROMPT}\n${GUIDANCE_CLOSE_TAG}`;
