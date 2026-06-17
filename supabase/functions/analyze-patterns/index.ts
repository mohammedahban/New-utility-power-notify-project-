// analyze-patterns Edge Function — APPPE v4.0
// Adaptive Drift-Correcting Prediction Engine
// Replaces: APPPE v3.0 fixed-hour profile blending (51% accuracy, declining trend)
// Uses: drift offset correction, duration bias correction, exponential recency
//       weighting, crisis recentering, MAD-based stability, and a single
//       transition-focused forecast as the authoritative output.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG FLAGS
// ─────────────────────────────────────────────────────────────────────────────

// Where do drift/bias history come from?
//   "accuracy_log"  -> read/write the existing accuracy-log-style table that
//                       produced your export (predicted_time/actual_time/
//                       error_minutes/predicted_state/accuracy_score).
//   "dedicated"      -> read/write a new prediction_history table with a
//                       richer schema (errorMinutes, biasRatio, durationType,
//                       crisis flags, etc.) purpose-built for v4.
//
// Start with "accuracy_log" since that table already exists and is already
// being populated by your client (see the client_positive_offset_* slot_id
// values in the export) — zero migration needed to ship v4. Flip to
// "dedicated" once you're ready to retire the legacy table.
const HISTORY_SOURCE: "accuracy_log" | "dedicated" = "accuracy_log";

const ACCURACY_LOG_TABLE = "prediction_accuracy_log"; // adjust to your real table name
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

// Phase 6 — Volatility EMA
const VOLATILITY_EMA_ALPHA = 0.3;

// Phase 8 — Adaptive learning trust
//
// IMPORTANT: this threshold is compared against the SUM of exponentially
// decayed weights (weight = 0.5^(ageHours/24)), not a raw cycle count.
// With a 7-day window and cycles spaced a few hours apart, that sum
// saturates low — a realistic 19-cycle week sums to ~4-5, never near 15 —
// because anything older than ~2 days contributes almost nothing. Setting
// this too high means the model can NEVER reach full trust in real data,
// permanently blending in the cold-start prior regardless of how much
// history accumulates. Calibrated instead against "how much does a single
// very recent day's worth of cycles sum to" (roughly 3-6 cycles at
// near-1.0 weight), so a normal day or two of real data earns full trust.
const EFFECTIVE_SAMPLES_FOR_FULL_TRUST = 4;

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
// Calibrated to this grid's reported real-world bounds: OFF duration has
// never been observed under 4h, ON duration has never exceeded 2h20. The
// median sits comfortably inside those bounds rather than at a generic
// regional guess, so even a small residual prior-blend (see
// EFFECTIVE_SAMPLES_FOR_FULL_TRUST) nudges predictions in the right
// direction instead of away from it. Update these numbers if/when the
// grid's actual pattern shifts — this is meant to be a starting point for
// a brand-new install with zero history, not a long-term anchor.
const COLD_START_PRIOR = {
  medOff: 300, medOn: 100,
  p25Off: 240, p75Off: 360,
  p25On: 70, p75On: 130,
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
    // Recenter: shift the OFF median toward the recent reality, not just widen.
    const offShift = recentOffMed - baseOffMed;
    const onShift = (recentOnSamples.length >= 2 && baseOnSamples.length >= 2)
      ? recentOnMed - baseOnMed
      : 0;
    return {
      active: true,
      reason: `Outage durations increased by ${Math.round(offIncrease * 100)}% vs baseline — possible fuel shortage or schedule change. Prediction center shifted by ${fmtSignedMin(Math.round(offShift))}.`,
      offShift,
      onShift,
    };
  }

  if (onDecrease >= CRISIS_ON_DECREASE_PCT) {
    const onShift = recentOnMed - baseOnMed;
    const offShift = recentOffMed - baseOffMed;
    return {
      active: true,
      reason: `ON durations decreased by ${Math.round(onDecrease * 100)}% vs baseline — possible generator capacity issue. Prediction center shifted by ${fmtSignedMin(Math.round(onShift))}.`,
      offShift,
      onShift,
    };
  }

  return { active: false, reason: null, offShift: 0, onShift: 0 };
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
// PHASE 2 — DRIFT OFFSET ENGINE
// rollingMedianError = median(actual - predicted) over the last N completed
// predictions. Applied additively to the next transition forecast.
// ─────────────────────────────────────────────────────────────────────────────

function computeDriftOffset(historyNewestFirst: HistoryRow[]): { offsetMin: number; sampleCount: number } {
  const slice = historyNewestFirst.slice(0, DRIFT_HISTORY_SIZE);
  if (slice.length === 0) return { offsetMin: 0, sampleCount: 0 };

  // Exponentially weight by how long ago each completed prediction was made
  // (Phase 3 applies everywhere, including drift/bias history).
  const errs = slice.map((h) => h.errorMinutes);
  const wts = slice.map((h) => recencyWeight(h.ageHours));
  const offset = weightedMedian(errs, wts);

  return { offsetMin: Math.round(offset), sampleCount: slice.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — PREDICTION BIAS ENGINE
// durationBiasRatio = actualDuration / predictedDuration, applied BEFORE
// drift correction: Raw Prediction → Bias Correction → Drift Correction → Range.
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
  driftOffset: { offsetMin: number; sampleCount: number },
  volatilityEMA: number,
) {
  const type = currentlyOn ? "UTILITY_OFF" : "UTILITY_ON";

  // ── Step 0: raw expected total duration of current state ──────────────────
  let totalExpOff = stats.medianOff;
  let totalExpOn = stats.medianOn ?? stats.medianOff;
  let pLowOff = stats.p25Off, pHighOff = stats.p75Off;
  let pLowOn = stats.p25On ?? stats.p25Off, pHighOn = stats.p75On ?? stats.p75Off;

  // ── Step 1: crisis recentering happens on the base medians/ranges first ───
  if (crisis.active) {
    totalExpOff += crisis.offShift;
    totalExpOn += crisis.onShift;
    pLowOff += crisis.offShift;
    pHighOff += crisis.offShift;
    pLowOn += crisis.onShift;
    pHighOn += crisis.onShift;
  }

  // ── Step 2: bias correction (multiplicative, on durations) ────────────────
  const biasAdjOff = totalExpOff * biasRatio.ratio;
  const biasAdjOn = totalExpOn * biasRatio.ratio;
  const biasAdjPLowOff = pLowOff * biasRatio.ratio;
  const biasAdjPHighOff = pHighOff * biasRatio.ratio;
  const biasAdjPLowOn = pLowOn * biasRatio.ratio;
  const biasAdjPHighOn = pHighOn * biasRatio.ratio;

  const totalExp = currentlyOn ? biasAdjOn : biasAdjOff;
  const pLow = currentlyOn ? biasAdjPLowOn : biasAdjPLowOff;
  const pHigh = currentlyOn ? biasAdjPHighOn : biasAdjPHighOff;

  // ── Step 3: drift correction (additive, on the absolute predicted time) ───
  // remaining = (bias-corrected total) - elapsed, then drift is added on top
  // of the resulting timestamp, exactly as specified: correctedPrediction =
  // basePrediction + rollingMedianError.
  let minRemaining = Math.max(0, pLow - currentStateDurationMin);
  let maxRemaining = Math.max(minRemaining + 5, pHigh - currentStateDurationMin);
  let midRemaining = Math.max(0, totalExp - currentStateDurationMin);

  // ── Step 4: widen ranges for instability/volatility/crisis ────────────────
  // BUG FIX: previously each condition multiplied maxRemaining/minRemaining
  // independently and in sequence (stability x1.4, then volatility x1.25,
  // then crisis x1.6 — a combined ~x2.8 on the high end and ~x0.42 on the
  // low end). Because these conditions overlap often (a thin-data, slightly
  // unstable grid easily trips two or three at once), a 28-minute base range
  // could balloon past 4 hours — turning a usable prediction into a window
  // too wide to plan around, which defeats the app's purpose.
  //
  // Fix: compute one combined "uncertainty multiplier" from whichever
  // conditions are active, using a square-root combination instead of
  // straight multiplication so multiple simultaneous signals don't compound
  // linearly, then apply it once and cap the total widening.
  const stabilityWidenFactor = stats.stabilityScore < 0.45 ? 1.4 : 1.0;
  const volatilityWidenFactor = volatilityEMA >= 70 ? 1.5 : volatilityEMA >= 35 ? 1.25 : 1.0;
  const crisisWidenFactor = crisis.active ? 1.6 : 1.0;

  // sqrt-combination: if all three factors-above-1 are present, the combined
  // effect is much less than their product, while still being more than any
  // single factor alone. Equivalent to treating each "excess uncertainty"
  // contribution as adding in quadrature rather than multiplying serially.
  const excessSq =
    Math.pow(stabilityWidenFactor - 1, 2) +
    Math.pow(volatilityWidenFactor - 1, 2) +
    Math.pow(crisisWidenFactor - 1, 2);
  const combinedWidenFactor = Math.min(1.8, 1 + Math.sqrt(excessSq)); // hard cap: never more than 1.8x the base spread

  // Narrowing on the low end uses the inverse of the same combined factor,
  // also capped, so the window doesn't collapse toward zero at the same
  // time the high end balloons.
  const combinedNarrowFactor = Math.max(0.55, 1 / combinedWidenFactor);

  maxRemaining = maxRemaining * combinedWidenFactor;
  minRemaining = Math.max(0, minRemaining * combinedNarrowFactor);

  // Absolute safety cap: regardless of how the math above works out, the
  // total displayed range must stay within something a user can actually
  // plan around (e.g. "wait or go run an errand"). 90 minutes was chosen as
  // the ceiling — beyond that, a range stops being a usable prediction and
  // starts looking like the app doesn't know what it's doing, which erodes
  // trust faster than an honest "Low confidence" label does.
  const MAX_RANGE_WIDTH_MIN = 90; // 1.5 hours
  let rangeWasClamped = false;
  if (maxRemaining - minRemaining > MAX_RANGE_WIDTH_MIN) {
    const center = (minRemaining + maxRemaining) / 2;
    minRemaining = Math.max(0, center - MAX_RANGE_WIDTH_MIN / 2);
    maxRemaining = center + MAX_RANGE_WIDTH_MIN / 2;
    rangeWasClamped = true;
  }

  // Apply drift offset additively to the predicted timestamp (in minutes-from-now terms).
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
    rangeWasClamped, // true if the 90-min cap had to compress an otherwise wider range — signals reduced trust even though the displayed window looks tight
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
// ─────────────────────────────────────────────────────────────────────────────

async function loadHistory(
  supabase: ReturnType<typeof createClient>,
  now: Date,
): Promise<HistoryRow[]> {
  if (HISTORY_SOURCE === "accuracy_log") {
    // Read from the existing log table — same shape as your accuracy export:
    // predicted_state, predicted_time, actual_time, error_minutes.
    // Duration-specific fields (predicted_duration_min/actual_duration_min)
    // are optional columns; if absent, bias correction simply sees 0 samples
    // and falls back to ratio=1 (no-op) until you add them.
    const { data, error } = await supabase
      .from(ACCURACY_LOG_TABLE)
      .select("predicted_state, predicted_time, actual_time, error_minutes, predicted_duration_min, actual_duration_min, duration_type")
      .order("actual_time", { ascending: false })
      .limit(Math.max(DRIFT_HISTORY_SIZE, BIAS_HISTORY_SIZE) * 2); // headroom before filtering

    if (error || !data) return [];

    return data.map((row: any) => ({
      predictedType: row.predicted_state,
      predictedTimeIso: row.predicted_time,
      actualTimeIso: row.actual_time,
      errorMinutes: row.error_minutes != null
        ? (new Date(row.actual_time).getTime() > new Date(row.predicted_time).getTime() ? 1 : -1) * Math.abs(row.error_minutes)
        : (new Date(row.actual_time).getTime() - new Date(row.predicted_time).getTime()) / 60000,
      ageHours: Math.max(0, (now.getTime() - new Date(row.actual_time).getTime()) / 3_600_000),
      durationType: row.duration_type ?? null,
      predictedDurationMin: row.predicted_duration_min ?? null,
      actualDurationMin: row.actual_duration_min ?? null,
    }));
  }

  // "dedicated" — new purpose-built table.
  const { data, error } = await supabase
    .from(DEDICATED_HISTORY_TABLE)
    .select("predicted_type, predicted_time, actual_time, error_minutes, duration_type, predicted_duration_min, actual_duration_min")
    .order("actual_time", { ascending: false })
    .limit(Math.max(DRIFT_HISTORY_SIZE, BIAS_HISTORY_SIZE) * 2);

  if (error || !data) return [];

  return data.map((row: any) => ({
    predictedType: row.predicted_type,
    predictedTimeIso: row.predicted_time,
    actualTimeIso: row.actual_time,
    errorMinutes: row.error_minutes,
    ageHours: Math.max(0, (now.getTime() - new Date(row.actual_time).getTime()) / 3_600_000),
    durationType: row.duration_type ?? null,
    predictedDurationMin: row.predicted_duration_min ?? null,
    actualDurationMin: row.actual_duration_min ?? null,
  }));
}

// Writes this cycle's completed-prediction outcome back to history once we
// can observe what actually happened (called from the polling/event-ingest
// function, NOT from analyze-patterns itself — analyze-patterns only reads).
// Included here for reference / so the schema lives next to the reader.
async function recordCompletedPrediction(
  supabase: ReturnType<typeof createClient>,
  row: {
    predictedType: "UTILITY_ON" | "UTILITY_OFF";
    predictedTimeIso: string;
    actualTimeIso: string;
    durationType?: "OFF" | "ON";
    predictedDurationMin?: number;
    actualDurationMin?: number;
  },
) {
  const errorMinutes = (new Date(row.actualTimeIso).getTime() - new Date(row.predictedTimeIso).getTime()) / 60000;

  if (HISTORY_SOURCE === "accuracy_log") {
    return supabase.from(ACCURACY_LOG_TABLE).insert({
      predicted_state: row.predictedType,
      predicted_time: row.predictedTimeIso,
      actual_time: row.actualTimeIso,
      error_minutes: Math.abs(errorMinutes),
      duration_type: row.durationType ?? null,
      predicted_duration_min: row.predictedDurationMin ?? null,
      actual_duration_min: row.actualDurationMin ?? null,
    });
  }

  return supabase.from(DEDICATED_HISTORY_TABLE).insert({
    predicted_type: row.predictedType,
    predicted_time: row.predictedTimeIso,
    actual_time: row.actualTimeIso,
    error_minutes: errorMinutes,
    duration_type: row.durationType ?? null,
    predicted_duration_min: row.predictedDurationMin ?? null,
    actual_duration_min: row.actualDurationMin ?? null,
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

  // ── Crisis detection + recentering (Phase 5) ───────────────────────────────
  const crisis = detectAndRecenterCrisis(cycles);

  // ── History for drift/bias engines (Phase 13, behind HISTORY_SOURCE flag) ──
  const history = await loadHistory(supabase, now); // already sorted newest-first

  // ── Bias correction (Phase 4) — applied before drift, per spec ────────────
  const biasOff = computeBiasRatio(history, "OFF");
  const biasOn = computeBiasRatio(history, "ON");
  // Single ratio used downstream; if ON-specific data is too sparse, fall
  // back to the OFF ratio rather than defaulting silently to 1.0.
  const biasRatio = biasOn.sampleCount >= 3 ? biasOn : (biasOff.sampleCount >= 3 ? biasOff : { ratio: 1, sampleCount: 0 });

  // ── Drift offset (Phase 2) ─────────────────────────────────────────────────
  const driftOffset = computeDriftOffset(history);

  // ── Volatility EMA (Phase 6) ───────────────────────────────────────────────
  const volatilityEMA = computeVolatilityEMA(history);
  const volatilityLabel = volatilityToLabel(volatilityEMA);

  // ── Stability / confidence (Phase 7 + Phase 11) ────────────────────────────
  const stabilityRaw = stats.stabilityScore;
  const isUnstable = stabilityRaw < 0.28 || crisis.active || volatilityEMA >= 70;
  const stabilityScore = Math.round(stabilityRaw * 100);
  const stabLabel = stabilityRaw >= 0.75 ? "Stable" : stabilityRaw >= 0.45 ? "Slightly Unstable" : "Unstable";

  // ── Next transition — the authoritative forecast (Phase 9) ────────────────
  // Built before final confidence so a clamped range can demote confidence.
  let nextTransition: (ReturnType<typeof buildNextTransition>) | null = null;
  if (!isUnstable || cycles.length >= 2) {
    nextTransition = buildNextTransition(
      now, currentlyOn, currentStateDurationMin, stats, crisis, biasRatio, driftOffset, volatilityEMA,
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
  const crisisFactor = crisis.active ? 0.5 : 1;

  let confidenceRaw =
    dataQuantityFactor * 0.30 +
    stabilityRaw * 0.25 +
    driftStabilityFactor * 0.15 +
    biasStabilityFactor * 0.10 +
    volatilityFactor * 0.15 +
    crisisFactor * 0.05;

  confidenceRaw = Math.min(0.97, confidenceRaw);
  if (isUnstable) confidenceRaw = Math.min(confidenceRaw, 0.30);

  // BUG FIX (range-width vs. confidence mismatch): if the 90-minute range
  // cap had to compress what would otherwise have been a much wider window,
  // the displayed range looks deceptively tight unless confidence reflects
  // that compression. Without this, a user could see "9:00–10:30am, High
  // confidence" when the underlying uncertainty was actually enormous.
  if (nextTransition?.rangeWasClamped) {
    confidenceRaw = Math.min(confidenceRaw, 0.35);
  }

  const confidence = Math.round(confidenceRaw * 100);
  const confLabel = confidence >= 88 ? "Very High" : confidence >= 72 ? "High" :
    confidence >= 52 ? "Medium" : confidence >= 35 ? "Low" : "Very Low";


  // ── Expected ranges (bias + crisis corrected, for display) ────────────────
  const correctedP25Off = (stats.p25Off + (crisis.active ? crisis.offShift : 0)) * biasRatio.ratio;
  const correctedP75Off = (stats.p75Off + (crisis.active ? crisis.offShift : 0)) * biasRatio.ratio;
  const correctedP25On = stats.p25On !== null ? (stats.p25On + (crisis.active ? crisis.onShift : 0)) * biasRatio.ratio : null;
  const correctedP75On = stats.p75On !== null ? (stats.p75On + (crisis.active ? crisis.onShift : 0)) * biasRatio.ratio : null;

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
          : `Recent predictions have been averaging ${fmtMin(Math.abs(driftOffset.offsetMin))} ${driftOffset.offsetMin > 0 ? "late" : "early"}. Drift correction applied.`
      );
    }

    if (biasRatio.sampleCount > 0 && Math.abs(1 - biasRatio.ratio) > 0.03) {
      reasoning.push(
        `Duration bias ratio currently ${biasRatio.ratio.toFixed(2)}. Predicted durations ${biasRatio.ratio < 1 ? "shortened" : "lengthened"} by ${Math.round(Math.abs(1 - biasRatio.ratio) * 100)}%.`
      );
    }

    reasoning.push(`Volatility: ${volatilityLabel} (EMA ${Math.round(volatilityEMA)} min).`);

    if (crisis.active && crisis.reason) {
      reasoning.push(`⚠️ Crisis recentering active: ${crisis.reason}`);
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

  if (nextTransition?.rangeWasClamped) {
    reasoning.push("⚠️ Underlying uncertainty was very high — the displayed window was compressed to stay usable, but treat this prediction as Low confidence rather than precise.");
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

    confidence: isUnstable ? Math.min(confidence, 30) : confidence,
    confidenceLabel: isUnstable ? "Low" : confLabel,
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

    // Phase 14 — new v4 fields, additive under apppe
    apppe: {
      version: "4.0",
      driftOffset: driftOffset.offsetMin,
      driftSampleCount: driftOffset.sampleCount,
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
        crisisFactor: Math.round(crisisFactor * 100),
      },
      historySource: HISTORY_SOURCE,
      rangeWasClamped: nextTransition?.rangeWasClamped ?? false,
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
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
