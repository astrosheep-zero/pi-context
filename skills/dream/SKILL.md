---
name: dream
description: Review and consolidate durable notes using pi-context's shared dream playbook. Use when the human asks to dream over notes, merge genuine duplicates, update maps, or promote durable learning.
---

# Dream

Read `../../playbook.md` completely, resolving the path from this skill's directory. That file is the single source of dream instructions; follow it rather than reconstructing or copying its rules here.

Run the playbook in this agent's current session. Loading this skill does not authorize starting the `dream` CLI, calling another model, or choosing a dreamer model. Ask before doing any of those.

Record the invocation working directory before changing directories or resolving this skill's files. Resolve the notes store from a non-empty `PI_NOTES_HOME`, otherwise `~/.agents/notes`, and apply the shared playbook's working-directory scope rule. Running inside the notes store permits store-wide inspection; running in a project permits that project's source material, project notes, and read-only session notes whose project metadata matches. Inspect session notes' frontmatter `project` fields to discover matching notes; skip unknown ownership without guessing or backfilling. Changing directories later does not widen that scope. Do not treat a session's notes-tool view as the entire store.

The CLI normally supplies locking, audit snapshots, and jailed write tools. This skill does not install those protections. Before changing notes, establish exclusive ownership of the store's `.dream.lock` and a successful Git baseline snapshot in the notes store. Never remove or replace an existing lock, including one that appears stale. If you cannot establish the safeguards, inspect only and report the blocker. Keep every note write within the resolved store and the playbook's writable homes.

After changes, save the report and make the final audit snapshot in the notes store, then release only the lock this run acquired. Record partial changes and failures honestly. Do not report a successful dream when its audit failed.
