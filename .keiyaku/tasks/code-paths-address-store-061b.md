---
id: task/code-paths-address-store-061b
title: "Code: paths/address/store + frontmatter scopes"
state: done
priority: 2
needs: []
parent: task/notes-homes-v2-human-rename-feeb
supersedes: []
relates: []
note: ""
createdAt: 2026-09-21T16:20:30.915Z
updatedAt: 2026-09-21T16:20:38.798Z
---
paths.ts: Scope + slugify + agentSlug/modelSlug + scopeDir(who) + migrateLegacyHomes.
address.ts: 7-form dispatch, ADDRESS_FORMS. store.ts: permission checks (named agent/model read-only), merged listings over 5 homes, pattern-prefixed home selection, canonical address rendering.
frontmatter.ts: SCOPES extended, scope stays unserialized legacy field.