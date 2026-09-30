import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatch, handleLine } from "../src/claude/helper.js";

const identity = { home: mkdtempSync(join(tmpdir(), "claude-mod-")), sessionId: "session", cwd: process.cwd(), agent: "claude", model: "claude" };

test("Claude helper exposes the five shared note schemas", async () => {
  const schemas = await dispatch({ op: "schemas" }) as Array<{ name: string; description: string; inputSchema: { type: string } }>;
  assert.deepEqual(schemas.map((schema) => schema.name), ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search"]);
  assert.ok(schemas.every((schema) => schema.description.length > 20 && schema.inputSchema.type === "object"));
});

test("Claude helper dispatches notes and rejects malformed or unknown requests", async () => {
  const write = await dispatch({ op: "tool", tool: "notes_write", identity, params: { address: "checkpoint.md", content: "hello" } }) as { content: Array<{ text: string }> };
  assert.match(write.content[0]?.text ?? "", /checkpoint/);
  const malformed = JSON.parse(await handleLine("not json")) as { ok: boolean; error: string };
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /Unexpected|malformed/);
  const unknown = JSON.parse(await handleLine(JSON.stringify({ op: "tool", tool: "history_read", identity, params: {} }))) as { ok: boolean; error: string };
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "unknown tool");
});

test("Claude helper boot uses actual Claude note tool bindings and a fresh snapshot", async () => {
  const boot = await dispatch({ op: "boot", identity, openedAt: 1700000000000, tools: {
    notes: "mcp__pi-context__notes_*", notesList: "mcp__pi-context__notes_list",
    history: "history unavailable", historyList: "history_list unavailable", historySearch: "history_search unavailable", historyRead: "history_read unavailable",
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

test("Claude Mod uses persisted prompt.context boot blocks exactly once", () => {
  const source = readFileSync(join(process.cwd(), "mods/pi-context/hooks/register.ts"), "utf8");
  assert.match(source, /on\("prompt\.context"/);
  assert.doesNotMatch(source, /on\("prompt\.submit"/);
  assert.match(source, /block\.name === "pi-context:boot"/);
  assert.match(source, /name: "pi-context:boot"/);
  assert.ok(source.includes("blocks: [...result.blocks, block]"));
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
