---
scope: session
origin: self
status: active
stale: false
created_at: 2026-09-18T19:44:24.493+08:00
updated_at: 2026-09-18T21:56:45.696+08:00
last_accessed: 2026-09-18T19:52:13.194+08:00
access_count: 2
---

# wallkick-valid-choice — LIVE STATE (window pcw:01a0b40d:ac7999f9 → handing off)

## REVISION (unchanged since audit, verified)
`git diff HEAD | md5` = **15845eb5b3e182421bf994494d474ff3**; 44 entries = 40 tracked + 4 untracked
(`src/core/wallKickSurface.ts`, `src/species/rabbit/rabbitWallKickVariant.ts`,
`src/species/rabbit/wallKickBodyLimits.ts`, `src/test/rabbit-wall-kick-execution-chain.test.ts`). Base b6ee6d12.
NO commit/push. Snapshots: `/tmp/wk-variants-snapshot.tgz` (this revision), `/tmp/wk-green-snapshot.tgz` (849b90b0).
tsc clean; codegen:check fresh; focused 72 passed/7 files; full suite 1339 passed + same 3 pre-existing failures
(rabbit-fear-delete-regression, rabbit-semantic-telemetry, rabbit-threat-perception).
All artifacts in `/Volumes/Data/bio/chase-northstar-20260918/performance-slice/wallkick-valid-choice/variants/`.

## TASK A — DONE (root review packet, ≤5 paths)
1. `variants/crucial-diff-semantic.patch` — md5 **b986e17db93fa8e36ce86a37b584b431**, 3734 lines, 34 paths:
   `git diff HEAD -- src ':!src/gen' ':!src/test'` + full bodies of the 3 untracked sources. VERIFIED: applied
   onto `git archive HEAD src` it reproduces every path it touches byte-identically.
2. `variants/new-module-rabbitWallKickVariant.ts` — md5 05b900756d259a7190686157ef1db930 (full new module).
3. `variants/implementation-checkpoint.md` (design + audit responses + findings), 4. `variants/g-bill.md`
   (source bill), 5. `variants/wallkick-variants-geometry-s9.png` (visual; + its 2 source CSVs + plot script).
Other artifacts: `crucial-diff.patch` md5 da46498919b91cb3cb7e350af1172e5c (cumulative vs b6ee6d12 + 4 untracked),
`delta-vs-849b90b0.patch` md5 db7686a39a5aa19c9095295d4415fae5 (29 files), `counts.md`, `g-by-heading.md`,
`receipt.md`, 10 `.diagtrace`, projections in `sel/`, `test-logs/focused-variants.log`,
`sel/bill-full-s9-*.txt`, `variant-geometry-walls9.csv`, `variant-kinematics-walls9.csv`. Auditor's file:
`../implementation-audit.md` (+ `variants/bill-geometry-debug.md` from the read-only geometry trace).

## TASK B — PENDING (the closed task to execute next; NOT started)
User order (verbatim intent): capture a SMALL explicit physically-plausible wall-opportunity suite with the
CURRENT UNCHANGED behaviour to distinguish "all worlds bad" vs "bad initial pressure geometry":
- 6 geometry cases = 2 wall clearances (both reachable inside the existing 0.45 s approach timeout) × 3
  approach angles, PLUS 2 paired open controls. Every parameter FROZEN before observing results; record recipe
  inputs in SI with rationale; do NOT search until a win.
- Geometry: straight wall near the rabbit on left/right; predator approaches from BEHIND / slightly lateral
  (NOT blocking the whole exit); rabbit initially parallel to or obliquely toward the wall at EXISTING body
  canonical speeds.
- 6–8 s, FIRST GRAPPLE ONLY as the bound. NO forced/selected policy, NO primed wall-kick intent, NO hidden
  belief hacks, NO new production behaviour conditions, NO G/shared-metric constant tuning. Canonical
  spawn + sensors + ordinary inference; scene may set initial pose/velocity like wall_pressure does.
- Count candidates by variant / G / selection → action → contact → rebound / first grapple. **At least 1 actual
  execution (ENTERED + CONTACT + REBOUND) is required for acceptance**; negative/open cases must NOT invent a
  wall. If nothing wins: report the EXACT failure chain and do NOT declare the mechanism complete.
- Use the approved existing diagnostic scenario/custom-case path; any temporary fixture lives OUTSIDE git
  except a small scenario if the public path needs registration. If no honest public init recipe exists, ask a
  BOUNDED tooling question instead of hacking.
- If delegated to a worker: the contract must keep this scope AND the PRE-FIRST-GRAPPLE bound.

### The init recipe template (from `FoxRabbitWallPressure.ts`, the approved path)
`src/apps/diagnostics/inspector/scenarios/FoxRabbitWallPressure.ts` (registered in `scenarios/index.ts:141`,
`ScenarioMeta` arena `{width:28,height:20,boundary:'closed-wall'}`), plus `scenarios/shared.ts`
(`spawnAtLocalAddress(ctx, PrefabId.X, col, row, viewport)`, `pointEntity(eid, heading)`,
`setHungerPressure(eid, v)`, `setFocusEntityIds`, `ctx.setChaseIds(fox, rabbit)`). Honest pose init is:
`Position.x/y`, `Velocity.x/y`, heading via `pointEntity`, `Locomotion.targetVx/Vy`, `Sensor.fov[rabbit]=360`,
`Locomotion.state=Recover`, `Locomotion.timer/phaseDurationSec`, `targetHeadingTrackingActive=1` for both.
wall_pressure case values: rabbit col 23 or 4 (`sideSign`), fox col `rabbitCol - sideSign*3`, same row from
`ROW_OPTIONS=[6,10,14]`, rabbit velocity `2.6 * chaseDirectionX` px/tick, fox `5.7 * chaseDirectionX`,
`chaseDirectionX = sideSign>0 ? 1 : -1` (rabbit runs AWAY from the wall, i.e. toward open field — that is the
suspect initial pressure geometry for task B). open control = both at col 14. SI conversion: 32 px/m,
60 ticks/s (so 2.6 px/tick ≈ 1.39 m/s, 5.7 ≈ 3.05 m/s).
Scenarios listing: `npm run diag:trace -- list` / `show <scenario>`; capture with
`npm run diag:trace -- --domain cognition,body,action,interaction --scenario <s> --seed <n> --sim-seconds <6-8>
--tick-step 1 --out <path>`; DELETE existing `*.diagtrace`/`-wal`/`-shm` first (writer refuses to overwrite);
run `npm run diag:build` explicitly after source changes (`diag:trace` never rebuilds). `--fields` takes LEAF
names only; `simSec`/`tick`/`subjectId` are envelope columns (never list them in `--fields`); a missing out-file
means "no rows matched".

## AUDITOR READ-ONLY GEOMETRY TRACE (decides WHAT the suite must report; no repo edits, tree unchanged)
`variants/bill-geometry-debug.md`. Verdicts: (b) "probe origin is decision-time" FALSE — each sample's probe
origin is the sample's TERMINAL position (`angularEscapeFreedom.ts:239-245`, `projection.finalPositionM`).
(a) CONFIRMED mechanism present: `rabbitHopOption.ts:363-375` keys the wall correction on the body HEADING, not
velocity (`wallExitDirection = normal && dot(heading,normal) < 0.85 ? normalize(normal*0.7 + tangent*0.3) :
tangent`, then `preferredExecutionDriveDirection = clampDirectionToward(canonicalRouteDirection,
wallExitDirection, PI/4)`), while `applyImpulseFromContact` writes only `setVelocityTarget` + a nudge and NEVER
calls `setBodyRotationIntent` — so post-kick the heading still faces the approach (dot(heading,normal)≈-1) while
velocity points outward, which is exactly what makes speedLoss/speedRetention reject samples
(`rabbitHopOption.ts:480-500` speedLoss from dot(launchVelocity, direction) vs the effort target;
`angularEscapeFreedom.ts:226-300` clearance01/speedRetentionSafety01/physicalSafety01/viability01 with
`speedLossReject01 = 0.75`, `projectionHorizonSec = 1`). (c) NOT established from source alone.
The auditor does NOT claim root causality. **The suite must report, per candidate (reflect/left/right + best
flee) at the candidate tick: terminal position, terminal velocity, projectedHeadingRad,
projectedAngularVelocityRadPerSec, elapsedToEndpointSec, the endpoint-advanced threat vector, and per-sample
clearance01 / speedLoss01 / speedRetentionSafety01 / physicalSafety01 / viability01 / routeProbeValid01 plus the
valid-sample fraction.** Those per-sample fields come from `evaluateRabbitTerminalAngularFreedom` /
`angularEscapeFreedom` and are NOT all in the current diagnostic rows — check `--list-fields` first; if they are
absent, the honest options are (i) a temporary read-only fixture outside git that calls the metric directly with
the frozen scene state, or (ii) a bounded tooling question. Do NOT add production behaviour conditions.
BOOKED DEBT (definite, not fixed): `WallKickContactHelpers.ts:47-72` `resolveWallContact` keeps the primary
(collision) point/normal but overwrites `distance` with `min(primary, proximity)`, so the reach gate
(`distance <= supportReachM`) can be satisfied by a NEARER different wall while the point/normal/plane identity
belong to a farther primary surface, and `contactDistanceM` can mis-report. It cannot fire when nothing is in
reach; no remote impulse.

## STATE OF THE SLICE (what is proven vs not)
- Audited PASS: direction single-owner, per-variant candidates, no cardinality multiplication, no contract
  break; note-(1) fix (departure validated against the SAME committed latched normal the projection bills)
  VERIFIED; source bill verified (risk lane ≈100% of the G gap, prior adds ≈1.40 of which 1.17 is
  `selector.incumbent_continuation`; corrected per-variant arithmetic: logit = prior − 10.6068·max(0,G−argminG)
  → reflect −29.71, edge:left −28.73, edge:right −27.79, flee argmin 3.21).
- NOT proven: NO wall-kick was ever SELECTED or EXECUTED in any of the 10 traces (candidates only: s7 1 tick,
  s9 2 ticks, 0 elsewhere; SELECTED 0/10; `action.wall_kick_execution` 0/10). The execution chain rests on
  system tests. That is exactly what task B must attack empirically.
- The metric question (is the 0.0–0.24 post-kick terminal margin true geometry or a 1 s-look-ahead artifact of
  billing one committed action?) is booked for the lead; auditor's tell: reflect at outward·n 0.9987 still bills
  only 0.069/0.243 while the cone edges bill 0.000–0.139, and the metric is the same symmetric ruler for flee
  and wall_kick. NO constants may move.

## SKILLS / KEY FILES
`.agents/skills/diag/SKILL.md`, `.agents/skills/chase-trajectory/SKILL.md`,
`.agents/skills/animal-behaviour-dev/SKILL.md`; plot venv `/Volumes/Data/bio/tools/chase-trajectory-venv`
(`plot_wallkick_variant_geometry.py` in `variants/` is the working overlay example).
Semantic owners: `src/species/rabbit/rabbitWallKickVariant.ts` (variant identity), 
`src/species/rabbit/rabbitEscapeManeuverProjection.ts` (intent + per-variant projection),
`src/species/rabbit/rabbitWallEscapeOpportunity.ts` (per-variant authority), `src/species/rabbit/stages/
rabbitSignals.ts` (publishes `wallKickVariantProjections`), `src/species/rabbit/options/rabbitPolicySpecs.ts`
(optionVariantIds + per-candidate plan), `src/systems/WallKickSystem.ts` (realizes the requested direction).
Only auditor: `aku/intern/ba95a09d` (last told 20:33; `aku/intern/162c8a24` STRANDED; I am `aku/intern/30e85c03`).
