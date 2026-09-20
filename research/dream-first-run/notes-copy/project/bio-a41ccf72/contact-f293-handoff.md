---
scope: project
origin: self
status: active
stale: true
created_at: 2026-09-19T00:12:30.487+08:00
updated_at: 2026-09-19T01:08:35.816+08:00
last_accessed: 2026-09-19T00:43:24.625+08:00
access_count: 1
---

# contact-f293 handoff (context reset)

**FULL NOTE (authoritative):** `/Volumes/Data/bio/chase-northstar-20260918/performance-slice/wallkick-valid-choice/contact/HANDOFF-contact-f293.md` — read it first.

## Goal
Implement lead's contact slice `task contact-f293` on parent Task `task/chase-model/chase-prediction-one-command-one-6b3a`.
One canonical `RabbitEscapeThreatVector.attackContactRangeM` (number|null), identity-bound only, `null` = unavailable (never 0.625 default, never candidate-infeasible, never silent 0). Envelope: physical radius governs nominal-path TTC + `terminalEventReached`; uncertainty/pursuit/turn margins + burst sweep are risk only. Shared rabbit threat vector + rabbitWorldProjection use the same bound capability. Diagnostics expose radius availability + physical/risk radius. Update existing focused tests; no coefficient tuning; don't touch fear/timings/legacy scorer.

## State (base b6ee6d12, working tree uncommitted — DO NOT commit/push/reset)
All source edits for (1)-(4) APPLIED and `npm run test:typecheck` CLEAN. `npm run codegen` run (3 generated diag files modified). NOT yet: focused tests updated/run, diag c3 verification, bounded diff/receipt.

## Next steps
1. Update existing focused tests (grep `evaluatorContactRangeM` → expect 0).
2. Run only affected focused tests (suite already has 2 pre-existing failures: `rabbit-fear-delete-regression`, `rabbit-threat-perception`).
3. `npm run diag:build`, then c3 2 s tick1 capture → `contact/c3-2s.diagtrace`, discover fields, `--out ... --limit 0` query, compare tick 37 + TTC/motorHorizon distinct counts + selection/executed hop, record source hash.
4. Bounded diff + receipt in `model-redesign/contact/`; delete the wrong "0.25 m > 0.375 m" claim in `model-redesign/provenance-contact-capability.md` §2.
5. PAUSE edits for lead inspection.

## Key paths
- `model-redesign/DECISIONS.md`, `model-redesign/baseline-20260919/MANIFEST.md`, `model-redesign/provenance-contact-capability.md`
- previous receipt `variants/current-delivery-receipt.md`; pages: `__image_review?name=wallkick-current-trajectories`, `__trajectory_review?name=wallkick-current`, `__video_review?name=wallkick-c4-kick-8s`
- `diag:query` stdout caps at 200 rows → always `--out <path> --limit 0`; matplotlib only in `/Volumes/Data/bio/tools/chase-trajectory-venv/bin/python`.
