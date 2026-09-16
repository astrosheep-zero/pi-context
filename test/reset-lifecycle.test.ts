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
		fallback: { customType: "fallback", content: "save notes", display: true },
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
		borrow: () => {
			idle = false;
			assert.deepEqual(emit("session_before_compact", { reason: "threshold", signal: new AbortController().signal }), { cancel: true });
		},
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
	h.borrow();
	assert.equal(h.lifecycle.request(), "rollover_requested");
	assert.equal(h.lifecycle.request(), "rollover_already_pending");
	h.settle();
	h.emit("agent_settled");
	assert.equal(h.requests.length, 1);
	h.success();
	h.success();
	assert.deepEqual(h.messages, ["fallback"], "nothing starts inside session_compact");
	h.complete();
	h.complete();
	h.emit("agent_settled");
	assert.deepEqual(h.messages, ["fallback", "continue"]);
	assert.equal(h.requests.length, 1);
});

test("fallback alone resumes after its extension-requested reset", () => {
	const h = harness();
	h.borrow();
	h.settle();
	h.success();
	h.complete();
	assert.deepEqual(h.messages, ["fallback", "continue"]);
});

test("a borrowed-turn cancellation is not treated as failure of an explicit reset", () => {
	const h = harness();
	h.borrow();
	h.emit("session_compact_failed", { reason: "threshold", aborted: true });
	h.lifecycle.request();
	h.settle();
	h.success();
	h.complete();
	assert.deepEqual(h.messages, ["fallback", "continue"]);
});

test("failed resets release the request, retain history, and do not retry or borrow indefinitely", () => {
	const h = harness();
	h.borrow();
	h.lifecycle.request();
	h.settle();
	h.emit("session_compact_failed", { reason: "manual", aborted: false });
	h.requests[0]!.onError!(new Error("Nothing to compact"));
	h.requests[0]!.onError!(new Error("duplicate callback"));
	h.complete();
	h.emit("agent_settled");
	assert.equal(h.requests.length, 1);
	assert.equal(h.notices.length, 1);
	assert.deepEqual(h.messages, ["fallback"]);
	h.setIdle(false);
	assert.ok(h.before().compaction, "the next native attempt resets without borrowing again");
	assert.equal(h.lifecycle.request(), "rollover_requested", "explicit retry is possible");
	h.settle();
	assert.equal(h.requests.length, 2);
	h.success();
	h.complete(1);
	assert.deepEqual(h.messages, ["fallback", "continue"]);
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

test("user abort ends both explicit and fallback work without resurrecting the run", () => {
	for (const borrow of [false, true]) {
		const h = harness();
		if (borrow) h.borrow();
		h.lifecycle.request();
		h.setSignal(AbortSignal.abort());
		h.settle();
		assert.equal(h.requests.length, 0);
		assert.equal(h.messages.includes("continue"), false);
	}
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
	h.emit("session_compact", { compactionEntry: { id: "foreign" }, willRetry: false });
	h.complete();
	assert.deepEqual(h.messages, []);
	assert.equal(h.lifecycle.request(), "rollover_requested");
});
