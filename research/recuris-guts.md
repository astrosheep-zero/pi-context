# Recuris Implementation Spec

## Repository

Official upstream repository: `https://github.com/Gen-Verse/Recuris`, cloned to `/tmp/recuris-src` at commit `7d3745ab787b1206ccd981cb1511100476097266`.

The repository’s own format documentation confirms:

> “A package is a directory. Its `manifest.yaml` declares the four components of `M = (E, W, ρ, C)`; its `em/` holds the cards, one per file.”  
> `/tmp/recuris-src/docs/skill-memory-format.md:3-5`

The loader entry point is:

> `def load_skill_memory(root: str | Path) -> SkillMemory:`  
> `/tmp/recuris-src/src/recuris/skillmemory.py:167`

The loader requires `manifest.yaml`; missing manifests raise `ProfileError` (`skillmemory.py:169-172`). It reads `name`, `wm`, `grounding`, `delivery`, `checkers`, `gate`, `feasibility`, and `board` (`skillmemory.py:174-219`). Unknown top-level manifest sections are ignored by the kernel and rejected by the linter (`metaagent/lint.py:28-31`, `139-146`).

## Components

The documented mapping is:

- `E`: external memory cards in `em/`.
- `W`: working-memory ledger configured by `wm`.
- `ρ`: delivery/retrieval strategies configured by `delivery`.
- `C`: checkers configured by `checkers`.

The format example maps these directly (`docs/skill-memory-format.md:16-44`).

No separate runtime object named `E`, `W`, `ρ`, or `C` exists; these are the package-level conceptual components. The concrete loader constructs `EMStore`, `WMSchema`/ledger manager, deliverers, and checkers (`skillmemory.py:204-219`).

## Cards

### Card types

Exactly three types are accepted:

> `VALID_TYPES = {"knowledge", "procedure", "action_result"}`  
> `/tmp/recuris-src/src/recuris/em/entry.py:18`

Parsing rejects missing or unknown types:

> `if etype not in VALID_TYPES:`  
> `raise ProfileError(f"{path}: type must be one of {sorted(VALID_TYPES)}")`  
> `/tmp/recuris-src/src/recuris/em/entry.py:42-44`

Semantics documented by the repository:

- `knowledge`: facts, policies, formulas; target of self-directed retrieval.
- `procedure`: processes/checklists.
- `action_result`: worked examples and common mistakes; target of event-triggered delivery.  
  `/tmp/recuris-src/docs/skill-memory-format.md:77-85`

### Frontmatter fields

The parser accepts these fields:

| Field | Default / validation |
|---|---|
| `id` | `str(fm.get("id") or path.stem)`; filename stem default (`em/entry.py:47-49`) |
| `type` | Required in practice; string must be one of the three valid types (`em/entry.py:42-44`) |
| `trigger.event` | Optional; defaults to `""` (`em/entry.py:45-52`) |
| `trigger.tool` | Optional; defaults to `""`; `"*"` is treated specially by some deliverers (`em/entry.py:26-28`, `em/store.py:44-50`) |
| `source` | Optional; defaults to `""` (`em/entry.py:47-53`) |
| unknown fields | Preserved in `extra`, with no validation (`em/entry.py:46-55`) |

The card body is everything after the second `---`, with surrounding newlines stripped:

> `body=body.strip("\n")`  
> `/tmp/recuris-src/src/recuris/em/entry.py:47-53`

Malformed cards are rejected if they do not start with `---` or cannot be split into frontmatter/body (`em/entry.py:34-40`).

Cards are loaded recursively from sorted `*.md` files under `em/`; `README.md` is skipped; a missing `em/` directory produces an empty store plus warning (`em/store.py:17-27`).

`source` is parsed but not used by retrieval or matching. Its stated purpose is provenance and removal decisions (`docs/skill-memory-format.md:87-88`).

## Trigger and retrieval

### Exact event/tool querying

`EMStore.query()` performs exact matching:

> `if event and e.trigger_event != event: continue`  
> `if tool and e.trigger_tool != tool: continue`  
> `/tmp/recuris-src/src/recuris/em/store.py:29-42`

`for_tool()` first searches the exact tool, then falls back to `trigger.tool: "*"`:

> `generic = self.query(event=event, tool="*")`  
> `/tmp/recuris-src/src/recuris/em/store.py:44-50`

There is no semantic trigger field beyond `event` and `tool`.

### Standing injection

`StandingInject` runs at `turn_start` and injects every matching card of its configured type:

> `events = (Event.TURN_START.value,)`  
> `entries = em.query(event=Event.TURN_START.value, type=self.em_type)`  
> `/tmp/recuris-src/src/recuris/builtin/deliverers.py:73-89`

Defaults are `em_type="knowledge"` and `tool="*"` (`deliverers.py:80-85`), although its `select()` filters by event/type only (`deliverers.py:87-89`).

### Exemplar bounce

`ExemplarBounceDeliverer` runs at `pre_write` and handles write-tool calls:

> `events = (Event.PRE_WRITE.value,)`  
> `writes = [tc for tc in calls if tc.name in write_tools]`  
> `/tmp/recuris-src/src/recuris/builtin/deliverers.py:22-49`

Default card type is `action_result`; defaults are `refusal_branch=False`, `exact_only=False` (`deliverers.py:28-34`). It searches exact tool cards and generic `*` cards (`deliverers.py:36-43`). With `exact_only=True`, any uncovered write tool aborts the entire bounce (`deliverers.py:51-57`).

### Lexical need-driven retrieval

`NeedDrivenRetrieval` runs on `intent_recorded` and defaults to:

> `em_types=("knowledge", "procedure"), top_k=1, min_overlap=2, settle=True`  
> `/tmp/recuris-src/src/recuris/builtin/deliverers.py:96-119`

For every pending WM entry:

1. Query tokens are alphanumeric/underscore tokens longer than two characters from `entry.description` (`deliverers.py:92-93`, `145-147`).
2. Document tokens come from `card.id` plus the first 400 body characters (`deliverers.py:149-152`).
3. Score is set intersection size (`deliverers.py:149-154`).
4. Candidates require `score >= min_overlap`, sort descending, and emit up to `top_k` cards (`deliverers.py:152-155`).
5. Stable deduplication uses `(doc.id, entry.description)` (`deliverers.py:156-159`).
6. Optional `scope_by_tool` allows `trigger_tool=="*"` or exact pending-entry tool; missing metadata is not wildcard (`deliverers.py:121-129`).
7. Optional `max_per_episode` caps delivery count per card (`deliverers.py:137-143`, `160-173`).

There is no global retrieval budget; budgets are deliverer-specific.

### Embedding retrieval

`EmbeddingRetrieval` is an optional dense alternative. Defaults:

> `top_k=2, min_sim=0.30, head_chars=300, settle=True`  
> `/tmp/recuris-src/src/recuris/builtin/embed_retrieval.py:46-69`

It embeds pending descriptions, ranks card vectors by cosine similarity, stops below `min_sim`, applies optional tool scope and per-episode cap, and emits up to `top_k` cards (`embed_retrieval.py:118-142`). Card vectors are cached by embedder/card-set hash (`embed_retrieval.py:46-52`).

### State reminders

`StateReminder` runs on `intent_recorded` and emits notes for pending unauthorized and authorized entries (`deliverers.py:177-228`). It uses configured card IDs when present, otherwise built-in fallback text (`deliverers.py:204-211`).

### Boundary injection

`BoundaryInject` defaults to `turn_start`, `when="always"`, `em_type="procedure"`, `tool="*"`, `max_cards=1` (`deliverers.py:232-258`). Predicates are exactly `always`, `first_turn`, and `has_pending` (`deliverers.py:260-265`). It requires matching event/predicate (`deliverers.py:267-269`), then uses exact-tool-first plus wildcard fallback (`deliverers.py:270-274`).

### Runtime delivery validation

The runtime validates every retrieval action:

> “entry must be pending, doc must exist in THIS package's EM, and content must be that doc's body.”  
> `/tmp/recuris-src/src/recuris/runtime.py:311-324`

Invalid actions are counted as `cover_rejected`; valid cards are injected as:

> `"[RETRIEVED — for your pending item {action.entry_id}]\n{doc.body}"`  
> `/tmp/recuris-src/src/recuris/runtime.py:325-330`

`settle=True` creates a kernel `DeliveryReceipt` and grounds the entry; `settle=False` injects only and leaves the ledger pending (`runtime.py:331-349`).

## Evidence admission and grounding

This is distinct from candidate-package admission.

The kernel explicitly prevents matchers from deciding admissibility:

> “Matchers ... only decide WHICH entry admitted evidence settles; they are never consulted about admissibility.”  
> `/tmp/recuris-src/src/recuris/grounding.py:137-143`

Admission rules:

- Kernel-born `DeliveryReceipt`: accepted.
- Synthetic receipt or known synthetic content: rejected.
- Error receipt: rejected.
- Otherwise: accepted.  
  `/tmp/recuris-src/src/recuris/grounding.py:153-163`

Evidence IDs are consumed before admissibility checking, preventing repeated rejection counting (`grounding.py:165-180`). Admissible evidence is matched to pending entries; matched entries become `DONE`; unmatched evidence is counted/logged and never creates a ledger entry (`grounding.py:181-195`).

### Receipt matching

`ReceiptBindingMatcher` rejects tool conflicts and binding-key conflicts (`grounding.py:96-104`). Score components are:

- tool match bonus;
- exact binding-key bonus;
- soft binding-key bonus;
- collection overlap bonus;
- collection soft bonus.  
  `/tmp/recuris-src/src/recuris/grounding.py:105-116`

The highest score wins only if it reaches `min_score` (`grounding.py:118-122`).

`DeliveryReceiptMatcher` matches exact `entry_id` only (`grounding.py:125-135`).

## WM admission and write permissions

Ledger states are `not_yet`, `done`, `blocked`, and `obsolete` (`wm/schema.py:23-34`).

Model updates:

> “DONE / BLOCKED entries kept verbatim; previous NOT_YET entries become OBSOLETE”  
> `/tmp/recuris-src/src/recuris/wm/ledger.py:119-127`

Implementation:

- preserve `DONE` and `BLOCKED`;
- mark previous `NOT_YET` entries `OBSOLETE`;
- admit at most `max_entries - len(kept)` proposals;
- validate each through `EntryKind.parse_proposal`;
- skip malformed proposals;
- assign fresh sequential IDs `req-N`.  
  `/tmp/recuris-src/src/recuris/wm/ledger.py:136-159`

State writes are permissioned:

- `DONE`: harness only (`wm/ledger.py:162-174`);
- authorization: harness only (`wm/ledger.py:176-189`);
- `BLOCKED`: harness or oracle only (`wm/ledger.py:191-201`);
- model may update descriptions/fields and obsolete entries, but cannot self-mark completion.

Built-in proposal validation:

- `ServiceRequestKind`: requires non-empty description; unknown tool becomes empty; non-dict params become `{}` (`builtin/entrykinds.py:21-34`).
- `ServiceRequestAuthKind`: optionally accepts `confirmed_by.quote` (`entrykinds.py:86-93`).
- `KnowledgeNeedKind`: requires description; unknown function coerces to `"procedure"`; `needs_external` defaults true (`entrykinds.py:160-170`).
- `GenericItemKind`: requires only non-empty description (`entrykinds.py:198-209`).

## Candidate/card package admission

The meta-agent’s actual package gate is not card-level insertion. A candidate package is admitted only after validation and evaluation.

The primary gate computes per-item candidate/base mean differences, bootstraps over items, and accepts iff the lower confidence bound is positive and regressions are within `reg_cap`:

> `accept = (lo > 0) and (n_dn <= reg_cap)`  
> `/tmp/recuris-src/src/recuris/metaagent/gates.py:31-75`

Additional checks:

- leakage scan rejects card bodies containing held-out answer parameters (`gates.py:78-86`);
- mechanism fingerprint requires the prescribed carrier to fire (`gates.py:89-96`);
- CLI gate additionally requires diagnosed repair-task improvement (`metaagent/gate.py:60-75`).

Before committing, the driver verifies the candidate digest is unchanged from the evaluated package:

> `candidate bytes no longer match the package admitted by evaluation`  
> `/tmp/recuris-src/src/recuris/metaagent/driver.py:9692-9697`

## Promotion, demotion, forgetting

**MISSING — no explicit card promotion/demotion subsystem exists.**

Cards are edited, added, or deleted by the external meta-agent in a disposable candidate package; package admission is through lint/validation/evaluation gates. The round loop applies planned deletions and patches before evaluation (`driver.py:10322-10335`).

WM entries do have lifecycle transitions:

- `NOT_YET -> OBSOLETE` during model refresh (`wm/ledger.py:142-145`);
- `NOT_YET -> DONE` only from admitted harness evidence (`wm/ledger.py:162-174`);
- `NOT_YET -> BLOCKED` only from harness/oracle (`wm/ledger.py:191-201`).

Obsolete entries remain in the audit list; there is no forgetting scheduler (`wm/ledger.py:141-158`).

Rejected candidates may optionally become provisional working bases in progressive/calibrated modes, but committed best remains unchanged (`driver.py:10412-10547`). This is package lineage management, not card promotion.

## Meta-agent loop

The documented loop is:

> “evaluate the current best on the train split -> failing tasks, sanitized trajectories, mechanism fingerprint -> diagnose and patch (an external coding agent) -> plan.json + a disposable candidate package -> validate -> decide -> record”  
> `/tmp/recuris-src/docs/architecture.md:84-105`

The implementation performs:

1. Evaluate current working package on train tasks (`driver.py:10188-10221`).
2. Stop if no failing tasks (`driver.py:10213-10216`).
3. Generate diagnosis/plan and identify actionable clusters (`driver.py:10223-10320`).
4. Prepare candidate, apply planned deletions, and run external patch phase (`driver.py:10322-10345`).
5. Evaluate repair tasks and held-out gate (`driver.py:10352-10369`).
6. Commit accepted immutable version or handle rejection/provisional lifecycle (`driver.py:10401-10410`).

The patch prompt constrains card content to generic, placeholder-based guidance and forbids embedding successful task-specific answers (`driver.py:577-635`).

There is no fixed wall-clock schedule. The loop runs one campaign round at a time; each round starts with train evaluation (`driver.py:10159-10194`).

## Reusable implementation details

- Stable retrieval dedup key `(card_id, entry_description)` prevents re-delivery after WM IDs are regenerated (`deliverers.py:156-159`).
- `settle=False` separates “knowledge was shown” from “external action completed” (`runtime.py:331-349`).
- Delivery validates exact card body against the current package, preventing forged retrieval receipts (`runtime.py:311-324`).
- Bootstrap resamples items, not trials, because trials within one item are not independent (`gates.py:40-45`).
- Leakage scan is intentionally syntactic and crude; held-out evaluation remains the primary defense (`gates.py:78-86`).
- Boundary cards use exact tool first, then `"*"` generic fallback (`em/store.py:44-50`).
- Card loading is file-based: adding a card requires adding one Markdown file, not code (`docs/skill-memory-format.md:7-9`).

## Port surface

A faithful `pi` TypeScript plugin minimally needs to implement:

1. Load a package directory containing `manifest.yaml` and recursive `em/**/*.md` cards.
2. Parse card frontmatter exactly: `id`, `type`, nested `trigger.event/tool`, `source`, preserving unknown fields.
3. Enforce the three card types and malformed-frontmatter errors.
4. Implement WM ledger states, model proposal refresh, `max_entries`, fresh request IDs, and state write permissions.
5. Implement runtime evidence admission: reject synthetic/error receipts, consume IDs once, exact delivery receipts, matcher-based real-receipt settlement.
6. Implement at least lexical need-driven retrieval with `top_k`, `min_overlap`, deduplication, optional tool scope, and per-episode cap.
7. Implement event/tool delivery, including exact-tool then `"*"` fallback.
8. Implement standing injection, boundary injection, state reminders, and pre-write exemplar bounce if behavioral parity is required.
9. Validate retrieval actions against current package card identity/body and pending ledger state.
10. Implement candidate-package linting, leakage checks, held-out paired bootstrap gate, fingerprint verification, and evaluated-tree digest verification if porting the meta-agent.
11. Preserve audit-retained obsolete WM entries.
12. **Do not invent card promotion, demotion, or forgetting behavior: those components are MISSING in Recuris.**