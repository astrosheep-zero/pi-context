import { VERSION, type ExtensionAPI, type ExtensionFactory, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerHistoryTools } from "./history/history-tools.js";
import { registerNotesTools } from "./notes/tools.js";
import { deriveThresholds } from "./context/thresholds.js";
import { registerContext } from "./context/runtime.js";
import { mergePiContextSettings } from "./settings.js";
import { NOTE_TYPE, BOOT_TYPE, GUIDANCE_TYPE, WARNING_TYPE, RESET_MARKER_TYPE, CONTINUATION_TYPE, MAX_NOTE_BYTES, CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, CONTEXT_WINDOW_PROTOCOL_OPEN_TAG, CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG, GUIDANCE_OPEN_TAG, PI_CONTEXT_SETTINGS_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, WARNING_RUNWAY_TOKENS, RESET_SUMMARY, CONTINUATION, WARNING_PROMPT } from "./protocol.js";
import { assertVirtualPath } from "./notes/address.js";
export { historyFromSession } from "./history/history.js";
export { notesFromSession } from "./notes/session-replay.js";

function registerPiContext(pi: ExtensionAPI, settingsManager?: SettingsManager): void {
	const [major, minor] = VERSION.split(".").map(Number);
	if (!(major > 0 || (major === 0 && minor >= 87))) {
		throw new Error(`pi-context requires Pi >= 0.87.0; running ${VERSION}. Upgrade Pi and restart the process; /reload only reloads extensions.`);
	}
	registerContext(pi, settingsManager);
	registerHistoryTools(pi);
	registerNotesTools(pi);
}

/**
 * Create an extension factory bound to an SDK settings authority. The host must pass
 * the same manager to createAgentSession and to this factory's resource loader.
 */
export function createPiContext(options: { settingsManager?: SettingsManager } = {}): ExtensionFactory {
	return (pi) => registerPiContext(pi, options.settingsManager);
}

/** The Pi-discovered extension keeps the standard file-backed settings behavior. */
export default function piContext(pi: ExtensionAPI): void {
	registerPiContext(pi);
}

export const internal = { MAX_NOTE_BYTES, NOTE_TYPE, BOOT_TYPE, GUIDANCE_TYPE, WARNING_TYPE, CONTINUATION_TYPE, WARNING_PROMPT, WARNING_RUNWAY_TOKENS, RESET_MARKER_TYPE, RESET_SUMMARY, CONTINUATION, CONTEXT_WINDOW_OPEN_TAG, CONTEXT_WINDOW_CLOSE_TAG, CONTEXT_WINDOW_PROTOCOL_OPEN_TAG, CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG, GUIDANCE_OPEN_TAG, PI_CONTEXT_SETTINGS_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, deriveThresholds, mergePiContextSettings, assertVirtualPath };
