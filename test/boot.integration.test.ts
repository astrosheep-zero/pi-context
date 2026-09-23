import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { historyFromSession, internal } from "../src/index.js";
import { listNotes, physicalPath } from "./helpers/notes.js";
import { CONTINUATION_TYPE, WARNING_TYPE } from "../src/protocol.js";
import {
	appendText,
	call,
	commitTurnEndBoundary,
	context,
	explicitBoot,
	makeExtension,
	manager,
	noticesOf,
	resultJson,
	resultRead,
	runContextHook,
	runContextWithSystemHook,
	runHandlers,
	runManualCompact,
	runCommand,
	sentOf,
} from "./helpers/extension.js";
import { installExtensionTestHooks } from "./helpers/extension-test-environment.js";

const testEnvironment = installExtensionTestHooks("pi-context-integration");

test("custom reset marker removes old provider context while history remains searchable", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	const oldUserId = appendText(sessionManager, "user", "OLD-UNIQUE-TRANSCRIPT needle");
	appendText(sessionManager, "assistant", "I will use a tool");
	const toolResultId = appendText(sessionManager, "toolResult", "tool result safely recorded");
	await call(captured, "wipe_memory", {}, ctx);
	const boundary = await commitTurnEndBoundary(captured, sessionManager, ctx);
	assert.equal(boundary.continue, true);
	const branch = sessionManager.getBranch();
	const marker = branch.find((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE);
	assert.ok(marker && marker.type === "custom");
	const checkpoint = branch.find((entry) => entry.type === "compaction");
	assert.ok(checkpoint && checkpoint.type === "compaction", "reset persists a native retain-none checkpoint");
	assert.equal(checkpoint.parentId, toolResultId, "checkpoint follows the completed tool result");
	assert.equal(checkpoint.summary, "");
	assert.equal(checkpoint.firstKeptEntryId, checkpoint.id);
	assert.equal(marker.parentId, checkpoint.id, "marker follows the native checkpoint");
	assert.deepEqual(Object.keys(marker.data as object), ["windowId"]);
	const projected = await runContextWithSystemHook(captured, ctx, sessionManager.buildSessionContext().messages);
	const providerText = JSON.stringify(projected?.messages ?? []);
	assert.equal(providerText.includes("OLD-UNIQUE-TRANSCRIPT"), false);
	assert.equal(providerText.includes(internal.CONTEXT_WINDOW_OPEN_TAG), true);
	assert.equal(providerText.includes(internal.RESET_MARKER_TYPE), false, "plain reset state never reaches the provider");

	const windows = historyFromSession(ctx);
	assert.equal(windows.length, 2);
	const oldWindow = windows[0]?.windowId;
	assert.ok(oldWindow);
	const read = resultRead(await call(captured, "history_read", { window_id: oldWindow, item_id: oldUserId }, ctx));
	assert.match(read.content, /OLD-UNIQUE-TRANSCRIPT/);
	const found = resultJson<{ items: Array<{ item_id: string }> }>(await call(captured, "history_search", { query: "needle" }, ctx));
	assert.equal(found.items.length, 1);
	assert.equal(found.items[0]?.item_id, oldUserId);
});

test("the root boot and reset boot carry durable window identity", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	appendText(sessionManager, "user", "task before reset");
	appendText(sessionManager, "assistant", "working");
	await call(captured, "notes_write", { address: "decisions.md", content: "use terra" }, ctx);

	// Root window: session_start persists the boot block without triggering a turn.
	await runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	assert.equal(captured.sent.length, 1);
	const rootBoot = captured.sent[0];
	assert.equal(rootBoot?.message.customType, internal.BOOT_TYPE);
	assert.equal(rootBoot?.message.display, false, "boot block stays out of the TUI");
	assert.equal(rootBoot?.options?.triggerTurn, false);
	assert.equal(noticesOf(ctx).length, 0, "initial boot is silent");
	await runHandlers(captured, "session_start", { reason: "reload" }, ctx);
	assert.equal(noticesOf(ctx).length, 0, "reload is silent");
	assert.deepEqual(rootBoot?.message.details, { windowId: `pcw:${sessionManager.getSessionId().slice(0, 8)}:root` });
	const rootText = typeof rootBoot?.message.content === "string" ? rootBoot.message.content : "";
	assert.ok(rootText.startsWith(internal.CONTEXT_WINDOW_OPEN_TAG), "root block omits the reset line");
	assert.equal(rootText.includes(internal.CONTINUATION), false, "root startup carries no reset message");
	assert.equal(rootText.includes("Previous context window id:"), false, "root block omits the previous-id line");
	assert.match(rootText, new RegExp(`First context window id: pcw:${sessionManager.getSessionId().slice(0, 8)}:root`));
	assert.match(rootText, new RegExp(`Current context window id: pcw:${sessionManager.getSessionId().slice(0, 8)}:root`));
	assert.ok(rootText.includes("decisions.md"));
	const decisionsMeta = (await listNotes(ctx, { scope: "session" })).find((row) => row.path === "decisions.md")?.meta;
	assert.ok(decisionsMeta);
	assert.match(rootText, /updated \d+s ago\)/, "boot note metadata carries a relative update time");
	assert.ok(rootText.includes(internal.CONTEXT_WINDOW_PROTOCOL_OPEN_TAG));

	// Reset: the marker and boot are committed together at the turn boundary.
	await call(captured, "wipe_memory", {}, ctx);
	assert.equal(noticesOf(ctx).length, 0, "requesting a reset does not announce success");
	const boundary = await commitTurnEndBoundary(captured, sessionManager, ctx);
	assert.equal(boundary.continue, true);
	await runHandlers(captured, "turn_start", {}, ctx);
	await runHandlers(captured, "agent_settled", {}, ctx);
	assert.equal(noticesOf(ctx).filter((notice) => notice.message.includes("memory cleared")).length, 1, "the committed reset is announced once");
	const entries = sessionManager.getBranch();
	const marker = entries.find((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE);
	assert.ok(marker && marker.type === "custom");
	const resetWindowId = (marker.data as { windowId: string }).windowId;
	const resetBoot = entries.find((entry) => entry.type === "custom_message" && entry.customType === internal.BOOT_TYPE && entry.details && typeof entry.details === "object" && (entry.details as { windowId?: unknown }).windowId === resetWindowId);
	assert.ok(resetBoot && resetBoot.type === "custom_message");
	assert.equal((resetBoot.details as { windowId: string }).windowId, (marker.data as { windowId: string }).windowId);
	const continuation = entries.find((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE);
	assert.ok(continuation && continuation.type === "custom_message" && continuation.display === false, "the resumed run is represented by one hidden continuation");
});

test("an aborted async boot repair emits no boot, continuation, or incomplete-notes notice", async () => {
	const notesHome = process.env.PI_NOTES_HOME;
	assert.ok(notesHome);
	rmSync(notesHome, { recursive: true, force: true });
	writeFileSync(notesHome, "not a directory");
	const sessionManager = manager();
	const windowId = "pcw:aborted-boot-repair";
	sessionManager.appendCustomEntry(internal.RESET_MARKER_TYPE, { windowId });
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	const controller = new AbortController();
	ctx.signal = controller.signal;
	const sessionStart = captured.handlers.get("session_start")?.[0];
	assert.ok(sessionStart);
	const pending = sessionStart({ reason: "startup" } as never, ctx);
	controller.abort();
	await pending;

	assert.equal(captured.sent.length, 0, "aborted snapshot work cannot append the reset boot or continuation");
	assert.equal(noticesOf(ctx).some((notice) => notice.message.includes("notes index incomplete")), false, "aborted snapshot work cannot notify about missing homes");
	assert.equal(sessionManager.getBranch().some((entry) => entry.type === "custom_message" && [internal.BOOT_TYPE, CONTINUATION_TYPE].includes(entry.customType)), false);
});

test("a marker tail with only metadata repairs its missing boot and continuation without moving the boundary", async () => {
	const sessionManager = manager(true);
	const windowId = "pcw:metadata-tail";
	const markerId = sessionManager.appendCustomEntry(internal.RESET_MARKER_TYPE, { windowId });
	const modelChangeId = sessionManager.appendModelChange("openai", "scripted-model");
	sessionManager.appendThinkingLevelChange("low");
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);

	await runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	const branch = sessionManager.getBranch();
	const markerIndex = branch.findIndex((entry) => entry.id === markerId);
	const bootEntries = branch.filter((entry) => entry.type === "custom_message" && entry.customType === internal.BOOT_TYPE && entry.details && typeof entry.details === "object" && (entry.details as { windowId?: unknown }).windowId === windowId);
	const continuationEntries = branch.filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE);
	assert.equal(bootEntries.length, 1, "an incomplete marker tail gets one repaired boot");
	assert.equal(continuationEntries.length, 1, "the same repair completes the missing continuation");
	assert.ok(branch.findIndex((entry) => entry.id === modelChangeId) > markerIndex, "metadata remains after the marker");
	assert.ok(branch.findIndex((entry) => entry.id === bootEntries[0]?.id) > markerIndex, "the repaired boot remains in the marked window");
	assert.ok(branch.findIndex((entry) => entry.id === continuationEntries[0]?.id) > branch.findIndex((entry) => entry.id === bootEntries[0]?.id), "the continuation follows its boot");
	assert.equal(captured.sent.length, 2, "repair emits only the missing boot and continuation, without a model turn");
	assert.equal(captured.sent[0]?.message.customType, internal.BOOT_TYPE);
	assert.equal(captured.sent[1]?.message.customType, CONTINUATION_TYPE);
	assert.equal(noticesOf(ctx).length, 0, "repairing a reset tail is not a new reset");
});

test("a bare marker tail repairs the full ordered reset shape", async () => {
	const sessionManager = manager(true);
	const windowId = "pcw:bare-marker";
	const markerId = sessionManager.appendCustomEntry(internal.RESET_MARKER_TYPE, { windowId });
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);

	await runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	assert.equal(captured.sent.length, 2, "a bare marker emits a boot and a continuation");
	const branch = sessionManager.getBranch();
	const markerIndex = branch.findIndex((entry) => entry.id === markerId);
	const bootIndex = branch.findIndex((entry) => entry.type === "custom_message" && entry.customType === internal.BOOT_TYPE && (entry.details as { windowId?: string } | undefined)?.windowId === windowId);
	const continuationIndex = branch.findIndex((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE);
	assert.ok(bootIndex > markerIndex, "the repaired boot follows its marker");
	assert.ok(continuationIndex > bootIndex, "the repaired continuation follows its boot");
});

test("a marker tail that already carries a boot repairs only its missing continuation, once", async () => {
	const sessionManager = manager(true);
	const windowId = "pcw:missing-continuation";
	const markerId = sessionManager.appendCustomEntry(internal.RESET_MARKER_TYPE, { windowId });
	sessionManager.appendModelChange("openai", "scripted-model");
	sessionManager.appendCustomMessageEntry(internal.BOOT_TYPE, "already-persisted boot", false, { windowId });
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);

	await runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	assert.equal(captured.sent.length, 1, "only the missing continuation is emitted");
	assert.equal(captured.sent[0]?.message.customType, CONTINUATION_TYPE);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.BOOT_TYPE).length, 1, "the existing boot is never duplicated");
	assert.ok(sessionManager.getBranch().findIndex((entry) => entry.id === markerId) >= 0);

	await runHandlers(captured, "session_start", { reason: "reload" }, ctx);
	assert.equal(captured.sent.length, 1, "a complete reset tail is idempotent");
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE).length, 1);
});

test("a marker tail followed by real conversation is never repaired", async () => {
	const sessionManager = manager(true);
	const windowId = "pcw:unsafe-tail";
	sessionManager.appendCustomEntry(internal.RESET_MARKER_TYPE, { windowId });
	appendText(sessionManager, "user", "post-marker work that must not be pushed behind a late boot");
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);

	await runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	assert.equal(captured.sent.length, 0, "an unsafe marker tail emits nothing");
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.BOOT_TYPE).length, 0, "no boot is appended after real work");
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE).length, 0, "no continuation is appended after real work");
});

test("off preserves an existing marker window and still cancels native compaction", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	appendText(sessionManager, "user", "old context must stay hidden");
	const windowId = "pcw:test:existing";
	sessionManager.appendCustomEntry(internal.RESET_MARKER_TYPE, { windowId });
	sessionManager.appendCustomMessageEntry(internal.BOOT_TYPE, "fresh boot", false, { windowId });
	await runCommand(captured, "pi-context", "off", ctx);
	const before = await runManualCompact(captured, ctx);
	assert.deepEqual(before, { cancel: true });
	const projected = await runContextWithSystemHook(captured, ctx, sessionManager.buildSessionContext().messages);
	assert.equal(JSON.stringify(projected?.messages ?? []).includes("old context must stay hidden"), false);
	const windows = resultJson<{ windows: Array<{ window_id: string }> }>(await call(captured, "history_windows", {}, ctx));
	assert.equal(windows.windows[0]?.window_id, windowId);
});

test("wipe_memory uses one turn boundary and never calls ctx.compact", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager, () => assert.fail("ctx.compact must not be used"));
	appendText(sessionManager, "user", "enough history for the boundary test");
	const result = resultJson<{ status?: string }>(await call(captured, "wipe_memory", {}, ctx));
	assert.ok(result.status);
	const boundary = await commitTurnEndBoundary(captured, sessionManager, ctx);
	assert.equal(boundary.continue, true);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE).length, 1);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === internal.BOOT_TYPE && entry.details && typeof entry.details === "object" && "windowId" in entry.details).length, 1);
});

test("pi-context command toggles future work, /wipe-memory starts close-out, and /compact remains disabled", async () => {
	const sessionManager = manager();
	appendText(sessionManager, "user", "hello");
	const captured = makeExtension(sessionManager);
	const low = context(sessionManager, undefined, { tokens: 170_000, contextWindow: 200_000, percent: 85 });

	// On by default: session_start persists the root boot block.
	await runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 1);
	assert.equal(captured.sent[0]?.message.customType, internal.BOOT_TYPE);

	let notices = await runCommand(captured, "pi-context", "off", low);
	assert.match(notices[0]?.message ?? "", /off/);
	assert.equal(await runContextHook(captured, low), undefined, "no guidance while off");
	assert.equal(sentOf(captured, internal.GUIDANCE_TYPE).length, 0, "no guidance persisted while off");
	await runHandlers(captured, "session_start", { reason: "startup" }, low);
	assert.equal(captured.sent.length, 1, "no new boot block is persisted while off");
	const offResult = resultJson<{ error?: string }>(await call(captured, "wipe_memory", {}, low));
	assert.match(offResult.error ?? "", /off/, "wipe_memory refuses while off");

	notices = await runCommand(captured, "pi-context", "on", low);
	assert.match(notices[0]?.message ?? "", /on/);
	notices = await runCommand(captured, "wipe-memory", "", low);
	assert.equal(notices.length, 0, "the command begins a model close-out rather than announcing a reset request");
	assert.equal(captured.sent.length, 2, "the command persists one hidden warning after the startup boot");
	assert.equal(captured.sent[1]?.options?.triggerTurn, true, "the shared warning starts an ordinary agent turn");
	assert.equal(captured.sent[1]?.message.customType, WARNING_TYPE);
	assert.equal(captured.sent[1]?.message.display, false);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === internal.RESET_MARKER_TYPE).length, 0, "no reset is claimed until close-out completes");
	const markerContext = await runManualCompact(captured, low);
	assert.deepEqual(markerContext, { cancel: true }, "/compact is canceled while context windows are enabled");
	const projected = await runContextWithSystemHook(captured, low, sessionManager.buildSessionContext().messages);
	assert.equal(JSON.stringify(projected?.messages ?? []).includes("hello"), true, "the old window remains active until the close-out commits");

	notices = await runCommand(captured, "pi-context", "maybe", low);
	assert.equal(notices[0]?.type, "error", "unknown argument rejected");

	// Bare command reports current state without changing it.
	notices = await runCommand(captured, "pi-context", "", low);
	assert.match(notices[0]?.message ?? "", /on/);
});
