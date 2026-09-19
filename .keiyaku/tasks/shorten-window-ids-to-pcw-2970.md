---
id: task/shorten-window-ids-to-pcw-2970
title: Shorten window IDs to pcw:<session8>:<minted8>
state: done
priority: 2
needs:
  - task/explicit-stale-lifecycle-for-a780
parent: null
supersedes: []
relates: []
note: "USER-APPROVED option (b). Format: pcw:<first-8-of-session-UUID>:<minted8>, root pcw:<session8>:root, native fallback pcw:<session8>:<entry.id>. Example pcw:01a08ffa:369769fe. Rationale: history_* never cross sessions, per-session uniqueness suffices (mint collision check stays); session segment is only an ownership anchor. Read path treats ids as opaque (no strict regex since v0.11.0) so old long ids keep working; no reset-v3 needed. Touch: src/index.ts (rootId, buildReset mint/previousId), src/history.ts (root x2 + native fallback), README, test format assertions (integration 'native compactions fall back to entry.id' + any pcw regexes; prompts.ts identityBlock needs NO change, ids are passed in). SEQUENCING: bind only after stale contract lands — both touch test/integration.test.ts + README.md."
createdAt: 2026-09-17T03:01:26.787Z
updatedAt: 2026-09-17T03:28:21.026Z
---
