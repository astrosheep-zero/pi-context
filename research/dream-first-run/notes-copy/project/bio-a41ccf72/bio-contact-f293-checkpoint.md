---
scope: project
origin: self
status: active
stale: false
created_at: 2026-09-19T01:08:28.313+08:00
updated_at: 2026-09-19T01:24:33.615+08:00
last_accessed: 2026-09-19T01:28:26.178+08:00
access_count: 4
---

# bio forecast slice — checkpoint @ window pcw:01a0b519:8a88642f → next (2026-09-19 01:26)

Repo `/Users/astrosheep/Developer/bio`. Lead = user (report in Chinese). I am sole main writer, NO commits.
Tree GREEN: `npx tsc -p tsconfig.app.json --noEmit` = 0. Objective: implement the ACTUAL single
trajectory/body/fear forecast (not bookkeeping). All helper patches are already integrated.

## Durable design store (read FIRST)
`/Volumes/Data/bio/chase-northstar-20260918/performance-slice/wallkick-valid-choice/model-redesign/next-slice-handoff-staged.md`
— verbatim lead locks: single-forecast preamble, fear design lock, fear integration detail, forecast ownership,
forecast entry coverage (WallKick is a DIRECT semantics, not one of the 10 wrappers), body finalization P0
(no double starvation), fear precision ownership (forecast pi authoritative; no re-decay/re-gain), parallel
helper division, WallKick bodyLoad visibility (real kick charge = 0.38 bodyLoad impulse), outcome ownership for
body-authoritative paths, test discipline, and the 817 F2 adjudication + how it was applied.
Also `model-redesign/DECISIONS.md` "Slice 2"; `model-redesign/forecast/STATUS.md`.

## Landed in main (my work, all green)
1. `OwnBodyReserves` (narrow absolute) in `src/logic/context.ts`; captured in `src/systems/brain/cognitionContext.ts`
   via `resolveOwnBodyReserves` → null WHOLE snapshot only when a quantity is non-finite or a capacity
   (maxEnergy/maxHealth) is non-positive. **Zeros are VALID and preserved** (energy=0/health=0/satietyReserve=0
   are starvation/death, not unavailability). Carried on `BrainFacts` + `OptionSemanticsInput` (optional, null=unavailable).
2. ONE interval owner `src/logic/prediction/intervals.ts::resolvePredictionIntervals(timing)` — same validation/throws
   and same min/max math as the old inline code; `buildPredictionSignals` consumes it.
3. `src/logic/candidateForecast.ts::CandidateForecastTiming` = `PredictionIntervals` + `dtSec` + `noDriveRemainder`,
   built ONCE per candidate in `computePolicySemantics`; NO event field (single event producer stays
   `ResolvedPolicySemantics.predictionEndTimeSec`, which must come from the requested trajectory).
4. D1 fixed: `rabbitPolicySemantics` wrapper forwards args 5–6; `getRabbitPolicySemantics(policy, ctx, state,
   postBeliefs, _speciesSignals?, timing?)` consumes `timing`; the DIRECT WallKick `computePolicySemantics`
   declares+consumes `timing` too.
5. Integrated delta patches: `fear-forecast-new-file.patch` (pure `applyBeliefObservation` in `logic/beliefs.ts`,
   live `beliefUpdate.ts` consumes it, NEW `src/species/rabbit/rabbitFearForecast.ts`:
   `forecastRabbitFear(input, precisionGain = 1)` with
   `RabbitFearForecastSample = { dtSec, escapeMargin01, thumpCompletionSignal? }` at cognition dt, event-bounded;
   empty samples = world already ended; returns the final fear Gaussian whose mu AND pi are authoritative) and
   `timing-fox-wrapper-tests.patch` (15/15 fox wrapper tests).
6. Test discipline applied: `src/test/candidate-forecast-timing.test.ts` DELETED (mirrored the shared resolver).
   Real acceptance cases must EXTEND `src/test/rabbit-own-escape-margin.test.ts` (already drives the spec's
   `computePolicySemantics` with `TEST_REQUEST_TIMING`) and must fail on: dead timing forwarding, wrong own
   command binding, event-0 residual fear/body charge, wrong endpoint/bodyLoad. No mirror tests for type edits.

## RETRACTED
`src/species/rabbit/rabbitCandidateEvent.ts` DELETED — it took the event from the proposal cache
(`fleeVariantProjections`, built at the 0.8 s envelope horizon), which 817 F2 forbids. The
`forecast/c3-2s-forecast.diagtrace` "Flee 30/484, WallKick 2/8 events" claim is NOT forecast evidence; do not cite.
No event producer exists today (honest absence). The interval-envelope part of that trace remains valid.

## KEY SOURCE FINDING for the next step (just learned)
The existing exact integrator output for one candidate hop is already per-step:
- `RabbitFleeMotionBinding` (`rabbitEscapeAffordanceTypes.ts:46-53`) = `{ rawDesiredSpeedMps, desiredDirection,
  supportTargetSpeedMps, survivalBurst01, nextStanceStart, hop: RabbitHopEffortResolution }`.
- `SharedContactProjectionResult` (`logic/locomotion/sharedContactProjection.ts:66-92`) carries
  `samples: SharedContactProjectionSample[]` + `flightSamples: SharedContactProjectionFlightSample[]` plus
  `airDurationSec`, `landingVelocityMps`, `momentumOut`, `takeoffMassKg`, `speedLoss01`, force saturations.
So the candidate's own requested trajectory can be assembled from `affordance.fleeMotion.hop.projection` samples
(already the exact execution-shared law) + the explicit no-drive remainder past `effectHorizonSec` — no second
integrator, no endpoint interpolation.

## Angular fan cost (source-derived, NOT a benchmark)
Naive fan-per-cognition-step = 27 candidates × 60 cognition steps (T=1 s ÷ 1/60) × ≤4 fan directions
(`buildRabbitHopDirectionsForRoute` returns preferred-execution / preferred-route / outside-turn / inside-turn,
deduped) = **6,480** `resolveRabbitHopEffortForDirection` projections per decision; endpoint-only = 27 × 4 = 108.
Any sampling simplification needs a LEAD DECISION; never hidden endpoint interpolation.

## Next steps (in order)
1. Build the per-candidate requested-trajectory sample path (event-clipped, cognition-dt, explicit no-drive
   remainder) from `fleeMotion.hop.projection` samples + WallKick carried samples; expose it as the single
   forecast carrier (extend `candidateForecast`), NOT a proposal-cache substitution.
2. Resolve the contact event FROM THAT path and publish it as the single `predictionEndTimeSec` producer at the
   single assembly point (document the decision-relative clock origin).
3. Fear: feed `forecastRabbitFear` with the per-step `escapeMargin01` (source still to be decided with the lead
   given the fan cost) — do NOT write a competing fear loop.
4. Body: `projectBodyReservesAfterStep` + `movementFatigueGainPerSecond`/`advanceFatigue01`/`fatigueRestRecovery`
   per step with the exact command schedule; carry WallKick projected bodyLoad to endpoint/control-fan facts;
   no double starvation in `finalizePrediction`; delete the WallKick pre-contact `mitigatedApproachRiskLoad`
   integrity bill (same encounter must not be billed twice alongside `predatorIntercept`); keep Struggle/injury
   and Eat intake as distinct command-owned effects; surface missing interaction forecast rather than fabricate.
5. Delete the production `projectTerminal` repeated integration + duplicate route fear/fatigue authorities;
   expose minimal forecast provenance on the existing policy-evaluation rows (no new telemetry mirror).

## Verification state / environment
- Green focused logs in `model-redesign/contact/`: `post-integration-focused.log` (25 files, 250 passed + 1
  pre-existing failure `rabbit-threat-perception`), `post-legacy-focused.log`, `post-f123-focused.log`;
  `fear-dynamics-authority` 8, `fox-hunt-variant-offer` 15.
- Pre-existing failures: `rabbit-threat-perception` (expected 6 got 0.6), `rabbit-fear-delete-regression` (full suite only).
- `npm run diag:build` must be run explicitly before any capture; queries always `--out <path> --limit 0`;
  matplotlib only in `/Volumes/Data/bio/tools/chase-trajectory-venv/bin/python`; big artifacts under `/Volumes/Data/bio/`.
- Contact slice receipt `model-redesign/contact/RECEIPT.md` (817 confirmed F1–F3; may close after review).
