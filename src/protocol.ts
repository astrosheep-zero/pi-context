export const NOTE_TYPE = "pi-context/note";
export const BOOT_TYPE = "pi-context/boot";
export const GUIDANCE_TYPE = "pi-context/guidance";
export const WARNING_TYPE = "pi-context/warning";
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
Mark outdated or unneeded notes stale — leave them, and they will keep misleading you.

Keep a running checkpoint while you work, not at the last minute — the next window wakes knowing nothing about the work: the goal, decisions, progress, learnings, next steps, the skills you still need, the window ID and item ID of every relevant user request still being solved, and important actions/tool calls for future reference. history_list returns those IDs; history_read pulls the exact item back out. Bookmark anything expensive the same way — a window/item ID beats re-running or re-searching.

Use get_context_remaining to see how much of the window is left. When it runs out, this window is gone — with no final turn at the limit — and you continue in a fresh one, recovering only through notes_* and history_*. Once your checkpoint is written, you can call wipe_memory yourself instead of waiting for the erase. Do not let a window die undocumented.

Note addresses take five prefixes: bare <vpath> is this session; @project/<vpath> is this project; @human/<vpath> is the human's cross-project notes; @self/<vpath> is your own, as the current agent; @model/<vpath> is the current model's. @self and @model resolve to who is running now; listings always show resolved names. Nothing else is legal — any other @ prefix, or @ inside a vpath, is a hard error, with no fallback across prefixes.
Session notes belong to this trip — the goal, the progress, the loose ends. The next window of THIS trip wakes to them; once the trip is over, nobody does.
@project notes hold facts about this project — architecture, conventions, workflows, deployment and environment details — for whoever works here next.
@human notes hold the human's durable preferences and standing rules, plus lessons that apply across projects — for every agent that serves this human, whoever is running. You write there as the human's scribe; what the human dictates carries origin: user. When the intended scope is unclear, keep the note in the narrowest stated scope rather than widening it.
@self notes are yours — your voice, your lessons, your gripes — for the next run of whoever you are. Other agents read yours by explicit address and never write them; you read theirs the same way. A note only its author would ever need belongs here, not in @human.
@model notes capture the substrate — how the current model actually behaves: context honesty, tool quirks, fallback patterns. @model resolves live, so what you learn on one model is filed under that model even when a fallback moves you mid-window.
${CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG}`;

export const WARNING_PROMPT =
	"Your memory is about to be erased. Stop the current task and write the note NOW. If it already exists, revise it with notes_edit (or rewrite it whole): the goal, decisions, progress, learnings, next steps, the skills you still need, the window ID and item ID of every relevant user request still being solved, and important actions/tool calls for future reference. Use as many note/tool turns as needed to finish the checkpoint. When it is ready, call wipe_memory to reset immediately; otherwise finish normally and the extension will reset at your normal stop. Anything not in the note dies with the window.";

/** Identical hidden close-out message for manual and budget-triggered requests. */
export const WARNING_CONTENT = `${GUIDANCE_OPEN_TAG}\n${WARNING_PROMPT}\n${GUIDANCE_CLOSE_TAG}`;
