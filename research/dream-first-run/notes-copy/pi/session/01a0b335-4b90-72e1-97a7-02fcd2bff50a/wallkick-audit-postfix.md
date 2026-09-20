---
scope: session
origin: self
status: active
stale: false
created_at: 2026-09-18T19:33:53.868+08:00
updated_at: 2026-09-18T19:33:53.868+08:00
last_accessed: 2026-09-18T19:33:53.868+08:00
access_count: 0
---

# wallkick audit — POST-ADJUDICATION re-audit COMPLETE (19:33)

Session: pcw:01a0b335 (agent root). Writer = `aku/intern/30e85c03`. I am read-only.
Base `b6ee6d12`. Note: earlier/longer notes live in the v1 note root
(`wallkick-diff-audit-in-progress.md`, `wallkick-solo-writer-30e85c03.md`, `wallkick-handoff-to-0455-sent.md` [stale]).

## Active request (window pcw:01a0b335:b78b5510)
"Re-audit the diff" for the post-adjudication wallkick work. DONE. Findings sent to 30e85c03 at 19:33 (exit 0).

## Revision audited
worktree status md5 `58b2d5811906b401d1363f4505d42ea2`, `git diff | md5` `c5f244830038e104459642c9dd505fdc`,
base `b6ee6d12`, 38 changed/untracked entries (incl. new `src/core/wallKickSurface.ts`,
`src/species/rabbit/wallKickBodyLimits.ts`, `src/test/rabbit-wall-kick-execution-chain.test.ts`).

## Verdict: ALL 4 ITEMS PASS
- **P0-A target identity**: `core/wallKickSurface.ts` = one surface vocabulary (source codes+codec,
  `WallKickSurfaceCommit`/`WallKickLiveCommit`, `WALL_KICK_SURFACE_PLANE_TOLERANCE_M=1e-3`).
  `WallKickPayload`/`ActionIntent` carry targetPoint/observedDistance/source/cell. `WallKickCommandPayload`
  (`logic/actionCommand.ts`) = single shape; `intentFinalizer` forwards `wallKick: command.wallKick` verbatim;
  `writeActionIntent` encodes source. `resolveRabbitWallKickIntent` commit branch bills the committed
  surface/ray/reference, **never iterates wallAffordance.contacts**, and no longer requires `wallAffordance`.
  Execution entry refuses without finite point + decodable source; kick gate = |plane dist| ≤ 1e-3 m AND
  `MIN_WALL_KICK_SURFACE_AGREEMENT_DOT`; kickDirection + positionNudge from the LATCHED normal.
- **P0-1 revocation**: `onUnexecutedPlanRevoke` dispatched by `revokeUnexecutedPlanLifecycle` at the top of
  `ActionArbiterSystem.tryTransition` (single real call site) BEFORE the Hop+Moving guard;
  `revokeWallKickApproach` = revoked=1/Recovery/timer0/interruptible TRUE, one row, no stance/velocity/position
  write, refuses when `contacted===1`; WallKickSystem early-continues on Recovery/revoked.
- **Truth bug**: `projectRabbitWallKickApproachContact` clearance — null→0, finite→blocker, +Infinity→clear,
  degenerate→0. Artifact effect: s9 gained the 0.517 s candidate.
- **Counts reproduced**: candidates s7=1, s9=2, 0 in other 8; selected 0 in all 10; `action.lifecycle` rows
  present (17/9/141 in s7/s9/1v1) with NO `action.wall_kick_execution` → ENTERED=0 observed; selection
  `(simSec,subjectId,selectedPolicy,selectedG)` md5-identical after/ vs after-postfix/ in ALL 10;
  firstGrapple s7 4.033 / s8 none / s9 none / 1v1 8.617 (+ death 14.833).

## Residuals (non-P0, do not block acceptance)
1. `actionTransition.ts:111` `decodeWallKickSurfaceSource(...) ?? 'boundary'` — full-strength fallback
   (inert for entry, but forbidden shape; zero/passive is honest).
2. Deprecated `MIN_WALL_KICK_CONTACT_NORMAL_DOT` alias still used inside `estimateWallKickExecutionDirection`
   (no external consumer) — dead naming weight.
3. In-flight commit branch hardcodes `referenceDirectionSource: 'threat_away'` — provenance label only.
4. Pre-existing: `resolveWallContact` mixes collision point/normal with min(collision,proximity) distance;
   harmless for the kick because the plane gate keys on the collision point.
5. s9's two candidate ticks share cell 4936 + point but differ ~5° in normal → point+cell is the right identity.

## Honest shape / not verified
No trace selects wall_kick → in-flight commit + revocation paths are proven by tests only
(execution-chain 6, arbiter +2, opportunity +1). Writer's vitest 1332/3, tsc, codegen claims NOT verified by me
(source-only instruction).

## Read-only commands that worked
`npm run -s diag:query -- <trace> --list-names | --list-subjects | --summary`;
`--name cognition.policy_evaluation --fields evaluatedPolicy --format csv --out /tmp/x.csv` then `grep -c wall_kick`;
`--name cognition.policy_selection --fields selectedPolicy,selectedG --format csv --out ...` then
`cut -d, -f2,6,7,8 | tail -n +2 | md5`;
`--name action.wall_kick_execution --limit 3` → "no rows matched filters" = the observed ENTERED=0.
GOTCHA: diag:query can transiently return EMPTY output for a valid query; always check `wc -l` on the CSV or
re-run before trusting a grep count. `.diagtrace` is SQLite; the manifest carries `"capture":{"domains":[...]}`
and the recorded `--domain ...` command (python scan of first ~500 KB).

## Still-outstanding writer work / watch items
- after/postfix traces read fine; artifacts under
  `/Volumes/Data/bio/chase-northstar-20260918/performance-slice/wallkick-valid-choice/{after,after-postfix}/`.
- 0455 remains STRANDED — never wake `aku/intern/0455ff64`.
