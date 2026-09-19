---
id: task/write-release-note-for-v0-7-0-556f
title: Write release note for v0.7.0 breaking window-id change
state: open
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-15T09:00:57.482Z
updatedAt: 2026-09-15T09:00:57.482Z
---
v0.7.0 (e8fb6c6, published) switched window ids to extension-owned minted ids (details.windowId, reset-v2) with no reset-v1 backwards compatibility: window ids of pre-existing sessions change after upgrade, so notes saved by older versions reference ids that no longer resolve. Accepted by the user. Task: publish a GitHub release / changelog entry for v0.7.0 stating the breaking change plainly.