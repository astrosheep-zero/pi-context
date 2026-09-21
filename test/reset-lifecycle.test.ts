import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerResetLifecycle } from "../src/reset-lifecycle.js";

type CompactOptions = NonNullable<Parameters<ExtensionContext["compact"]>[0]>;
function harness() {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
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
		on: (name: string, fn: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(name, fn),
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
		setSignal: (value: AbortSignal | undefined) => { signal = value; },
		setSession: (value: string) => { sessionId = value; },
		setThrow: () => { throwOnCompact = true; },
		disable: () => { enabled = false; lifecycle.clear(); },
		enable: () => { enabled = true; },
		before: (reason = "threshold") => emit("session_before_compact", { reason, signal: new AbortController().signal }),
		// Do not await this result until after the manually driven compact callbacks:
		// real Pi awaits the originating handler while the continuation can emit its
		// own nested agent_settled event.
		settle: () => { emit("agent_end"); idle = true; return emit("agent_settled"); },
		success: (id = "reset", willRetry = false) => {
			currentReset = id;
			emit("session_compact", { compactionEntry: { id }, willRetry });
		},
		complete: (index = 0) => requests[index]!.onComplete!({} as Parameters<NonNullable<CompactOptions["onComplete"]>>[0]),
	};
}

test("the originating settled handler waits for its continuation's nested settlement", async () => {
	const h = harness();
	assert.equal(h.lifecycle.request(), "rollover_requested");
	assert.equal(h.lifecycle.request(), "rollover_already_pending");
	const outer = h.settle();
	assert.equal(h.requests.length, 1);
	h.success();
	h.success();
	h.complete();
	h.complete();
	assert.deepEqual(h.messages, ["continue"], "one continuation starts after compaction completion");

	let released = false;
	void Promise.resolve(outer).then(() => { released = true; });
	await Promise.resolve();
	assert.equal(released, false, "sending the continuation does not release the original handler");
	await h.settle();
	await outer;
	assert.equal(released, true, "only the continuation's settled event releases its owner");
	assert.equal(h.requests.length, 1, "duplicate compact and settled callbacks do not restart reset work");
});

test("a reset requested by a continuation completes before its predecessor releases", async () => {
	const h = harness();
	h.lifecycle.request();
	const first = h.settle();
	h.success("first"); h.complete();
	assert.deepEqual(h.messages, ["continue"]);

	// This models new_context being called during the first continuation run.
	assert.equal(h.lifecycle.request(), "rollover_requested");
	const second = h.settle();
	assert.equal(h.requests.length, 2, "the continuation's settled handler starts its requested reset");
	h.success("second"); h.complete(1);
	assert.deepEqual(h.messages, ["continue", "continue"]);

	let firstReleased = false;
	void Promise.resolve(first).then(() => { firstReleased = true; });
	await Promise.resolve();
	assert.equal(firstReleased, false, "the predecessor remains owned while the second continuation runs");
	await h.settle();
	await second;
	await first;
	assert.equal(firstReleased, true);
	assert.equal(h.lifecycle.request(), "rollover_requested", "a later window can request another reset");
});

test("automatic compactions reset on the spot, with no continuation", () => {
	const h = harness();
	assert.ok((h.before() as { compaction?: unknown }).compaction, "the native attempt becomes our reset immediately");
	assert.deepEqual(h.messages, []);
});

test("failure, synchronous scheduling errors, and cancellation release their owners without retry", async () => {
	const failed = harness();
	failed.lifecycle.request();
	const outer = failed.settle();
	failed.requests[0]!.onError!(new Error("Nothing to compact"));
	failed.requests[0]!.onError!(new Error("duplicate callback"));
	failed.complete();
	await outer;
	assert.equal(failed.notices.length, 1);
	assert.deepEqual(failed.messages, []);
	assert.equal(failed.lifecycle.request(), "rollover_requested", "a later explicit request is possible");

	const synchronous = harness();
	synchronous.setThrow();
	synchronous.lifecycle.request();
	await synchronous.settle();
	assert.equal(synchronous.notices.length, 1);
	assert.equal(synchronous.lifecycle.request(), "rollover_requested");

	const aborted = harness();
	aborted.lifecycle.request();
	aborted.setSignal(AbortSignal.abort());
	await aborted.settle();
	assert.equal(aborted.requests.length, 0);
	assert.deepEqual(aborted.messages, []);
});

test("shutdown, tree invalidation, toggling off, and stale sessions release waiters safely", async () => {
	for (const boundary of ["session_shutdown", "session_start", "session_tree", "off", "session-change"] as const) {
		const h = harness();
		h.lifecycle.request();
		const outer = h.settle();
		h.success(); h.complete();
		if (boundary === "off") { h.disable(); h.enable(); }
		else if (boundary === "session-change") { h.setSession("second"); h.complete(); h.emit("session_tree"); }
		else h.emit(boundary);
		h.complete();
		h.requests[0]!.onError!(new Error("late error"));
		await outer;
		assert.deepEqual(h.notices, [], boundary);
		assert.deepEqual(h.messages, ["continue"], boundary);
		if (boundary === "session_shutdown") h.emit("session_start");
		if (boundary === "session-change") h.emit("session_tree");
		assert.equal(h.lifecycle.request(), "rollover_requested", `${boundary}: a fresh request still works`);
	}
});

test("queued or competing work is not duplicated and releases an unneeded continuation owner", async () => {
	const competing = harness();
	competing.lifecycle.request();
	competing.setIdle(false);
	assert.equal(competing.emit("agent_settled"), undefined, "another run owns the first settled event");
	competing.setIdle(true);
	const outer = competing.settle();
	competing.success();
	competing.setIdle(false);
	competing.complete();
	await outer;
	assert.deepEqual(competing.messages, [], "an active prompt owns continuation");

	const queued = harness();
	queued.lifecycle.request();
	const queuedOuter = queued.settle();
	queued.success();
	queued.setPending(true); queued.complete();
	await queuedOuter;
	assert.deepEqual(queued.messages, [], "queued user work is never duplicated");
});

test("foreign boundaries and native compactions do not manufacture a continuation", async () => {
	const h = harness();
	h.lifecycle.request();
	const outer = h.settle();
	h.emit("session_compact", { compactionEntry: { id: "foreign" }, willRetry: false });
	h.emit("session_compact", { compactionEntry: { id: "foreign" }, willRetry: false });
	assert.equal(h.lifecycle.request(), "rollover_already_pending");
	h.complete();
	await outer;
	assert.deepEqual(h.messages, []);

	const native = harness();
	native.lifecycle.request();
	native.success("native", false);
	await native.settle();
	assert.equal(native.requests.length, 0);
	assert.deepEqual(native.messages, []);
});
