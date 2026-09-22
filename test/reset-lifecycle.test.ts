import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBoundaryDraft,
	SessionManager,
	ToolDefinition,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { SessionManager as Manager } from "@earendil-works/pi-coding-agent";
import piContext, { internal } from "../src/index.js";
import {
	initialResetControl,
	reduceResetControl,
	registerResetLifecycle,
	type ResetBeforeSettleFacts,
	type ResetControlState,
	type ResetTurnEndFacts,
} from "../src/context/reset-lifecycle.js";

const previousNotesHome = process.env.PI_NOTES_HOME;
const testNotesHome = mkdtempSync(join(tmpdir(), "pi-context-lifecycle-notes-"));
process.env.PI_NOTES_HOME = testNotesHome;
test.after(() => {
	if (previousNotesHome === undefined) delete process.env.PI_NOTES_HOME;
	else process.env.PI_NOTES_HOME = previousNotesHome;
	rmSync(testNotesHome, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

function harness() {
	const sessionManager = Manager.inMemory("/private/tmp/pi-context-lifecycle-test");
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, Command>();
	const sent: Array<{ customType: string; details?: unknown; triggerTurn?: boolean }> = [];
	const notices: Array<{ message: string; type?: string }> = [];
	const api = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		registerFlag() {},
		appendEntry(customType: string, data?: unknown) { sessionManager.appendCustomEntry(customType, data); },
		sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean }) {
			sent.push({ customType: message.customType, details: message.details, triggerTurn: options?.triggerTurn });
			sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
	};
	piContext(api as unknown as ExtensionAPI);
	const ctx = {
		sessionManager,
		cwd: "/private/tmp",
		model: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		getContextUsage: () => undefined,
		compact: () => assert.fail("the reset path must not call ctx.compact()"),
		abort: () => {},
		isProjectTrusted: () => true,
		ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: unknown): Promise<unknown[]> => {
		const results: unknown[] = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	};
	const runCommand = async (name: string, args = "") => {
		const command = commands.get(name);
		assert.ok(command, `${name} command is registered`);
		const commandCtx = Object.assign({}, ctx, {
			waitForIdle: async () => {},
			ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
		}) as unknown as ExtensionCommandContext;
		await command.handler(args, commandCtx);
	};
	const callTool = async (name: string): Promise<AgentToolResult<unknown>> => {
		const tool = tools.get(name);
		assert.ok(tool, `${name} is registered`);
		return tool.execute("call", {}, new AbortController().signal, () => {}, ctx) as Promise<AgentToolResult<unknown>>;
	};
	return { sessionManager, handlers, sent, notices, emit, runCommand, callTool };
}

function resultEntries(results: unknown[]): { entries: SessionBoundaryDraft[]; continue: boolean } {
	let entries: SessionBoundaryDraft[] = [];
	let shouldContinue = false;
	for (const result of results) {
		if (!result || typeof result !== "object") continue;
		const value = result as { entries?: SessionBoundaryDraft[]; continue?: boolean };
		if (value.entries) entries = value.entries;
		if (value.continue !== undefined) shouldContinue = value.continue;
	}
	return { entries, continue: shouldContinue };
}

function appendDrafts(sessionManager: SessionManager, entries: SessionBoundaryDraft[]): void {
	for (const entry of entries) {
		switch (entry.type) {
			case "custom": sessionManager.appendCustomEntry(entry.customType, entry.data); break;
			case "custom_message": sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details); break;
			case "context_edit": sessionManager.appendContextEdit(entry.targetId, entry.replacement); break;
			case "compaction": sessionManager.appendCompaction(entry.summary, entry.firstKeptEntryId, 0, entry.details, true, entry.usage); break;
		}
	}
}

function turnEndFacts(overrides: Partial<ResetTurnEndFacts> = {}): ResetTurnEndFacts {
	return {
		aborted: false,
		overflow: false,
		failed: false,
		enabled: true,
		queued: false,
		automaticResetEnabled: true,
		thresholdDue: false,
		...overrides,
	};
}

function beforeSettleFacts(overrides: Partial<ResetBeforeSettleFacts> = {}): ResetBeforeSettleFacts {
	return {
		queued: false,
		enabled: true,
		automaticResetEnabled: true,
		aborted: false,
		...overrides,
	};
}

function fakeBoundaryEvent(entries: SessionBoundaryDraft[] = []): TurnEndEvent {
	return {
		type: "turn_end",
		entries,
		continue: false,
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
		outcome: "completed",
		turnIndex: 0,
		message: { role: "assistant", content: [], timestamp: Date.now() } as unknown as AgentMessage,
		toolResults: [],
		messageEntryId: "assistant-entry",
		toolResultEntryIds: [],
	} as TurnEndEvent;
}

test("public reset boundary drafts one marker, one boot, and one continuation after a tool batch", async () => {
	const h = harness();
	h.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "before reset" }], timestamp: Date.now() });
	const first = await h.callTool("wipe_memory");
	const second = await h.callTool("wipe_memory");
	assert.ok(first.content.length > 0 && second.content.length > 0, "both tool calls return normally");

	const toolBatch: SessionBoundaryDraft[] = [{ type: "custom_message", customType: "foreign/tool-batch", content: "tool finished", display: false }];
	const boundary = resultEntries(await h.emit("turn_end", fakeBoundaryEvent(toolBatch)));
	assert.equal(boundary.continue, true, "the whole tool batch continues only after the boundary is committed");
	const markerDrafts = boundary.entries.filter((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE);
	const bootDrafts = boundary.entries.filter((entry) => entry.type === "custom_message" && entry.customType === internal.BOOT_TYPE);
	assert.equal(markerDrafts.length, 1, "duplicate wipe requests in one turn dedupe");
	assert.equal(bootDrafts.length, 1);
	assert.equal(boundary.entries[0]?.type, "custom_message", "ordinary tool-batch entries precede the reset drafts");
	assert.equal(boundary.entries[1]?.type, "custom");
	assert.equal(boundary.entries[2]?.type, "custom_message");
	const windowId = (markerDrafts[0] as { data: { windowId: string } }).data.windowId;
	assert.match(windowId, /^pcw:/);
	assert.equal((bootDrafts[0] as { details: { windowId: string } }).details.windowId, windowId);
	const continuationDrafts = boundary.entries.filter((entry) => entry.type === "custom_message" && entry.customType === internal.CONTINUATION_TYPE);
	assert.equal(continuationDrafts.length, 1, "the boundary persists exactly one reset message");
	assert.equal(boundary.entries[3]?.type, "custom_message", "the continuation closes the ordered reset shape");
	appendDrafts(h.sessionManager, boundary.entries);
	const branch = h.sessionManager.getBranch();
	assert.deepEqual(branch.filter((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE).map((entry) => entry.type === "custom" ? entry.data : undefined), [{ windowId }]);
	assert.equal(branch.filter((entry) => entry.type === "custom_message" && entry.customType === internal.BOOT_TYPE).length, 1);
});

test("off stops future automatic/manual reset requests while an existing marker remains authoritative", async () => {
	const h = harness();
	await h.callTool("wipe_memory");
	const first = resultEntries(await h.emit("turn_end", fakeBoundaryEvent()));
	assert.ok(first.entries.some((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE));
	appendDrafts(h.sessionManager, first.entries);
	await h.runCommand("pi-context", "off");
	const before = await h.emit("session_before_compact", {
		type: "session_before_compact",
		reason: "manual",
		willRetry: false,
		branchEntries: h.sessionManager.getBranch(),
		preparation: { tokensBefore: 100, firstKeptEntryId: null, keptMessages: [], droppedMessages: [] },
		signal: new AbortController().signal,
	});
	assert.deepEqual(before.at(-1), { cancel: true }, "/compact is canceled when an existing marker would expose old canonical history");
	const afterOff = resultEntries(await h.emit("turn_end", fakeBoundaryEvent()));
	assert.equal(afterOff.entries.length, 0, "off does not create another reset");
	await h.runCommand("pi-context", "on");
	await h.runCommand("wipe-memory");
	assert.equal(h.sent.length, 2, "/wipe-memory writes one hidden boot and one continuation without a model turn");
	assert.equal(h.sent[0]?.triggerTurn, false);
	assert.equal(h.sent[0]?.customType, internal.BOOT_TYPE);
	assert.equal(h.sent[1]?.customType, internal.CONTINUATION_TYPE);
	const markers = h.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE);
	assert.equal(markers.length, 2, "off does not resurrect history; re-enabled wipe-memory creates the explicit new marker");
});

test("reset construction failure preserves incoming and budget drafts without continuation", async () => {
	const sessionManager = Manager.inMemory("/private/tmp/pi-context-reset-failure-test");
	const handlers = new Map<string, Handler[]>();
	const notices: Array<{ message: string; type?: string }> = [];
	const api = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager,
		model: undefined,
		signal: undefined,
		hasPendingMessages: () => false,
		ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
	} as unknown as ExtensionContext;
	const budgetDraft: SessionBoundaryDraft = { type: "custom_message", customType: internal.GUIDANCE_TYPE, content: "budget draft", display: false };
	const lifecycle = registerResetLifecycle(api, {
		isEnabled: () => true,
		budget: {
			automaticResetEnabled: () => true,
			resetDue: () => false,
			consumeTurnEnd: () => [budgetDraft],
			clear: () => {},
		},
		buildReset: () => { throw new Error("synthetic reset construction failure"); },
	});
	lifecycle.request();
	const incoming: SessionBoundaryDraft = { type: "custom_message", customType: "foreign/boundary", content: "foreign draft", display: false };
	const results = [];
	for (const handler of handlers.get("turn_end") ?? []) results.push(await handler(fakeBoundaryEvent([incoming]), ctx));
	const result = resultEntries(results);
	assert.deepEqual(result.entries, [incoming, budgetDraft], "already-built drafts survive reset construction failure");
	assert.equal(result.continue, false, "a failed reset does not request continuation");
	assert.equal(notices.at(-1)?.type, "warning");
	assert.match(notices.at(-1)?.message ?? "", /could not build reset/);
});

test("a queued success clears an overflow failure before settle recovery can reset", async () => {
	const sessionManager = Manager.inMemory("/private/tmp/pi-context-queued-overflow-test");
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager,
		model: { contextWindow: 100_000, maxTokens: 4_096 },
		signal: undefined,
		hasPendingMessages: () => false,
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	let resetCount = 0;
	const lifecycle = registerResetLifecycle(api, {
		isEnabled: () => true,
		budget: {
			automaticResetEnabled: () => true,
			resetDue: () => false,
			consumeTurnEnd: () => [],
			clear: () => {},
		},
		buildReset: () => {
			resetCount += 1;
			return [];
		},
	});

	const failed = fakeBoundaryEvent();
	failed.message = { ...failed.message, stopReason: "error", errorMessage: "Prompt too long: context exceeds maximum context length" } as unknown as AgentMessage;
	const turnEnd = handlers.get("turn_end")?.[0];
	const beforeSettle = handlers.get("agent_before_settle")?.[0];
	assert.ok(turnEnd && beforeSettle);
	await turnEnd(failed, ctx);
	const queued = {
		...failed,
		type: "agent_before_settle",
		outcome: "error",
		context: { ...failed.context, pendingMessages: [{ role: "user", content: [{ type: "text", text: "queued success" }], timestamp: Date.now() }] },
	};
	assert.equal(await beforeSettle(queued, ctx), undefined, "a queued message defers overflow recovery");

	const success = fakeBoundaryEvent();
	await turnEnd(success, ctx);
	const settled = { ...queued, context: { ...queued.context, pendingMessages: [] }, outcome: "completed" };
	assert.equal(await beforeSettle(settled, ctx), undefined, "the successful queued turn clears the stale recovery");
	assert.equal(resetCount, 0);
});

test("reset-control: an explicit request deduplicates and is consumed at the turn boundary", () => {
	const idle = Object.freeze({ ...initialResetControl() });
	const first = reduceResetControl(idle, { type: "request" });
	assert.equal(first.effect, "requested");
	assert.deepEqual(first.state, { request: "explicit", overflow: "idle" });

	const again = reduceResetControl(first.state, { type: "request" });
	assert.equal(again.effect, "already-requested");
	assert.deepEqual(again.state, first.state, "a duplicate request does not change state");

	const committed = reduceResetControl(again.state, { type: "turn_end", facts: turnEndFacts() });
	assert.equal(committed.effect, "commit-boundary");
	assert.deepEqual(committed.state, initialResetControl(), "the request is consumed whether or not it commits");
});

test("reset-control: turn_end commits explicit and threshold resets, and skips disabled or failed turns", () => {
	const explicit = reduceResetControl({ request: "explicit", overflow: "idle" }, { type: "turn_end", facts: turnEndFacts() });
	assert.equal(explicit.effect, "commit-boundary");

	const threshold = reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ thresholdDue: true }) });
	assert.equal(threshold.effect, "commit-boundary");

	const neither = reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts() });
	assert.equal(neither.effect, "none");

	const disabled = reduceResetControl({ request: "explicit", overflow: "idle" }, { type: "turn_end", facts: turnEndFacts({ enabled: false, thresholdDue: true }) });
	assert.equal(disabled.effect, "none");
	assert.deepEqual(disabled.state, initialResetControl(), "a disabled turn drops the explicit request without committing");

	const failed = reduceResetControl({ request: "explicit", overflow: "idle" }, { type: "turn_end", facts: turnEndFacts({ failed: true, thresholdDue: true }) });
	assert.equal(failed.effect, "none");
	assert.deepEqual(failed.state, initialResetControl());
});

test("reset-control: aborted turns clear the boundary, settlement keeps only an explicit request", () => {
	const both: ResetControlState = { request: "explicit", overflow: "pending" };

	const aborted = reduceResetControl(both, { type: "turn_end", facts: turnEndFacts({ aborted: true }) });
	assert.equal(aborted.effect, "none");
	assert.deepEqual(aborted.state, initialResetControl(), "an abort manufactures no continuation");

	const settled = reduceResetControl(both, { type: "settled" });
	assert.deepEqual(settled.state, { request: "explicit", overflow: "idle" }, "settlement ends the failure chain only");

	const cleared = reduceResetControl(both, { type: "clear" });
	assert.deepEqual(cleared.state, initialResetControl());
});

test("reset-control: overflow recovery is armed at turn_end and spent exactly once at settle", () => {
	const armed = reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) });
	assert.deepEqual(armed.state, { request: "none", overflow: "pending" });

	const recovered = reduceResetControl(armed.state, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(recovered.effect, "recover-overflow", "the first settle commits the bounded recovery");
	assert.deepEqual(recovered.state, { request: "none", overflow: "spent" });

	const repeated = reduceResetControl(recovered.state, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(repeated.effect, "none", "a spent recovery is never retried");

	const rearmed = reduceResetControl(recovered.state, { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) });
	assert.deepEqual(rearmed.state, { request: "none", overflow: "pending-spent" });
	const bounded = reduceResetControl(rearmed.state, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(bounded.effect, "none", "a second failure chain stays bounded to the spent attempt");
	assert.deepEqual(bounded.state, { request: "none", overflow: "spent" });
});

test("reset-control: a queued turn defers recovery and its success supersedes the failure", () => {
	const armed = reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) }).state;
	const deferred = reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts({ queued: true }) });
	assert.equal(deferred.effect, "none");
	assert.deepEqual(deferred.state, armed, "a queued message leaves the overflow chain armed");

	const success = reduceResetControl(armed, { type: "turn_end", facts: turnEndFacts() });
	assert.deepEqual(success.state, initialResetControl(), "a successful queued turn clears the stale failure");
});

test("reset-control: disabled mode and explicit aborts disarm overflow without a recovery", () => {
	const armed = reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) }).state;

	const disabled = reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts({ enabled: false }) });
	assert.equal(disabled.effect, "none");
	assert.deepEqual(disabled.state, { request: "none", overflow: "idle" });

	const automaticOff = reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts({ automaticResetEnabled: false }) });
	assert.equal(automaticOff.effect, "none");
	assert.deepEqual(automaticOff.state, { request: "none", overflow: "idle" });

	const aborted = reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts({ aborted: true }) });
	assert.equal(aborted.effect, "none");
	assert.deepEqual(aborted.state, { request: "none", overflow: "idle" });
});

test("reset-control: policy guards are consulted only in the branches that need them", () => {
	const tracked = (overrides: {
		aborted?: boolean;
		overflow?: boolean;
		failed?: boolean;
		enabled?: boolean;
		queuedResult?: boolean;
		automaticResult?: boolean;
		thresholdResult?: boolean;
	}) => {
		const calls = { queued: 0, automatic: 0, threshold: 0 };
		const facts: ResetTurnEndFacts = {
			aborted: overrides.aborted ?? false,
			overflow: overrides.overflow ?? false,
			failed: overrides.failed ?? false,
			enabled: overrides.enabled ?? true,
			get queued() { calls.queued += 1; return overrides.queuedResult ?? false; },
			get automaticResetEnabled() { calls.automatic += 1; return overrides.automaticResult ?? true; },
			get thresholdDue() { calls.threshold += 1; return overrides.thresholdResult ?? true; },
		};
		return { facts, calls };
	};

	const aborted = tracked({ aborted: true });
	reduceResetControl(initialResetControl(), { type: "turn_end", facts: aborted.facts });
	assert.deepEqual(aborted.calls, { queued: 0, automatic: 0, threshold: 0 }, "an abort consults no policy guard");

	const failed = tracked({ failed: true });
	reduceResetControl(initialResetControl(), { type: "turn_end", facts: failed.facts });
	assert.deepEqual(failed.calls, { queued: 0, automatic: 0, threshold: 0 }, "a failed turn consults no threshold guard");

	const disabled = tracked({ enabled: false });
	reduceResetControl(initialResetControl(), { type: "turn_end", facts: disabled.facts });
	assert.deepEqual(disabled.calls, { queued: 0, automatic: 0, threshold: 0 }, "a disabled turn consults no threshold guard");

	const overflow = tracked({ overflow: true, queuedResult: false });
	reduceResetControl(initialResetControl(), { type: "turn_end", facts: overflow.facts });
	assert.deepEqual(overflow.calls, { queued: 1, automatic: 1, threshold: 0 }, "an overflow turn consults only the overflow guards");

	const complete = tracked({ thresholdResult: false });
	reduceResetControl(initialResetControl(), { type: "turn_end", facts: complete.facts });
	assert.deepEqual(complete.calls, { queued: 0, automatic: 0, threshold: 1 }, "a completed turn consults only the threshold guard");

	const settleCalls = { queued: 0, enabled: 0, automatic: 0 };
	const settleFacts: ResetBeforeSettleFacts = {
		get queued() { settleCalls.queued += 1; return true; },
		get enabled() { settleCalls.enabled += 1; return true; },
		get automaticResetEnabled() { settleCalls.automatic += 1; return true; },
		aborted: false,
	};
	reduceResetControl({ request: "none", overflow: "pending" }, { type: "before_settle", facts: settleFacts });
	assert.deepEqual(settleCalls, { queued: 1, enabled: 0, automatic: 0 }, "a queued settle consults only the pending-message guard");
});

test("a committed reset places incoming and budget drafts before marker -> boot -> continuation", async () => {
	const sessionManager = Manager.inMemory("/private/tmp/pi-context-reset-ordering-test");
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager,
		model: undefined,
		signal: undefined,
		hasPendingMessages: () => false,
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	const windowId = "pcw:ordering:test";
	const budgetDraft: SessionBoundaryDraft = { type: "custom_message", customType: internal.GUIDANCE_TYPE, content: "budget draft", display: false };
	const lifecycle = registerResetLifecycle(api, {
		isEnabled: () => true,
		budget: {
			automaticResetEnabled: () => true,
			resetDue: () => false,
			consumeTurnEnd: () => [budgetDraft],
			clear: () => {},
		},
		buildReset: () => [
			{ type: "custom", customType: internal.RESET_MARKER_TYPE, data: { windowId } },
			{ type: "custom_message", customType: internal.BOOT_TYPE, content: "boot", display: false, details: { windowId } },
			{ type: "custom_message", customType: internal.CONTINUATION_TYPE, content: "continuation", display: false },
		],
	});
	lifecycle.request();
	const incoming: SessionBoundaryDraft = { type: "custom_message", customType: "foreign/boundary", content: "incoming", display: false };
	const results = [];
	for (const handler of handlers.get("turn_end") ?? []) results.push(await handler(fakeBoundaryEvent([incoming]), ctx));
	const result = resultEntries(results);
	assert.equal(result.continue, true);
	const customTypes = (entries: readonly { readonly type: string; readonly customType?: string }[]) => entries.map((entry) => {
		assert.ok(entry.type === "custom" || entry.type === "custom_message", "the boundary only carries named reset drafts here");
		return entry.customType;
	});
	assert.deepEqual(customTypes(result.entries), [
		"foreign/boundary",
		internal.GUIDANCE_TYPE,
		internal.RESET_MARKER_TYPE,
		internal.BOOT_TYPE,
		internal.CONTINUATION_TYPE,
	], "ordinary and budget drafts precede the closed reset shape");
	appendDrafts(sessionManager, result.entries);
	const branch = sessionManager.getBranch();
	const markerIndex = branch.findIndex((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE);
	assert.ok(markerIndex >= 0);
	assert.deepEqual(customTypes(branch.slice(markerIndex)), [
		internal.RESET_MARKER_TYPE,
		internal.BOOT_TYPE,
		internal.CONTINUATION_TYPE,
	], "the persisted reset shape remains marker -> boot -> continuation");
});
