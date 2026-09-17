import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerResetLifecycle } from "../src/reset-lifecycle.js";

type CompactOptions = NonNullable<Parameters<ExtensionContext["compact"]>[0]>;
function harness() {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const messages: string[] = [];
	const notices: string[] = [];
	const requests: CompactOptions[] = [];
	let sessionId = "first", currentReset = "", enabled = true, idle = true, pending = false;
	let signal: AbortSignal | undefined;
	let throwOnCompact = false;
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		get signal() { return signal; },
		compact: (options: CompactOptions) => {
			if (throwOnCompact) throw new Error("synchronous failure");
			requests.push(options);
		},
		ui: { notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionContext;
	const lifecycle = registerResetLifecycle({
		on: (name: string, fn: (event: any, ctx: ExtensionContext) => any) => handlers.set(name, fn),
		sendMessage: (message: { customType: string }) => messages.push(message.customType),
	} as unknown as ExtensionAPI, {
		isEnabled: () => enabled,
		continuation: { customType: "continue", content: "resume", display: false },
		buildReset: () => ({ compaction: { summary: "reset", firstKeptEntryId: "marker", tokensBefore: 100, details: {} } }),
		isCurrentReset: (id) => id === currentReset,
		onReset: () => {},
	});
	const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	return {
		ctx, lifecycle, emit, messages, notices, requests,
		setIdle: (value: boolean) => { idle = value; },
		setPending: (value: boolean) => { pending = value; },
		setSignal: (value: AbortSignal) => { signal = value; },
		setSession: (value: string) => { sessionId = value; },
		setThrow: () => { throwOnCompact = true; },
		disable: () => { enabled = false; lifecycle.clear(); },
		enable: () => { enabled = true; },
		before: (reason = "threshold") => emit("session_before_compact", { reason, signal: new AbortController().signal }),
		settle: () => { emit("agent_end"); idle = true; emit("agent_settled"); },
		success: (id = "reset", willRetry = false) => {
			currentReset = id;
			emit("session_compact", { compactionEntry: { id }, willRetry });
		},
		complete: (index = 0) => requests[index]!.onComplete!({} as Parameters<NonNullable<CompactOptions["onComplete"]>>[0]),
	};
}

test("reset completion, duplicate callbacks, and duplicate tools cannot launch duplicate runs", () => {
	const h = harness();
	assert.equal(h.lifecycle.request(), "rollover_requested");
	assert.equal(h.lifecycle.request(), "rollover_already_pending");
	h.settle();
	h.emit("agent_settled");
	assert.equal(h.requests.length, 1);
	h.success();
	h.success();
	assert.deepEqual(h.messages, [], "nothing starts inside session_compact");
	h.complete();
	h.complete();
	h.emit("agent_settled");
	assert.deepEqual(h.messages, ["continue"]);
	assert.equal(h.requests.length, 1);
});

test("automatic threshold compactions reset on the spot, with no steer and no model turn", () => {
	const h = harness();
	assert.ok(h.before().compaction, "the native attempt becomes our reset immediately");
	assert.deepEqual(h.messages, [], "nothing is sent to the model");
});

test("a native compaction failure is not treated as failure of an explicit reset", () => {
	const h = harness();
	h.emit("session_compact_failed", { reason: "threshold", aborted: true });
	h.lifecycle.request();
	h.settle();
	h.success();
	h.complete();
	assert.deepEqual(h.messages, ["continue"]);
});

test("failed resets release the request, retain history, and do not retry", () => {
	const h = harness();
	h.lifecycle.request();
	h.settle();
	h.emit("session_compact_failed", { reason: "manual", aborted: false });
	h.requests[0]!.onError!(new Error("Nothing to compact"));
	h.requests[0]!.onError!(new Error("duplicate callback"));
	h.complete();
	h.emit("agent_settled");
	assert.equal(h.requests.length, 1);
	assert.equal(h.notices.length, 1);
	assert.deepEqual(h.messages, []);
	h.setIdle(false);
	assert.ok(h.before().compaction, "the next native attempt resets directly");
	assert.equal(h.lifecycle.request(), "rollover_requested", "explicit retry is possible");
	h.settle();
	assert.equal(h.requests.length, 2);
	h.success();
	h.complete(1);
	assert.deepEqual(h.messages, ["continue"]);
});

test("synchronous compact errors cannot leave a permanent in-flight request", () => {
	const h = harness();
	h.setThrow();
	h.lifecycle.request();
	h.settle();
	h.emit("agent_settled");
	assert.equal(h.notices.length, 1);
	assert.equal(h.lifecycle.request(), "rollover_requested");
});

test("user abort ends explicit work without resurrecting the run", () => {
	const h = harness();
	h.lifecycle.request();
	h.setSignal(AbortSignal.abort());
	h.settle();
	assert.equal(h.requests.length, 0);
	assert.equal(h.messages.includes("continue"), false);
});

test("shutdown, restart, tree navigation and toggling off invalidate late callbacks", () => {
	for (const boundary of ["session_shutdown", "session_start", "session_tree", "off"]) {
		const h = harness();
		h.lifecycle.request();
		h.settle();
		h.success();
		if (boundary === "off") { h.disable(); h.enable(); }
		else h.emit(boundary);
		h.complete();
		h.requests[0]!.onError!(new Error("late error"));
		assert.deepEqual(h.messages, [], boundary);
		assert.deepEqual(h.notices, [], boundary);
		if (boundary === "session_shutdown") h.emit("session_start");
		h.lifecycle.request();
		h.settle();
		assert.equal(h.requests.length, 2, `${boundary}: a fresh request still works`);
	}
});

test("callback identity keeps an earlier failure from cancelling a newer request", () => {
	const h = harness();
	h.lifecycle.request(); h.settle();
	h.requests[0]!.onError!(new Error("first failure"));
	h.lifecycle.request(); h.settle();
	h.requests[0]!.onError!(new Error("late first failure"));
	h.success(); h.complete(1);
	assert.deepEqual(h.messages, ["continue"]);
	assert.equal(h.notices.length, 1);
});

test("native compaction satisfies a pending request without duplicating Pi's continuation", () => {
	for (const willRetry of [false, true]) {
		const h = harness();
		h.lifecycle.request();
		h.success("native", willRetry);
		h.settle();
		assert.equal(h.requests.length, 0);
		assert.deepEqual(h.messages, []);
	}
});

test("do not interrupt another active run or duplicate a queued user prompt", () => {
	const h = harness();
	h.lifecycle.request();
	h.setIdle(false);
	h.emit("agent_settled");
	assert.equal(h.requests.length, 0, "another extension already started work");
	h.settle();
	h.success();
	h.setIdle(false);
	h.complete();
	assert.deepEqual(h.messages, [], "the active prompt owns continuation");
	const queued = harness();
	queued.lifecycle.request(); queued.settle(); queued.success();
	queued.setPending(true); queued.complete();
	assert.deepEqual(queued.messages, [], "do not add a competing prompt");
});

test("foreign or unconfirmed reset events cannot trigger a successful continuation", () => {
	const h = harness();
	h.lifecycle.request(); h.settle();
	// isCurrentReset stands in for the reset-v2/window-id check index.ts runs against the
	// compaction entry's details. Emitting the foreign boundary twice proves it is never
	// marked handled, and the request stays in flight rather than completing.
	h.emit("session_compact", { compactionEntry: { id: "foreign" }, willRetry: false });
	h.emit("session_compact", { compactionEntry: { id: "foreign" }, willRetry: false });
	assert.equal(h.lifecycle.request(), "rollover_already_pending", "the ignored event did not complete or clear the attempt");
	h.complete();
	assert.deepEqual(h.messages, [], "an unconfirmed boundary never resumes the run");
	assert.equal(h.lifecycle.request(), "rollover_requested", "the request is released after its own completion");
});
