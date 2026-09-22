import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_REMINDER_MARGIN_TOKENS, WARNING_RUNWAY_TOKENS } from "../src/protocol.js";
import { deriveThresholds, mergePiContextSettings, readThresholdSettings } from "../src/thresholds.js";

const PI_CONTEXT = "pi-context";
type SettingsInput = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

function context(cwd: string, model?: { provider: string; id: string }): ExtensionContext {
	return {
		cwd,
		model: model as ExtensionContext["model"],
		sessionManager: SessionManager.inMemory(cwd),
		isProjectTrusted: () => true,
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;
}

function settingsWithCustomKey(value: Record<string, unknown>): SettingsInput {
	return { ...value, [PI_CONTEXT]: value[PI_CONTEXT] } as unknown as SettingsInput;
}

test("threshold derivation preserves project-per-key merge and invalid-margin fallback", () => {
	assert.deepEqual(
		mergePiContextSettings(
			{ [PI_CONTEXT]: { reminderMarginTokens: 10_000, dreamer: "global/model" } },
			{ [PI_CONTEXT]: { reminderMarginTokens: 20_000 } },
		),
		{ reminderMarginTokens: 20_000, dreamer: "global/model" },
	);
	assert.deepEqual(deriveThresholds(30_000, { reminderMarginTokens: 20_000 }), {
		thresholds: { reminder: 50_000, reserve: 30_000, warning: 30_000 + WARNING_RUNWAY_TOKENS },
		warnings: [],
	});
	const invalid = deriveThresholds(30_000, { reminderMarginTokens: 0 });
	assert.deepEqual(invalid.thresholds, { reminder: 30_000 + DEFAULT_REMINDER_MARGIN_TOKENS, reserve: 30_000, warning: 30_000 + WARNING_RUNWAY_TOKENS });
	assert.equal(invalid.warnings.length, 1);
});

test("an injected manager is the sole authority, including a custom agentDir", () => {
	const defaultCwd = mkdtempSync(join(tmpdir(), "pi-context-default-cwd-"));
	const defaultAgentDir = mkdtempSync(join(tmpdir(), "pi-context-default-agent-"));
	const customCwd = mkdtempSync(join(tmpdir(), "pi-context-custom-cwd-"));
	const customAgentDir = mkdtempSync(join(tmpdir(), "pi-context-custom-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		writeFileSync(join(defaultAgentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false, reserveTokens: 90_000 } }));
		writeFileSync(join(customAgentDir, "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 12_000 },
			[PI_CONTEXT]: { reminderMarginTokens: 7_000 },
		}));
		mkdirSync(join(customCwd, ".pi"), { recursive: true });
		writeFileSync(join(customCwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { reserveTokens: 24_000 },
			[PI_CONTEXT]: { reminderMarginTokens: 8_000 },
		}));
		process.env.PI_CODING_AGENT_DIR = defaultAgentDir;
		const defaultResolved = readThresholdSettings(context(defaultCwd));
		assert.equal(defaultResolved.automatic, false, "the active default path reads the conflicting default file");
		assert.equal(defaultResolved.thresholds.reserve, 90_000);

		const manager = SettingsManager.create(customCwd, customAgentDir, { projectTrusted: true });
		const resolved = readThresholdSettings(context(defaultCwd), manager);
		assert.equal(resolved.automatic, true, "the injected custom manager's enabled value wins");
		assert.deepEqual(resolved.thresholds, { reminder: 32_000, reserve: 24_000, warning: 24_000 + WARNING_RUNWAY_TOKENS }, "custom agentDir/project settings win over default files and ctx.cwd");

		const inMemory = SettingsManager.inMemory(settingsWithCustomKey({
			compaction: { enabled: true, reserveTokens: 13_000 },
			[PI_CONTEXT]: { reminderMarginTokens: 6_000 },
		}));
		const injected = readThresholdSettings(context(defaultCwd), inMemory);
		assert.equal(injected.thresholds.reserve, 13_000, "default files do not win over an in-memory authority");
		assert.equal(injected.thresholds.reminder, 19_000);
		assert.equal(injected.warnings.length, 0);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(defaultCwd, { recursive: true, force: true });
		rmSync(defaultAgentDir, { recursive: true, force: true });
		rmSync(customCwd, { recursive: true, force: true });
		rmSync(customAgentDir, { recursive: true, force: true });
	}
});

test("injected policy reads live compaction setters and exact model overrides", () => {
	const manager = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			reserveTokens: 10_000,
			modelOverrides: { "openai/model-a": { reserveTokens: 30_000 } },
		},
	});
	const ctx = context("/private/tmp/pi-context-thresholds", { provider: "openai", id: "model-a" });
	assert.equal(readThresholdSettings(ctx, manager).thresholds.reserve, 30_000);

	manager.setCompactionEnabled(false);
	assert.equal(readThresholdSettings(ctx, manager).automatic, false);
	manager.applyOverrides({ compaction: { enabled: true, reserveTokens: 40_000 } });
	assert.equal(readThresholdSettings(ctx, manager).automatic, true);
	assert.equal(readThresholdSettings(ctx, manager).thresholds.reserve, 30_000, "model-specific reserve still wins over the ordinary override");
	(ctx as { model: ExtensionContext["model"] }).model = { provider: "openai", id: "model-b" } as ExtensionContext["model"];
	assert.equal(readThresholdSettings(ctx, manager).thresholds.reserve, 40_000, "switching models selects the live ordinary reserve");
});

test("threshold resolution leaves public settings diagnostics for the embedding app", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-context-errors-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi-context-errors-agent-"));
	try {
		writeFileSync(join(agentDir, "settings.json"), "{ invalid settings json");
		const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const resolved = readThresholdSettings(context(cwd), manager);
		assert.ok(resolved.thresholds.reserve > 0, "resolution still falls back to usable SDK defaults");
		const errors = manager.drainErrors();
		assert.equal(errors.length, 1, "the extension leaves the SDK settings error queued for its host");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});
