---
scope: session
origin: self
status: active
stale: true
created_at: 2026-09-18T22:11:40.683+08:00
updated_at: 2026-09-18T22:12:04.333+08:00
last_accessed: 2026-09-18T22:11:45.821+08:00
access_count: 1
---

# wallkick-valid-choice audit — checkpoint (read-only auditor role)

Repo: /Users/astrosheep/Developer/bio. Artifacts root: /Volumes/Data/bio/chase-northstar-20260918/performance-slice/wallkick-valid-choice/.

## My role
Read-only auditor (no repo source edits, no commits). Old auditor `162c` STRANDED — do NOT wake. Stranded writer `aku/intern/30e85c03`. CURRENT sole writer: **`aku/intern/fc38da04` @wallkick-continuation** (contact atomic-truth P0 landed). `keiyaku tell aku/intern/fc38da04 "..."`; `keiyaku status`. Report to user in Chinese.

## Active user requests (window pcw:01a0b421:root)
- item `04fb6f96` (NEWEST): ROOT REVIEW P0 — rebound actuator mismatch. My closed task = read actual physics/timed WallKick flight; give exact law/owners to fc38. **DONE this window.**
- item `8f8dfbf8`: writer30 stranded→fc38; frozen 6-geometry+2-open suite before tuning; probe s9 t37 per-sample terminal metric; provide exact semantic patch path ≤5 to lead.
- items `1d7ab77a` / `1e0a6549` / `bb02ef3a` / `f8c91fc5`: earlier audit notes (note(1) law fix verified; g-bill arithmetic corrected; variant selection byte-identical).

## DELIVERED this window: executed rebound law map
`variants/executed-rebound-law.md` (auditor artifact, written 22:1x; sent to fc38 via keiyaku tell).
Key source facts (do not re-derive):
- Order (`SimulationCore.ts:40`): locomotion BEFORE wallKick, physics AFTER. dt=1/60. flightDurationSec=0.28 (~16.8 ticks).
- Contact tick: `setVelocityTarget(dir*loaded6.5, dt)` ONE shot (`WallKickSystem.ts:261`) + nudge 0.06m + bodyLoad bump; contacted=1, phase Active, timer 0.28. Speed = min(loaded7.0, loaded6.5)=loaded6.5 (`wallKickBodyLimits.ts:33-44`).
- Later Active ticks: locomotion skip-branch → `continue` (`LocomotionSystem.ts:1765-1770`) ⇒ ZERO accel, ZERO damping, hop atom dead; physics a=0, damping = terrain friction only (0 when friction<=1) ⇒ constant-speed straight coast; wallKickSystem only decrements timer + height01=sin arc (presentation only).
- Heading frozen: nothing writes `Locomotion.heading`/`Position.rotation` during Active (only writer is drive branch `LocomotionSystem.ts:1885`).
- Discriminator: `Locomotion.state` at contact tick. Moving ⇒ hop flight handler not skipped that tick ⇒ airDrag 0.6027/s on remaining airborne ticks; else no air drag. Not instrumented anywhere yet.
- Prediction mismatch owners: `rabbitEscapeManeuverProjection.ts:946-953` `hopLocomotion: undefined` + `projectRabbitHopMotor` ⇒ fresh ground stance leg-drive + airDrag + landing recursion + heading rotation; envelope re-enters path from airborne pose (re-approach/re-kick). Terminal pose → `evaluateRabbitTerminalAngularFreedom` → `buildRabbitHopDirectionsForRoute` (heading-keyed wall correction `rabbitHopOption.ts:363-375`).
- Trace reality: variants wall_pressure-s7/s9 + open_pressure_control-s9 have ZERO `action.wall_kick_execution` rows; only `cognition.wall_kick_projection` (6 rows, t=0.517/0.617, no terminal pose, no per-sample fields). No executed kick exists ⇒ per-sample probe still unbuilt.

## Revision state (moving — re-pin before auditing)
- Post-P0 revision `git diff HEAD` md5 = 90e90207e399d217d6fb4948e1ce35c8 (45 entries) per `variants/artifact-index.md` (22:01).
- At 22:11 the tree had moved again: `git diff HEAD` md5 = **aae08d46140e286331fd878d0f27a21f**, 47 entries (fc38 mid-suite). Re-pin and diff vs 90e90207 when he reports.
- Semantic patch paths for lead (≤5): `variants/crucial-diff-semantic-p0.patch` md5 ae2d8cabe6b2b500433d335c34954fbe (35 file entries, excludes src/gen + src/test); full `variants/crucial-diff-p0.patch` 04f7546293d90d405c63071123399e1f; pre-P0 `variants/crucial-diff-semantic.patch` b986e17d…, `variants/delta-vs-849b90b0.patch` db7686a3… (delta vs green 849b90b0). Pre-P0 full tree md5 was 15845eb5… (44 entries).
- Reconstruction recipe (no repo edit): `git archive HEAD | tar -x -C /tmp/X` then `patch -p1 -s < cumulative.patch`; verify with `diff -rq /tmp/X/src <repo>/src`.

## My audit artifacts (append-only)
- `implementation-audit.md` — main audit (5 P0 checks + post-fix verifications + variants + g-bill).
- `variants/executed-rebound-law.md` — NEW, the executed actuator/drag/heading map.
- `variants/bill-geometry-debug.md` — geometry trace.

## Other key source facts (do not re-derive)
- `species/rabbit/rabbitEscapeAngularFreedom.ts:24-97`: metric builds hop samples from TERMINAL pose; `projectionHorizonSec=1`, `speedLossReject01=0.75`, threat advanced by `elapsedToEndpointSec`.
- `logic/cognition/angularEscapeFreedom.ts:226-300`: route probe ORIGIN = `projection.finalPositionM` (terminal) — hypothesis (b) route-probe-origin is FALSE.
- `species/rabbit/rabbitHopOption.ts:363-375`: wall correction keyed on body HEADING; kick writes only `setVelocityTarget`+nudge, never rotation.
- Selection = global posterior MODE (`policyPosterior.ts:50-61,:182-190`); all 10 variant traces selection tuples byte-identical; wall_kick SELECTED 0/10.
- g-bill: logit = prior − precision·max(0, G−argminG), precision 10.6068, argminG 4.1089.

## Next steps
1. Wait for fc38 delta (frozen 6-geometry + 2-open suite + pure rebound-carry kernel). Then: re-pin tree md5, diff vs 90e90207, audit the kernel against `executed-rebound-law.md` (bit-exact law, no stance/re-approach/re-kick, frozen heading, no constant tuning).
2. Push for the instrumented discriminator row (locomotion state + height01 + wall_kick velocity/damping per tick) so the same-state exec check has source facts.
3. Only after the kernel lands: re-open the s9 t37 per-sample metric question (probe still mandatory).
4. Do NOT rotate the body to fix G; no constant tuning of the shared metric; no broad cleanup.

## Learning
- `keiyaku wait` can return "No result provided"/timeout; poll `keiyaku status`. Writers may `new_context` mid-task (stranding).
- Do not audit a moving tree: pin `git diff HEAD` md5 first; note stale md5 chains.
- `diag:query` field names are LEAF paths; `--list-names` finds row names; query does not rebuild.
