---
id: task/evaluate-per-model-margins-when-5139
title: Evaluate per-model margins when Pi ships compaction.modelOverrides
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
Pi's unreleased changelog has compaction.modelOverrides (per-model reserveTokens). When it lands in a released Pi, evaluate whether pi-context's reminder/fallback margins should resolve per model (reserve from the active model's override + margins), and update deriveThresholds/README accordingly. Blocked on an upstream Pi release; check on Pi upgrades.