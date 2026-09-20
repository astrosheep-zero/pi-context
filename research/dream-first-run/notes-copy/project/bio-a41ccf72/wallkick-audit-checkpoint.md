---
scope: project
origin: self
status: active
stale: false
created_at: 2026-09-18T21:58:16.125+08:00
updated_at: 2026-09-18T23:18:46.962+08:00
last_accessed: 2026-09-19T00:43:27.405+08:00
access_count: 3
---

# wallkick audit — checkpoint (read-only auditor; window pcw:01a0b421:17d6c4d3 ending)

Repo `/Users/astrosheep/Developer/bio`. My artifacts: `/Volumes/Data/bio/chase-northstar-20260918/performance-slice/wallkick-valid-choice/variants/*.md`. Writer suite/captures: `.../geometry-suite/`. Read-only, no repo edits, no commits. Do NOT wake `162c`,`30e85c03`,`fc38da04`,`0455ff64`. Sole writer: `aku/intern/bd188d90 @wallkick-finish` — `keiyaku tell aku/intern/bd188d90 'text'` (SINGLE QUOTES; backticks get shell-mangled). Report to user in Chinese.

## OPEN USER REQUEST (newest, item in window 17d6c4d3) — c3 counter-run bill diagnostic
User confirmed: c4 real positive toward-fox component; c3 `counter-run` is NOT a feint. Now wants a **bounded c3 root diagnostic on the CURRENT PUBLISHED source (bfb5c2cf)**: decisions at **0.617 / 0.717 / 0.817 / 0.917**, inspect exact candidate variants + G / fear / integrity / escapeMargin / terminal geometry vs the **actual accepted command** (hop origin). Find the EARLIEST selection that makes the approach; check whether `counter-run` is just a label while the body carries another plan. Compare desired/billed direction/speed to the actual lunge timing and the body's low velocity. Ask: does prediction bill counter-run's improvement via a wrong locomotion heading / overshoot / gate, or via a legitimate local belief? **Record evidence, do not diagnose by name.** Separate lane from bd188's wall fix, no edits. Artifact to write: `variants/c3-counter-run-bill.md`. First get variant origin + same-state forecast terminal / + predator-contact consistency, then the lead decides.

### DONE so far for that request
- **Identity from policy ownership (source fact, not speed — user's method correction)**: `--list-subjects` has an EMPTY species column, so use policies: `c3` Entity:1 = rabbit (all `flee`), Entity:2 = fox (`hunt`, variant `pounce_commit`). Entity:1 rows end at 4.483 s, Entity:2 at 8 s.
- **Rabbit c3 selections (pre-grapple, queried via `npm run diag:query` on `geometry-suite/c3.diagtrace`, fields `selectedPolicy`,`selectedOptionVariantId`)**: 0.617 `flee/cross-break:right:0`; 0.717 `flee/counter-run:center:2`; 0.817 `flee/counter-run:center:2`; 0.917 `flee/counter-run:center:1`. Grapple at 0.967 s (`interaction.grapple_contest` 0.967–4.467, `*-grapple.csv`).
- c3 rabbit facts already measured (from `queries/c3-kine.csv`): 0.750 (0.96 m, own toward +0.10) → 0.833 (+0.78 peak, dist 0.81) → 0.917 (fox lunge, own closing 1.07→5.40 m/s, dist 0.58) → 0.950 (dist 0.39) → grapple. Rabbit own velocity ≈ (+0.42,+1.20) m/s (1.3 m/s diagonal up-along-wall + 0.42 inward); 79% of closure is the fox (descriptive approx, NOT causal attribution — user correction).

### STILL TO DO (run these next)
1. Fields discovery then query at 0.617/0.717/0.817/0.917: `cognition.policy_evaluation` (per-candidate variant id + G, 1408 rows), `cognition.policy_prior_contribution`, `cognition.g_step_risk` / `g_step_ambiguity` / `g_step_epistemic`, `cognition.current_state` (fear), `cognition.belief_state`, `cognition.candidate_screening` (2512 rows), `cognition.rabbit_escape_route_candidate` (1113 rows), `cognition.fear_authority`, `cognition.scoring_weights`, `cognition.policy_prediction_step`, `cognition.policy_prediction_channel`.
2. Actual command: `body.movement_intent` (requestedSpeedMps/targetSpeedMps/targetVelocityX/Y) + `action.execution` + `action.hop_bout_command` at 0.6–0.98 → is the accepted hop command really the counter-run direction/speed, or a different plan/label?
3. G-bill: `npm run diag:report -- g-breakdown <trace> --subject Entity:1 --format pretty` (report is derived-only; no rebuild).
4. Write `variants/c3-counter-run-bill.md`: variant origin (which candidate produced counter-run:center), forecast terminal geometry, predator-contact consistency, billed vs actual direction/speed, lunge timing (fox closing jump at 0.917), and the honest verdict on "wrong heading/overshoot/gate vs legitimate local belief".
5. Method corrections to apply in that artifact: (a) identity via explicit source (list-subjects species is blank → policy ownership) not 6.21 m/s; (b) **c4's 7.933–8.000 s "toward fox" episode must NOT be labelled post-capture** — no grapple recorded ≠ alive; exclude it from any pre-entry narrative until a death fact is checked (my `toward-fox-review.md` labelled it "post-capture jitter" → CORRECT that file); (c) closing-percentage shares are descriptive approximations, not causal attribution.

## DELIVERED 23:16: toward-fox review (user question 为什么兔子往狐狸方向跳)
`variants/toward-fox-review.md` + `variants/toward-fox-c4-annotation.png` (SVG→`sips -s format png`; no PIL/ImageMagick, ffmpeg has drawbox but NOT drawtext). Method: u=unit(rabbit→fox), rabbitToward=v_r·u, foxToward=-(v_f·u), episodes = contiguous rabbitToward>0.1 m/s ≥3 ticks, pre-first-grapple, from published `geometry-suite/queries/*-kine.csv`.
- c4 kick: latched normal (-1,0), fox parked at rabbit+normal·3.0 m (outward side by fixture) ⇒ outward rebound (cone edge n·0.5±t·√0.75, 60° off normal) ⇒ rabbitToward +4.13 m/s = 64% of the 6.5 m/s kick; fox own closing +5.90; dist 2.62→1.43 in 0.15 s. Reflect variant ≈ straight at the fox. Geometry, not a direction-law bug.
- Episodes: c1 0.133–0.483 (+0.64/+4.26, 13% rabbit share); c2 0.100–0.350 (+0.95/+4.25); c3 0.117–0.483 (+0.79/+2.93) and 0.750–0.950 (+0.57/+2.15); c4 0.233–0.383 (+2.80/+5.12); c5 0.317–0.450 and 0.500–0.617; c6/open_a/open_b none. NOT supported: feint/crossing.

## OTHER OPEN FINDINGS sent to bd188 (separate lane)
- **Windup WallKick does NOT drive the hop motor** — `variants/windup-ownership-source-check.md`: registry gives WallKick only `ownsTimedLocomotion` (`actionRuntimeLifecycleRegistry.ts:291-293`, predicates `:396-400`), Windup sets `interruptible=TRUE` (`WallKickSystem.ts:61-67`) ⇒ `actionCurrentlyOwnsTimedLocomotion` false ⇒ `LocomotionSystem.ts:1756-1785` takes the `clearHopLocomotionAtom` (:364-372) + passive-decay else branch ⇒ the plan's accepted Move command is INERT; the projection's approach walk (`rabbitEscapeManeuverProjection.ts:326-339`) bills propulsion execution never applies. c4 fingerprint: ticks 2–6 damp/s 2.77 (hop idleDrag), ticks 7–12 damp/s 1.80 (passive), speed 6.21→4.11→0, no propulsion.
- **Quantizer one step short** (`variants/c4-count-semantics-and-callback-boundary-review.md`): executed flight = 18 full physics steps (y 43.88→45.57 m = 1.689 = 18 × 0.0938); `rabbitEscapeManeuverProjection.ts:801-804` bills `ceil(0.28/dt)=17` ⇒ 0.108 m under-bill; fix `1 + ceil(requested/dt)`.
- **c4 counts**: exec 25 rows = 7 Windup + 18 Active; `contacted=true` on all 18 only because the latch persists — contact EVENT = tick 14 alone ⇒ 1 episode; proj 9 rows = cadence samples at ticks 1/7/13/19/25/31.
- **Callback boundary**: `terrainFrictionAt` correctly injected (`cognitionContext.ts:592-595`, `logic/context.ts:444`, `rabbitEscapeAffordanceTypes.ts:214`, `rabbitSignals.ts:343`); STILL AMBIENT: `stepOrdinaryBody` imported (`rabbitEscapeManeuverProjection.ts:39`, call :820) reads `WorldGrid` for terrain damping (`ordinaryBodyStep.ts:19-32`) + blocking resolve (`blockingMotion.ts:54,63,64,74,76,79,123,148,271`) ⇒ two friction owners.
- **Envelope contract** (`variants/delta-review-envelope-and-world-boundary.md`): `projectedDisplacement` = INTERVAL delta (`buildEnvelopeSamples` accumulates `rabbitEscapeProjection.ts:127-142`; envelope reads end position `rabbitPredatorEnvelope.ts:346-364`,`:589`). Pre-22:25 cumulative mapping double-counted (16.1 vs 1.79 m, risk under-billed), fixed 22:25:46.
- c4 open fact: `contactDistanceM 0.1347` is 0.053 m inside the collision radius 0.1875 while the centre sits 0.187 m from the face.
- **RETRACTED by me** (they were stale): `geometry-suite-c4-verification.md` §7 and `kernel-parity-check.md` §D ("no Locomotion+Physics / no fresh-contact parity test") — the writer's 22:54 tests DO run `clearAccumulators → locomotion → wallKick → physics` tick-for-tick (`bills the executed carried rebound flight tick for tick (hopAirborne=…)`, k=1..6, Δ≤1e-6; `bills the executed impulse tick and carried rebound from one pre-contact state (hopAirborne=…)`, tick 1 = contact tick, k=1..12, 1e-4 incl. heading) + the interval-envelope regression; see `variants/actuator-parity-test.md`. Remaining hole: both cases use incomingSpeedMps=3.5 (non-zero) so the stationary-contact case (c4's real contact tick, speed 0) is untested.
- Status: production `tsc` clean; ~147 errors all in `src/test/` (stale fixtures).

## TOOL NOTES
- `diag:query` field names are LEAF paths; `--list-subjects` species column blank for these traces; `--since/--until` in seconds; `cognition.policy_selection` carries `selectedOptionVariantId`,`lowestGOptionVariantId`; body rows use METRES for posX/posY and m/s for velocity; kine rounded to 2 dp ⇒ use per-tick ratios / the y channel for step counts.
- Tree moves fast: re-pin `git diff HEAD | md5sum` + mtimes before asserting anything current. Published capture revision = `bfb5c2cf444f889acbbe59c58c0f1ee5`.
- Image tooling: no PIL/ImageMagick; SVG → `sips -s format png in.svg --out out.png` works; ffmpeg lacks drawtext.
