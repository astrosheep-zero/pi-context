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
import { registerResetLifecycle } from "../src/reset-lifecycle.js";

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
	await h.runCommand("clear-context");
	assert.equal(h.sent.length, 1, "/clear-context writes one hidden boot without a model turn");
	assert.equal(h.sent[0]?.triggerTurn, false);
	const markers = h.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE);
	assert.equal(markers.length, 2, "off does not resurrect history; re-enabled clear-context creates the explicit new marker");
});

test("tree navigation with a marker returns an empty extension summary and never delegates old history to a model", async () => {
	const h = harness();
	const marker = h.sessionManager.appendCustomEntry(internal.RESET_MARKER_TYPE, { windowId: "pcw:test:one" });
	h.sessionManager.appendCustomMessageEntry(internal.BOOT_TYPE, "fresh boot", false, { windowId: "pcw:test:one" });
	const result = await h.emit("session_before_tree", {
		type: "session_before_tree",
		preparation: {
			targetId: marker,
			oldLeafId: marker,
			commonAncestorId: null,
			entriesToSummarize: h.sessionManager.getBranch(),
			userWantsSummary: true,
		},
		signal: new AbortController().signal,
	});
	assert.deepEqual(result.at(-1), { summary: { summary: "" } }, "an empty extension summary prevents SDK summarization");
	assert.equal(h.sessionManager.getEntries().filter((entry) => entry.type === "branch_summary").length, 0, "the hook itself does not write a summary");
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
