---
id: task/notes-homes-v2-human-rename-feeb
title: "Notes homes v2: @human rename + agent/model homes"
state: in_progress
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-21T16:20:30.915Z
updatedAt: 2026-09-21T16:20:30.915Z
---
Spec: @project/design-notes-homes-v2.md (human-approved). Breaking change → 0.25.0.
Grammar: bare | @project/ | @human/ (renamed from @personal) | @self/ + @agents/<slug>/ | @model/ + @models/<slug>/.
Identity: PI_NOTES_AGENT env, default root. Model slug live-resolved from ctx.model.id.
Migration: personal/ → human/ renameSync at activation; @personal/ hard error.
Copy: protocol.ts PROTOCOL_BLOCK, prompts.ts (identity brain + pocket + homes line), tools.ts ADDRESS_DESCRIPTION.