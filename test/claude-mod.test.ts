import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { dispatch, handleLine, type ClaudeToolResult } from "../src/claude/helper.js";

const identity = { home: mkdtempSync(join(tmpdir(), "claude-mod-")), sessionId: "session", cwd: process.cwd(), agent: "claude", model: "claude" };

type ToolOutcome = { ok: boolean; error?: { code: string; message: string } };

/** One engine handler: it receives the engine, the event, and the rest of the chain. */
type HookHandler = ($: HookEngine, e: Record<string, unknown>, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;
/** The engine surface the hook actually touches: no session, no model, no user configuration. */
type HookEngine = {
  env: { get: (name: string) => Promise<string | undefined> };
  session: { id: () => Promise<string> };
  tool: { register: (spec: { name: string }) => Promise<{ tool: string }> };
  process: { run: (argv: readonly string[], init?: { cwd?: string; stdin?: string }) => Promise<{ exitCode: number; stdout: string }> };
};

async function callTool(tool: string, params: Record<string, unknown>): Promise<ClaudeToolResult> {
  return await dispatch({ op: "tool", tool, identity, params }) as ClaudeToolResult;
}

/**
 * Load the hooks module the way the engine loads it: its own directory decides where the helper is,
 * which `import.meta.dir` expresses at run time. Node has no such global, so the transpiled copy
 * gets the real one; nothing else about the module is changed.
 */
async function loadHookModule(t: test.TestContext): Promise<{ register: (on: (event: string, handler: HookHandler) => void) => void }> {
  const hooksDir = join(process.cwd(), "mods/pi-context/hooks");
  const transpiled = await build({
    stdin: { contents: readFileSync(join(hooksDir, "register.ts"), "utf8"), loader: "ts", resolveDir: hooksDir, sourcefile: "register.ts" },
    bundle: false, format: "esm", platform: "node", target: "node22", write: false,
    banner: { js: `import.meta.dir = ${JSON.stringify(hooksDir)};` },
  });
  const loaded = mkdtempSync(join(tmpdir(), "claude-hook-module-"));
  t.after(() => rmSync(loaded, { recursive: true, force: true }));
  const module = join(loaded, "register.mjs");
  writeFileSync(module, transpiled.outputFiles[0]!.text);
  return await import(pathToFileURL(module).href) as { register: (on: (event: string, handler: HookHandler) => void) => void };
}

/** An engine that answers the hook by running the real helper against a throwaway notes home. */
function fakeEngine(home: string): { host: HookEngine; registered: string[] } {
  const registered: string[] = [];
  return {
    registered,
    host: {
      env: { get: async (name) => name === "PI_NOTES_HOME" ? home : undefined },
      session: { id: async () => "hook-session" },
      tool: { register: async (spec) => { registered.push(spec.name); return { tool: `mcp__pi-context__${spec.name}` }; } },
      process: { run: async (argv, init) => ({
        exitCode: 0,
        stdout: execFileSync(argv[0]!, argv.slice(1), { cwd: init?.cwd, input: init?.stdin, encoding: "utf8" }),
      }) },
    },
  };
}

test("Claude helper exposes the five shared note schemas", async () => {
  const schemas = await dispatch({ op: "schemas" }) as Array<{ name: string; description: string; inputSchema: { type: string } }>;
  assert.deepEqual(schemas.map((schema) => schema.name), ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search"]);
  assert.ok(schemas.every((schema) => schema.description.length > 20 && schema.inputSchema.type === "object"));
});

test("Claude helper delivers the shared text and the shared outcome it came from", async () => {
  const write = await callTool("notes_write", { address: "checkpoint.md", content: "hello" });
  assert.equal((write.outcome as ToolOutcome).ok, true);
  assert.match(write.text, /checkpoint\.md/);
  assert.equal(write.text.includes("READ WINDOW"), false, "Claude reads the same presentation as Pi");
  const missing = await callTool("notes_read", { address: "absent.md" });
  assert.equal((missing.outcome as ToolOutcome).ok, false);
  assert.equal((missing.outcome as Required<ToolOutcome>).error?.code, "not_found");
  assert.match(missing.text, /^error: not_found: /, "the refusal renders as the shared error line");
});

test("Claude helper rejects malformed or unknown requests", async () => {
  const malformed = JSON.parse(await handleLine("not json")) as { ok: boolean; error: string };
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /Unexpected|malformed/);
  const unknown = JSON.parse(await handleLine(JSON.stringify({ op: "tool", tool: "history_read", identity, params: {} }))) as { ok: boolean; error: string };
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "unknown tool");
});

test("Claude helper refuses schema-invalid parameters before any operation runs", async () => {
  const address = "boundary.md";
  const written = await callTool("notes_write", { address, content: "boundary body" });
  assert.equal((written.outcome as ToolOutcome).ok, true, "the fixture note exists before anything is refused");

  const cases: Array<{ name: string; params: Record<string, unknown> }> = [
    { name: "a string offset", params: { address, offset_chars: "0" } },
    { name: "a fractional offset", params: { address, offset_chars: 0.5 } },
    { name: "a zero limit", params: { address, limit_chars: 0 } },
    { name: "a limit past the maximum", params: { address, limit_chars: 999_999_999 } },
  ];
  for (const { name, params } of cases) {
    const refused = JSON.parse(await handleLine(JSON.stringify({ op: "tool", tool: "notes_read", identity, params }))) as { ok: boolean; error?: string };
    assert.equal(refused.ok, false, `${name} is refused at the boundary`);
    assert.equal(refused.error, "invalid notes_read parameters", `${name} names the refused parameters`);
  }
  await assert.rejects(callTool("notes_read", { address, offset_chars: "0" }), /invalid notes_read parameters/);

  // Refusal happens before execute: a rejected mutation leaves nothing on disk.
  await assert.rejects(callTool("notes_write", { address: "rejected.md", content: 42 }), /invalid notes_write parameters/);
  const absent = await callTool("notes_read", { address: "rejected.md" });
  assert.equal((absent.outcome as ToolOutcome).ok, false);
  assert.equal((absent.outcome as Required<ToolOutcome>).error?.code, "not_found", "the refused write never reached the store");

  const valid = await callTool("notes_read", { address, offset_chars: 0, limit_chars: 8 });
  assert.equal((valid.outcome as ToolOutcome).ok, true, "a schema-valid window still reads");
  assert.match(valid.text, /^boundary\.md/);
});

test("Claude helper boot uses actual Claude note tool bindings and a fresh snapshot", async () => {
  const boot = await dispatch({ op: "boot", identity, openedAt: 1700000000000, tools: {
    notes: "mcp__pi-context__notes_*", notesList: "mcp__pi-context__notes_list",
    history: "history unavailable", historyWindows: "history_windows unavailable", historyList: "history_list unavailable", historySearch: "history_search unavailable", historyRead: "history_read unavailable",
    remaining: "remaining unavailable", wipe: "wipe unavailable",
  } }) as string;
  assert.match(boot, /mcp__pi-context__notes_\*/);
  assert.match(boot, /claude:session/);
  assert.doesNotMatch(boot, /memory cleared|continuation/);
});


test("Claude Mod helper runs from a standalone copied plugin directory", () => {
  const fixture = mkdtempSync(join(tmpdir(), "claude-mod-install-"));
  try {
    const plugin = join(fixture, "pi-context");
    cpSync(join(process.cwd(), "mods/pi-context"), plugin, { recursive: true });
    const hook = readFileSync(join(plugin, "hooks/register.ts"), "utf8");
    assert.ok(hook.includes('${import.meta.dir}/../dist/claude/helper.js'));
    const helper = join(plugin, "dist/claude/helper.js");
    const run = (input: string) => JSON.parse(execFileSync(process.execPath, [helper], {
      cwd: fixture, input, encoding: "utf8",
    })) as { ok: boolean; result?: Array<{ name: string }>; error?: string };
    const schemas = run('{"op":"schemas"}');
    assert.equal(schemas.ok, true);
    assert.equal(schemas.result?.length, 5);
    assert.equal(run("not json").ok, false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Claude Mod appends boot once and reuses persisted blocks after re-registration", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-hook-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // Count the boot requests the hook actually sends while the real helper still answers every one.
  let bootRequests = 0;
  const { host } = fakeEngine(home);
  const runProcess = host.process.run;
  host.process.run = async (argv, init) => {
    const request = JSON.parse(String(init?.stdin ?? "")) as { op?: string };
    if (request.op === "boot") bootRequests += 1;
    return await runProcess(argv, init);
  };

  // Each registration is a fresh hook closure, so any dedup it shows lives in the persisted result.
  const registerSession = async () => {
    const hooks = await loadHookModule(t);
    const handlers = new Map<string, HookHandler>();
    hooks.register((event, handler) => handlers.set(event, handler));
    await handlers.get("session.start")!(host, { cwd: home }, async (event: unknown) => event);
    return handlers;
  };

  let nextCalls = 0;
  const promptContext = (handlers: Map<string, HookHandler>, result: Record<string, unknown>) =>
    handlers.get("prompt.context")!(host, { cwd: home }, async () => { nextCalls += 1; return result; }) as Promise<{ blocks: Array<{ name: string; text: string }> } & Record<string, unknown>>;

  const upstream = { blocks: [{ name: "claude:user-context", text: "unrelated upstream block" }], sentinel: "kept" };

  const first = await promptContext(await registerSession(), structuredClone(upstream));
  assert.equal(first.blocks.length, 2, "exactly one boot block joins the upstream blocks");
  assert.deepEqual(first.blocks[0], upstream.blocks[0], "the upstream block is preserved untouched");
  const boot = first.blocks[1]!;
  assert.equal(boot.name, "pi-context:boot");
  assert.ok(boot.text.length > 0, "the boot block carries real boot text");
  assert.match(boot.text, /mcp__pi-context__notes_\*/, "the boot text names the actual Claude note tool binding");
  assert.equal(first.sentinel, "kept", "unrelated result fields survive");
  assert.equal(bootRequests, 1, "the first prompt makes exactly one boot helper request");
  assert.equal(nextCalls, 1, "the upstream chain runs exactly once per prompt");

  const second = await promptContext(await registerSession(), structuredClone(first));
  assert.deepEqual(second, first, "the persisted result, boot block and sentinel included, is reused unchanged");
  assert.equal(bootRequests, 1, "a persisted boot block needs no second boot helper request");
  assert.equal(nextCalls, 2, "the upstream chain still runs exactly once per prompt");
});

test("Claude Mod hook delivers the helper's shared text, and marks only a refusal as an error", async (t) => {
  const hooks = await loadHookModule(t);
  const home = mkdtempSync(join(tmpdir(), "claude-hook-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host, registered } = fakeEngine(home);
  const handlers = new Map<string, HookHandler>();
  hooks.register((event, handler) => handlers.set(event, handler));
  await handlers.get("session.start")!(host, { cwd: home }, async (event: unknown) => event);
  assert.deepEqual(registered, ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search"]);

  const call = (tool: string, params: Record<string, unknown>) => handlers.get("tool.call")!(host, { tool: `mcp__pi-context__${tool}`, tool_use_id: "hook-1", ...params }, async (event: unknown) => event) as Promise<{ result: unknown; isError?: unknown }>;

  const written = await call("notes_write", { address: "hook.md", content: "hook body" });
  assert.equal(written.result, "created hook.md", "the hook hands back the shared text unchanged");
  assert.equal("isError" in written, false, "a success carries no discriminator at all, not a false one");

  const refused = await call("notes_read", { address: "absent.md" });
  assert.equal(refused.isError, true, "a refusal carries the literal the public ToolCallResult declares");
  assert.match(String(refused.result), /^error: not_found: /, "the refusal reads as the shared error line");

  // A tool this plugin never registered is somebody else's answer, not a pi-context refusal.
  const foreign = await call("other_tool", {});
  assert.equal("result" in foreign, false, "an unregistered tool falls through to the engine's own handling");
});


test("Claude dream skill projection stays byte-identical to canonical shared files", () => {
  assert.deepEqual(
    readFileSync(join(process.cwd(), "mods/pi-context/skills/dream/SKILL.md")),
    readFileSync(join(process.cwd(), "skills/dream/SKILL.md")),
  );
  assert.deepEqual(
    readFileSync(join(process.cwd(), "mods/pi-context/playbook.md")),
    readFileSync(join(process.cwd(), "playbook.md")),
  );
  const skill = readFileSync(join(process.cwd(), "mods/pi-context/skills/dream/SKILL.md"), "utf8");
  assert.match(skill, /\.\.\/\.\.\/playbook\.md/);
  assert.doesNotMatch(skill, /Claude.*runner|dream runner/i);
});
