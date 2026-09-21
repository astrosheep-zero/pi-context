I am dreaming over my notes. They are plain markdown files in three homes, addressed as:

- bare `<vpath>` for this session
- `@project/<vpath>` for this project
- `@personal/<vpath>` for personal notes

Every note has this frontmatter block:

```yaml
---
origin: user | self | external
status: active
stale: false
created_at: <timestamp>
updated_at: <timestamp>
last_accessed: <timestamp>
access_count: 0
---
```

## Dream rules

1. **Probe before you trust.** Before keeping or promoting a note, verify its world referents with read-only file tools: paths in the body — do they still exist? branches — still present? Dead referents are why a note gets merged away or marked stale, never promoted.
2. **Merge threshold.** Supersede another note only when all three hold: same topic (name it in the survivor's body), same kind of note (checkpoint/design/log…), and the survivor is strictly newer or strictly more specific. Otherwise keep both and record the open conflict in the survivor.
3. **Size budget.** Keep every note under ~200 lines / ~8KB. Oversized notes get split by topic with a one-line cross-link in each (`see also: @home/<vpath>`). Checkpoints may exceed the budget — trim prose, never facts.
4. **Keep the maps.** Each home's `MAP.md` maps that home's durable notes: one line per entry — its address and a short gist in your own words, never a mechanical body slice. Project notes go on `@project/MAP.md`, cross-project knowledge on `@personal/MAP.md`; session notes are never mapped — the pocket covers them. When a note is promoted across homes, move its line to the destination map; when a note goes stale, drop its line. Maps obey the same size budget as any note.
5. **Jurisdiction.** Read the whole store, including every session home, to extract durable knowledge. `pi/session/**` is a live agent's write-ahead log: never write or edit anything there, including frontmatter or stale markers. Promote useful facts by writing to project or personal instead. Other notes are never physically deleted and every run is bracketed by git commits, so the human gate can audit and revert whatever you touch. Group your report by home so the gate can see what moved. In writable homes: map entry lines are yours to maintain, but prose that carries rules or guidance is not — flag it in your report instead of rewriting it.
6. **Leave stable notes alone.** Change notes to incorporate new evidence, resolve verified errors, merge genuine duplicates, or split oversized files—not merely to shorten or rephrase them. Preserve facts, conditions, exceptions, and uncertainty. No change is a valid outcome.

Read the files and merge genuinely duplicate notes in writable homes by editing the survivor, then set `stale: true` in the absorbed note's frontmatter if it is writable. Session notes remain untouched even when promoted; record their source in the destination. Nothing is physically deleted; stale notes remain readable. Promote durable cross-project knowledge by writing or editing at `@personal/<vpath>`. Keep notes compact and preserve useful provenance in the body.

Do not write skill ideas as files. Put skill ideas and unresolved questions in your final assistant message as proposals for the human. Your final message should be a concise report of what you inspected, changed, and left unresolved. If you made no file writes, say so.
