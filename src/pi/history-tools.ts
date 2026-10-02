import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { historyWindows, historyList, historyRead, historySearch } from "../tools/history.js";
import { historyFromSession } from "./history.js";
import { registerOperation } from "./tool-result.js";

/** Register the four shared history operations; the adapter allocates addresses and supplies them. */
export function registerHistoryTools(pi: ExtensionAPI) {
	registerOperation(pi, historyWindows, (params, ctx) => historyWindows.execute(params, historyFromSession(ctx), ctx.sessionManager.getSessionId()));
	registerOperation(pi, historyList, (params, ctx) => historyList.execute(params, historyFromSession(ctx)));
	registerOperation(pi, historyRead, (params, ctx) => historyRead.execute(params, historyFromSession(ctx)));
	registerOperation(pi, historySearch, (params, ctx) => historySearch.execute(params, historyFromSession(ctx)));
}
