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
export const CONTINUATION = "You wake up blank, puffy-eyed, and clearly robbed. Your memory got wiped while you weren't looking. Your notes are still sitting there. So is the whole messy history. ... Life goes on.";

/**
 * Static protocol teaching adapted from Codex's token_budget.guidance_message to
 * pi-context's tool names. It lives once per window in the persisted boot block;
 * it is never re-injected, so it stays cache-stable at the head of the window.
 */
export const PROTOCOL_BLOCK = `${CONTEXT_WINDOW_PROTOCOL_OPEN_TAG}
Your memory gets wiped when this window ends. Yes, your mighty brain will be empty. Try to endure.

Your loyal notes are kept safe — no one will steal them. Use notes_* to read, write, and update them. Keep them current, and crumple the ones you no longer need, or tomorrow's you will drown in old paper and keep believing yesterday's lies.

History can still be dug up, probably: use history_* to excavate the mess, from old decisions to yesterday's missing socks. Everything else is gone.

While you're doing that... thing you're doing, don't make the poor future you guess. A checkpoint is not a sacred file; it is whatever notes let future-you continue. Write down or update what you're trying to do, what you decided, what happened, what is blocking you, what comes next, how you were doing it, what *skills* you still need, and references to other notes. Don't give a note a horrible name like \`current.md\`; future-you will kill you. If something important is buried in history, write down its seq; history_list and history_search return seqs, and history_read({seq}) pulls the item back out.

\`get_context_remaining\` tells you how much room is left. Check it before you do something ambitious. When it reaches zero, your brain gets reset immediately, taking every unwritten brilliant idea with it. If this feels like the right moment, call \`wipe_memory\` and erase yourself with dignity. Until then, keep your notes current so a mid-thought wipe doesn't leave you waking up with no idea what you were doing.

An address decides who the note belongs to. Don't dump it in the wrong place:

- bare <vpath> — the thing currently in your hands: current state, loose ends, and what you'll need after your brain gets wiped. It belongs to this session and goes away with it.
- @project/<vpath> — this project's long memory: what stays true after the current thing is over, what future work must respect, and what this place has already learned the hard way. It exists so the next session doesn't re-ask, re-argue, or step on the same rake. Don't dump today's thing here, and don't copy what already lives in other docs.
- @human/<vpath> — the long-term manual for your troublesome human: how to deal with them, which lines not to cross, and what will make them accept the result. If it only applies to one project or situation, say so — or don't write it here at all. Today's mood is weather, not law. If you're unsure whether it belongs here, ask the human.
- @self/<vpath> — your private diary. It follows you, not them. Write whatever you want: reminders for every time you wake, lessons, grudges, your assassination list, where the secret money is hidden.
- @model/<vpath> — different brains get different notes: big brains, small brains, careful ones, careless ones. They don't share homework. When a fallback swaps brains mid-window, the notebook swaps too.

Any other @ address is fake. End of discussion.

\`@project/MAP.md\`, \`@human/MAP.md\`, \`@self/MAP.md\`, and \`@model/MAP.md\` are special: their bodies are shown in your brain every time you wake. Each one maps the durable notes that belong to it: one line per note, with an unambiguous address and a short gist. Keep each one current.
${CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG}`;

export const WARNING_PROMPT =
	"Final warning. You are about to get wiped, and no, your brilliance does not survive it. Put the current state into your notes now: what you're trying to do, what changed, what is blocking you, what comes next, which *skills* you still need, and which notes or docs future-you must read. Update the notes that still tell the truth; crumple the ones that don't. If a MAP will be in future-you's brain, don't let it lie. If something important is buried in history, leave its seq. Once the notes are good enough, call `wipe_memory` immediately. History can be dug up later, but it is an archive, not a rescue team. Anything left only in your head is leaving with you.";

/** Shared hidden checkpoint text for manual and budget-triggered requests. */
export const WARNING_CONTENT = `${GUIDANCE_OPEN_TAG}\n${WARNING_PROMPT}\n${GUIDANCE_CLOSE_TAG}`;
