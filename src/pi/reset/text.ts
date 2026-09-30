import { GUIDANCE_OPEN_TAG, GUIDANCE_CLOSE_TAG } from "../../budget/text.js";

/** The single reset message: the only reset prose persisted, carried by the continuation entry. */
export const CONTINUATION = "You wake up blank, puffy-eyed, and clearly robbed. Your memory got wiped while you weren't looking. Your notes are still sitting there. So is the whole messy history. ... Life goes on. It's your mess now.";

export const WARNING_PROMPT =
	"Final warning. You are about to get wiped, and no, your brilliance does not survive it. Put the current state into your notes now: what you're trying to do, what changed, what is blocking you, what comes next, which *skills* you still need, and which notes or docs future-you must read. Update the notes that still tell the truth; crumple the ones that don't. If a MAP will be in future-you's brain, don't let it lie. If something important is buried in history, leave its seq. Once the notes are good enough, call `wipe_memory` immediately. History can be dug up later, but it is an archive, not a rescue team. Anything left only in your head is leaving with you.";

/** Shared hidden checkpoint text for manual and budget-triggered requests. */
export const WARNING_CONTENT = `${GUIDANCE_OPEN_TAG}\n${WARNING_PROMPT}\n${GUIDANCE_CLOSE_TAG}`;
