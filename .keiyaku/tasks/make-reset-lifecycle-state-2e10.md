---
id: task/make-reset-lifecycle-state-2e10
title: Make reset lifecycle state machine explicit
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-22T08:43:02.069Z
updatedAt: 2026-09-22T08:51:30.418Z
---
Replace implicit reset lifecycle boolean combinations with an explicit TypeScript state model and pure transition/effect boundary. Document the transition table and invariants, add focused transition tests, preserve existing persistence order and runtime behavior, then verify the full suite.