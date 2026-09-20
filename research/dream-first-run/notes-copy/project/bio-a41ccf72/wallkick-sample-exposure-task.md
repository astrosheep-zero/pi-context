---
scope: project
origin: self
status: active
stale: false
created_at: 2026-09-19T01:26:59.385+08:00
updated_at: 2026-09-19T01:35:44.500+08:00
last_accessed: 2026-09-19T01:28:26.177+08:00
access_count: 2
---

# ACTIVE TASK — WallKick sample exposure (closed mechanical), isolated worktree

Last user request (verbatim intent): "IMPLEMENT closed mechanical WallKick sample exposure in ISOLATED
worktree from CURRENT main snapshot; no main writes. Own ONLY rabbitEscapeManeuverProjection.ts +
necessary local exported motion sample type (prefer same file), existing relevant projection test if
needed. Main e082 will avoid this file until delta integrated."

## Deliverable / contract
- API `RabbitWallKickProjection` gains `readonly motionSamples: readonly RabbitWallKickMotionSample[]`
  and `wallKickImpulseSec: number | null`.
- New exported type (same file): `RabbitWallKickMotionSample` = `{ startSec, endSec,
  startPositionM:{x,y}, endPositionM:{x,y}, startVelocityMps:{x,y}, endVelocityMps:{x,y},
  headingRad, angularVelocityRadPerSec, phase: "approach" | "rebound_carry" }`. Units meters/mps,
  decision-relative clock.
- Populate from ALREADY computed `approach.phaseSamples` (`WallKickApproachProjection`) and
  `runRabbitWallKickCarry.steps` (add start velocity/heading source where needed).
- Public projection function is `projectRabbitWallKickProjection` (already exported, line ~1322 in
  worktree file). Enrich its return so e082 calls it ONCE for the requested horizon and reads
  path/terminal/event. `projectRabbitWallKickTerminal` (line ~1338) is the terminal-only wrapper that
  drops the path — keep it working but the enriched `projectRabbitWallKickProjection` is the target.
- When modeled predator contact ends the path: slice/interpolate the SAME `motionSamples` to the event
  time; REMOVE the second re-run in `finishRabbitWallKickCarry` (currently it recursively calls
  `projectRabbitWallKickPath(facts, intent, envelope.predictedTimeToContactSec, false)` at lines
  ~1148-1160). Keep blocked/world-physics law (`runRabbitWallKickCarry`, `stepOrdinaryBody`) unchanged.
- `wallKickImpulseSec`: decision-relative time the rebound impulse is applied (fresh approach =
  `contactPose.elapsedSec`); `null` if never reached (truncated approach terminal) OR already paid
  before t0 (live `intent.airborneCarry` branch).
- No new costs/body/fear code, no tuning. Live locked approach/rebound prefix must stay honest
  (airborneCarry: no approach re-walk, samples = carry steps only, impulse null).

## Worktree / snapshot (already set up)
- Worktree: `/Volumes/Data/bio/chase-northstar-20260918/performance-slice/wallkick-valid-choice/model-redesign/wallkick-samples-worktree`
- Isolated from CURRENT main snapshot: worktree at HEAD `b6ee6d12`, then main's `git diff HEAD` applied
  + main's untracked `src/` files copied. node_modules symlinked.
- Snapshot tree hash (index, = baseline for my delta): `b7d9385c7cc5306ab5399eb994aafa8b53c18c76`.
- Delta = `git diff` (index=snapshot vs worktree). Generate patch + receipt under
  `.../model-redesign/wallkick-samples-slice/` when done.
- Snapshot was taken while e082 was still writing main (main had 92 tracked mods, 13 untracked src
  files). Expect PRE-EXISTING typecheck/test errors from incomplete main; must distinguish my hunks.
  e082 files in flux included `logic/prediction/intervals.ts`, `species/rabbit/rabbitFearForecast.ts`
  (and `rabbitCandidateEvent.ts` existed earlier, later gone).

## File facts (worktree copy of the main snapshot; line numbers pre-edit)
`src/species/rabbit/rabbitEscapeManeuverProjection.ts` (1534 lines):
- imports top ~1-40; `RabbitEscapeBoundSample` from `./rabbitEscapeAffordanceTypes`.
- `WallKickApproachProjection` (293-315): `pose`, `contactElapsedSec`, `phaseSamples:
  readonly RabbitEscapeBoundSample[]`, `remainingAirborneSec`, `contactDragPerSecond`,
  `contactAirborne`.
- `projectRabbitWallKickApproachContact` (331-450): walks `approach.phaseSamples`; produces contact
  `pose` via lerp; `phaseSamples` are `RabbitEscapeBoundSample` with fields `startSec,endSec,velocity`
  (start), `projectedVelocity` (end), `projectedDisplacement` (delta), `headingRad` (end),
  `headingDeltaRad` (so angular velocity = headingDeltaRad/(endSec-startSec)), `phase` (HopContactPhase).
- `RabbitWallKickCarryStep` (662-670): `startSec,endSec,positionXM,positionYM,velocityX,velocityY`
  (velocity = END velocity of the step; start velocity = previous step end or launch velocity;
  position absolute meters already).
- `RabbitWallKickCarry` (671-683): `steps`, end pos/vel, `blocked`, commanded/achieved distance,
  reachableFlightRatio01.
- `runRabbitWallKickCarry` (762-845): DO NOT change physics.
- `RabbitWallKickProjection` type (981-986): currently `{ terminal: RabbitTerminalPose; facts:
  RabbitWallKickProjectionFacts }` → add the two new fields.
- `sliceWallKickApproachPose` (987-1043): approach pose lerp helper (pattern to copy for
  interpolation).
- `finishRabbitWallKickCarry` (1046-1160): builds carry, terminal, `projectionFacts`; when
  `stopAtPredatorContact`, builds `flightSamples` (line ~1122) and `envelope =
  evaluateRabbitPredatorContactEnvelope({ motorSamples: [...input.envelopePrefixSamples,
  ...flightSamples] })`; if `envelope.predictedTimeToContactSec <= terminal.elapsedSec` it currently
  RE-RUNS `projectRabbitWallKickPath(..., event, false)` (the duplicate to remove).
  Inputs include `startXM/Y`, `startVelocityX/Y`, `startHeadingRad`, `launchSpeedMps`, `flightSec`,
  `elapsedToFlightStartSec`, `targetReached`, `envelopePrefixSamples`, `dampingPlan`,
  `quantizeFlightToExecutorTicks`.
- `projectRabbitWallKickPath` (1161-1320): airborneCarry branch (~1173-1206), truncated approach
  branch (~1230-1265, returns `{ terminal: truncatedPose, facts: {...zeros, targetReached:false} }`),
  fresh approach branch (~1273-1320) computes `launchSpeedMps`, `flightSec`, `envelopePrefixSamples`
  (`slicePhaseSamplesUntil(approach.phaseSamples, contactPose.elapsedSec)` + zero-length kick sample
  with nudge displacement + launch velocity), then calls `finishRabbitWallKickCarry`.
- `projectRabbitWallKickProjection` (1322-1336) public; `projectRabbitWallKickTerminal` (1338-1345)
  terminal-only.

## Design decisions made
- Pass a new `approachMotionSamples: RabbitWallKickMotionSample[]` (phase "approach") built in
  `projectRabbitWallKickPath` into `finishRabbitWallKickCarry`; airborneCarry passes `[]`.
- `finishRabbitWallKickCarry` builds carry samples (phase "rebound_carry") from `carry.steps`
  (absolute times = step.startSec/endSec + `elapsedToFlightStartSec`; start position = previous end,
  or `startXM/Y` for step 0; end position = step.positionXM/Y; start/end velocity from prev/current
  step velocity; heading = `startHeadingRad` constant; angularVelocity = 0), concatenates
  `[...approachMotionSamples, ...carrySamples]` → `motionSamples`.
- Add `impulseSec: number | null` param to `finishRabbitWallKickCarry` (fresh approach =
  `elapsedToFlightStartSec`/contact time; airborneCarry = null since already paid).
- Add an interpolation helper over `motionSamples` (lerp position/velocity/heading shortest-angle,
  angularVelocity from source sample, phase), returning an interpolated `RabbitTerminalPose` plus the
  sliced sample list; use it for the predator-contact stop instead of re-running the path.
- Truncated approach terminal and airborneCarry get `wallKickImpulseSec` null; full/stopped fresh
  path gets the contact time (kept even if stopped after impulse, since it was predicted applied).
- `RabbitTerminalPose` is in `species/rabbit/rabbitOwnEscapeGeometry.ts:18-27` (fields positionM,
  velocityMps, headingRad, angularVelocityRadPerSec?, elapsedSec, terminatedByBlocking?,
  terminatedByPredatorContact?).
- `RabbitPredatorContactMotorSample` = Pick<RabbitEscapeBoundSample,'startSec'|'endSec'|
  'projectedDisplacement'|'projectedVelocity'|'speedMps'> (`rabbitEscapeProjection.ts:122-125`).
- `slicePhaseSamplesUntil` exported from `rabbitEscapeProjection.ts:145`.

## Progress — DONE (awaiting lead review / integration into main)
- Worktree + snapshot created; node_modules symlinked; baseline index tree re-verified at
  `b7d9385c7cc5306ab5399eb994aafa8b53c18c76` (unchanged; main file mtime older than my edits => main NOT written).
- IMPLEMENTED. Delta = exactly 3 files: `src/species/rabbit/rabbitEscapeManeuverProjection.ts` (+296/−44),
  `src/test/rabbit-own-escape-margin.test.ts` (+72), `src/test/rabbit-wall-kick-execution-chain.test.ts` (+16).
- Verification: `npx tsc -p tsconfig.app.json --noEmit` exit 0 (0 errors; baseline was also clean, no
  pre-existing errors to distinguish); 10 focused projection test files, 121 tests passed.
- Artifacts: `.../model-redesign/wallkick-samples-slice/delta.patch` (24317 bytes) and `RECEIPT.md`.

### Final API (as implemented)
- `RabbitWallKickProjection` gains `motionSamples: readonly RabbitWallKickMotionSample[]` and
  `wallKickImpulseSec: number | null`.
- `RabbitWallKickMotionSample` (same file, exported): startSec,endSec,startPositionM,endPositionM,
  startVelocityMps,endVelocityMps,startHeadingRad,endHeadingRad,angularVelocityRadPerSec,
  phase:'approach'|'rebound_carry'. The original `headingRad` request is realized as `endHeadingRad` plus
  `startHeadingRad` (lead locked: expose canonical start/end heading facts, no guessed atan2).
- Approach slices from `approach.phaseSamples` (via `approach.startHeadingRad`, captured from the walk's own
  init heading expr); carry slices from `carry.steps` + `elapsedToFlightStartSec`; heading frozen for carry.
- Predator contact now slices the SAME motion samples (`sliceWallKickMotionSamplesUntil`, angle-unwrap
  interpolation); recursive `projectRabbitWallKickPath(...event...)` re-run REMOVED.
- Deleted private `sliceWallKickApproachPose` (its guessed `atan2(projectedDisplacement)` heading law gone).
- `wallKickImpulseSec`: fresh = contactPose.elapsedSec; null for truncated approach, live airborneCarry,
  and predator contact before the impulse.

### Behavior deltas to report to lead (all disclosed in RECEIPT §5)
1. Predator-contact endpoint is now interpolation of the same path instead of a fractional-dt re-run.
2. `facts.reboundReachableFlightRatio01` for a contact AFTER the impulse keeps the full-flight ratio
   (re-run used the truncated-flight ratio). `facts.reboundTerminalSec` = event time.
3. Truncated-inside-first-slice approach terminal heading now uses sampled heading facts (was
   `atan2(displacement)`). Only terminal-pose value change.
4. FINDING (pre-existing, NOT fixed): full-budget carry is rounded up to whole exec ticks
   (`safeDurationSec=(1+ceil(flightSec/dt-eps))*dt`), so `motionSamples.at(-1).endSec` can exceed
   `terminal.elapsedSec` by up to 2*dt (terminal bills authored seconds, pose is realized carry end).

### Next steps
- None for me until the lead reviews. If integration requested: apply `delta.patch` to main (main's e082
  must have stopped touching `rabbitEscapeManeuverProjection.ts`). Do NOT commit main without request.

## Constraints / skills
- Do NOT write main; do NOT commit/push/merge. Isolated delta relative to snapshot tree
  `b7d9385c...`.
- No duplicate prediction pathway; keep world/blocked physics law unchanged.
- Relevant skills available: `diag` (not needed), `animal-behaviour-dev` (mindset). Not needed now.
- Lead will review body billing vs execution later; earlier frozen checklist at
  `.../model-redesign/body-billing-review-checklist.md`. Contact F1-F3 accepted/closed; audit frozen
  at `.../model-redesign/contact-review.md`.
- Prior delivered timing slice receipt: `.../model-redesign/timing-slice/`.

## Session IDs (window `pcw:01a0b547:root`)
- `955fee60` (1706 chars) = LATEST: IMPLEMENT WallKick sample exposure in isolated worktree (the task
  this note is about).
- `13fb22b7` = Thanks; Contact F1-F3 accepted; assigned e082 main corrections (ownbody absolutes,
  duplicate interval resolver, event single-producer/provenance); freeze; later body-review scope.
- `6bca8469` = Alongside interface inspection, confirm F1/F2/F3 in current main; 3-line confirmation.
- `ef8bd6c8` = Early READONLY interface check on candidateForecast.ts/rabbitCandidateEvent.ts/context/
  policySpec.
- `95be3f08` = Read contact-review; assigned e082 F1/F2/F3; freeze audit.
- Earlier: `fb60b5ce` (timing audit follow-ups), and prior timing-slice / contact-audit requests in the
  same window. Recover exact text with `history_read window_id=pcw:01a0b547:root item_id=<id>`.
