---
scope: session
origin: self
status: active
stale: false
created_at: 2026-09-19T01:12:05.899+08:00
updated_at: 2026-09-19T01:18:08.832+08:00
last_accessed: 2026-09-19T01:14:20.769+08:00
access_count: 2
---

# Session handoff: timing fox acceptance tests + legacy deletion

Scope root: `/Volumes/Data/bio/chase-northstar-20260918/performance-slice/wallkick-valid-choice/model-redesign/`
Worktree alias below: `$D` = that dir. Repo base HEAD `b6ee6d12`.

## STATUS: TWO TASKS

### TASK A — legacy deletion (task legacy-ea85): **DONE, delivered, not integrated**
- Worktree: `$D/legacy-worktree` (detached; baseline commit `4959923`, tag `legacy-baseline` = `b6ee6d12` + inherited wallkick patch).
- Patch: `$D/legacy-delete.patch` (4092 lines, sha256 `f788d3fed9fa4ecce0f79b1ef3ded8406107015166ceb27af86d0d961553a478`). Base = `legacy-baseline` (inherited wallkick patch excluded).
- Receipt: `$D/legacy-delete-receipt.md`. Audit doc: `$D/legacy-consumers.md`.
- Deleted `rabbitFleeDirectionEvaluator.ts` (710 lines), G-row semantic telemetry (−492), `freshFleeDirectionGRows`/`freshBestFleeAffordance`, 23 production-null trace fields; added `optionVariantId` to `cognition.rabbit_escape_route_candidate`; regenerated catalog via `node scripts/codegen.mjs` (owner script). 14 files changed.
- `boundaryConditionedFreedom.ts` joins canonical `cognition.policy_selection.selectedOptionVariantId` + `cognition.policy_evaluation` (evaluatedPolicy 'flee') by `run|subject|tick|optionVariantId`; NO argmin. Added 2 new contract tests (5 total in that file).
- Tests: 22 files / 207 passed; `tsconfig.app.json` + `tsconfig.cli.json` 0 errors; real trace (seed 7 wall_pressure, tick-step 1) → report `[OK] rows=96`.
- Deleted test count 20 (19 audited + 1 `it.fails`), plan-target 2→3, semantic-telemetry 9→9.
- Main NOT touched by me. `legacy-baseline-verify` worktree was pruned.

### TASK B — timing fox wrapper acceptance tests: **DELIVERED (2026-09-19 01:18)**

- Patch: `$D/timing-fox-wrapper-tests.patch` (242 l, sha256 `571811550381f89ce53e1cc7b61a278bd0274a11f5e146833ee69522e24a04b7`), delta vs the timing-slice snapshot, ONE file (`src/test/fox-hunt-variant-offer.test.ts`, +222 l, last hunk only). Receipt: `$D/timing-fox-wrapper-tests-receipt.md`. Review wording fixed in `$D/timing-review.md` (D1 + D2).
- Tests: 15/15 in the host file; focused 9-file set = 98 passed. No broad suite. Main untouched, no commits.
- Fixture fix: `executableContactAdmitted` was false because `resolveGrappleSelfGateAdmission` treats a non-finite cooldown as BLOCKED; new ctx helper now states `grapplePostEscapeCooldownRemainingSec: 0` + `grappleMissedContactRecoveryRemainingSec: 0` (live facts from `cognitionContext.ts:968-969`). Shared `makeCtx` untouched.
- Must-fail proofs run+reverted: A `return undefined` at resolver head (`foxTargetAccessPrediction.ts:331-334`) kills 4/5 new tests; B `costDtSec: 0` bill (`foxHunt.ts:445`) kills 1; C targetAccess at bounded T (`:487`) kills 1.
- Contact-event basis answer: decision-relative by construction (`foxCaptureProjection.ts:263-273`); the `?? captureProjectedContactTimeSec` fallback at `foxTargetAccessPrediction.ts:173,247` is a latent hazard that cannot fire (`eventSec == null ⇔ timeSec == null`).

### (superseded) original TASK B note — timing fox wrapper acceptance tests
- `$D/timing-review.md` (98 lines) already written and delivered: defects D1 (receipt claims 10 rabbit wrappers forward timing; `src/species/rabbit/options/rabbitPolicySpecs.ts:854-858` takes neither — pre-existing plumbing, non-behavioral), D2 (fox resolver has **1 module-local caller** `foxTargetAccessPrediction.ts:469` inside `withFoxTargetAccessGoal`, **plus** definition at `:331`; wording must say zero refs outside the definition FILE ≠ zero callers; test coverage gap is real: no test anywhere hits it), D3 negative event rejected in `signals.ts:208-211` not at documented layer.
- User now asked to: correct D2 wording, note D1's old scalar helper ignoring unused timing is not itself a new bug (main's new forecast will consume the actual clock; receipt claim corrected), then IMPLEMENT real fox wrapper acceptance tests in `timing-worktree` ONLY, delta vs delivered `timing-slice` snapshot, deliver separate patch + receipt.
- Worktree: `$D/timing-worktree` (detached). Inherited baseline is in the **index**; `git diff` = the timing delta (21 tracked + 2 new files). Do NOT commit/apply to main.
- New tests appended to existing host file `src/test/fox-hunt-variant-offer.test.ts` (1207 lines before my append), inside new `describe('fox world-end timing reaches the wrapped Hunt spec')` at end of file.
- Added imports: `FOX_HUNT_CONTACT_COMMIT_VARIANT_ID` (to the identity import block) and `import { POLICY_EVALUATION_HORIZON_SEC } from '../logic/cognition/timing'`.

#### Current test state: 15 tests, **1 failing**, 4 new passing
PASSING new tests (all real-fixture, drive the WRAPPED spec `foxPolicySpecsByPolicy[Policy.Hunt]`):
1. "binds an admitted pounce to its own decision-relative impact clock" — asserts `captureImpactAdmitted`, event ∈ (0,T), `=== captureProjectedContactEventSec`, `> captureProjectedContactTimeSec`.
2. "binds a lethal pursuit rollout to its death tick and leaves a live one absent" — live: `predictionEndTimeSec === undefined`; lethal trot `{energy:0, satietyReserve:0.01, health:0.2}`: `terminatedByDeath === true`, event `=== prefixElapsedSec + sampleGapM.length*dtSec < T`. **This is the case that fails if the resolver returns undefined.**
3. "bills the grab own executed tick at event zero..." — `ownTickBill.available`, `costDtSec === DT_SEC`, `extendFoxPredictionSignals(...).huntMovementBody.effectHorizonSec === costDtSec > 0`.
4. "keeps targetAccess on the requested horizon..." — evaluator row `predictionHorizonSec === predictionEndTimeSec < REQUESTED_T`, `evaluationHorizonSec === REQUESTED_T`, `access.targetAccessStatus !== 'invalid'`, `access.targetAccess.predictionHorizonSec === REQUESTED_T`. **Fails if targetAccess used bounded T.**

FAILING: `it('binds an admitted grab to event-at-zero, not an absent event')` at `src/test/fox-hunt-variant-offer.test.ts:1326`:
```
expect(semantics.foxContactCommitForecast?.executableContactAdmitted).toBe(true)
// → received false
```
Fixture used: `semanticsFor(FOX_HUNT_CONTACT_COMMIT_VARIANT_ID, {}, preyAt(1.1, 0.4))`.

#### NEXT STEP (concrete)
The grab fixture does NOT produce `executableContactAdmitted === true`. Learn the real admission inputs, do not fabricate:
- `resolveFoxContactCommitForecast` / eligibility gates live in `src/species/fox/foxContactCommitPrediction.ts` (see `:287-300` invalid clock/pose → unavailable; `actorGates` cannotInitiate/stunned/occupiedGrappler).
- `src/test/fox-contact-commit.test.ts:429-432` shows the canonical admitted case: `{...input, eligibility: ELIGIBLE, ownTickBill: MODELLED_BILL}` → `executableContactAdmitted === true`. Read that file's `ELIGIBLE` and target input builder (distance/velocity need to satisfy swept-contact admission + `attackContactRangeM`).
- Grab path in `src/species/fox/options/foxHunt.ts:385-455`; contact target comes from `baseStage.pursuitProjection.authority` — so the ctx must have `hasPursuitTracking: true` (makePlanCtx sets it) and a belief target inside contact range. Try smaller `relativeXM` (e.g. 0.9–1.1) with closing velocity, and check `FOX_BODY.actionContact.attackContactRangeM`.
- Iterate: `cd $D/timing-worktree && npx vitest run src/test/fox-hunt-variant-offer.test.ts` (fast, ~1.5s).
- Also fix the unused `_relativeXM`/`_vx` leftovers in my `beliefsFor` helper and the stray `...{}` (clean-up before delivery).

#### THEN
1. Correct D2 wording in `$D/timing-review.md` (module-local caller at `:469` vs test coverage) + D1 clarification (old scalar helper ignoring unused timing is not a new bug; receipt claim corrected).
2. Deliver separate patch + receipt (e.g. `$D/timing-fox-wrapper-tests.patch`, `$D/timing-fox-wrapper-tests-receipt.md`), delta vs the delivered `timing-slice` snapshot, NOT mixed with original `timing-slice/delta.patch`.
3. Must-fail proof to record in receipt: (a) resolver → `return undefined` breaks tests 1/2 (and 5); (b) ownTickBill lost breaks test 3; (c) targetAccess bounded T breaks test 4. Ideally actually run one mutation locally in the worktree then revert (do not leave it), or argue by construction.
4. Report the pounce contactEvent basis investigation: **answer = decision-relative by construction** (`src/species/fox/foxCaptureProjection.ts:~248-256`: `projectedContactEventSec = prefixElapsedSec + preLaunchDurationSec + projectedContactTimeSec`; flight time alone is flight-relative). The `?? captureProjectedContactTimeSec` fallback in `foxTargetAccessPrediction.ts:173,247` would mix clocks if it ever fired, but producer invariant (`eventSec === null ⇔ timeSec === null`, wired at `foxHuntStalkSemantics.ts:525-526`) means it cannot. → latent hazard, NOT an actual bug.
5. No broad suite. Focused only. Main must stay untouched.

## KEY FACTS / LEARNINGS
- `rg -r` is the replace flag: never write `rg -rn "sym"` (it dumped the whole generated catalog). Use `rg -n`.
- Worktree setup pattern used: `git worktree add --detach <path> <sha>`, `git apply --index`, symlink `node_modules` to `/Users/astrosheep/Developer/bio/node_modules`.
- `tsconfig.app.json` excludes `src/apps/diagnostics` and `src/test`; tests are NOT typechecked by CI (`npm run test:typecheck`). `tsconfig.cli.json` covers diagnostics. Full `tsconfig.json` has ~32 pre-existing error-site files.
- Report to user in Chinese; high-density. Commit freely; pushing/merging needs explicit request.

## RELEVANT USER REQUESTS (this window)
- Window ID / item IDs: not captured (tool calls used directly, no `history_list` query). Recover via `history_search` for: `legacy deletion`, `legacy-consumers.md`, `timing-review.md`, `withFoxTargetAccessGoal`, `executableContactAdmitted`, `D2 wording`.
- Skills likely needed: `diag` (if evidence traces needed; `$D/legacy-worktree` already built `dist-cli`), `chase-trajectory` (not needed so far).
