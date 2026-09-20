---
scope: project
origin: self
status: active
stale: false
created_at: 2026-09-18T23:51:11.273+08:00
updated_at: 2026-09-19T01:30:33.298+08:00
last_accessed: 2026-09-19T01:15:15.440+08:00
access_count: 7
---

# c3 fear / world-end handoff — state at memory wipe

## TASK WORLD — FROZEN (2026-09-19 ~01:24, keiyaku namespace `chase-model`)
Parent `task/chase-model/chase-prediction-one-command-one-6b3a` = in_progress (note: fear helper UPDATED patch 298 l
ready + real-fox-wrapper tests patch ready; full model acceptance NOT claimed).
- DONE: `task/chase-model/contact-semantics-and-contact-f293` (note cites contact/RECEIPT.md + aku/intern/81788c53 latest say 01:18 F1/F2/F3 confirmation).
- DONE: `task/chase-model/remove-dead-direction-scorer-and-ea85` (note cites legacy-delete-receipt.md + model-redesign/contact/RECEIPT.md main-integration).
- in_progress: `task/chase-model/candidate-owned-trajectory-and-d66e` (forecast).
- open/awaiting: `task/chase-model/upstream-event-timing-shared-by-aad8` (final integration/clock-refactor verification).
- open/pending: `task/chase-model/re-run-pursuit-trajectories-and-4033` (acceptance).
FREEZE after this: no further work until the lead gives the next instruction.

## acceptance-command-plan CORRECTED (2026-09-19 ~01:35, read-only, 144 l)
File: `variants/acceptance-command-plan.md` (correction 3). Changes: `body.death` owns death facts (body domain,
`cause`/`age`/`speciesId`); `interaction.*` owns only grapple/contact rows; NO interaction-death requirement.
New §3.3b column-discovery checklist maps one discovered leaf to each of 9 semantic forecast channels
(a request T, b bounded T, c event NULL-vs-0, d own command kind, e endpoint body, f endpoint fear mu/pi authoritative,
g body/motor load, h own contact, i variant identity) and reports a missing channel instead of skipping.
New counters: zero-contact (event-at-zero) vs absent, per-candidate distinct counts (fear mu/pi, body fatigue/energy/
load, endpoint escape margin) same-tick. `selected != argmin` explicitly not a failure; keep posteriors+priors for the
focal tick. No proof from summary alone. Source-frozen rule kept. No build/capture run. NEXT: await capture signal.

## Active task (IN PROGRESS, was mid-flight)
Latest user request: read-only architecture fact collection → write
`/Volumes/Data/bio/chase-northstar-20260918/performance-slice/wallkick-valid-choice/variants/model-source-inventory.md`
containing: shared evaluation order + timing types; rabbit flee/wallkick prediction horizon/event
ownership; fox `predictionEndTimeSec` precedent; `escapeOutcomeProgress01` zero case; dead
`freshFleeDirectionGRows` consumer inventory; **distinction event-at-zero vs absent event**; fear
overlay/finalizer owners; ALL `predictionEndTimeSec` producers/consumers; physical vs uncertainty
contact radius facts. No redesign suggestions. Return source revision + path, stdout short.
READ-ONLY: do not edit repo. Do NOT interfere with e08237d0 (owns active wall video/boundary slice,
uncommitted).

I had just run the last greps (results below) and had NOT yet written the file. NEXT STEP: write
that file, then reply short (Chinese) with revision + path.

## Already delivered artifacts (all external, repo untouched)
- `/Volumes/Data/bio/chase-northstar-20260918/performance-slice/wallkick-valid-choice/variants/c3-counter-run-bill.md` (140 lines)
- `.../variants/c3-fear-law-excerpts.md` (497 lines, ≤500 budget)
- `.../variants/c3-worldend-attachment-handoff.md` (344 lines, ≤400 budget)
- query CSVs in `.../c3-counter-run/*.csv`

## Source revision / repo state
- HEAD = `b6ee6d12ca6ef3724d790c14842f7605929a540c`; base for captures. `git diff HEAD --stat` =
  51 files changed, 3479 insertions, 1648 deletions. `git status --short` = 58 entries (7 untracked:
  WallKickGeometry.ts, wallKickSurface.ts, kinematics/ordinaryBodyStep.ts, rabbitWallKickVariant.ts,
  wallKickBodyLimits.ts, rabbit-wall-kick-execution-chain.test.ts, world/ordinaryBodyStep.ts).
  Published c3 trace rev = `bfb5c2cf444f889acbbe59c58c0f1ee5`.
- Repo NOT modified by me. No `diag:build` run. `diag:query` used on existing traces only.

## Decisive measured facts (c3, published trace, pre-grapple <0.967s)
- tick 37 = 0.617s is the earliest "G argmin + toward-fox direction + actually hop-latched" decision:
  `flee/cross-break:right:0`, G 3.5621, billed dir (0.3275,0.9449) spd 5.85; hop latched t=0.633
  (`action.hop_bout_command`, origin tick 37). Earlier tick 31 (0.517, carry-speed:center:0, +1.000x)
  billed +x but latched nothing (completed-hop inertia). Later counter-run selections (43/49/55)
  never latched a hop; consumed payload origin stayed 37.
- Flee selection is decided ONLY by the fear channel. `contribution_fear = weightFear(4.0038) ×
  predictedStateFear²`; `weightFear(effective) = scoring_weights.weightFear(3) × neuroticism(1.334593)`.
- `escapeOutcomeProgress01 = escapeOutcomeDurationSec > 0 ? clamp01(E/dur) : 0` (rabbitPrediction.ts:198-201);
  `escapeOutcomeDurationSec = flee.horizonSec = motorHorizonSec`.
- Measured: 0.417/0.517 → dur 0.0833/0.05 → progress 1 → predFear 1.0 for ALL 27 candidates.
  0.617+ → dur 0 → guard returns 0 → predFear per-candidate, exactly affine in own E
  (per-tick R²>0.9999993; pooled 0.617–0.917 n=110 slope −1.17484, R² 0.99993; fitted intercept ==
  `cognition.current_state.fear` to 4dp). `E = commandProjectionContactWindowSec + commandProjectionAirDurationSec`.
- TTC=0 root: gate `currentSeparationM <= effectiveContactRadiusM` → pTTC=0 + captureBreachRisk01=1.
  `effective = contactRadius + uncertainty + pursuitReach`; `uncertainty = 0.18*(1+(1−conf)*2.25)`;
  `pursuitReach = predatorSpeed*0.075*closingAlignment*(0.4+0.6*closePressure)`;
  `contactRadius` = **fallback `DEFAULT_ATTACK_CONTACT_RANGE_M = 20/32 = 0.625`** because
  `resolveRabbitEscapeThreatVector` never sets `attackContactRangeM`; fox's own
  `FOX_ATTACK_CONTACT_RANGE_M = 12/32 = 0.375` is a different lane field (cone `contactRangeM`).
  tick37: actual separation 1.104m, believed 1.080m, believed fox speed 3.086 (actual 1.78),
  conf 0.55667 → 0.625+0.35955+0.21188 = 1.19643 ≥ 1.080. Missing: raw `threat.relativeXM/Y` sign
  convention + exact conf passed to envelope.

## LAST TOOL RESULTS (needed for the pending file)
`InferenceTiming` (src/logic/ActiveInference.ts):
```ts
export type InferenceTiming = {
  dtSec?: number
  /** Policy-owned action phase duration; shared evaluation may continue beyond this. */
  actionEffectDurationSec: number
  /** Shared horizon T used to compare all policies at the same future depth. */
  evaluationHorizonSec: number
  /** Execution-owned delay before a replacement action can begin taking effect. */
  exitPrefixDurationSec?: number
}
```
`predictionEndTimeSec` ALL occurrences (only 3):
- `src/logic/ActiveInference.ts:227` — type field on `PredictedStateTransition` (doc: explicit
  end-of-world time; shared finalization must not accumulate starvation/precision beyond it)
- `src/logic/prediction/finalize.ts:27` — consumer: `boundedHorizonSec = min(evalHorizon, predictionEndSec)`
- `src/species/fox/foxTargetAccessPrediction.ts:500` — sole producer: `predictionEndTimeSec: ownEndSec`
  (inside `withFoxTargetAccessGoal.predict`, foxTargetAccessPrediction.ts:463-500; helper
  `resolveFoxPredictionEndSec` at :328-341; `CLOCK_EPSILON_SEC = 1e-9` at :108).
  Zero-end semantics: `endSec = Math.max(safeDtSec, outcome.terminalEventSec)`; returns null if
  terminal ≥ requested − 1e-9 (path unchanged). NO TESTS reference predictionEndTimeSec.

`freshFleeDirectionGRows` ALL occurrences (dead-in-production inventory):
- `src/species/rabbit/cognitionTypes.ts:52` — optional field declaration
- `src/species/rabbit/stages/rabbitSignals.ts:598` — producer sets `= []` (comment: legacy selected-route
  fields are passive telemetry defaults so they cannot become decision input)
- `src/species/rabbit/stages/rabbitSignals.ts:741` — reader (candidate row lookup for `candidateRow`)
- `src/species/rabbit/rabbitSemanticTelemetry.ts:457` — reader
- tests: `src/test/rabbit-semantic-telemetry.test.ts:118,409`; also tests calling
  `evaluateRabbitFleeDirectionsByG`: rabbit-escape-affordance.test.ts, rabbit-escape-plan-target.test.ts,
  rabbit-fox-belief-proxy.test.ts (this one asserts source does NOT contain it).
- `rabbitFleeDirectionEvaluator.ts:173` `RABBIT_FLEE_DIRECTION_EVALUATION_HORIZON_SEC = 1`;
  `predictDirectionState` (:213-222) uses `routePrediction.predictedFear` (different fear quantity).

## Other source facts already extracted (in the three artifacts above)
- Evaluation order (evaluator.ts ~236-315): `computePolicySemantics` → `actionEffectDurationSec` →
  `buildPredictionSignals` → `extendPredictionSignals` → `spec.predict` → `finalizePrediction` →
  `scoreResolvedPolicyPrediction`. Candidate clock (`fleeAffordance.horizonSec`,
  `.terminatedByPredatorContact`, `.predictedTimeToContactSec`) exists at step 1 (before base rates).
- Rabbit Flee spec `predict` at `src/species/rabbit/options/rabbitPolicySpecs.ts:1129-1131`.
- Fear overlay owners: `rabbitPrediction.ts` `deriveRabbitEscapeFearAfterManeuver01` (:123-196),
  `escapeOutcomeProgress01` (:198-201), `applyRabbitEscapeFearAfterManeuver` (:217-228), Flee branch
  (:577-607), `ownEscapeMargin01` terminal wiring (:385-400). Base: `rates.ts` `fleePredict`
  (:259-266), `applyNeutralDecay` (:99-127), `createRuntime.addFear` (:50-56),
  `buildNeutralPhaseSignals` (:33-40), `createRateBasedPredict` (:146-184). Time setup: `signals.ts:191-204`.
- Terminal stop code: `rabbitOwnEscapeGeometry.ts:86-121` `projectRabbitOwnCommandTerminal`;
  stamping: `rabbitEscapeProjection.ts:404-424` + `resolveFirstPredatorContactSec` (:433-445);
  candidate clock/zeroed lanes: `rabbitEscapeAffordanceBuilder.ts:337-347, 726-745, 979-981`;
  `predictionTypes.ts` `escapeOutcomeDurationSec` + `projectTerminal` wiring (~:270-290).
- Constants: `emotionSemantics.ts` flee.fearReliefPerSecond 0.96, idle.fearCalmPerSecond 0.06,
  idle.threatFearGainBasePerSecond 0.18, idle.threatFearGainProximityScalePerSecond 0.3.
  `body.constants.ts:8` DEFAULT_ATTACK_CONTACT_RANGE_M 20/32; `:11` RABBIT_ATTACK 6/32; `:14` FOX 12/32.
  `rabbitEscapeAffordanceConfig.ts:3-4` predatorEnvelopeHorizonSec 0.8, uncertaintyMargin 0.18.
  `rabbitPredatorEnvelope.ts:105-106` DEFAULT_HORIZON_SEC 0.8, DEFAULT_UNCERTAINTY_MARGIN_M 0.16.
  `chaseKinematics.ts:19` CHASE_CLOSE_RANGE_M = 8.
  `scoringProfileTuning.ts:4-5` preferences.fear 0, weights.fear 3.0.
  `rabbit/spawnProfile.ts:26-33` jitterTrait base neuroticism 1.5 spread 0.18 → 1.334593.
- WallKick ownership still to check for the pending file: `species/rabbit/rabbitWallKickVariant.ts`,
  `predictionTypes.ts` `wallKickEscapeManeuverProjection?.terminalPose?.elapsedSec` as
  escapeOutcomeDurationSec for WallKick; `rabbitPolicySpecs.ts` wallKick `actionEffectDurationSec`
  (:1218 `Math.max(dtSec, 0.35)`).

## Event-at-zero vs absent event (facts to state in pending file)
- Event at zero: `evaluateRabbitPredatorEnvelope` sets `terminalEventReached = currentSeparationM <=
  effectiveContactRadiusM` and pTTC=0/captureBreachRisk01=1 from t=0 (comment: "Initial geometric
  contact is a modeled contact: the world starts ended.").
- Absent event: pTTC=Infinity branch; `resolveFirstPredatorContactSec` returns null when
  `!Number.isFinite(pTTC)`; builder then keeps `seed.commitmentSec`/`probeHorizonSec` clocks.
- Overlay collapses BOTH into the same `>0`-guard zero progress (dur 0 vs dur missing) — that is the
  measured ambiguity.

## Task task/chase-model/chase-prediction-one-command-one-6b3a (open, read-only)
Artifacts (all in `/Volumes/Data/bio/chase-northstar-20260918/performance-slice/wallkick-valid-choice/model-redesign/`):
`canonical-dynamics-and-timing.md` (297 l), `canonical-dynamics-and-timing-supplement.md` (632 l),
`forecast-law-excerpts.md` (225 l). A copy of the first two also sits in
`/Volumes/Data/bio/chase-model/chase-prediction-one-command-one-6b3a/model-redesign/`.
User's frame: fit a predictor to the LIVE fear law; one source-backed affect law + own-motor cost; no new
heuristic coefficients; no implementation.
Core facts delivered: (a) live fear kernel = `beliefUpdate.ts:311-341` `updateTier0Channel` +
`beliefs.ts:109-130` bayesianUpdate/decay, fear lambda = ln2/2.5; (b) rabbit fear observation law =
`rabbitBeliefs.ts:155-205` buildRabbitFearObservation: `mu = max(0, max(base.mu, pursuitSalience) +
riskFearGainPerSecond(1.1) * threatPressure * policyRiskExposure * dtSec - thumpFearRelief)`,
`threatPressure = clamp01(threatPresence.mu * (1 - escapeMargin))`; (c) horizon is NOT in semantics ctx — it is a
scorePolicy parameter (`POLICY_EVALUATION_HORIZON_SEC = 1.0`, `logic/cognition/timing.ts:2`) reaching species only
via `predictionTiming.evaluationHorizonSec`; (d) rabbit's candidate contact clock IS in semantics via speciesSignals,
the projected terminal pose is not; (e) fox endpoint carry precedent = `foxTargetAccessPrediction.ts:448-475`;
(f) reusable kernels: `projectBodyReservesAfterStep`, `bodyFatigue.ts` (advanceFatigue01/movementFatigueGainPerSecond),
`effectKernel.ts` fatigueRestRecovery, `readFoxPursuitBodyForecast` (fox only, no rabbit twin);
(g) `RabbitEscapeBoundSample` has realized per-step kinematics + phase + force/effort but NO per-step commanded
speed/dash/burst/body state.
CAUTION: a concurrent writer (e08237d0 wallkick/boundary) holds uncommitted edits; git status went 58 → 67 files
during my pass. My excerpts are working-tree at read time; re-verify line numbers before reuse.

## delta2 ownership correction — DELIVERED (window pcw:01a0b51a:42d4d9d0)
`applyBeliefObservation(current, observation, config, precisionGain = 1)` lives in `logic/beliefs.ts` (verbatim live body);
`updateTier0Channel` private closure deleted → calls it (order/additional-observation loop untouched);
`rabbitFearForecast.ts` calls the same helper, keeps optional `precisionGain = 1`.
LIVE FEAR GAIN = exactly 1 by construction: `buildTier0PrecisionGains` only emits channels in
`RABBIT_PRECISION_GAIN_TUNING.belief.channels` (targetConfidence/hunger/libido/integrity — no fear) → `?? 1`.
Verified: 8/8 tests; tsc app+cli 0 lines; root tsc = 147-line baseline unchanged; `git apply --check` clean on live main;
pristine `b6ee6d12` worktree + extraction patch + replacement patch → 8/8 and same tsc baseline.
REPLACEMENT `model-redesign/fear-forecast-new-file.patch` = 298 l, 4 paths (beliefs.ts 24+, forecast 116+ NEW,
beliefUpdate.ts 16+- , test 95+); `fear-forecast-receipt.md` rewritten. No main writes. Patch --check passes on current main
because main's beliefs.ts/beliefUpdate.ts/test hashes still equal the worktree base
(32d38c31…/0809a0d3…/df2ebafc…).

## ORIGINAL delta2 order (for the record)
User order: extract the private `applyTier0Observation` (the generic observation→Gaussian step) into the existing pure owner
`src/logic/beliefs.ts`; live `updateTier0Channel` AND the new forecast helper must both call it; keep precisionGain
parameter semantics; no order/additional-observation-loop change; report the ACTUAL live fear precisionGain; trim long
comments to enduring law + modeling limits; preserve the existing 6 forecast tests; deliver a REPLACEMENT
`model-redesign/fear-forecast-new-file.patch` that supersedes the first and includes the generic-helper + live-caller
hunks. No main writes.

### SOURCE FACTS ESTABLISHED THIS WINDOW
- **Live fear precisionGain is exactly 1.** `buildTier0PrecisionGains` (`systems/brain/cognition/beliefUpdate.ts:91-107`)
only iterates `context.precisionGainTuning.belief.channels`; rabbit's `RABBIT_PRECISION_GAIN_TUNING`
(`src/species/rabbit/policyPrecisionTuning.ts:14-60`) lists ONLY channels `targetConfidence, hunger, libido, integrity`
— **no `fear` channel**. Caller uses `precisionGains[channel] ?? 1`. So no new forecast input gain is needed;
default 1 matches the live default. (Rabbit tuning clampMin 0.65 / clampMax 1.5 applies only to those 4 channels.)
- **main vs worktree**: `logic/beliefs.ts` (32d38c318e36), `beliefUpdate.ts` (0809a0d3d655) and
`species/rabbit/stages/rabbitBeliefs.ts` (67febda893ff) are byte-identical in main and in my worktree → delta2 hunks
apply cleanly to main. main ALREADY has the extraction integrated (rabbitBeliefs calls `resolveRabbitFearObservation`),
but its `rabbitFearObservation.ts` is `13ef80340fc2` vs my worktree `5395b1c69d53` (lead's own port; do not
reconcile). `rabbitFearForecast.ts` exists ONLY in my worktree.

### WORKTREE / ARTIFACTS
- Worktree: `/Users/astrosheep/Developer/bio/.keiyaku/wt/fear-law` (detached @ b6ee6d12…, `node_modules` symlinked).
  Files: `src/species/rabbit/rabbitFearObservation.ts` (extraction, 73 l),
  `src/species/rabbit/rabbitFearForecast.ts` (125 l, `forecastRabbitFear`),
  `src/test/fear-dynamics-authority.test.ts` (+95 = import + one describe, 6 new tests, total 8 passing),
  `src/species/rabbit/stages/rabbitBeliefs.ts` (extraction callsite :154-177, caller :222).
- Artifacts (all in `/Volumes/Data/bio/chase-northstar-20260918/performance-slice/wallkick-valid-choice/model-redesign/`):
  `fear-law-extraction.patch` (145 l), `fear-law-extraction-receipt.md`, `fear-forecast-new-file.patch` (241 l, TO BE
  REPLACED), `fear-forecast-receipt.md`. Plus read-only packets: `canonical-dynamics-and-timing.md`+supplement,
  `forecast-law-excerpts.md`, `one-forecast-inputs.md`, `body-bill-inputs.md`+supplement,
  `forecast-integration-points.md`, `world-projection-hazard-inputs.md`; acceptance plan in
  `../variants/acceptance-command-plan.md` (120 l).
- Verified: `npx vitest run src/test/fear-dynamics-authority.test.ts` = 8/8; tsc output 147 lines (unchanged
  baseline; the one test-file line is a PRE-EXISTING `movementExecution` fixture error at :127). Patch composability
  proven on a throwaway worktree (extraction then forecast applied clean, 8/8) — that worktree was removed.

### delta2 steps — ALL DONE
1. (done) Add to `logic/beliefs.ts`: `applyBeliefObservation(current, observation, config, precisionGain = 1)` carrying the
   EXACT live body: `evidencePresent === false` → current; else `precisionOverride`(finite → `clampBeliefPrecision(override * precisionGain)`) or `mapSensorySignalToPrecision(signal, config) * precisionGain` → `bayesianUpdate(current, createBelief(mu, pi))`.
2. `beliefUpdate.ts` `updateTier0Channel`: replace the private closure body with a call to it (same config/precisionGain,
   same additionalObservations loop and order).
3. `rabbitFearForecast.ts`: call it with `BELIEF_CHANNEL_CONFIG.fear, 1`; drop the private copy; trim comments.
4. Rerun the 8 tests + tsc; regenerate `fear-forecast-new-file.patch` covering beliefs.ts + beliefUpdate.ts +
   rabbitFearForecast.ts + the test file (NOT the extraction files), update `fear-forecast-receipt.md` with the new hunk
   list and the gain evidence. Then report: signature, gain evidence, patch path.

### Recorded debts / open threads
- Acceptance round NOT started: `variants/acceptance-command-plan.md` awaits the lead's source-ready instruction
  (c3/c1/c6 × seeds 1,7, 8 s, domains `cognition,body,action,interaction`; interaction is the contact/grapple/death
  authority; identical seeds are NOT a failure — report distinct counts; old c3 first divergence = tick 7).
- e082 owns trajectory/control-sample construction + forecast integration; lead owns main integration.

## fear-law extraction DELIVERED (worktree .keiyaku/wt/fear-law @ b6ee6d12, clean snapshot)
- New: `src/species/rabbit/rabbitFearObservation.ts` (73 l) — pure `resolveRabbitFearObservation(input)`,
  exact numeric law only, imports `RABBIT_PRECISION_RISK` + `RABBIT_THUMP_SEMANTICS` (single authoring owners),
  no context/species/ECS types, no new constants/clamps.
- Stage `src/species/rabbit/stages/rabbitBeliefs.ts` `buildRabbitFearObservation` (:154-177) still reads ctx/species,
  applies the exposure gate, builds the acute observation, then calls the helper (:167). Caller unchanged (:222).
- `npx vitest run src/test/fear-dynamics-authority.test.ts` → 2/2 pass. tsc: 0 lines matching my files (147-line baseline).
- Artifacts: `model-redesign/fear-law-extraction.patch` (145 l), `model-redesign/fear-law-extraction-receipt.md`.
  Main repo (75 dirty files) NOT touched by me; forecast wiring is e082 + lead.

## DELIVERED (task CLOSED, window pcw:01a0b51a:42d4d9d0)
- `.../variants/model-source-inventory.md` (341 lines) — bounded inventory answering both the
  `model-source-inventory` request (60d65c07) and the follow-up fact check (a539a3b9).
- `.../variants/model-source-inventory-supplement.md` (254 lines) — longer verbatim bodies.
- Read-only: no repo edits, no `diag:build`. Revision for both files = repo HEAD
  `b6ee6d12ca6ef3724d790c14842f7605929a540c`.
- User supplied design judgment (separate uncertain reach from sampled-path terminal; one upstream timing
  reused by predictors/precision/finalize/telemetry; remove policy-label automatic flee relief + duplicate
  fear authority; keep time-dependent body cost + belief-derived affect; terminal contact = encounter
  transition not death; retire legacy empty rows with consumers). NOT implemented, per instruction.

## CORRECTIONS to facts recorded earlier in this note (verified this window)
- Rabbit threat lane: `resolveRabbitEscapeThreatVector` (rabbitSignals.ts:107-164) does NOT set
  `attackContactRangeM`; it sets the DIFFERENT field `evaluatorContactRangeM` (:147-151). So
  `resolveRabbitThreatAttackContactRangeM` always falls back to `DEFAULT_ATTACK_CONTACT_RANGE_M = 0.625`
  for the envelope. `evaluatorContactRangeM` is consumed only by `rabbitInterceptConeEvaluation.ts:53`
  (intercept cone, 0.375 from observed fox body). Shared `ThreatKinematics` DOES get an
  `attackContactRangeM` writer at `src/logic/cognition/signals.ts:57-63` (other lane) — my earlier note
  wrongly said no writer existed.
- `wallKick` `actionEffectDurationSec` is a VARIABLE remaining-command duration
  (`rabbitPolicySpecs.ts:1280-1292`), NOT `Math.max(dtSec, 0.35)`; the 0.35 constant at `:1218` is the
  Struggle/grapple spec.
- Flee `E` source: `rabbitPolicySpecs.ts:1161-1167` (`Math.max(dtSec, projectedMovement.actionEffectDurationSec ?? 1)`)
  with `resolveRabbitFleeProjectedMovementCommand` `:375-396` = `max(EPSILON, contactWindowSec + airDurationSec)`.
- Evaluator file for the shared order is `src/systems/brain/cognition/evaluator.ts` (:234/:258/:284/:291/:295/:298/:305),
  not `src/logic/cognition/evaluator.ts` (does not exist).
- `freshFleeDirectionGRows`: only non-test writer assigns `[]` (rabbitSignals.ts:598); its reader at :741 only
  feeds a diagnostics `candidateRank` (always null), and rabbitSemanticTelemetry.ts:457 feeds telemetry.

## Next steps
None. Report delivered (short Chinese) with revision + both paths. Wait for the next user request.
