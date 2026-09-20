# Codex experimental context management — captured live samples (2026-09-20, codex 0.155.1, gpt-6-astra)

## <context_window_guidance> (developer message, every window)
<context_window_guidance>
For tasks that may span context windows, use `notes` to maintain a concise checkpoint of the goal, decisions, progress, learnings and next steps. Include the window ID and item ID for every relevant user request you are currently solving as well as important actions/tool calls. You can use `history` tool to look up details with the references later. Note that every non-assistant item, such as user, developer, tool response, has an item id `[id: ...]` that is immediately after its item content. Relative note paths belong to the current thread; absolute paths may read other threads' notes, but writes are limited to the current thread.

It is a good idea to take incremental notes while you work so that you do not miss any important info. You can also use `get_context_remaining` tool to find the remaining token budget for better planning. Once the token budget is exhausted, you will lose access to the current window and continue in a fresh context window and you can only recover through `notes` and `history` tools. So be careful not to over-run the context window without any documentation.

If Previous context window id is present in `<context_window>`, it means a context reset occurred and this is a new window. After a reset, read the checkpoint and use the read-only `history` tool to recover any missing details. When a window ID and item ID are known, prefer `read_item` directly; when they are missing or uncertain, use `list_items`, or `search_contents` to locate the item first.

Treat notes and history as internal bookkeeping. Do not mention them in user-facing messages.
</context_window_guidance>

## <context_window> (developer message, window 0 sample)
<context_window>
Agent name: /root
First context window id: 01a0bd4f-8b38-7860-8aea-8575c5ef50b0
Current context window id: 01a0bd4f-8b38-7860-8aea-8575c5ef50b0
</context_window>

## thread_hint (POST /backend-api/codex/alpha/notes/v2/thread_hint)
Request:  {"context": {"session_id": "<thread-uuid>", "current_agent_name": "/root"}}
Fresh thread response:  {"text": ""}
After one note written + new_context rollover, SAME thread:
{"text": "Recent notes (up to 5, most-recent first):\n- /root/notes/checkpoint.md (1 lines, 78 UTF-8 bytes)"}

## Tool namespaces declared to model (additional_tools developer item)
- functions: exec, wait, request_user_input, request_user_input_async, new_context
- clock: sleep
- collaboration: followup_task, interrupt_agent, list_agents, send_message, spawn_agent, wait_agent
- history: list_items, list_windows, read_item, search_contents
- notes: append_to_file, list_files_by_prefix, read_file, search_contents, write_file
(no get_context_remaining seen in prewarm additional_tools; guidance references it)

## Encryption
write_file/append/search arguments go over the wire Fernet-encrypted (gAAAAAB...)
with header x-openai-encrypted-tool-arguments: true; response is {"encrypted_output": "gAAAAAB..."}.
Server-side notes content is opaque to the local client; thread_hint only leaks path/lines/bytes metadata.

## Recipe that worked (isolated CODEX_HOME, no changes to user config)
1. claude-tap --tap-no-launch --tap-client codex --tap-target https://chatgpt.com \
     --tap-host 127.0.0.1 --tap-port 18927 --tap-allow-path /backend-api/codex
2. lab CODEX_HOME with auth.json copy + config.toml:
   [features.token_budget]
   enabled = true
   use_history_notes_extension = true
3. CODEX_HOME=<lab>/home codex -c openai_base_url='"http://127.0.0.1:18927/backend-api/codex"' \
     exec --skip-git-repo-check "<prompt>" </dev/null
Key: provider stays built-in `openai` (name "OpenAI" passes is_openai), base_url suffix
/backend-api/codex passes supports_codex_backend_routes; manual token_budget enable bypasses
the supports_experimental_context hard check (it sits inside the ContextManagement block).
Server /models STILL reports supports_experimental_context=false for ALL models, yet
alpha/notes/v2/* returns 200 — the flag only gates the client AUTO-enable path.

## ★ thread_hint content — definitive (2026-09-20 experiment 2)
Hint = notes INDEX ONLY, injected as a section inside <context_window> after the id lines:
```
<context_window>
Agent name: /root
First context window id: 01a0bd52-fcc0-71d3-91cd-8972dd5f5692
Current context window id: 01a0bd5d-ae24-7033-8ab1-7e8d982055e0
Previous context window id: 01a0bd56-11c1-7a80-8bf1-439fed00ffef
Recent notes (up to 5, most-recent first):
- /root/notes/plan.md (3 lines, 67 UTF-8 bytes)
- /root/notes/checkpoint.md (12 lines, 722 UTF-8 bytes)
</context_window>
```
Per-file = agent-scoped path + line count + UTF-8 bytes. NO content preview, NO timestamp
(tested with 67B/3-line and 722B/12-line notes). Most-recent first confirmed.
Content never rides the hint; model must call read_file (wire-encrypted both ways).
Bonus: after rollover the model autonomously called history list_items
{role:"user", limit:8, max_chars_per_item:5000, recent_first:true}.
