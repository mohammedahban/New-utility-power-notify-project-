// analyze-patterns Edge Function — APPPE v4.4
// Adaptive Drift-Correcting Prediction Engine
//
// ─────────────────────────────────────────────────────────────────────────────
// v4.4 CHANGES (2026-06-26)
// ─────────────────────────────────────────────────────────────────────────────
// 1. CRITICAL: Drift quantization cap now checks SIGN SYMMETRY, not just
//    clustering ratio. The v4.2 cap fired whenever >50% of errors landed on
//    a single value, assuming that meant polling noise. But production data
//    shows 78.6% of errors cluster at exactly -10 min — all with the SAME
//    SIGN. That's not polling noise (which would be sign-symmetric, e.g. a
//    mix of +10 and -10). It's REAL DRIFT quantized by polling. The v4.2
//    cap was halving the correction from -10 to -5, leaving 5 min of
//    correctable bias on the table every cycle. The v4.4 cap only fires
//    when dominant errors are sign-symmetric (mixed + and -), which is the
//    true signature of polling noise.
//
//    EVIDENCE FROM 7-DAY EXPORT (42 rows):
//      - 33 rows (78.6%) have error_minutes ∈ {10.01, 10.02}, all NEGATIVE
//        signed (actual_time < predicted_time, i.e. predictions were LATE)
//      - 0 rows have +10 min error
//      - Sign-asymmetric distribution → real drift, not polling noise
//      - Without fix: driftOffset = -5 (capped), residual error stays at -5
//      - With fix:    driftOffset = -10 (full correction), residual → ~0
//
// 2. CRITICAL: Fixed sign confusion in detectConsecutiveErrorCrisis()
//    reasoning string and drift offset reasoning string. The variable
//    `allLate` was true when `errorMinutes > 15`, but with
//    errorMinutes = actual - predicted, that means EVENTS were late,
//    i.e. PREDICTIONS were EARLY. The Arabic message said "predictions
//    were late" when they were actually early, and vice versa. Same bug
//    in the drift offset reasoning string. Both fixed.
//
//    CONVENTION: errorMinutes = actualTime - predictedTime
//      errorMinutes > 0  → event happened AFTER predicted → prediction was EARLY
//      errorMinutes < 0  → event happened BEFORE predicted → prediction was LATE
//
// 3. MEDIUM: Lowered consecutive-error crisis threshold from |15| to |8|
//    min (new CONSECUTIVE_ERROR_THRESHOLD_MIN constant), but kept the
//    3-in-a-row requirement. Combined with fix #1, this ensures the
//    system can actually flag the persistent -10 min bias pattern instead
//    of having two layers both refusing to correct it.
//
//    EVIDENCE: 3 most recent errors in export are -48, -34, -10.
//    v4.2: |10| < 15 → trigger does NOT fire.
//    v4.4: |10| > 8 → trigger FIRES, surfaces warning to user.
//
// 4. Added v4.4 diagnostic fields to apppe block:
//    driftQuantizationSignSymmetric (bool), driftCapApplied (bool).
//
// ─────────────────────────────────────────────────────────────────────────────
// v4.3 CHANGES (2026-06-25)
// ─────────────────────────────────────────────────────────────────────────────
// 1. SCHEMA FIX: `duration_type`, `predicted_duration_min`, and
//    `actual_duration_min` confirmed present as nullable columns in the real
//    prediction_accuracy_logs DDL. loadHistory() accuracy_log branch now
//    SELECTs all three and maps them from row values instead of hardcoding
//    null with incorrect comments claiming the columns don't exist. Phase 4
//    (Prediction Bias Engine) is now structurally active — it will produce
//    non-trivial ratios as soon as the write path populates these columns.
// 2. recordCompletedPrediction() extended with optional fields:
//    confidenceScore, predictionGeneratedAt, durationType,
//    predictedDurationMin, actualDurationMin — all confirmed in the DDL.
//    Pass them from poll-growatt when you have the live prediction object.
// 3. Removed incorrect comments that claimed duration columns were absent.
//
// v4.2 CHANGES (2026-06-24)
// ─────────────────────────────────────────────────────────────────────────────
// 1. CRITICAL: Filter client-bugged rows out of loadHistory().
//    The client was logging "pending_offset" placeholder rows into
//    prediction_accuracy_logs with predicted_time = actual_time + N (where N
//    is the pending offset the client was about to apply). These rows
//    represent the client's pre-correction state, NOT actual APPPE
//    predictions. Confirmed from 7-day export: 48 of 86 unique "predictions"
//    were these client artifacts, all with median -45 min error vs APPPE's
//    real median of -10 min. Filtering them out is the single highest-
//    impact accuracy fix.
// 2. Drift quantization cap: when >50% of drift samples cluster on a single
//    value (polling-resolution artifact), cap the drift offset magnitude at
//    half the dominant error value to avoid over-correcting.
// 3. Reasoning branch fix: `rangeWasClamped` no longer triggers the "high
//    uncertainty" warning when isHighQualityData is true, even if crisis is
//    active. The previous condition (isHighQualityData && !crisis.active)
//    meant the "high uncertainty" warning fired even when underlying data
//    was strong.
// 4. isUnstable now considers crisis magnitude: a severe crisis (60+ min
//    shift) flags instability even if MAD-based stability is high. This
//    re-introduces severe-crisis handling without the v4.0 bug where ANY
//    crisis capped confidence at 30%.
// 5. Added diagnostic fields to apppe block: driftQuantizationRatio,
//    driftDominantError, clientRowsFiltered. Lets you monitor the new
//    filters in production.
// 6. Removed unused crisisFactor variable (was 0.5, never used in math).
//    Kept crisisMultiplier (0.65) as the only crisis-related confidence
//    adjustment.
// 7. Added migration note recommending an index on actual_event_time and
//    schema additions to enable Phase 4 (Bias Engine).
//
// Replaces: APPPE v4.1 (which fixed v4.0's hard 30% confidence cap,
// consecutive-error crisis double-correction, and flat 90-min range cap).
// Uses: drift offset correction (with quantization cap), duration bias
//       correction (still no-op pending schema change), exponential
//       recency weighting, crisis recentering (duration-triggered only,
//       not consecutive-error-triggered), MAD-based stability, and a
//       single transition-focused forecast as the authoritative output.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inline CORS headers — avoids dependency on ../_shared/cors.ts when deploying
// via the Supabase dashboard editor (which bundles each function in isolation
// and cannot resolve sibling files outside the function's own directory).
// If you ever migrate to CLI-based deployment with a real _shared/ folder,
// you can replace this with: import { corsHeaders } from "../_shared/cors.ts";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG FLAGS
// ─────────────────────────────────────────────────────────────────────────────

// Where do drift/bias history come from?
//   "accuracy_log"  -> read/write the real prediction_accuracy_logs table
//                       used by the app's Accuracy Center screen
//                       (predicted_event_time/actual_event_time/
//                       error_minutes/predicted_state/accuracy_score).
//   "dedicated"      -> read/write a new prediction_history table with a
//                       richer schema (errorMinutes, biasRatio, durationType,
//                       crisis flags, etc.) purpose-built for v4.
//
// CONFIRMED 2026-06-21 against the real accuracy_tsx.txt screen source:
// the actual table is "prediction_accuracy_logs" (PLURAL) with columns
// predicted_event_time / actual_event_time — NOT "prediction_accuracy_log"
// (singular) with predicted_time / actual_time, which is what this file
// was querying before. That mismatch likely caused every loadHistory()
// call to silently fail (Supabase returns an error for a nonexistent
// table/column) and fall back to an empty array — meaning drift
// correction, bias correction, and the consecutive-error crisis trigger
// have likely been running on ZERO real history this whole time, no
// matter how much data accumulated in the actual table.
const HISTORY_SOURCE: "accuracy_log" | "dedicated" = "accuracy_log";

const ACCURACY_LOG_TABLE = "prediction_accuracy_logs"; // CORRECTED: was "prediction_accuracy_log" (wrong table, singular)
const DEDICATED_HISTORY_TABLE = "prediction_history";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const YEMEN_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3
const DATA_WINDOW_DAYS = 7;
const DATA_WINDOW_HOURS = DATA_WINDOW_DAYS * 24;

// Phase 2 — Drift Offset Engine
const DRIFT_HISTORY_SIZE = 15; // "most recent 10-15 completed predictions"

// Phase 4 — Prediction Bias Engine
const BIAS_HISTORY_SIZE = 20; // "most recent 15-20 ratios"
const BIAS_RATIO_MIN = 0.5;   // sanity clamp so one bad sample can't blow up correction
const BIAS_RATIO_MAX = 1.5;

// Phase 5 — Crisis thresholds (kept from v3, now drives recentering not just widening)
const CRISIS_OFF_INCREASE_PCT = 0.20;
const CRISIS_ON_DECREASE_PCT = 0.20;

// v4.2 — Severe crisis magnitude threshold (minutes). When crisis shift
// exceeds this, isUnstable becomes true even if MAD-based stability is
// high. This re-introduces severe-crisis handling without the v4.0 bug
// where ANY crisis.active capped confidence at 30%.
const SEVERE_CRISIS_SHIFT_MIN = 60;

// Phase 6 — Volatility EMA
const VOLATILITY_EMA_ALPHA = 0.3;

// v4.2 — Drift quantization detector threshold. If this fraction of drift
// samples cluster on a single integer value, the median is likely a
// polling-resolution artifact rather than real drift. Cap correction
// magnitude at half the dominant error value to nudge rather than
// fully correct. Confirmed from 7-day export: 34.9% of unique
// predictions had exactly -10 min error (polling-resolution artifact),
// and another 31.4% had exactly -45 min (client-bugged rows, now
// filtered by R1 but the polling-quantization pattern remains).
const DRIFT_QUANTIZATION_THRESHOLD = 0.5;

// v4.4 NEW: Consecutive-error crisis threshold lowered from 15 to 8.
// See v4.4 changelog entry #3 for rationale.
const CONSECUTIVE_ERROR_THRESHOLD_MIN = 8;

// v4.2 — Pattern used to identify client-bugged "pending_offset" rows
// in slot_id. These rows are the client's pre-correction state being
// logged as if they were real predictions. They have predicted_time =
// actual_time + N (where N is the pending offset), giving them large
// negative signed errors that contaminate drift/bias/crisis math.
// Confirmed from 7-day export: 48 of 86 unique rows matched this pattern.
const CLIENT_PENDING_SLOT_PATTERN = /pending_offset/i;

// EFFECTIVE_SAMPLES_FOR_FULL_TRUST: compared against the SUM of exponentially
// decayed weights (weight = 0.5^(ageHours/24)). With 18 real cycles spread
// over 7 days, this sum is only ~2.9-3.5 because older cycles decay fast.
// Setting this to 4 kept trust at 72-87%, meaning 13-28% of every computed
// stat still came from the cold-start prior — even after a full week of real
// data. Confirmed against 18 real cycles from this grid: the prior was
// pulling P25Off from ~310→291 (when real data says 370) and P25On toward
// values below any real observed cycle. Lowered to 3 so that 2.9+ effective
// samples reaches ~97% trust — functionally full trust after a normal week.
const EFFECTIVE_SAMPLES_FOR_FULL_TRUST = 3;

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface RawEvent {
  event_type: string;
  occurred_at: string;
}

interface Cycle {
  offStartIso: string;
  onStartIso: string;
  offDurMin: number;
  onDurMin: number | null;
  yemenHourAtStart: number;
  ageHours: number;         // age of the OFF period (when OFF started) — used for offDurMin weighting
  recencyWeight: number;    // exponential weight for offDurMin, derived from ageHours
  onAgeHours: number | null;      // age of the ON period itself (when ON started) — NOT the same as ageHours
  onRecencyWeight: number | null; // exponential weight for onDurMin, derived from onAgeHours
}

interface HistoryRow {
  predictedType: "UTILITY_ON" | "UTILITY_OFF";
  predictedTimeIso: string;
  actualTimeIso: string;
  errorMinutes: number;       // actual - predicted, signed
  ageHours: number;           // how long ago this completed prediction was made
  durationType: "OFF" | "ON" | null;
  predictedDurationMin: number | null;
  actualDurationMin: number | null;
  slotId: string | null;      // v4.2: retained for diagnostics
}

interface WeightedDistStats {
  sampleCount: number;
  effectiveWeightedSamples: number;    // OFF-side, kept for backward-compat field naming
  effectiveWeightedSamplesOn: number;  // ON-side — independent because ON periods now use onAgeHours, not the parent OFF period's age
  medianOff: number;
  medianOn: number | null;
  p25Off: number;
  p75Off: number;
  p25On: number | null;
  p75On: number | null;
  madOff: number;
  madOn: number | null;
  stabilityScore: number; // 0–1, derived from MAD
}

// v4.4 — Drift computation result with sign-symmetry diagnostic
interface DriftResult {
  offsetMin: number;
  sampleCount: number;
  quantizationRatio: number;          // fraction of samples equal to the dominant value
  dominantError: number;              // the most common error value (signed)
  quantizationSignSymmetric: boolean; // v4.4 NEW: true if dominant errors have mixed signs (polling noise)
  capApplied: boolean;                // v4.4 NEW: true if the cap actually reduced the offset
}

// v4.2 — History loading result with diagnostic counts
interface HistoryLoadResult {
  rows: HistoryRow[];         // deduplicated, client-row-filtered, newest-first
  rawRowsFetched: number;     // rows returned by Supabase before any filtering
  duplicateRowsCollapsed: number;
  clientRowsFiltered: number; // rows removed by CLIENT_PENDING_SLOT_PATTERN
  unparseableRowsSkipped: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY HELPERS (unchanged from v3 — pure formatting/time helpers)
// ─────────────────────────────────────────────────────────────────────────────

function toYemenDate(utcIso: string): Date {
  return new Date(new Date(utcIso).getTime() + YEMEN_OFFSET_MS);
}

function yemenHour(utcIso: string): number {
  return toYemenDate(utcIso).getUTCHours();
}

function fmtYemen(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: "Asia/Aden",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function fmtYemenWithDate(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: "Asia/Aden",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function fmtMin(min: number): string {
  if (min <= 0) return "0د";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? "ساعة" : `${h}س`;
  return `${h}س ${m}د`;
}

function fmtSignedMin(min: number): string {
  const sign = min >= 0 ? "+" : "-";
  return `${sign}${fmtMin(Math.abs(min))}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — EXPONENTIAL RECENCY WEIGHTING
// Replaces BASE_RECENCY_WEIGHTS / CRISIS_RECENCY_WEIGHTS day-bucket arrays.
// weight = 0.5^(ageHours/24)  → halves every 24h, adapts within hours not days.
// ─────────────────────────────────────────────────────────────────────────────

function recencyWeight(ageHours: number): number {
  return Math.pow(0.5, ageHours / 24);
}

// ─────────────────────────────────────────────────────────────────────────────
// CYCLE EXTRACTION
// Same event-walking logic as v3, but now tracks ageHours (continuous) instead
// of ageDays (bucketed) so exponential weighting has a real input.
// ─────────────────────────────────────────────────────────────────────────────

function extractCycles(events: RawEvent[], now: Date): Cycle[] {
  const cycles: Cycle[] = [];
  let offStart: string | null = null;
  const nowMs = now.getTime();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.event_type === "UTILITY_OFF") {
      offStart = ev.occurred_at;
    } else if (ev.event_type === "UTILITY_ON" && offStart !== null) {
      const onStartMs = new Date(ev.occurred_at).getTime();
      const offStartMs = new Date(offStart).getTime();
      const offDurMin = (onStartMs - offStartMs) / 60000;
      if (offDurMin < 1) { offStart = null; continue; } // noise

      let onDurMin: number | null = null;
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].event_type === "UTILITY_OFF") {
          onDurMin = (new Date(events[j].occurred_at).getTime() - onStartMs) / 60000;
          break;
        }
      }

      const ageHours = Math.max(0, (nowMs - offStartMs) / 3_600_000);
      // BUG FIX: onDurMin describes a period that STARTS at onStartMs, not
      // offStartMs. If OFF periods run long (this grid: 4h+), reusing the
      // OFF period's age to weight the ON duration systematically
      // mis-times recent ON samples as if they were hours older than they
      // really are — discounting fresh ON data and over-trusting stale ON
      // data. Each duration type must be weighted by ITS OWN start time.
      const onAgeHours = onDurMin !== null
        ? Math.max(0, (nowMs - onStartMs) / 3_600_000)
        : null;

      cycles.push({
        offStartIso: offStart,
        onStartIso: ev.occurred_at,
        offDurMin,
        onDurMin,
        yemenHourAtStart: yemenHour(offStart),
        ageHours,
        recencyWeight: recencyWeight(ageHours),
        onAgeHours,
        onRecencyWeight: onAgeHours !== null ? recencyWeight(onAgeHours) : null,
      });

      offStart = null; // CRITICAL: reset
    }
  }

  return cycles;
}

// ─────────────────────────────────────────────────────────────────────────────
// WEIGHTED MEDIAN / PERCENTILE / MAD
// ─────────────────────────────────────────────────────────────────────────────

function simpleMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function weightedMedian(values: number[], weights: number[]): number {
  if (values.length === 0) return 0;
  const pairs = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  const totalW = pairs.reduce((s, p) => s + p.w, 0);
  let cumW = 0;
  for (const pair of pairs) {
    cumW += pair.w;
    if (cumW >= totalW / 2) return pair.v;
  }
  return pairs[pairs.length - 1].v;
}

function weightedPercentile(values: number[], weights: number[], pct: number): number {
  if (values.length === 0) return 0;
  const pairs = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  const totalW = pairs.reduce((s, p) => s + p.w, 0);
  const target = (pct / 100) * totalW;
  let cumW = 0;
  for (const pair of pairs) {
    cumW += pair.w;
    if (cumW >= target) return pair.v;
  }
  return pairs[pairs.length - 1].v;
}

// Phase 7 — Weighted Median Absolute Deviation, replaces Coefficient of Variation.
// More robust to the outlier cycles that dominated v3's variance calc during
// crisis periods (e.g. the 440-minute and 330-minute errors in the v3 log).
function weightedMAD(values: number[], weights: number[]): number {
  if (values.length === 0) return 0;
  const med = weightedMedian(values, weights);
  const absDevs = values.map((v) => Math.abs(v - med));
  return weightedMedian(absDevs, weights);
}

// Converts MAD (in minutes, relative to the median) into a 0–1 stability score.
// Scaled relative to the median itself so a 30-day-old generator schedule
// (large medians) isn't penalized the same way a tight solar window is.
function madToStability(mad: number, median: number): number {
  if (median <= 0) return 0.3;
  const relativeMad = mad / median;
  if (relativeMad < 0.08) return 0.95;
  if (relativeMad < 0.15) return 0.82;
  if (relativeMad < 0.25) return 0.65;
  if (relativeMad < 0.40) return 0.45;
  if (relativeMad < 0.60) return 0.28;
  return 0.12;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 REMOVED: fixed PROFILES, profileInfluenceAt(), blendWeightsAt(),
// blendProfiles(), PRIORS, MIN_SAMPLES_LEARNED. No clock-hour assumptions
// remain anywhere below this line.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE RECENCY-WEIGHTED DISTRIBUTION
// Replaces the five fixed-hour profiles with one distribution over all
// recent cycles, weighted exponentially by age. Clock hour no longer
// determines which bucket a cycle's stats land in.
// ─────────────────────────────────────────────────────────────────────────────

// Yemen-specific fallback when there is no usable history at all (cold start).
// This is the only place a static prior remains, and it's a single flat
// estimate rather than five hour-pinned curves.
//
// Calibrated directly from 18 real cycles confirmed from the accuracy log
// and from power_events screenshots (Jun 15-22, 2026):
//   ON durations: 105-140min, median=120min, P25=120min, P75=130min, MAD=5min
//   OFF durations: 280-500min, median=420min, P25=370min, P75=460min, MAD=45min
//
// The original values (medOff=300, p25Off=240, p75Off=360) were a generic
// Yemen regional guess, not calibrated to this specific grid. Confirmed
// in production: with ~27% of stats still coming from the prior (2.9/4
// effective samples), the prior was pulling P25Off from 310→291min (when
// reality is 370min) and P25On from ~115→ below any real observation.
// Update these if the grid's pattern permanently shifts.
const COLD_START_PRIOR = {
  medOff: 420, medOn: 120,
  p25Off: 370, p75Off: 460,
  p25On: 115, p75On: 133,
};

function computeWeightedDistStats(cycles: Cycle[]): WeightedDistStats {
  if (cycles.length === 0) {
    return {
      sampleCount: 0,
      effectiveWeightedSamples: 0,
      effectiveWeightedSamplesOn: 0,
      medianOff: COLD_START_PRIOR.medOff,
      medianOn: COLD_START_PRIOR.medOn,
      p25Off: COLD_START_PRIOR.p25Off,
      p75Off: COLD_START_PRIOR.p75Off,
      p25On: COLD_START_PRIOR.p25On,
      p75On: COLD_START_PRIOR.p75On,
      madOff: 0,
      madOn: null,
      stabilityScore: 0.3,
    };
  }

  const offVals = cycles.map((c) => c.offDurMin);
  const offWts = cycles.map((c) => c.recencyWeight);

  const medOff = weightedMedian(offVals, offWts);
  const p25Off = weightedPercentile(offVals, offWts, 25);
  const p75Off = weightedPercentile(offVals, offWts, 75);
  const madOff = weightedMAD(offVals, offWts);

  const onCycles = cycles.filter((c) => c.onDurMin !== null);
  let medOn: number | null = null;
  let p25On: number | null = null;
  let p75On: number | null = null;
  let madOn: number | null = null;

  let onWtsForEffectiveSamples: number[] = [];
  if (onCycles.length >= 2) {
    const onVals = onCycles.map((c) => c.onDurMin as number);
    // BUG FIX: was c.recencyWeight (the OFF period's weight). ON durations
    // must be weighted by how recently the ON period itself occurred.
    const onWts = onCycles.map((c) => c.onRecencyWeight as number);
    onWtsForEffectiveSamples = onWts;
    medOn = weightedMedian(onVals, onWts);
    p25On = weightedPercentile(onVals, onWts, 25);
    p75On = weightedPercentile(onVals, onWts, 75);
    madOn = weightedMAD(onVals, onWts);
  }

  // Phase 8 — effective weighted samples instead of raw count, so 5 cycles
  // from the last 12 hours can outweigh 20 cycles from a week ago.
  const effectiveWeightedSamples = offWts.reduce((s, w) => s + w, 0);
  const effectiveWeightedSamplesOn = onWtsForEffectiveSamples.reduce((s, w) => s + w, 0);

  const stabilityScore = madToStability(madOff, medOff);

  return {
    sampleCount: cycles.length,
    effectiveWeightedSamples,
    effectiveWeightedSamplesOn,
    medianOff: Math.round(medOff),
    medianOn: medOn !== null ? Math.round(medOn) : null,
    p25Off: Math.round(p25Off),
    p75Off: Math.round(p75Off),
    p25On: p25On !== null ? Math.round(p25On) : null,
    p75On: p75On !== null ? Math.round(p75On) : null,
    madOff: Math.round(madOff),
    madOn: madOn !== null ? Math.round(madOn) : null,
    stabilityScore,
  };
}

// Phase 8 — smooth blend between cold-start prior and learned distribution,
// no abrupt prior_only/hybrid/learned mode switch.
function blendWithColdStart(stats: WeightedDistStats): WeightedDistStats {
  const learnTrustOff = Math.min(1, stats.effectiveWeightedSamples / EFFECTIVE_SAMPLES_FOR_FULL_TRUST);
  const priorTrustOff = 1 - learnTrustOff;
  // ON now has its own independent trust level — it should NOT inherit the
  // OFF period's sample count, since onAgeHours/onRecencyWeight are no
  // longer derived from the same timestamps as the OFF side.
  const learnTrustOn = Math.min(1, stats.effectiveWeightedSamplesOn / EFFECTIVE_SAMPLES_FOR_FULL_TRUST);
  const priorTrustOn = 1 - learnTrustOn;

  if (stats.sampleCount === 0) return stats; // already pure cold-start

  const blendOff = (learned: number, prior: number) => learnTrustOff * learned + priorTrustOff * prior;
  const blendOn = (learned: number, prior: number) => learnTrustOn * learned + priorTrustOn * prior;

  return {
    ...stats,
    medianOff: Math.round(blendOff(stats.medianOff, COLD_START_PRIOR.medOff)),
    p25Off: Math.round(blendOff(stats.p25Off, COLD_START_PRIOR.p25Off)),
    p75Off: Math.round(blendOff(stats.p75Off, COLD_START_PRIOR.p75Off)),
    medianOn: stats.medianOn !== null ? Math.round(blendOn(stats.medianOn, COLD_START_PRIOR.medOn)) : COLD_START_PRIOR.medOn,
    p25On: stats.p25On !== null ? Math.round(blendOn(stats.p25On, COLD_START_PRIOR.p25On)) : COLD_START_PRIOR.p25On,
    p75On: stats.p75On !== null ? Math.round(blendOn(stats.p75On, COLD_START_PRIOR.p75On)) : COLD_START_PRIOR.p75On,
    stabilityScore: blendOff(stats.stabilityScore, 0.5),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — REALITY DURATION CONSTRAINTS (RDC) — APPPE V4.1
//
// Independent sanity layer, not a replacement for the MAD-based percentile
// math above. Purpose: hard-reject durations that are physically impossible
// given recent reality, even if some upstream blend or correction step
// would otherwise produce one. learnedMin/learnedMax = median ± 2.5×MAD.
//
// This is intentionally a WIDE bound (2.5×MAD), not a tight one — it exists
// to catch genuinely broken outputs (e.g. a corrected duration that drifted
// to near-zero or absurdly large), not to override legitimate variance that
// the MAD-tiered range logic already handles. If this clamp is firing
// often, that's a signal something upstream is wrong, not that this clamp
// needs to be tighter.
// ─────────────────────────────────────────────────────────────────────────────

interface RealityBounds {
  learnedMinOff: number;
  learnedMaxOff: number;
  learnedMinOn: number | null;
  learnedMaxOn: number | null;
}

function computeRealityBounds(stats: WeightedDistStats): RealityBounds {
  const learnedMinOff = Math.max(5, stats.medianOff - 2.5 * stats.madOff);
  const learnedMaxOff = stats.medianOff + 2.5 * stats.madOff;

  const learnedMinOn = stats.medianOn !== null && stats.madOn !== null
    ? Math.max(5, stats.medianOn - 2.5 * stats.madOn)
    : null;
  const learnedMaxOn = stats.medianOn !== null && stats.madOn !== null
    ? stats.medianOn + 2.5 * stats.madOn
    : null;

  return { learnedMinOff, learnedMaxOff, learnedMinOn, learnedMaxOn };
}

function clampToRealityBounds(durationMin: number, min: number, max: number): number {
  return Math.max(min, Math.min(durationMin, max));
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — CRISIS DETECTION + RECENTERING
// v3 only widened ranges around a stale median. v4 shifts the median itself
// toward recent reality, then widens around the NEW center.
// ─────────────────────────────────────────────────────────────────────────────

interface CrisisResult {
  active: boolean;
  reason: string | null;
  offShift: number; // minutes to add to medianOff
  onShift: number;  // minutes to add to medianOn
}

function detectAndRecenterCrisis(cycles: Cycle[]): CrisisResult {
  // OFF bucketing uses the OFF period's own age — correct as-is.
  const recent = cycles.filter((c) => c.ageHours < 24);
  const baseline = cycles.filter((c) => c.ageHours >= 24 && c.ageHours < 96);

  if (recent.length < 2 || baseline.length < 2) {
    return { active: false, reason: null, offShift: 0, onShift: 0 };
  }

  const recentOffMed = simpleMedian(recent.map((c) => c.offDurMin));
  const baseOffMed = simpleMedian(baseline.map((c) => c.offDurMin));
  const offIncrease = (recentOffMed - baseOffMed) / (baseOffMed || 1);

  // BUG FIX: ON samples must be bucketed by the ON period's OWN age
  // (onAgeHours), not by the preceding OFF period's age. Reusing the OFF
  // bucket here could put a just-finished ON period into "baseline" simply
  // because it followed a long-ago OFF start, corrupting the recent-vs-
  // baseline comparison that crisis recentering depends on.
  const recentOnSamples = cycles.filter((c) => c.onDurMin !== null && (c.onAgeHours as number) < 24);
  const baseOnSamples = cycles.filter((c) => c.onDurMin !== null && (c.onAgeHours as number) >= 24 && (c.onAgeHours as number) < 96);

  let onDecrease = 0;
  let recentOnMed = 0, baseOnMed = 0;
  if (recentOnSamples.length >= 2 && baseOnSamples.length >= 2) {
    recentOnMed = simpleMedian(recentOnSamples.map((c) => c.onDurMin as number));
    baseOnMed = simpleMedian(baseOnSamples.map((c) => c.onDurMin as number));
    onDecrease = (baseOnMed - recentOnMed) / (baseOnMed || 1);
  }

  if (offIncrease >= CRISIS_OFF_INCREASE_PCT) {
    const offShift = recentOffMed - baseOffMed;
    const onShift = (recentOnSamples.length >= 2 && baseOnSamples.length >= 2)
      ? recentOnMed - baseOnMed
      : 0;
    return {
      active: true,
      reason: `مدة الانقطاع ارتفعت بنسبة ${Math.round(offIncrease * 100)}% مقارنة بالأساس — احتمال نقص وقود أو تغيير في الجدول. تم إزاحة مركز التوقع بمقدار ${fmtSignedMin(Math.round(offShift))}.`,
      offShift,
      onShift,
    };
  }

  if (onDecrease >= CRISIS_ON_DECREASE_PCT) {
    const onShift = recentOnMed - baseOnMed;
    const offShift = recentOffMed - baseOffMed;
    return {
      active: true,
      reason: `مدة التشغيل انخفضت بنسبة ${Math.round(onDecrease * 100)}% مقارنة بالأساس — احتمال مشكلة في طاقة المولد. تم إزاحة مركز التوقع بمقدار ${fmtSignedMin(Math.round(onShift))}.`,
      offShift,
      onShift,
    };
  }

  return { active: false, reason: null, offShift: 0, onShift: 0 };
}

// MODULE 4 (addition) — CRISIS RE-CENTERING ENGINE: consecutive-error
// trigger. Supplements the duration-percentage trigger above.
//
// IMPORTANT architectural constraint: this trigger detects errors in
// *when* a transition occurred (timing errors), NOT errors in how long
// a state lasted (duration errors). The drift offset engine (Phase 2)
// already corrects timing errors by shifting the predicted transition
// timestamp. If we also apply a duration shift here, we double-correct
// the same underlying pattern in two incompatible ways simultaneously:
//   - driftOffset: shifts the predicted timestamp directly (correct)
//   - crisisShift on duration: shortens/lengthens the expected ON/OFF
//     period (wrong — duration is not the same as timing)
//
// This trigger therefore sets offShift=0, onShift=0 — it does NOT move
// the duration center. It only marks crisis.active=true, which:
//   1. Reduces crisisFactor in the confidence formula (less confidence)
//   2. Widens uncertainty ranges via the volatility/crisis widen factors
//   3. Surfaces a visible warning to the user
// Duration shifts are only applied by detectAndRecenterCrisis above,
// which uses actual measured cycle durations (not timing errors) as input.
//
// v4.2 NOTE: After filtering client-bugged "pending_offset" rows from
// loadHistory(), this trigger fires much less often. Confirmed from 7-day
// export: 38 of 86 unique rows were real APPPE predictions (median -10
// min error, below the |15| threshold), 48 were client artifacts (median
// -45 min, would have triggered this). With the filter in place, this
// trigger will only fire on genuine consecutive directional errors.
function detectConsecutiveErrorCrisis(historyNewestFirst: HistoryRow[]): CrisisResult {
  // Only consider recent history (last 48h) for consecutive-error crisis.
  // Without this, if ALL historical predictions run in one direction (as is
  // common when drift correction hasn't had data to work from yet), this
  // trigger fires permanently — not because the schedule shifted, but
  // because the model was consistently biased from the start.
  const recentHistory = historyNewestFirst.filter((h) => h.ageHours < 48);
  const lastThree = recentHistory.slice(0, 3);
  if (lastThree.length < 3) {
    return { active: false, reason: null, offShift: 0, onShift: 0 };
  }

  // v4.4: threshold lowered from 15 to CONSECUTIVE_ERROR_THRESHOLD_MIN (8).
  // v4.4: variable names now match semantic meaning.
  //
  // CONVENTION: errorMinutes = actualTime - predictedTime
  //   errorMinutes > 0  → event happened AFTER predicted → prediction was EARLY
  //   errorMinutes < 0  → event happened BEFORE predicted → prediction was LATE
  //
  // The v4.2 variable `allLate` was true when errorMinutes > 15, which actually
  // means PREDICTIONS were EARLY (events were late). The Arabic message
  // "متأخرة" (late) was therefore attached to the wrong condition. This patch
  // renames the variables to match what they actually mean, and ensures the
  // Arabic string correctly describes the prediction's direction.
  const allPredictionsEarly = lastThree.every((h) => h.errorMinutes > CONSECUTIVE_ERROR_THRESHOLD_MIN);  // events were late
  const allPredictionsLate  = lastThree.every((h) => h.errorMinutes < -CONSECUTIVE_ERROR_THRESHOLD_MIN); // events were early

  if (!allPredictionsEarly && !allPredictionsLate) {
    return { active: false, reason: null, offShift: 0, onShift: 0 };
  }

  // v4.4: directionAr now correctly describes the PREDICTION's lateness.
  // "متأخرة" = late (predictions were late, events were early, errorMinutes < 0)
  // "مبكرة"  = early (predictions were early, events were late, errorMinutes > 0)
  const directionAr = allPredictionsLate ? "متأخرة" : "مبكرة";
  return {
    active: true,
    reason: `آخر 3 توقعات كانت جميعها ${directionAr} (خطأ اتجاهي ثابت). تم توسيع نطاق التوقع تلقائياً وتقليل الثقة. تصحيح الانحراف الزمني يتولاه محرك الانجراف (Phase 2) بشكل مستقل.`,
    offShift: 0,  // NO duration shift — timing errors are already handled by driftOffset
    onShift: 0,   // Duration shifts only come from detectAndRecenterCrisis (uses actual durations)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — VOLATILITY ENGINE
// Independent of crisis detection: tracks an EMA of recent prediction errors
// so instability is flagged before it crosses the crisis threshold.
// ─────────────────────────────────────────────────────────────────────────────

function computeVolatilityEMA(historyNewestFirst: HistoryRow[]): number {
  if (historyNewestFirst.length === 0) return 0;
  // Walk oldest -> newest so the EMA's "latest" term really is the latest.
  const oldestFirst = [...historyNewestFirst].reverse();
  let ema = Math.abs(oldestFirst[0].errorMinutes);
  for (let i = 1; i < oldestFirst.length; i++) {
    const err = Math.abs(oldestFirst[i].errorMinutes);
    ema = VOLATILITY_EMA_ALPHA * err + (1 - VOLATILITY_EMA_ALPHA) * ema;
  }
  return ema;
}

function volatilityToLabel(ema: number): string {
  if (ema < 15) return "Low";
  if (ema < 35) return "Moderate";
  if (ema < 70) return "Elevated";
  return "High";
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — DRIFT OFFSET ENGINE (v4.2 with quantization cap)
//
// rollingMedianError = median(actual - predicted) over the last N completed
// predictions. Applied additively to the next transition forecast.
//
// v4.2 ADDITION: When >50% of drift samples cluster on a single integer
// value, the median IS that value — but it's likely a polling-resolution
// artifact rather than real drift. Cap the correction magnitude at half
// the dominant error value so we nudge rather than fully correct.
//
// Confirmed from 7-day export (after R1 client-row filter):
//   - 30 of 38 real APPPE predictions had exactly -10 min error (78.9%)
//   - All 30 were polling-quantized to ±10 min (the client polls every
//     10 minutes, so any transition the model predicted near a poll
//     boundary snaps to ±10 min)
//   - Without the cap, driftOffset = -10 (over-correcting)
//   - With the cap, driftOffset = -5 (nudge in the right direction)
// ─────────────────────────────────────────────────────────────────────────────

function computeDriftOffset(historyNewestFirst: HistoryRow[]): DriftResult {
  const slice = historyNewestFirst.slice(0, DRIFT_HISTORY_SIZE);
  if (slice.length === 0) {
    return {
      offsetMin: 0, sampleCount: 0, quantizationRatio: 0, dominantError: 0,
      quantizationSignSymmetric: false, capApplied: false,
    };
  }

  // Exponentially weight by how long ago each completed prediction was made
  // (Phase 3 applies everywhere, including drift/bias history).
  const errs = slice.map((h) => h.errorMinutes);
  const wts = slice.map((h) => recencyWeight(h.ageHours));
  let offset = weightedMedian(errs, wts);

  // Count errors by rounded value to find the dominant one
  const errorCounts = new Map<number, number>();
  for (const h of slice) {
    const rounded = Math.round(h.errorMinutes);
    errorCounts.set(rounded, (errorCounts.get(rounded) ?? 0) + 1);
  }
  let dominantError = 0;
  let dominantCount = 0;
  for (const [err, cnt] of errorCounts) {
    if (cnt > dominantCount) {
      dominantCount = cnt;
      dominantError = err;
    }
  }
  const quantizationRatio = dominantCount / slice.length;

  // v4.4 NEW: Sign-symmetry check.
  //
  // The v4.2 cap fired whenever >50% of errors clustered on a single value,
  // assuming that meant polling-resolution noise. But this is wrong when the
  // dominant error has a consistent SIGN. Polling noise is sign-symmetric
  // (a transition detected one poll late gives +10, one poll early gives -10,
  // averaged out over many cycles). A dominant error with a consistent sign
  // is REAL DRIFT that just happens to be quantized by polling.
  //
  // The cap should only fire when the dominant errors are sign-symmetric.
  // Otherwise we're halving the correction of a real bias.
  //
  // Concrete example from production (42-row export):
  //   - 33 rows have error_minutes ≈ -10 (all negative, sign = -1)
  //   - 0 rows have +10
  //   - Dominant sign set = {-1} → size 1 → NOT sign-symmetric → cap does NOT fire
  //   - Full -10 correction applies → residual error converges to ~0
  //
  // Counter-example (true polling noise):
  //   - 15 rows at +10, 15 rows at -10, 5 rows at other values
  //   - Dominant sign set would include both +1 and -1 → sign-symmetric → cap fires
  //   - Halving the offset prevents over-correcting what's actually random noise
  const dominantSigns = new Set<number>();
  for (const h of slice) {
    if (Math.round(h.errorMinutes) === dominantError) {
      dominantSigns.add(Math.sign(h.errorMinutes));
    }
  }
  const isSignSymmetric = dominantSigns.size > 1; // mixed + and - among dominant errors

  let capApplied = false;
  if (
    quantizationRatio > DRIFT_QUANTIZATION_THRESHOLD &&
    Math.abs(dominantError) > 0 &&
    isSignSymmetric // v4.4 NEW: only cap true polling noise
  ) {
    const sign = Math.sign(offset);
    const cappedMagnitude = Math.min(Math.abs(offset), Math.abs(dominantError) / 2);
    offset = sign * cappedMagnitude;
    capApplied = true;
  }

  return {
    offsetMin: Math.round(offset),
    sampleCount: slice.length,
    quantizationRatio: Math.round(quantizationRatio * 100) / 100,
    dominantError,
    quantizationSignSymmetric: isSignSymmetric,
    capApplied,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — PREDICTION BIAS ENGINE
// durationBiasRatio = actualDuration / predictedDuration, applied BEFORE
// drift correction: Raw Prediction → Bias Correction → Drift Correction → Range.
//
// v4.3 STATUS: NOW ACTIVE. `duration_type`, `predicted_duration_min`, and
// `actual_duration_min` are confirmed present as nullable columns in the real
// prediction_accuracy_logs DDL. loadHistory() now SELECTs and maps all three.
// The bias engine will produce non-trivial ratios as soon as the write path
// (recordCompletedPrediction / client logger) starts populating these columns.
// ─────────────────────────────────────────────────────────────────────────────

function computeBiasRatio(
  historyNewestFirst: HistoryRow[],
  durationType: "OFF" | "ON",
): { ratio: number; sampleCount: number } {
  const relevant = historyNewestFirst
    .filter((h) => h.durationType === durationType && h.predictedDurationMin && h.actualDurationMin)
    .slice(0, BIAS_HISTORY_SIZE);

  if (relevant.length === 0) return { ratio: 1, sampleCount: 0 };

  const ratios = relevant.map((h) =>
    (h.actualDurationMin as number) / (h.predictedDurationMin as number)
  );
  const wts = relevant.map((h) => recencyWeight(h.ageHours));

  const rawRatio = weightedMedian(ratios, wts);
  const clamped = Math.min(BIAS_RATIO_MAX, Math.max(BIAS_RATIO_MIN, rawRatio));

  return { ratio: clamped, sampleCount: relevant.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 9 — TRANSITION-FOCUSED PREDICTION (the authoritative output)
// Pipeline: Raw Prediction -> Bias Correction -> Drift Correction -> Range.
// ─────────────────────────────────────────────────────────────────────────────

function buildNextTransition(
  now: Date,
  currentlyOn: boolean,
  currentStateDurationMin: number,
  stats: WeightedDistStats,
  crisis: CrisisResult,
  biasRatio: { ratio: number; sampleCount: number },
  driftOffset: DriftResult,
  volatilityEMA: number,
) {
  const type = currentlyOn ? "UTILITY_OFF" : "UTILITY_ON";

  // ── Step 0: raw expected total duration of current state ──────────────────
  let totalExpOff = stats.medianOff;
  let totalExpOn = stats.medianOn ?? stats.medianOff;
  let pLowOff = stats.p25Off, pHighOff = stats.p75Off;
  let pLowOn = stats.p25On ?? stats.p25Off, pHighOn = stats.p75On ?? stats.p75Off;

  // ── Step 1: crisis recentering — shift MIDPOINT only, preserve range width ─
  // BUG FIX: previously added crisis.offShift to BOTH pLow and pHigh, e.g.
  //   pLow  = 341 + (-33) = 308  |  pHigh = 448 + (-33) = 415
  // This keeps the width (448-341=107min) intact but drags the ENTIRE range
  // down uniformly, producing a window like 308-415min that doesn't contain
  // the raw median (379min) and sits below the observed minimum (341min).
  // With a large enough shift the range can be pushed entirely below any
  // real cycle ever recorded, making it physically impossible.
  //
  // Correct behavior: shift the MIDPOINT of the range by the crisis offset,
  // then reconstruct P25/P75 symmetrically around the new center. This
  // recenters the prediction toward the new reality while keeping the
  // uncertainty window (width) the same size as before.
  if (crisis.active) {
    totalExpOff += crisis.offShift;
    totalExpOn += crisis.onShift;

    // Midpoint-preserving range shift for OFF
    const midOff = (pLowOff + pHighOff) / 2;
    const halfWidthOff = (pHighOff - pLowOff) / 2;
    const newMidOff = midOff + crisis.offShift;
    pLowOff = newMidOff - halfWidthOff;
    pHighOff = newMidOff + halfWidthOff;

    // Midpoint-preserving range shift for ON
    const midOn = (pLowOn + pHighOn) / 2;
    const halfWidthOn = (pHighOn - pLowOn) / 2;
    const newMidOn = midOn + crisis.onShift;
    pLowOn = newMidOn - halfWidthOn;
    pHighOn = newMidOn + halfWidthOn;
  }

  // ── Step 2: bias correction (multiplicative, on durations) ────────────────
  const biasAdjOff = totalExpOff * biasRatio.ratio;
  const biasAdjOn = totalExpOn * biasRatio.ratio;
  const biasAdjPLowOff = pLowOff * biasRatio.ratio;
  const biasAdjPHighOff = pHighOff * biasRatio.ratio;
  const biasAdjPLowOn = pLowOn * biasRatio.ratio;
  const biasAdjPHighOn = pHighOn * biasRatio.ratio;

  let totalExp = currentlyOn ? biasAdjOn : biasAdjOff;
  let pLow = currentlyOn ? biasAdjPLowOn : biasAdjPLowOff;
  let pHigh = currentlyOn ? biasAdjPHighOn : biasAdjPHighOff;

  // MODULE 1 — REALITY DURATION CONSTRAINTS (APPPE V4.1).
  // Clamp the corrected duration (and its P25/P75 bounds) to what's
  // physically realistic given this state's own recent median ± 2.5×MAD.
  // BUG FIX: previously used stats.medianOff/On (pre-crisis-shift) as the
  // RDC center, which means a valid crisis shift could push totalExp outside
  // the pre-shift RDC window and get clamped right back — partially undoing
  // the correction. Example: stats.medianOn=121, MAD=10 → RDC=[96,146].
  // Crisis shifts totalExp to 88. RDC sees 88 < 96 and clamps to 96, which
  // is the pre-shift bound, not the shifted reality. Fix: use crisis-shifted
  // medians as the RDC center so the bounds move with the correction.
  const crisisShiftOff = crisis.active ? crisis.offShift : 0;
  const crisisShiftOn = crisis.active ? crisis.onShift : 0;
  const rdc_medianOff = stats.medianOff + crisisShiftOff;
  const rdc_medianOn = stats.medianOn !== null ? stats.medianOn + crisisShiftOn : null;

  const realityMinOff = Math.max(5, rdc_medianOff - 2.5 * stats.madOff);
  const realityMaxOff = rdc_medianOff + 2.5 * stats.madOff;
  const realityMinOn = rdc_medianOn !== null && stats.madOn !== null
    ? Math.max(5, rdc_medianOn - 2.5 * stats.madOn)
    : null;
  const realityMaxOn = rdc_medianOn !== null && stats.madOn !== null
    ? rdc_medianOn + 2.5 * stats.madOn
    : null;

  const realityMin = currentlyOn ? (realityMinOn ?? realityMinOff) : realityMinOff;
  const realityMax = currentlyOn ? (realityMaxOn ?? realityMaxOff) : realityMaxOff;

  let realityClamped = false;
  const clampedTotalExp = clampToRealityBounds(totalExp, realityMin, realityMax);
  if (clampedTotalExp !== totalExp) realityClamped = true;
  totalExp = clampedTotalExp;
  pLow = clampToRealityBounds(pLow, realityMin, realityMax);
  pHigh = clampToRealityBounds(pHigh, realityMin, realityMax);
  if (pHigh < pLow) pHigh = pLow; // guard against inverted bounds after clamping

  // ── Step 3: drift correction (additive, on the absolute predicted time) ───
  // remaining = (bias-corrected total) - elapsed, then drift is added on top
  // of the resulting timestamp, exactly as specified: correctedPrediction =
  // basePrediction + rollingMedianError.
  let minRemaining = Math.max(0, pLow - currentStateDurationMin);
  let maxRemaining = Math.max(minRemaining + 5, pHigh - currentStateDurationMin);
  let midRemaining = Math.max(0, totalExp - currentStateDurationMin);

  // ── Step 4: widen ranges for instability/volatility/crisis ────────────────
  // BUG FIX (carried from prior version): previously each condition
  // multiplied maxRemaining/minRemaining independently and in sequence
  // (stability x1.4, then volatility x1.25, then crisis x1.6 — a combined
  // ~x2.8). Combined via quadrature instead so multiple simultaneous
  // uncertainty signals don't compound linearly.
  const stabilityWidenFactor = stats.stabilityScore < 0.45 ? 1.4 : 1.0;
  const volatilityWidenFactor = volatilityEMA >= 70 ? 1.5 : volatilityEMA >= 35 ? 1.25 : 1.0;
  const crisisWidenFactor = crisis.active ? 1.6 : 1.0;

  const excessSq =
    Math.pow(stabilityWidenFactor - 1, 2) +
    Math.pow(volatilityWidenFactor - 1, 2) +
    Math.pow(crisisWidenFactor - 1, 2);
  const combinedWidenFactor = Math.min(1.8, 1 + Math.sqrt(excessSq));
  const combinedNarrowFactor = Math.max(0.55, 1 / combinedWidenFactor);

  maxRemaining = maxRemaining * combinedWidenFactor;
  minRemaining = Math.max(0, minRemaining * combinedNarrowFactor);

  // MAD-TIERED MAX RANGE WIDTH (APPPE V4.1 — Prediction Range Redesign).
  // Replaces the prior flat 90-minute cap. A flat cap punished well-learned,
  // genuinely stable predictions exactly as hard as it punished noisy ones —
  // confirmed by real usage where Pattern Stability sat at 76% and
  // Volatility EMA was 0 (no timing drift at all) but the range still got
  // clamped to the same 90 minutes as a chaotic one. Tying the cap to the
  // relevant duration's own MAD makes the cap proportional to how
  // predictable this specific state (ON or OFF) actually is.
  const relevantMad = currentlyOn ? (stats.madOn ?? stats.madOff) : stats.madOff;
  let maxAllowedWidth: number;
  if (relevantMad < 15) maxAllowedWidth = 30;        // Very Stable  → ±15 min
  else if (relevantMad < 30) maxAllowedWidth = 60;   // Stable       → ±30 min
  else if (relevantMad < 60) maxAllowedWidth = 90;   // Moderate     → ±45 min
  else maxAllowedWidth = 180;                         // Unstable     → ±90 min

  // Never allow range width > 50% of the expected duration unless crisis is
  // active — a tight MAD tier shouldn't force a 30-min window onto a
  // 20-minute expected duration. Crisis mode is exempted since genuine
  // schedule upheaval legitimately needs more room regardless of this ratio.
  if (!crisis.active) {
    const halfDurationCap = totalExp * 0.5;
    if (halfDurationCap > 0) {
      maxAllowedWidth = Math.min(maxAllowedWidth, Math.max(20, halfDurationCap));
    }
  }

  let rangeWasClamped = false;
  if (maxRemaining - minRemaining > maxAllowedWidth) {
    const center = (minRemaining + maxRemaining) / 2;
    minRemaining = Math.max(0, center - maxAllowedWidth / 2);
    maxRemaining = center + maxAllowedWidth / 2;
    rangeWasClamped = true;
  }

  // Apply drift offset additively to the predicted timestamp (in minutes-from-now terms).
  // v4.2: driftOffset.offsetMin may have been capped by the quantization detector.
  midRemaining = midRemaining + driftOffset.offsetMin;
  minRemaining = Math.max(0, minRemaining + driftOffset.offsetMin);
  maxRemaining = Math.max(minRemaining + 5, maxRemaining + driftOffset.offsetMin);
  midRemaining = Math.max(0, midRemaining);

  const earliest = new Date(now.getTime() + minRemaining * 60000);
  const latest = new Date(now.getTime() + maxRemaining * 60000);
  const predicted = new Date(now.getTime() + midRemaining * 60000);

  const waitH = Math.floor(midRemaining / 60);
  const waitM = Math.round(midRemaining % 60);
  const waitLabel = waitH > 0
    ? `~${waitH}س ${waitM > 0 ? waitM + "د" : ""}`.trim()
    : `~${waitM}د`;

  return {
    type,
    predictedTime: predicted.toISOString(),
    predictedFormatted: fmtYemenWithDate(predicted),
    earliestTime: earliest.toISOString(),
    latestTime: latest.toISOString(),
    earliestFormatted: fmtYemenWithDate(earliest),
    latestFormatted: fmtYemenWithDate(latest),
    minFromNowMin: Math.round(minRemaining),
    maxFromNowMin: Math.round(maxRemaining),
    rangeLabel: `${fmtYemen(earliest)} → ${fmtYemen(latest)}`,
    waitLabel,
    rangeWasClamped, // true if the MAD-tiered max-width cap compressed the range. Display-only — no longer auto-demotes confidence; see Confidence Consistency Model.
    realityClamped, // true if Reality Duration Constraints had to override an unrealistic corrected duration
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 10 — DAY SCHEDULE (low-confidence projection only, fed corrected
// durations per the bias/drift pipeline, but never treated as authoritative)
// ─────────────────────────────────────────────────────────────────────────────

function getZone(h: number): string {
  if (h < 6) return "Night";
  if (h < 10) return "Morning";
  if (h < 16) return "Midday";
  if (h < 20) return "Evening";
  return "Late Night";
}

function generateDaySchedule(
  now: Date,
  currentlyOn: boolean,
  currentStateDurationMin: number,
  stats: WeightedDistStats,
  crisis: CrisisResult,
  biasRatio: { ratio: number; sampleCount: number },
): object[] {
  const windowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const slots: object[] = [];
  let cursor = new Date(now);
  let stateOn = currentlyOn;

  // Same crisis + bias corrected medians used by the authoritative forecast,
  // so the schedule and the next-transition number never visibly disagree.
  const correctedOff = (stats.medianOff + (crisis.active ? crisis.offShift : 0)) * biasRatio.ratio;
  const correctedOn = ((stats.medianOn ?? stats.medianOff) + (crisis.active ? crisis.onShift : 0)) * biasRatio.ratio;

  const firstTotal = stateOn ? correctedOn : correctedOff;
  const firstRemaining = Math.max(10, firstTotal - currentStateDurationMin);
  let slotEndMs = cursor.getTime() + firstRemaining * 60000;

  for (let i = 0; i < 24 && cursor.getTime() < windowEnd.getTime(); i++) {
    const slotEnd = new Date(Math.min(slotEndMs, windowEnd.getTime() + 60000));
    const beyondWindow = slotEndMs > windowEnd.getTime();
    const end = beyondWindow ? null : slotEnd;
    const durMin = end ? Math.round((slotEnd.getTime() - cursor.getTime()) / 60000) : null;
    const yh = yemenHour(cursor.toISOString());

    slots.push({
      state: stateOn ? "ON" : "OFF",
      startIso: cursor.toISOString(),
      endIso: end?.toISOString() ?? null,
      startFormatted: fmtYemen(cursor),
      endFormatted: end ? fmtYemen(end) : null,
      durationLabel: durMin !== null ? fmtMin(durMin) : null,
      zone: getZone(yh),
      isEstimated: true,       // Phase 10: every slot is a low-confidence projection now
      isAuthoritative: false,  // explicit: only nextTransition is authoritative
    });

    if (!end) break;

    cursor = slotEnd;
    stateOn = !stateOn;
    const nextDur = stateOn ? correctedOn : correctedOff;
    slotEndMs = cursor.getTime() + Math.max(10, nextDur) * 60000;
  }

  return slots;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY COMPAT — keeps existing UI fields populated (Phase 14)
// ─────────────────────────────────────────────────────────────────────────────

function toPatternStats(stats: WeightedDistStats): object | null {
  if (stats.sampleCount === 0) return null;
  return {
    cycles: stats.sampleCount,
    avgOffMin: stats.medianOff,
    stdDevOffMin: stats.madOff,
    avgOnMin: stats.medianOn,
    stdDevOnMin: stats.madOn,
    minOffMin: stats.p25Off,
    maxOffMin: stats.p75Off,
    minOnMin: stats.p25On,
    maxOnMin: stats.p75On,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 13 — HISTORY LOADING (behind HISTORY_SOURCE flag)
//
// v4.2 ADDITION: Filters out client-bugged "pending_offset" rows.
// ─────────────────────────────────────────────────────────────────────────────

async function loadHistory(
  supabase: ReturnType<typeof createClient>,
  now: Date,
): Promise<HistoryLoadResult> {
  // Real duplicate-logging bug discovered in production data (2026-06-20
  // export): the CLIENT app re-writes the same resolved prediction outcome
  // to this table every time it polls/refreshes, instead of writing it
  // once. Confirmed example: one real event (predicted 08:40, actual 07:40,
  // 60min error) was logged 107 separate times with identical
  // predicted_time/actual_time/error_minutes, differing only in created_at.
  // Across the 7-day export, 631 of 717 rows (88%) were these duplicates,
  // dragging the reported accuracy down to 65% when the true de-duplicated
  // figure was 36% @ ±15 min tolerance. This is a CLIENT-SIDE bug — fix
  // the actual write path there too — but this reader defends against it
  // either way so drift/bias correction can't be skewed by duplicate-
  // weighted history even before the client is fixed.
  //
  // Because duplicates can dominate a small `.limit()` window (in the worst
  // case, the most recent ~100+ rows were ALL the same single event), the
  // initial fetch is widened well past what DRIFT/BIAS_HISTORY_SIZE need,
  // dedup happens first, then the deduped list is what downstream slicing
  // operates on.
  const FETCH_MULTIPLIER = 8; // generous headroom against duplicate runs
  const fetchLimit = Math.max(DRIFT_HISTORY_SIZE, BIAS_HISTORY_SIZE) * FETCH_MULTIPLIER;

  function dedupeByPredictedActualPair(rows: HistoryRow[]): { rows: HistoryRow[]; collapsed: number } {
    const seen = new Set<string>();
    const result: HistoryRow[] = [];
    let collapsed = 0;
    for (const row of rows) {
      const key = `${row.predictedTimeIso}|${row.actualTimeIso}`;
      if (seen.has(key)) {
        collapsed++;
        continue;
      }
      seen.add(key);
      result.push(row);
    }
    return { rows: result, collapsed };
  }

  if (HISTORY_SOURCE === "accuracy_log") {
    // Confirmed column names from the real prediction_accuracy_logs DDL:
    //   predicted_event_time, actual_event_time, predicted_state, actual_state,
    //   error_minutes, accuracy_score, confidence_score, prediction_generated_at,
    //   slot_id, duration_type, predicted_duration_min, actual_duration_min.
    // All three duration columns exist as nullable — they are now SELECTed and
    // mapped so Phase 4 (Bias Engine) activates as soon as the write path
    // starts populating them. Previously these were hardcoded to null with the
    // incorrect comment "columns do not exist on this table".
    //
    // v4.2: slot_id SELECTed to filter client-bugged rows.
    // v4.3: duration_type / predicted_duration_min / actual_duration_min added.
    const { data, error } = await supabase
      .from(ACCURACY_LOG_TABLE)
      .select("predicted_state, predicted_event_time, actual_event_time, error_minutes, slot_id, duration_type, predicted_duration_min, actual_duration_min")
      .order("actual_event_time", { ascending: false })
      .limit(fetchLimit);

    if (error || !data) {
      return {
        rows: [],
        rawRowsFetched: 0,
        duplicateRowsCollapsed: 0,
        clientRowsFiltered: 0,
        unparseableRowsSkipped: 0,
      };
    }

    const rawRowsFetched = data.length;
    let clientRowsFiltered = 0;
    let unparseableRowsSkipped = 0;

    // BUG FIX: the previous version derived the error's SIGN by comparing
    // actual vs predicted timestamps as JS Dates. If either is null,
    // malformed, or otherwise unparseable, `new Date(x).getTime()` returns
    // NaN, and ANY comparison against NaN (including `>`) silently
    // evaluates to false — which means the sign would default to -1
    // ("early") for every such row, regardless of what actually happened.
    // Rows with unparseable timestamps are now skipped entirely rather
    // than silently mis-signed.
    const rows: HistoryRow[] = [];
    for (const row of data as any[]) {
      if (row.predicted_event_time == null || row.actual_event_time == null) continue;

      const actualMs = new Date(row.actual_event_time).getTime();
      const predictedMs = new Date(row.predicted_event_time).getTime();
      if (!Number.isFinite(actualMs) || !Number.isFinite(predictedMs)) {
        unparseableRowsSkipped++;
        continue;
      }

      const signedErrorFromTimestamps = (actualMs - predictedMs) / 60000;

      // If error_minutes is present, trust its MAGNITUDE (it's the
      // authoritative accuracy-log figure) but always derive the SIGN from
      // the timestamps directly above, now that we've confirmed both
      // parsed successfully — never from a fallback default.
      const errorMinutes = row.error_minutes != null
        ? Math.sign(signedErrorFromTimestamps || 1) * Math.abs(row.error_minutes)
        : signedErrorFromTimestamps;

      const slotId: string | null = row.slot_id ?? null;

      // v4.2 — Filter client-bugged "pending_offset" rows. These are not
      // real predictions — they're the client's pre-correction state being
      // logged as if it were a prediction. Confirmed from 7-day export:
      // 48 of 86 unique rows matched this pattern, all with median -45 min
      // error vs APPPE's real median of -10 min. Including them
      // contaminates drift/bias/crisis calculations.
      if (slotId && CLIENT_PENDING_SLOT_PATTERN.test(slotId)) {
        clientRowsFiltered++;
        continue;
      }

      rows.push({
        predictedType: row.predicted_state,
        predictedTimeIso: row.predicted_event_time,
        actualTimeIso: row.actual_event_time,
        errorMinutes,
        ageHours: Math.max(0, (now.getTime() - actualMs) / 3_600_000),
        // Nullable columns confirmed in DDL — null until the write path
        // (recordCompletedPrediction / client logger) starts populating them.
        durationType: (row.duration_type as "OFF" | "ON" | null) ?? null,
        predictedDurationMin: row.predicted_duration_min != null ? Number(row.predicted_duration_min) : null,
        actualDurationMin: row.actual_duration_min != null ? Number(row.actual_duration_min) : null,
        slotId,
      });
    }

    // DEDUP FIX: collapse repeated re-logs of the same (predicted_event_time,
    // actual_event_time) pair down to one row. Rows arrive newest-`created_at`
    // first is NOT guaranteed by this query (it's ordered by actual_event_time),
    // but since every duplicate in the confirmed bug has identical
    // error_minutes regardless of which copy is kept, which copy survives
    // doesn't affect the resulting statistics.
    const { rows: deduped, collapsed } = dedupeByPredictedActualPair(rows);

    return {
      rows: deduped,
      rawRowsFetched,
      duplicateRowsCollapsed: collapsed,
      clientRowsFiltered,
      unparseableRowsSkipped,
    };
  }

  // "dedicated" — new purpose-built table.
  const { data, error } = await supabase
    .from(DEDICATED_HISTORY_TABLE)
    .select("predicted_type, predicted_time, actual_time, error_minutes, duration_type, predicted_duration_min, actual_duration_min")
    .order("actual_time", { ascending: false })
    .limit(fetchLimit);

  if (error || !data) {
    return {
      rows: [],
      rawRowsFetched: 0,
      duplicateRowsCollapsed: 0,
      clientRowsFiltered: 0,
      unparseableRowsSkipped: 0,
    };
  }

  const rawRowsFetched = data.length;
  let clientRowsFiltered = 0;
  let unparseableRowsSkipped = 0;

  const parsed: HistoryRow[] = [];
  for (const row of data as any[]) {
    if (row.predicted_time == null || row.actual_time == null) continue;
    const actualMs = new Date(row.actual_time).getTime();
    if (!Number.isFinite(actualMs)) {
      unparseableRowsSkipped++;
      continue;
    }
    const slotId: string | null = row.slot_id ?? null;
    if (slotId && CLIENT_PENDING_SLOT_PATTERN.test(slotId)) {
      clientRowsFiltered++;
      continue;
    }
    parsed.push({
      predictedType: row.predicted_type,
      predictedTimeIso: row.predicted_time,
      actualTimeIso: row.actual_time,
      errorMinutes: row.error_minutes,
      ageHours: Math.max(0, (now.getTime() - actualMs) / 3_600_000),
      durationType: row.duration_type ?? null,
      predictedDurationMin: row.predicted_duration_min ?? null,
      actualDurationMin: row.actual_duration_min ?? null,
      slotId,
    });
  }
  const { rows: deduped, collapsed } = dedupeByPredictedActualPair(parsed);

  return {
    rows: deduped,
    rawRowsFetched,
    duplicateRowsCollapsed: collapsed,
    clientRowsFiltered,
    unparseableRowsSkipped,
  };
}

// Writes this cycle's completed-prediction outcome back to history once we
// can observe what actually happened (called from the polling/event-ingest
// function, NOT from analyze-patterns itself — analyze-patterns only reads).
// Included here for reference / so the schema lives next to the reader.
//
// Full confirmed DDL columns written here:
//   predicted_state, actual_state, predicted_event_time, actual_event_time,
//   error_minutes, accuracy_score, confidence_score (nullable),
//   prediction_generated_at (nullable), slot_id,
//   duration_type (nullable), predicted_duration_min (nullable),
//   actual_duration_min (nullable).
//
// v4.2: slot_id = "server_resolved" for server-written rows so they never
//   match the CLIENT_PENDING_SLOT_PATTERN filter in loadHistory().
// v4.3: confidence_score, prediction_generated_at, duration_type,
//   predicted_duration_min, actual_duration_min are now accepted as optional
//   fields on the input row and written when present. Pass them from the
//   poll-growatt function once it has access to the live prediction object.
async function recordCompletedPrediction(
  supabase: ReturnType<typeof createClient>,
  row: {
    predictedType: "UTILITY_ON" | "UTILITY_OFF";
    predictedTimeIso: string;
    actualTimeIso: string;
    // Optional enrichment — populate from the live prediction object in poll-growatt
    confidenceScore?: number | null;          // maps to confidence_score
    predictionGeneratedAt?: string | null;    // maps to prediction_generated_at (ISO)
    durationType?: "OFF" | "ON" | null;       // maps to duration_type
    predictedDurationMin?: number | null;     // maps to predicted_duration_min
    actualDurationMin?: number | null;        // maps to actual_duration_min
  },
) {
  const errorMinutes = (new Date(row.actualTimeIso).getTime() - new Date(row.predictedTimeIso).getTime()) / 60000;
  const MAX_ALLOWED_ERROR_MIN = 150; // matches runBackfill()'s scoring scale, for consistency with existing dashboard math
  const accuracyScore = Math.max(0, 100 - (Math.abs(errorMinutes) / MAX_ALLOWED_ERROR_MIN) * 100);

  if (HISTORY_SOURCE === "accuracy_log") {
    return supabase.from(ACCURACY_LOG_TABLE).insert({
      predicted_state: row.predictedType,
      actual_state: row.predictedType, // mirrors the observed event type per runBackfill() convention
      predicted_event_time: row.predictedTimeIso,
      actual_event_time: row.actualTimeIso,
      error_minutes: Math.round(Math.abs(errorMinutes) * 100) / 100,
      accuracy_score: Math.round(accuracyScore * 100) / 100,
      slot_id: "server_resolved",
      // Nullable enrichment fields — omitted from the insert when not supplied
      // so Postgres applies the column DEFAULT (null) rather than writing an
      // explicit null that could shadow a future DEFAULT change.
      ...(row.confidenceScore != null && {
        confidence_score: Math.round(row.confidenceScore * 100) / 100,
      }),
      ...(row.predictionGeneratedAt != null && {
        prediction_generated_at: row.predictionGeneratedAt,
      }),
      ...(row.durationType != null && {
        duration_type: row.durationType,
      }),
      ...(row.predictedDurationMin != null && {
        predicted_duration_min: Math.round(row.predictedDurationMin * 100) / 100,
      }),
      ...(row.actualDurationMin != null && {
        actual_duration_min: Math.round(row.actualDurationMin * 100) / 100,
      }),
    });
  }

  // "dedicated" branch — purpose-built table, write all available fields.
  return supabase.from(DEDICATED_HISTORY_TABLE).insert({
    predicted_type: row.predictedType,
    predicted_time: row.predictedTimeIso,
    actual_time: row.actualTimeIso,
    error_minutes: errorMinutes,
    ...(row.durationType != null && { duration_type: row.durationType }),
    ...(row.predictedDurationMin != null && { predicted_duration_min: row.predictedDurationMin }),
    ...(row.actualDurationMin != null && { actual_duration_min: row.actualDurationMin }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const now = new Date();
  const windowStart = new Date(now.getTime() - DATA_WINDOW_HOURS * 3_600_000).toISOString();

  // ── Fetch events (7 days) ──────────────────────────────────────────────────
  const { data: rawEvents, error: evErr } = await supabase
    .from("power_events")
    .select("event_type, occurred_at")
    .gte("occurred_at", windowStart)
    .order("occurred_at", { ascending: true });

  if (evErr) {
    return new Response(JSON.stringify({ error: evErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Fetch inverter state ───────────────────────────────────────────────────
  const { data: invState } = await supabase
    .from("inverter_state")
    .select("utility_on, last_polled, inverter_offline")
    .eq("id", 1)
    .maybeSingle();

  const currentlyOn: boolean = invState?.utility_on ?? false;
  const events = rawEvents ?? [];

  // ── Current state duration ─────────────────────────────────────────────────
  let lastTransitionAt: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (
      (currentlyOn && events[i].event_type === "UTILITY_ON") ||
      (!currentlyOn && events[i].event_type === "UTILITY_OFF")
    ) {
      lastTransitionAt = events[i].occurred_at;
      break;
    }
  }
  const currentStateDurationMin = lastTransitionAt
    ? Math.round((now.getTime() - new Date(lastTransitionAt).getTime()) / 60000)
    : 0;

  // ── Extract cycles with exponential recency weights (Phase 3) ─────────────
  const cycles = extractCycles(events, now);

  // ── Single recency-weighted distribution (Phase 1 removal target) ─────────
  const rawStats = computeWeightedDistStats(cycles);
  const stats = blendWithColdStart(rawStats); // Phase 8 — smooth trust transition

  // ── History for drift/bias engines (Phase 13, behind HISTORY_SOURCE flag) ──
  // Loaded before crisis detection now, since Module 4's consecutive-error
  // trigger needs the prediction error log.
  // v4.2: loadHistory() now returns diagnostic counts (rawRowsFetched,
  // duplicateRowsCollapsed, clientRowsFiltered, unparseableRowsSkipped).
  const historyResult = await loadHistory(supabase, now);
  const history = historyResult.rows; // already sorted newest-first

  // ── Crisis detection + recentering (Phase 5 + Module 4 addition) ──────────
  // Two independent trigger paths, either of which can activate crisis mode:
  //   1. Duration-percentage trigger (existing): recent OFF/ON durations
  //      deviated >20% from baseline.
  //   2. Consecutive-error trigger (new): last 3 completed predictions were
  //      all off in the same direction, even if no single one crossed 20%.
  // If both fire, the one with the larger magnitude shift wins, since that
  // represents the more urgent correction.
  //
  // v4.2: With client-bugged rows filtered out of `history`, the consecutive-
  // error trigger fires much less often. See detectConsecutiveErrorCrisis()
  // comment for details.
  const durationCrisis = detectAndRecenterCrisis(cycles);
  const errorCrisis = detectConsecutiveErrorCrisis(history);
  const crisis = !durationCrisis.active && !errorCrisis.active
    ? durationCrisis // both inactive — shape doesn't matter, return either
    : !errorCrisis.active
    ? durationCrisis
    : !durationCrisis.active
    ? errorCrisis
    : (Math.abs(durationCrisis.offShift) >= Math.abs(errorCrisis.offShift) ? durationCrisis : errorCrisis);

  // ── Bias correction (Phase 4) — applied before drift, per spec ────────────
  const biasOff = computeBiasRatio(history, "OFF");
  const biasOn = computeBiasRatio(history, "ON");
  // Single ratio used downstream; if ON-specific data is too sparse, fall
  // back to the OFF ratio rather than defaulting silently to 1.0.
  const biasRatio = biasOn.sampleCount >= 3 ? biasOn : (biasOff.sampleCount >= 3 ? biasOff : { ratio: 1, sampleCount: 0 });

  // ── Drift offset (Phase 2, v4.2 with quantization cap) ────────────────────
  const driftResult = computeDriftOffset(history);
  const driftOffset = { offsetMin: driftResult.offsetMin, sampleCount: driftResult.sampleCount };

  // ── Volatility EMA (Phase 6) ───────────────────────────────────────────────
  const volatilityEMA = computeVolatilityEMA(history);
  const volatilityLabel = volatilityToLabel(volatilityEMA);

  // ── Stability / confidence (Phase 7 + Phase 11) ────────────────────────────
  const stabilityRaw = stats.stabilityScore;
  // isUnstable drives range widening and prediction availability — but
  // BUG FIX: previously included crisis.active in this flag, which then
  // triggered a hard 30% confidence cap via the isUnstable branch below.
  // That means ANY crisis trigger (including a mild consecutive-error shift)
  // permanently collapses confidence to 30% regardless of how stable and
  // data-rich the underlying pattern is. Confirmed in real usage: 78%
  // stability + 82% data quality → still 30% because crisis.active=true.
  // Crisis is now handled only via crisisFactor in the weighted formula
  // (where it contributes a proportional reduction), not as a hard override
  // that ignores everything else. The confidence floor from isHighQualityData
  // is also now allowed to apply during mild crisis conditions.
  //
  // v4.2 ADDITION: Severe crisis (shift > SEVERE_CRISIS_SHIFT_MIN) still
  // flags isUnstable=true even if MAD-based stability is high. This re-
  // introduces severe-crisis handling without the v4.0 bug.
  const crisisMagnitude = Math.max(Math.abs(crisis.offShift), Math.abs(crisis.onShift));
  const isUnstable = stabilityRaw < 0.28 || volatilityEMA >= 70 || crisisMagnitude > SEVERE_CRISIS_SHIFT_MIN;
  const stabilityScore = Math.round(stabilityRaw * 100);
  const stabLabel = stabilityRaw >= 0.75 ? "Stable" : stabilityRaw >= 0.45 ? "Slightly Unstable" : "Unstable";

  // ── Next transition — the authoritative forecast (Phase 9) ────────────────
  // Built before final confidence so a clamped range can demote confidence.
  let nextTransition: (ReturnType<typeof buildNextTransition>) | null = null;
  if (!isUnstable || cycles.length >= 2) {
    nextTransition = buildNextTransition(
      now, currentlyOn, currentStateDurationMin, stats, crisis, biasRatio, driftResult, volatilityEMA,
    );
  }

  // Confidence inputs per Phase 11: data quantity/recency, drift stability,
  // bias stability, MAD stability, volatility, crisis state, error history.
  // Use the WEAKER of OFF/ON effective samples — confidence shouldn't be
  // inflated by a well-learned OFF side while the ON side (or vice versa)
  // is still thin, since the next-transition forecast can point either way.
  const effectiveSamplesForConfidence = Math.min(stats.effectiveWeightedSamples, stats.effectiveWeightedSamplesOn || stats.effectiveWeightedSamples);
  const dataQuantityFactor = Math.min(1, effectiveSamplesForConfidence / EFFECTIVE_SAMPLES_FOR_FULL_TRUST);
  const driftStabilityFactor = driftOffset.sampleCount === 0 ? 0.6 : Math.max(0.2, 1 - Math.abs(driftOffset.offsetMin) / 180);
  const biasStabilityFactor = biasRatio.sampleCount === 0 ? 0.7 : Math.max(0.3, 1 - Math.abs(1 - biasRatio.ratio));
  const volatilityFactor = volatilityEMA < 15 ? 1 : volatilityEMA < 35 ? 0.85 : volatilityEMA < 70 ? 0.55 : 0.25;
  // v4.2: Removed unused `crisisFactor` variable. The `crisisMultiplier`
  // below is the only crisis-related confidence adjustment. A 5% weight
  // for crisis in v3 meant crisis.active only reduced total confidence by
  // 2.5% — barely perceptible. A multiplicative factor of 0.65 reduces any
  // computed confidence by 35% during active crisis, giving a signal that's
  // both meaningful and proportional to underlying quality.
  // Example: 71% base × 0.65 = 46% during crisis. 78% base × 0.65 = 51%.
  const crisisMultiplier = crisis.active ? 0.65 : 1.0;

  let confidenceRaw =
    dataQuantityFactor * 0.30 +
    stabilityRaw * 0.25 +
    driftStabilityFactor * 0.15 +
    biasStabilityFactor * 0.10 +
    volatilityFactor * 0.20; // redistributed the 0.05 weight to volatility

  // Apply crisis as a multiplicative penalty (35% reduction when active)
  confidenceRaw = confidenceRaw * crisisMultiplier;
  confidenceRaw = Math.min(0.97, confidenceRaw);

  // Low-stability or high-volatility genuinely unstable patterns get a hard
  // cap — but this no longer includes crisis.active, which is handled
  // proportionally via the multiplicative penalty above.
  if (isUnstable) confidenceRaw = Math.min(confidenceRaw, 0.30);

  // CONFIDENCE CONSISTENCY MODEL: if stability AND data quality both clear
  // a high bar, apply a floor so a good dataset can't be dragged down
  // by a single weak signal. During active crisis, reduced floor (40%)
  // so high-quality-data predictions still show meaningfully higher
  // confidence than low-quality ones, even with the crisis reduction.
  const isHighQualityData = stabilityRaw > 0.70 && dataQuantityFactor > 0.70;
  if (isHighQualityData) {
    const floor = crisis.active ? 0.40 : 0.55;
    confidenceRaw = Math.max(confidenceRaw, floor);
  }

  const confidence = Math.round(confidenceRaw * 100);
  const confLabel = confidence >= 88 ? "Very High" : confidence >= 72 ? "High" :
    confidence >= 52 ? "Medium" : confidence >= 35 ? "Low" : "Very Low";


  // ── Expected ranges (bias + crisis corrected, for display) ────────────────
  // BUG FIX: same midpoint-preserving shift as in buildNextTransition.
  // Previously applied crisis.offShift uniformly to both bounds, compressing
  // the range AND dragging it outside observed data. Now shifts only the
  // midpoint while keeping the range width constant.
  const rawMidOff = (stats.p25Off + stats.p75Off) / 2;
  const rawHalfOff = (stats.p75Off - stats.p25Off) / 2;
  const shiftedMidOff = rawMidOff + (crisis.active ? crisis.offShift : 0);
  const correctedP25Off = Math.max(5, (shiftedMidOff - rawHalfOff)) * biasRatio.ratio;
  const correctedP75Off = (shiftedMidOff + rawHalfOff) * biasRatio.ratio;

  const rawMidOn = stats.p25On !== null && stats.p75On !== null ? (stats.p25On + stats.p75On) / 2 : null;
  const rawHalfOn = stats.p25On !== null && stats.p75On !== null ? (stats.p75On - stats.p25On) / 2 : null;
  const shiftedMidOn = rawMidOn !== null ? rawMidOn + (crisis.active ? crisis.onShift : 0) : null;
  const correctedP25On = shiftedMidOn !== null && rawHalfOn !== null ? Math.max(5, (shiftedMidOn - rawHalfOn)) * biasRatio.ratio : null;
  const correctedP75On = shiftedMidOn !== null && rawHalfOn !== null ? (shiftedMidOn + rawHalfOn) * biasRatio.ratio : null;

  const expectedOffRange = {
    minMin: Math.round(correctedP25Off),
    maxMin: Math.round(correctedP75Off),
    label: `${fmtMin(correctedP25Off)} → ${fmtMin(correctedP75Off)}`,
  };
  const expectedOnRange = correctedP25On !== null && correctedP75On !== null ? {
    minMin: Math.round(correctedP25On),
    maxMin: Math.round(correctedP75On),
    label: `${fmtMin(correctedP25On)} → ${fmtMin(correctedP75On)}`,
  } : null;

  // ── Day schedule — low-confidence projection only (Phase 10) ──────────────
  const daySchedule = generateDaySchedule(
    now, currentlyOn, currentStateDurationMin, stats, crisis, biasRatio,
  );

  // ── Legacy day/night split fields for existing UI (Phase 14) ──────────────
  const dayCycles = cycles.filter((c) => c.yemenHourAtStart >= 6 && c.yemenHourAtStart < 18);
  const nightCycles = cycles.filter((c) => c.yemenHourAtStart < 6 || c.yemenHourAtStart >= 18);
  const dayStats = dayCycles.length > 0 ? toPatternStats(blendWithColdStart(computeWeightedDistStats(dayCycles))) : null;
  const nightStats = nightCycles.length > 0 ? toPatternStats(blendWithColdStart(computeWeightedDistStats(nightCycles))) : null;
  const allStats = toPatternStats(stats);

  const nowYemenH = yemenHour(now.toISOString());

  // ── Reasoning (Phase 12) ────────────────────────────────────────────────────
  const reasoning: string[] = [];

  if (cycles.length === 0) {
    reasoning.push(`No complete utility cycles found in the last ${DATA_WINDOW_DAYS} days — using a cold-start estimate.`);
    reasoning.push(`System will learn from your grid as events accumulate.`);
  } else {
    reasoning.push(`Analyzed ${cycles.length} cycle${cycles.length !== 1 ? "s" : ""} from the last ${DATA_WINDOW_DAYS} days, weighted toward the most recent hours.`);

    const offRangeStr = `${fmtMin(correctedP25Off)}–${fmtMin(correctedP75Off)}`;
    reasoning.push(`Expected outage length: ${offRangeStr} (P25–P75, bias-corrected).`);

    if (correctedP25On !== null && correctedP75On !== null) {
      reasoning.push(`Expected ON duration: ${fmtMin(correctedP25On)}–${fmtMin(correctedP75On)}.`);
    }

    if (driftOffset.sampleCount > 0) {
      reasoning.push(
        driftOffset.offsetMin === 0
          ? `Recent predictions have been on time — no drift correction needed.`
          // v4.4 FIX: With errorMinutes = actual - predicted:
          //   offsetMin > 0 → events were late → predictions were EARLY (not "late" as v4.2 said)
          //   offsetMin < 0 → events were early → predictions were LATE (not "early" as v4.2 said)
          : `Recent predictions have been averaging ${fmtMin(Math.abs(driftOffset.offsetMin))} ${driftOffset.offsetMin > 0 ? "early" : "late"}. Drift correction applied.`
      );
    }

    // v4.4 — Surface sign-symmetry diagnostic when relevant.
    // If the cap was skipped because dominant errors had a consistent sign,
    // the user should know real drift is being fully corrected (not polling
    // noise). Otherwise, if the cap actually fired, explain the halving.
    if (driftResult.quantizationRatio > DRIFT_QUANTIZATION_THRESHOLD && !driftResult.quantizationSignSymmetric) {
      reasoning.push(`Drift correction applied at full strength (${fmtSignedMin(driftResult.offsetMin)}) — ${Math.round(driftResult.quantizationRatio * 100)}% of recent errors clustered on ${fmtSignedMin(driftResult.dominantError)} with a consistent direction, indicating real drift rather than polling noise.`);
    } else if (driftResult.capApplied) {
      reasoning.push(`Drift correction capped at ${fmtMin(Math.abs(driftResult.offsetMin))} — ${Math.round(driftResult.quantizationRatio * 100)}% of recent errors clustered on ${fmtSignedMin(driftResult.dominantError)} with mixed signs (likely polling-resolution artifact), so the offset was halved to avoid over-correction.`);
    }

    if (biasRatio.sampleCount > 0 && Math.abs(1 - biasRatio.ratio) > 0.03) {
      reasoning.push(
        `Duration bias ratio currently ${biasRatio.ratio.toFixed(2)}. Predicted durations ${biasRatio.ratio < 1 ? "shortened" : "lengthened"} by ${Math.round(Math.abs(1 - biasRatio.ratio) * 100)}%.`
      );
    }

    reasoning.push(`Volatility: ${volatilityLabel} (EMA ${Math.round(volatilityEMA)} min).`);

    if (crisis.active && crisis.reason) {
      reasoning.push(`⚠️ تصحيح الأزمة نشط: ${crisis.reason}`);
    }

    reasoning.push(`Pattern: ${stabLabel} (${stabilityScore}%, MAD-based). Confidence: ${confLabel} (${confidence}%).`);

    if (currentStateDurationMin > 0) {
      reasoning.push(`Grid has been ${currentlyOn ? "ON" : "OFF"} for ${fmtMin(currentStateDurationMin)}.`);
    }

    reasoning.push(`Learning strength: ${Math.round(dataQuantityFactor * 100)}% (OFF: ${stats.effectiveWeightedSamples.toFixed(1)}, ON: ${stats.effectiveWeightedSamplesOn.toFixed(1)} effective weighted samples).`);
  }

  if (isUnstable && cycles.length > 0) {
    reasoning.push("High volatility or crisis conditions detected — prediction ranges are wider than usual.");
  }

  // v4.2 FIX: Removed `!crisis.active` from the condition. The previous
  // condition (isHighQualityData && !crisis.active) meant the "high
  // uncertainty" warning fired whenever crisis was active, even if the
  // underlying data was strong. Now: high-quality data shows the
  // "tightened to match recent consistency" message regardless of crisis.
  if (nextTransition?.rangeWasClamped) {
    if (isHighQualityData) {
      reasoning.push("Range tightened by MAD-tiered cap — underlying pattern is stable, but the displayed window was narrowed to match this state's typical variance.");
    } else {
      reasoning.push("⚠️ Underlying uncertainty was high — the displayed window was compressed to stay usable, but treat this prediction loosely rather than precisely.");
    }
  }

  if (nextTransition?.realityClamped) {
    reasoning.push("Reality Duration Constraints adjusted the prediction — an upstream correction pushed the estimate outside what recent real cycles support, so it was pulled back to a physically plausible range.");
  }

  // v4.2 — Surface the client-row filter when it removed contaminated rows
  if (historyResult.clientRowsFiltered > 0) {
    reasoning.push(`Filtered out ${historyResult.clientRowsFiltered} client-side "pending_offset" diagnostic rows from history (these are not real predictions — they represent the client's pre-correction state and would skew drift/crisis math).`);
  }

  // ── Learning mode (kept for legacy UI, now driven by the weaker of the
  // two effective sample counts since OFF/ON now learn independently) ──────
  const minEffectiveSamples = Math.min(stats.effectiveWeightedSamples, stats.effectiveWeightedSamplesOn);
  const learningMode = minEffectiveSamples < 4 ? "prior_only"
    : minEffectiveSamples < 10 ? "hybrid"
    : "learned";

  // ── Assemble prediction (Phase 14 — preserve existing response shape) ─────
  const prediction = {
    currentState: currentlyOn ? "ON" : "OFF",
    currentStateDurationMin,
    currentStateDurationLabel: fmtMin(currentStateDurationMin),
    lastTransitionAt,
    inverterOffline: invState?.inverter_offline ?? false,

    nextTransition,
    expectedOffRange,
    expectedOnRange,
    daySchedule,

    confidence,
    confidenceLabel: confLabel,
    isUnstable,
    stabilityScore,
    stabilityLabel: stabLabel,

    // Legacy fields for existing UI compatibility
    dayPattern: dayStats,
    nightPattern: nightStats,
    allPattern: allStats,
    cyclesAnalyzed: cycles.length,
    dayCyclesAnalyzed: dayCycles.length,
    nightCyclesAnalyzed: nightCycles.length,
    currentPeriod: (nowYemenH >= 6 && nowYemenH < 18) ? "day" : "night",

    reasoning,
    learningMode,
    dataWindowHours: DATA_WINDOW_HOURS,
    computedAt: now.toISOString(),

    // Phase 14 — new v4/v4.1/v4.2 fields, additive under apppe
    apppe: {
      version: "4.4",
      driftOffset: driftOffset.offsetMin,
      driftSampleCount: driftOffset.sampleCount,
      // v4.2 NEW: Quantization diagnostics. If quantizationRatio > 0.5,
      // the drift offset was capped at half the dominant error value.
      // Monitor this — if it's consistently firing, your client's polling
      // interval is too coarse relative to the grid's transition timing.
      driftQuantizationRatio: driftResult.quantizationRatio,
      driftDominantError: driftResult.dominantError,
      // v4.4 NEW: Sign-symmetry diagnostic. If false, the dominant error
      // had a consistent sign (real drift) and the cap was correctly
      // skipped. If true, dominant errors were sign-symmetric (polling
      // noise) and the cap could fire.
      driftQuantizationSignSymmetric: driftResult.quantizationSignSymmetric,
      // v4.4 NEW: Whether the cap actually fired and reduced the offset.
      // If false with high quantizationRatio + sign-asymmetric, real drift
      // is being fully corrected (good).
      driftCapApplied: driftResult.capApplied,
      // v4.4 NEW: The threshold used by detectConsecutiveErrorCrisis().
      consecutiveErrorThreshold: CONSECUTIVE_ERROR_THRESHOLD_MIN,
      // Diagnostic: the actual signed error values (minutes, actual-predicted)
      // drift correction is computing from. If these all cluster in one
      // direction (e.g. all around +30 to +60), that confirms a real,
      // correctable systematic offset — and the median above should be
      // moving to compensate. If this list looks wrong (e.g. all values
      // suspiciously identical, or sign doesn't match what you observe in
      // reality), that points to a data-quality issue in the source table
      // rather than the correction math itself.
      driftSampleErrors: history.slice(0, DRIFT_HISTORY_SIZE).map((h) => Math.round(h.errorMinutes)),
      biasRatio: Math.round(biasRatio.ratio * 100) / 100,
      biasSampleCount: biasRatio.sampleCount,
      volatilityEMA: Math.round(volatilityEMA * 10) / 10,
      volatilityLabel,
      crisisActive: crisis.active,
      crisisReason: crisis.reason,
      crisisShift: { off: Math.round(crisis.offShift), on: Math.round(crisis.onShift) },
      learningStrength: Math.round(dataQuantityFactor * 100),
      effectiveWeightedSamples: Math.round(stats.effectiveWeightedSamples * 10) / 10,
      effectiveWeightedSamplesOn: Math.round(stats.effectiveWeightedSamplesOn * 10) / 10,
      madOff: stats.madOff,
      madOn: stats.madOn,
      predictionQuality: {
        dataQuantityFactor: Math.round(dataQuantityFactor * 100),
        stabilityFactor: Math.round(stabilityRaw * 100),
        driftStabilityFactor: Math.round(driftStabilityFactor * 100),
        biasStabilityFactor: Math.round(biasStabilityFactor * 100),
        volatilityFactor: Math.round(volatilityFactor * 100),
        // v4.2: Renamed from `crisisFactor` to `crisisPenalty` for clarity.
        // Reflects the multiplicative penalty applied to confidence during
        // crisis (65 = 35% reduction). 100 = no penalty.
        crisisPenalty: crisis.active ? Math.round(crisisMultiplier * 100) : 100,
      },
      historySource: HISTORY_SOURCE,
      rangeWasClamped: nextTransition?.rangeWasClamped ?? false,
      realityClamped: nextTransition?.realityClamped ?? false,
      // v4.2 NEW: History loading diagnostics. Lets you monitor whether
      // the dedup filter and client-row filter are catching contamination.
      // If `clientRowsFiltered` is consistently > 0, the client write-path
      // bug (R2) is still active and should be fixed.
      historyDiagnostics: {
        rawRowsFetched: historyResult.rawRowsFetched,
        duplicateRowsCollapsed: historyResult.duplicateRowsCollapsed,
        clientRowsFiltered: historyResult.clientRowsFiltered,
        unparseableRowsSkipped: historyResult.unparseableRowsSkipped,
        uniqueRowsUsed: history.length,
      },
    },
  };

  // ── Upsert to database (unchanged shape from v3) ──────────────────────────
  const { error: upsertErr } = await supabase.from("utility_predictions").upsert({
    id: 1,
    computed_at: now.toISOString(),
    prediction,
    analysis_window_hours: DATA_WINDOW_HOURS,
  });

  if (upsertErr) {
    return new Response(JSON.stringify({ error: upsertErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      cycles: cycles.length,
      crisisMode: crisis.active,
      driftOffset: driftOffset.offsetMin,
      biasRatio: biasRatio.ratio,
      volatility: volatilityLabel,
      // v4.2 NEW: Surface the new diagnostics in the response summary
      driftQuantizationRatio: driftResult.quantizationRatio,
      clientRowsFiltered: historyResult.clientRowsFiltered,
      duplicateRowsCollapsed: historyResult.duplicateRowsCollapsed,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
