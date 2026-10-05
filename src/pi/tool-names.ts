import type { BootToolNames } from "../boot/text.js";

export const PI_TOOL_NAMES = {
	notes: "notes_*",
	notesList: "notes_list",
	history: "history_*",
	historyWindows: "history_windows",
	historyList: "history_list",
	historySearch: "history_search",
	historyRead: "history_read",
	remaining: "get_context_remaining",
	wipe: "wipe_memory",
} as const satisfies BootToolNames;
