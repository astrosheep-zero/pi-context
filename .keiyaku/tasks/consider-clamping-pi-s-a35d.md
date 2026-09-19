---
id: task/consider-clamping-pi-s-a35d
title: Consider clamping Pi's reserveTokens before deriving pi-context thresholds
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
Origin: advice noted while reviewing kei/drive-pi-context-thresholds-from-settings-json (landed 6a331a8). A garbage reserveTokens (negative, zero, huge) in settings.json flows unclamped into the derived reminder/fallback thresholds; Pi's own getCompactionSettings does no clamping either. Decide: clamp/warn in deriveThresholds, or accept and document. Not blocking; review-level advice.