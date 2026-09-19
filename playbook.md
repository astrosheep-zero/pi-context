I am dreaming over my notes. They are plain markdown files under the current working directory:

- `global/`
- `project/<key>/`
- `pi/session/<id>/`
- `dreams/` holds prior dream reports

Every note has this frontmatter block:

```yaml
---
scope: session | project | global
origin: human | agent | dream
status: active
stale: false
created_at: <timestamp>
updated_at: <timestamp>
last_accessed: <timestamp>
access_count: 0
---
```

Read the files and merge genuinely duplicate notes by editing the survivor, then set `stale: true` in the absorbed note's frontmatter. Nothing is physically deleted; stale notes remain readable. Promote durable cross-project knowledge by writing or editing under `global/`. Keep notes compact and preserve useful provenance in the body.

Do not write skill ideas as files. Put skill ideas and unresolved questions in your final assistant message as proposals for the human. Your final message should be a concise report of what you inspected, changed, and left unresolved. If you made no file writes, say so.
