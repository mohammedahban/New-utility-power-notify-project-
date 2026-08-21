/**
 * analyze-patterns — APPPE v6 "Circadian Kernel Model"
 *
 * Triggered automatically by poll-growatt on every Growatt state change.
 * Also runs on schedule (cron) and manual invocation from admin dashboard.
 *
 * Pipeline:
 *   1. Load power_events (36h state window + 80-day learning window)
 *   2. Extract ON/OFF cycles (counter-state blips < 12 min merged for stats)
 *   3. Gentle recency weighting (half-life 60 DAYS): backtesting on the full
 *      event history showed the city's regime is stable for months, so long
 *      memory beats fast forgetting. Regime breaks (fuel crises) are handled
 *      by the crisis detector + deadbanded drift corrector, not by shrinking
 *      the window.
 *   4. OFF-duration model: circular Gaussian kernel regression over the
 *      Aden start-hour (σ = 1.75h), recency-weighted, shrunk toward the
 *      global weighted mean (κ = 1.75). NO day/night split and no fixed
 *      bucket edges — both were backtested and lost:
 *        - day/night means (the v4/v5 fallback): OFF MAE ≈ 59 min
 *        - this kernel model:                       OFF MAE ≈ 33 min (−45%)
 *      The measured reality (77 days): morning OFFs ≈ 5.3h, evening OFFs
 *      ≈ 8.6h — a smooth curve the coarse splits could not express with
 *      only ~6 effective samples per bucket.
 *   5. ON-duration model: single recency-weighted mean. Measured ON duration
 *      is 125 ± 13 min regardless of hour — day/night splits add nothing.
 *   6. Drift correction with DEADBAND (|median| ≥ 15 min, ≥ 8 samples):
 *      absorbs genuine regime offsets but ignores stable-regime noise
 *      (backtest showed unconditional drift only adds variance).
 *   6b. SHOCK detector (v6.1): sudden fuel/weather/breakdown regime breaks.
 *      In-run layer extends the CURRENT outage the moment it exceeds its
 *      hour-matched band (expected + max(90min, 1.75*sd)); persistent layer
 *      shifts all future OFFs when 2 of the last 3 completed runs break the
 *      pattern (median residual, clamped ±240 min). Auto-clears on recovery.
 *   7. Bias ratios learned ONLY from clean snapshot accuracy rows.
 *   8. Generate 24h schedule with PER-SLOT durations; data-driven ranges.
 *   9. Accuracy logging v2 (snapshot & resolve) + prediction horizon.
 *  10. Write result to utility_predictions (id = 1, upsert).
 *  11. v6.2 phase-group models: ONE shared pipeline module
 *      (computePhaseModel) is re-run per offset-hour group (+5…+9, −3…−7 —
 *      intentionally asymmetric) over the phase-shifted event stream, each
 *      producing its own stats/curves/schedule/confidence. Embedded as
 *      prediction.phaseModels; they never write accuracy rows — all learning
 *      stays exclusive to the base Growatt model.
 *
 * IMPORTANT: This function must remain deployed at all times.
 * poll-growatt calls it automatically after every state change detection.
 * Without it, utility_predictions never updates and all user app states freeze.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// ── Supabase client (service role) ───────────────────────────────────────────
function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

// ── Constants ────────────────────────────────────────────────────────────────
const ANALYSIS_WINDOW_HOURS = 36;      // state-detection window (recent events)
const LEARNING_WINDOW_DAYS = 80;       // duration-learning window (≈ all history)
const MIN_CYCLES_FOR_LEARNING = 3;
const MAX_DRIFT_SAMPLES = 20;
const VOLATILITY_EMA_ALPHA = 0.3;
const CRISIS_THRESHOLD_PCT = 0.40;     // 40% change triggers crisis mode
const SCHEDULE_AHEAD_HOURS = 24;

// v6 model constants
const BLIP_MERGE_MIN = 12;             // counter-state runs shorter than this are noise
const RECENCY_HALFLIFE_HOURS = 60 * 24; // 60 DAYS — regime is stable for months;
                                        // fast forgetting was v5's core weakness
const KERNEL_SIGMA_HOURS = 1.75;       // circular Gaussian kernel bandwidth over
                                       // the OFF-start hour-of-day (backtested)
const GLOBAL_SHRINK_K = 1.75;          // pseudo-weight pulling kernel estimate
                                       // toward the global mean (backtested)
const DRIFT_MAX_ABS_MIN = 45;          // drift correction clamp
const DRIFT_MIN_SAMPLES = 8;           // was 4 — noisier than useful
const DRIFT_DEADBAND_MIN = 15;         // |median error| below this = noise, no drift
// v6.1 shock detector — fuel shortages / cloudy days / breakdowns
const SHOCK_SD_MULT = 1.75;            // flag when |resid| > max(SHOCK_MIN_RESID_MIN, 1.75*localSd)
const SHOCK_MIN_RESID_MIN = 90;
const SHOCK_LOOKBACK = 3;              // completed OFF runs examined for a persistent shift
const SHOCK_MIN_FLAGGED = 2;           // of the last 3 → persistent regime break
const SHOCK_MAX_SHIFT_MIN = 240;
const SHOCK_INRUN_BUFFER_MIN = 45;     // extension granularity while an anomalous run continues
const BIAS_MIN_SAMPLES = 4;
const BIAS_CLAMP_MIN = 0.5;
const BIAS_CLAMP_MAX = 2.0;
const OFF_DUR_MIN_CLAMP = 5;
const OFF_DUR_MAX_CLAMP = 900;         // real night OFFs can exceed 8h
const ON_DUR_MIN_CLAMP = 10;
const ON_DUR_MAX_CLAMP = 480;
const MAX_ALLOWED_ERROR_MIN = 180;     // accuracy score scale
const SNAPSHOT_MAX_AGE_HOURS = 36;
const SNAPSHOT_CAP = 40;
const SNAPSHOT_MATCH_TOLERANCE_MS = 6 * 3600_000;

// ── v6.2 phase-group models ─────────────────────────────────────────────────
// Dedicated per-phase prediction models, all produced by ONE shared pipeline
// module (computePhaseModel below) — only the phase offset VALUE changes
// between runs; there is no per-model system. The groups are INTENTIONALLY
// ASYMMETRIC (product decision — do not normalize):
//   POSITIVE offsets: dedicated models for +5h … +9h only
//                     (+1h … +4h keep using the base model + full offset)
//   NEGATIVE offsets: dedicated models for −3h … −7h only
//                     (−1h … −2h keep using the base model + full offset)
// The base sensor model (offset 0) remains the ONLY model that learns:
// pattern learning, drift/bias correction, crisis/shock detection outputs and
// accuracy logging stay exclusive to it. Phase models never write to
// prediction_accuracy_logs and never register snapshots.
// NOTE: the same list is declared client-side in lib/phaseGroups.ts
// (edge functions cannot import app code) — keep the two in sync.
const PHASE_GROUP_OFFSETS_HOURS: readonly number[] = [
  5, 6, 7, 8, 9,      // positive phases
  -3, -4, -5, -6, -7, // negative phases
];

// ── Types ────────────────────────────────────────────────────────────────────
interface PowerEvent {
  id: number;
  event_type: "UTILITY_ON" | "UTILITY_OFF";
  occurred_at: string;
  vac?: number;
  pac_to_user?: number;
  status_text?: string;
}

interface Cycle {
  state: "ON" | "OFF";
  startMs: number;
  endMs: number;
  durationMin: number;
  period: "day" | "night";
  censored: boolean; // still-active run (right-censored) — excluded from duration stats
}

interface AccuracyLogRow {
  predicted_event_time: string;
  actual_event_time: string;
  error_minutes: number;
  accuracy_score: number;
  duration_type: string | null;
  predicted_duration_min: number | null;
  actual_duration_min: number | null;
  confidence_score: number | null;
  slot_id: string | null;
  created_at: string;
}

interface PatternStats {
  cycles: number;
  avgOffMin: number;
  stdDevOffMin: number;
  avgOnMin: number | null;
  stdDevOnMin: number | null;
  minOffMin: number;
  maxOffMin: number;
  minOnMin: number | null;
  maxOnMin: number | null;
}

interface PredictionSnapshot {
  id: string;                 // snap_<TYPE>_<predictedIso>
  type: "UTILITY_ON" | "UTILITY_OFF";
  predictedIso: string;       // predicted transition time (slot start)
  slotDurationMin: number;    // FULL predicted duration of the slot that STARTS at predictedIso
  generatedAt: string;        // when this prediction was live
  confidence: number;
}

interface ScheduleSlot {
  state: "ON" | "OFF";
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function adenHourFloat(ms: number): number {
  // Fractional hour (0–24) in Asia/Aden, computed arithmetically (UTC+3, no DST)
  const adenMs = ms + 3 * 3600_000;
  const dayMs = ((adenMs % 86_400_000) + 86_400_000) % 86_400_000;
  return dayMs / 3600_000;
}

function getPeriod(ms: number): "day" | "night" {
  const h = adenHourFloat(ms);
  return h >= 6 && h < 20 ? "day" : "night";
}

function fmtYemenTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "Asia/Aden",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).replace("AM", " ص").replace("PM", " م");
}

function durationLabel(min: number): string {
  if (min <= 0) return "0د";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? "ساعة" : `${h}س`;
  return `${h}س ${m}د`;
}

// ── Stats helpers ─────────────────────────────────────────────────────────────
function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function mad(arr: number[]): number {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  return mean(arr.map(v => Math.abs(v - m)));
}

function weightedMean(arr: number[], weights: number[]): number {
  const totalW = weights.reduce((s, w) => s + w, 0);
  if (totalW === 0) return 0;
  return arr.reduce((s, v, i) => s + v * weights[i], 0) / totalW;
}

/** Weighted median — robust center estimate for regime data with outliers. */
function weightedMedian(values: number[], weights: number[]): number {
  if (values.length === 0) return 0;
  const pairs = values.map((v, i) => ({ v, w: weights[i] }))
    .sort((a, b) => a.v - b.v);
  const totalW = pairs.reduce((s, p) => s + p.w, 0);
  if (totalW === 0) return pairs[Math.floor(pairs.length / 2)].v;
  let acc = 0;
  for (const p of pairs) {
    acc += p.w;
    if (acc >= totalW / 2) return p.v;
  }
  return pairs[pairs.length - 1].v;
}

/** Weighted quantile (for outlier trimming). */
function weightedQuantile(values: number[], weights: number[], q: number): number {
  if (values.length === 0) return 0;
  const pairs = values.map((v, i) => ({ v, w: weights[i] }))
    .sort((a, b) => a.v - b.v);
  const totalW = pairs.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (const p of pairs) {
    acc += p.w;
    if (acc >= totalW * q) return p.v;
  }
  return pairs[pairs.length - 1].v;
}

function weightedStdDev(values: number[], weights: number[]): number {
  if (values.length < 2) return 0;
  const wm = weightedMean(values, weights);
  const totalW = weights.reduce((s, w) => s + w, 0);
  if (totalW === 0) return 0;
  const variance = values.reduce((s, v, i) => s + weights[i] * (v - wm) ** 2, 0) / totalW;
  return Math.sqrt(variance);
}

/** Exponential recency weight — half-life RECENCY_HALFLIFE_HOURS. */
function recencyWeight(startMs: number, nowMs: number): number {
  const ageHours = Math.max(0, (nowMs - startMs) / 3600_000);
  return Math.pow(0.5, ageHours / RECENCY_HALFLIFE_HOURS);
}

// ── Extract cycles from power events ─────────────────────────────────────────
// v5: counter-state "blips" (< BLIP_MERGE_MIN) are merged into the surrounding
// same-state runs. A 10-minute ON between two OFFs (generator stutter, sensor
// flicker, brief grid return) is real for state tracking but must not distort
// duration statistics. The still-active final run is kept but marked censored
// so it never pollutes duration averages with an incomplete duration.
function extractCycles(events: PowerEvent[], windowMs: number, nowMs: number): Cycle[] {
  const raw: Cycle[] = [];
  const sorted = [...events].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  );

  for (let i = 0; i < sorted.length - 1; i++) {
    const ev = sorted[i];
    const nextEv = sorted[i + 1];
    const startMs = new Date(ev.occurred_at).getTime();
    const endMs = new Date(nextEv.occurred_at).getTime();
    const durationMin = (endMs - startMs) / 60_000;
    if (durationMin < 1) continue; // skip spurious sub-minute events
    const state: "ON" | "OFF" = ev.event_type === "UTILITY_ON" ? "ON" : "OFF";
    raw.push({ state, startMs, endMs, durationMin, period: getPeriod(startMs), censored: false });
  }

  if (sorted.length > 0) {
    const last = sorted[sorted.length - 1];
    const lastMs = new Date(last.occurred_at).getTime();
    if (nowMs - lastMs < windowMs) {
      const state: "ON" | "OFF" = last.event_type === "UTILITY_ON" ? "ON" : "OFF";
      raw.push({
        state,
        startMs: lastMs,
        endMs: nowMs,
        durationMin: (nowMs - lastMs) / 60_000,
        period: getPeriod(lastMs),
        censored: true,
      });
    }
  }

  // Merge blips: a short counter-state run flanked by two runs of the same
  // state is folded into one continuous run of that state. Single forward
  // pass; merged run re-checked against the following run.
  const merged: Cycle[] = [];
  for (const c of raw) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    if (prev && prev.state === c.state) {
      // Adjacent same-state runs (possible after a merge) — fuse them.
      prev.endMs = c.endMs;
      prev.durationMin = (prev.endMs - prev.startMs) / 60_000;
      prev.censored = prev.censored && c.censored;
      continue;
    }
    merged.push({ ...c });
  }
  const out: Cycle[] = [];
  for (let i = 0; i < merged.length; i++) {
    const c = merged[i];
    const prev = out.length > 0 ? out[out.length - 1] : null;
    const next = i + 1 < merged.length ? merged[i + 1] : null;
    const isBlip = !c.censored && c.durationMin < BLIP_MERGE_MIN &&
      prev && next && prev.state === next.state && prev.state !== c.state;
    if (isBlip && prev && next) {
      // Fold blip + next into prev (prev keeps its start, absorbs to next.end)
      prev.endMs = next.endMs;
      prev.durationMin = (prev.endMs - prev.startMs) / 60_000;
      prev.censored = next.censored;
      i++; // skip next — already absorbed
      continue;
    }
    out.push(c);
  }
  return out;
}

// ── Pattern stats (descriptive, for display) ─────────────────────────────────
function computePatternStats(cycles: Cycle[]): PatternStats {
  const completed = cycles.filter(c => !c.censored);
  const offDurations = completed.filter(c => c.state === "OFF").map(c => c.durationMin);
  const onDurations = completed.filter(c => c.state === "ON").map(c => c.durationMin);

  return {
    cycles: completed.length,
    avgOffMin: mean(offDurations),
    stdDevOffMin: stdDev(offDurations),
    avgOnMin: onDurations.length > 0 ? mean(onDurations) : null,
    stdDevOnMin: onDurations.length > 1 ? stdDev(onDurations) : null,
    minOffMin: offDurations.length > 0 ? Math.min(...offDurations) : 0,
    maxOffMin: offDurations.length > 0 ? Math.max(...offDurations) : 0,
    minOnMin: onDurations.length > 0 ? Math.min(...onDurations) : null,
    maxOnMin: onDurations.length > 0 ? Math.max(...onDurations) : null,
  };
}

// ── APPPE quality factor computation ──────────────────────────────────────────
function computeQualityFactors(
  cycles: Cycle[],
  driftSamples: number[],
  biasSamples: number[],
  volatilityEMA: number,
  crisisActive: boolean,
): {
  dataQuantityFactor: number;
  stabilityFactor: number;
  driftStabilityFactor: number;
  biasStabilityFactor: number;
  volatilityFactor: number;
  crisisFactor: number;
} {
  const effectiveSamples = Math.min(cycles.length, 25);
  const dataQuantityFactor = Math.min(100, Math.round((effectiveSamples / 25) * 100));

  const offDurs = cycles.filter(c => c.state === "OFF" && !c.censored).map(c => c.durationMin);
  const avgOff = mean(offDurs);
  const madOff = mad(offDurs);
  const relMad = avgOff > 0 ? madOff / avgOff : 1;
  const stabilityFactor = Math.max(0, Math.round(100 - relMad * 200));

  const driftStabilityFactor = driftSamples.length < 2
    ? 50
    : Math.max(0, Math.round(100 - (stdDev(driftSamples) / 30) * 100));

  const avgBias = biasSamples.length > 0 ? mean(biasSamples) : 1.0;
  const biasDeviation = Math.abs(1 - avgBias);
  const biasStabilityFactor = Math.max(0, Math.round(100 - biasDeviation * 200));

  const volatilityFactor = Math.max(0, Math.round(100 - (volatilityEMA / 60) * 100));

  const crisisFactor = crisisActive ? 30 : 100;

  return {
    dataQuantityFactor,
    stabilityFactor,
    driftStabilityFactor,
    biasStabilityFactor,
    volatilityFactor,
    crisisFactor,
  };
}

function computeConfidence(factors: ReturnType<typeof computeQualityFactors>): number {
  const weights = {
    dataQuantityFactor: 0.30,
    stabilityFactor: 0.25,
    driftStabilityFactor: 0.15,
    biasStabilityFactor: 0.10,
    volatilityFactor: 0.15,
    crisisFactor: 0.05,
  };
  const weighted =
    factors.dataQuantityFactor * weights.dataQuantityFactor +
    factors.stabilityFactor * weights.stabilityFactor +
    factors.driftStabilityFactor * weights.driftStabilityFactor +
    factors.biasStabilityFactor * weights.biasStabilityFactor +
    factors.volatilityFactor * weights.volatilityFactor +
    factors.crisisFactor * weights.crisisFactor;
  return Math.min(97, Math.round(weighted));
}

// ── v6 Duration Model ─────────────────────────────────────────────────────────
//
// What 77 days of real data showed (rolling-origin backtest, 187 OFF runs):
//   • ON duration is 125 ± 13 min at ANY hour — a global weighted mean is the
//     right model; day/night or per-hour splits only add variance.
//   • OFF duration is a SMOOTH function of the Aden start-hour:
//     ≈ 5.3h for morning starts rising to ≈ 8.6h for 18:00 starts.
//   • The regime is stable for months (weekly OFF means: 394–467 min), so a
//     long window + gentle recency decay beats v5's 7-day / 60h half-life,
//     which left each 2h bucket with < 1 effective sample and collapsed the
//     model to its day/night prior (the user's reported symptom).
//
// Model: Nadaraya–Watson kernel regression with a CIRCULAR Gaussian kernel
// over the start hour (σ = 1.75h), samples weighted by recency (half-life
// 60 days), shrunk toward the global weighted mean (κ = 1.75 pseudo-weight)
// so thin night hours fall back gracefully. No bucket edges, no day/night
// boundary anywhere in the prediction path.
interface DurationModel {
  offDurAt: (startMs: number) => number;
  onDurAt: (startMs: number) => number;
  offCurve: Array<{ hour: number; durMin: number; samples: number }>;
  offSdFor: (startMs: number) => number;
  onSdFor: (startMs: number) => number;
}

function buildDurationModel(cycles: Cycle[], nowMs: number): DurationModel {
  const completed = cycles.filter(c => !c.censored);
  const offs = completed.filter(c => c.state === "OFF");
  const ons = completed.filter(c => c.state === "ON");

  const wOf = (c: Cycle) => recencyWeight(c.startMs, nowMs);

  // ── Global trimmed stats per state (trim 2% tails to kill residual outliers)
  const offVals = offs.map(c => c.durationMin);
  const offW = offs.map(wOf);
  let lo = 0, hi = Infinity;
  if (offVals.length >= 8) {
    lo = weightedQuantile(offVals, offW, 0.02);
    hi = weightedQuantile(offVals, offW, 0.98);
  }
  const offsT = offs.filter(c => c.durationMin >= lo && c.durationMin <= hi);
  const offTVals = offsT.map(c => c.durationMin);
  const offTW = offsT.map(wOf);
  const globalOffMean = offTVals.length > 0 ? weightedMean(offTVals, offTW) : 360;
  const globalOffSd = offTVals.length > 1 ? weightedStdDev(offTVals, offTW) : 60;

  const onVals = ons.map(c => c.durationMin);
  const onW = ons.map(wOf);
  let onLo = 0, onHi = Infinity;
  if (onVals.length >= 8) {
    onLo = weightedQuantile(onVals, onW, 0.02);
    onHi = weightedQuantile(onVals, onW, 0.98);
  }
  const onsT = ons.filter(c => c.durationMin >= onLo && c.durationMin <= onHi);
  const onTVals = onsT.map(c => c.durationMin);
  const onTW = onsT.map(wOf);
  const globalOnMean = onTVals.length > 0 ? weightedMean(onTVals, onTW) : 120;
  const globalOnSd = onTVals.length > 1 ? weightedStdDev(onTVals, onTW) : 20;

  // ── Circadian kernel over the OFF-start hour ────────────────────────────────
  const offHours = offsT.map(c => adenHourFloat(c.startMs));
  const kernelWeights = (hour: number): number[] =>
    offHours.map((sh, i) => {
      const dRaw = (((sh - hour) % 24) + 24) % 24;          // 0..24 circular
      const dh = dRaw > 12 ? 24 - dRaw : dRaw;              // 0..12 distance
      return offTW[i] * Math.exp(-0.5 * (dh / KERNEL_SIGMA_HOURS) ** 2);
    });

  /** Kernel estimate at hour, shrunk toward the global weighted mean. */
  const kernelEstimate = (hour: number): { est: number; wSum: number } => {
    const ww = kernelWeights(hour);
    const wSum = ww.reduce((s, x) => s + x, 0);
    if (wSum < 1e-6) return { est: globalOffMean, wSum: 0 };
    const local = weightedMean(offTVals, ww);
    return {
      est: (wSum * local + GLOBAL_SHRINK_K * globalOffMean) / (wSum + GLOBAL_SHRINK_K),
      wSum,
    };
  };

  const offDurAt = (startMs: number): number =>
    kernelEstimate(adenHourFloat(startMs)).est;

  // ON duration: hour-independent by measurement — single weighted mean.
  const onDurAt = (_startMs: number): number => globalOnMean;

  // Display curve: sample the kernel model at 12 two-hour centers
  // (same shape the admin dashboard has always rendered).
  const offCurve = Array.from({ length: 12 }, (_, b) => {
    const hour = b * 2 + 1;
    const { est, wSum } = kernelEstimate(hour);
    return { hour, durMin: Math.round(est), samples: Math.round(wSum * 10) / 10 };
  });

  // Local (kernel-weighted) dispersion for honest transition ranges, shrunk
  // toward the global sd the same way the mean is shrunk.
  const offSdFor = (startMs: number): number => {
    const ww = kernelWeights(adenHourFloat(startMs));
    const wSum = ww.reduce((s, x) => s + x, 0);
    if (wSum < 1e-6) return globalOffSd;
    const localSd = weightedStdDev(offTVals, ww);
    return (wSum * localSd + GLOBAL_SHRINK_K * globalOffSd) / (wSum + GLOBAL_SHRINK_K);
  };
  const onSdFor = (_startMs: number): number => globalOnSd;

  return { offDurAt, onDurAt, offCurve, offSdFor, onSdFor };
}

// ── v6.1 Shock detector (fuel shortage / cloudy day / breakdown) ─────────────
//
// Two layers, both measured against the HOUR-MATCHED kernel expectation
// (not raw means — a long evening OFF is normal, a long morning OFF is not):
//
//  1. IN-RUN (fastest possible): the still-active OFF run has already lasted
//     longer than expected + max(90min, 1.75*localSd). On 77 days of history
//     this fired on only 8 of 186 runs — including all three real anomaly
//     days (Jun 6, Jun 28 15.3h, Jul 31 16.1h) — catching them 2.5–8 hours
//     before they ended. While active, the current slot is extended in
//     45-min steps, self-correcting every analysis run until power returns.
//
//  2. PERSISTENT SHIFT: 2 of the last 3 completed OFF runs deviated beyond
//     the same threshold → regime break, not a single bad day. Future OFF
//     predictions are shifted by the median residual (clamped ±240 min).
//     Auto-clears as soon as new runs return to normal. Single extreme days
//     (Jul 31: +565 min residual) do NOT trigger this — they are handled by
//     the in-run layer and must not poison the following day's predictions.
interface ShockResult {
  shockActive: boolean;
  shockKind: "none" | "inrun" | "persistent";
  shiftOffMin: number;
  reason: string | null;
}

function detectShock(cycles: Cycle[], model: DurationModel): ShockResult {
  const none: ShockResult = { shockActive: false, shockKind: "none", shiftOffMin: 0, reason: null };
  const completedOff = cycles.filter(c => !c.censored && c.state === "OFF");
  if (completedOff.length < 10) return none;

  // 1) In-run: is the CURRENT OFF run already far beyond its expectation?
  const last = cycles.length > 0 ? cycles[cycles.length - 1] : null;
  if (last && last.censored && last.state === "OFF") {
    const expected = model.offDurAt(last.startMs);
    const sd = model.offSdFor(last.startMs);
    const threshold = expected + Math.max(SHOCK_MIN_RESID_MIN, SHOCK_SD_MULT * sd);
    if (last.durationMin > threshold) {
      return {
        shockActive: true,
        shockKind: "inrun",
        shiftOffMin: 0,
        reason: `Current outage at ${Math.round(last.durationMin)} min vs typical ` +
          `${Math.round(expected)} min for its start hour — extended-outage mode`,
      };
    }
  }

  // 2) Persistent: 2 of last 3 completed OFF runs beyond their hour-matched band
  const recent = completedOff.slice(-SHOCK_LOOKBACK);
  const flagged: number[] = [];
  for (const c of recent) {
    const resid = c.durationMin - model.offDurAt(c.startMs);
    const sd = model.offSdFor(c.startMs);
    if (Math.abs(resid) > Math.max(SHOCK_MIN_RESID_MIN, SHOCK_SD_MULT * sd)) flagged.push(resid);
  }
  if (flagged.length >= SHOCK_MIN_FLAGGED) {
    const s = [...flagged].sort((a, b) => a - b);
    const med = s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    const shift = Math.round(Math.min(SHOCK_MAX_SHIFT_MIN, Math.max(-SHOCK_MAX_SHIFT_MIN, med)));
    return {
      shockActive: true,
      shockKind: "persistent",
      shiftOffMin: shift,
      reason: `${flagged.length} of last ${recent.length} outages broke the pattern — ` +
        `regime shift ${shift > 0 ? "+" : ""}${shift} min applied`,
    };
  }
  return none;
}

// ── Bias Engine (v5: clean snapshot rows only) ────────────────────────────────
interface BiasResult {
  biasRatioOn: number;
  biasRatioOff: number;
  sampleCount: number;
}

function loadBiasFromHistory(history: AccuracyLogRow[]): BiasResult {
  // Only rows produced by the v5 snapshot logger carry FULL predicted
  // durations. Legacy rows mixed remaining-time values and circular
  // time-of-day matches — their ratios were noise.
  const clean = history.filter(r => r.slot_id !== null && r.slot_id.startsWith("snap_"));
  const ratiosFor = (type: "ON" | "OFF") =>
    clean.filter(
      r => r.duration_type === type &&
        r.predicted_duration_min !== null &&
        r.actual_duration_min !== null &&
        (r.predicted_duration_min ?? 0) > 0 &&
        (r.actual_duration_min ?? 0) > 0
    ).map(r => r.actual_duration_min! / r.predicted_duration_min!);

  const onRatios = ratiosFor("ON");
  const offRatios = ratiosFor("OFF");
  const clamp = (v: number) => Math.min(BIAS_CLAMP_MAX, Math.max(BIAS_CLAMP_MIN, v));

  return {
    biasRatioOn: onRatios.length >= BIAS_MIN_SAMPLES ? clamp(mean(onRatios)) : 1.0,
    biasRatioOff: offRatios.length >= BIAS_MIN_SAMPLES ? clamp(mean(offRatios)) : 1.0,
    sampleCount: onRatios.length + offRatios.length,
  };
}

// ── Drift offset (v5: clean rows, robust median, clamped) ────────────────────
function computeDriftOffset(history: AccuracyLogRow[]): {
  driftOffset: number;
  driftSamples: number[];
  sampleCount: number;
} {
  const clean = history.filter(r => r.slot_id !== null && r.slot_id.startsWith("snap_"));
  if (clean.length < DRIFT_MIN_SAMPLES) {
    return { driftOffset: 0, driftSamples: [], sampleCount: clean.length };
  }

  const samples = clean
    .slice(-MAX_DRIFT_SAMPLES)
    .map(r => {
      const predicted = new Date(r.predicted_event_time).getTime();
      const actual = new Date(r.actual_event_time).getTime();
      return (actual - predicted) / 60_000;
    })
    .filter(v => Number.isFinite(v) && Math.abs(v) < 300);

  if (samples.length < DRIFT_MIN_SAMPLES) {
    return { driftOffset: 0, driftSamples: samples, sampleCount: samples.length };
  }

  // Median is robust against the occasional wildly-off prediction
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted.length % 2 === 1
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  // v6 deadband: a tiny systematic median is just kernel noise — chasing it
  // made backtest accuracy WORSE (37.3 vs 32.7 MAE). Only correct a real
  // regime shift, and never by more than DRIFT_MAX_ABS_MIN.
  if (Math.abs(median) < DRIFT_DEADBAND_MIN) {
    return { driftOffset: 0, driftSamples: samples, sampleCount: samples.length };
  }
  const driftOffset = Math.round(
    Math.min(DRIFT_MAX_ABS_MIN, Math.max(-DRIFT_MAX_ABS_MIN, median))
  );

  return { driftOffset, driftSamples: samples, sampleCount: samples.length };
}

// ── Volatility EMA ─────────────────────────────────────────────────────────────
function computeVolatilityEMA(history: AccuracyLogRow[], prevEMA: number): number {
  if (history.length === 0) return prevEMA;
  const recent = history.slice(-10);
  const errors = recent.map(r => Math.abs(r.error_minutes));
  let ema = prevEMA || (errors[0] ?? 0);
  for (const err of errors) {
    ema = VOLATILITY_EMA_ALPHA * err + (1 - VOLATILITY_EMA_ALPHA) * ema;
  }
  return Math.round(ema);
}

// ── Generate day schedule (v5: per-slot durations) ────────────────────────────
function generateDaySchedule(
  currentState: "ON" | "OFF",
  currentStateStartMs: number,
  model: DurationModel,
  driftOffsetMin: number,
  biasResult: BiasResult,
  nowMs: number,
  crisisActive: boolean,
  crisisShift: { on: number; off: number },
  shock: ShockResult,
): ScheduleSlot[] {
  const slots: ScheduleSlot[] = [];
  const endMs = nowMs + SCHEDULE_AHEAD_HOURS * 3600_000;

  // A persistent shock shift takes precedence over the (slower) crisis shift —
  // it is measured against hour-matched expectations, so it is both faster
  // and more precise. They never stack.
  const effOffShift = shock.shockKind === "persistent"
    ? shock.shiftOffMin
    : (crisisActive ? crisisShift.off : 0);

  const durFor = (state: "ON" | "OFF", startMs: number): number => {
    const base = state === "ON" ? model.onDurAt(startMs) : model.offDurAt(startMs);
    const corrected = base * (state === "ON" ? biasResult.biasRatioOn : biasResult.biasRatioOff) +
      (state === "ON" ? (crisisActive ? crisisShift.on : 0) : effOffShift);
    return state === "ON"
      ? Math.max(ON_DUR_MIN_CLAMP, Math.min(ON_DUR_MAX_CLAMP, corrected))
      : Math.max(OFF_DUR_MIN_CLAMP, Math.min(OFF_DUR_MAX_CLAMP, corrected));
  };

  let state = currentState;
  let slotStartMs = currentStateStartMs; // known fact — never shifted by drift

  let iterCount = 0;
  const MAX_ITER = 48;

  while (slotStartMs < endMs && iterCount < MAX_ITER) {
    iterCount++;
    let dur = durFor(state, slotStartMs);
    // In-run shock: the CURRENT OFF has already outlived its expectation.
    // Extend in 45-min (or 0.5*sd) steps from NOW — self-corrects every run.
    if (iterCount === 1 && shock.shockKind === "inrun" && state === "OFF") {
      const elapsed = (nowMs - slotStartMs) / 60_000;
      dur = Math.min(OFF_DUR_MAX_CLAMP,
        elapsed + Math.max(SHOCK_INRUN_BUFFER_MIN, 0.5 * model.offSdFor(slotStartMs)));
    }
    // Drift correction applies ONCE, to the end of the current (first) slot —
    // it compensates the systematic phase error measured on past transitions.
    // The chain then carries the correction forward naturally.
    const driftMs = iterCount === 1 ? driftOffsetMin * 60_000 : 0;
    const slotEndMs = slotStartMs + dur * 60_000 + driftMs;

    const zone = getPeriod(slotStartMs);
    const endIso = slotEndMs < endMs ? new Date(slotEndMs).toISOString() : null;

    slots.push({
      state,
      startIso: new Date(slotStartMs).toISOString(),
      endIso,
      startFormatted: fmtYemenTime(slotStartMs),
      endFormatted: endIso ? fmtYemenTime(slotEndMs) : null,
      durationLabel: durationLabel(Math.round(dur)),
      zone,
      isEstimated: slotStartMs > nowMs,
    });

    slotStartMs = slotEndMs;
    state = state === "ON" ? "OFF" : "ON";
  }

  return slots;
}

// ── Crisis detection ───────────────────────────────────────────────────────────
function detectCrisis(
  currentCycles: Cycle[],
  historicalCycles: Cycle[],
): { crisisActive: boolean; crisisReason: string | null; crisisShift: { on: number; off: number } } {
  if (historicalCycles.length < MIN_CYCLES_FOR_LEARNING || currentCycles.length < 2) {
    return { crisisActive: false, crisisReason: null, crisisShift: { on: 0, off: 0 } };
  }

  const durs = (pool: Cycle[], state: "ON" | "OFF") =>
    pool.filter(c => c.state === state && !c.censored).map(c => c.durationMin);

  const histOff = durs(historicalCycles, "OFF");
  const histOn = durs(historicalCycles, "ON");
  const currOff = durs(currentCycles, "OFF");
  const currOn = durs(currentCycles, "ON");

  if (histOff.length === 0 || currOff.length === 0) {
    return { crisisActive: false, crisisReason: null, crisisShift: { on: 0, off: 0 } };
  }

  const avgHistOff = mean(histOff);
  const avgCurrOff = mean(currOff);
  const offChangePct = Math.abs(avgCurrOff - avgHistOff) / Math.max(avgHistOff, 1);

  const avgHistOn = histOn.length > 0 ? mean(histOn) : null;
  const avgCurrOn = currOn.length > 0 ? mean(currOn) : null;
  const onChangePct = (avgHistOn && avgCurrOn)
    ? Math.abs(avgCurrOn - avgHistOn) / Math.max(avgHistOn, 1)
    : 0;

  let crisisActive = false;
  let crisisReason: string | null = null;
  let crisisShiftOff = 0;
  let crisisShiftOn = 0;

  if (offChangePct > CRISIS_THRESHOLD_PCT) {
    crisisActive = true;
    const pct = Math.round(offChangePct * 100);
    const dir = avgCurrOff > avgHistOff ? "increased" : "decreased";
    crisisReason = dir === "increased"
      ? `Outage durations increased by ${pct}% vs baseline, possible fuel shortage or schedule change`
      : `Prediction center shifted by ${Math.round(avgCurrOff - avgHistOff)}min`;
    crisisShiftOff = Math.round(avgCurrOff - avgHistOff);
  }

  if (onChangePct > CRISIS_THRESHOLD_PCT && avgHistOn && avgCurrOn) {
    crisisActive = true;
    const pct = Math.round(onChangePct * 100);
    if (!crisisReason) {
      crisisReason = avgCurrOn < avgHistOn
        ? `ON durations decreased by ${pct}% vs baseline, possible generator capacity issue`
        : `ON durations increased by ${pct}% vs baseline`;
    }
    crisisShiftOn = Math.round(avgCurrOn - avgHistOn);
  }

  return { crisisActive, crisisReason, crisisShift: { on: crisisShiftOn, off: crisisShiftOff } };
}

// ── Next transition computation (v5: data-driven range width) ─────────────────
function computeNextTransition(
  slots: ScheduleSlot[],
  currentState: "ON" | "OFF",
  model: DurationModel,
  nowMs: number,
): object | null {
  const targetState: "ON" | "OFF" = currentState === "ON" ? "OFF" : "ON";
  const nextSlot = slots.find(s => s.state === targetState && new Date(s.startIso).getTime() > nowMs);
  if (!nextSlot) return null;

  const startMs = new Date(nextSlot.startIso).getTime();
  const minFromNow = Math.max(0, (startMs - nowMs) / 60_000);
  // Honest range: scaled to the observed dispersion of the CURRENT state's
  // duration (the uncertainty of when it will end), bounded to [30, 120] min.
  const sd = currentState === "OFF" ? model.offSdFor(nowMs) : model.onSdFor(nowMs);
  const rangeWidth = Math.max(30, Math.min(120, Math.round(1.5 * sd)));
  const endRangeMs = startMs + rangeWidth * 60_000;
  const endIso = new Date(endRangeMs).toISOString();

  return {
    type: targetState === "ON" ? "UTILITY_ON" : "UTILITY_OFF",
    earliestTime: nextSlot.startIso,
    latestTime: endIso,
    earliestFormatted: nextSlot.startFormatted,
    latestFormatted: fmtYemenTime(endRangeMs),
    minFromNowMin: minFromNow,
    maxFromNowMin: minFromNow + rangeWidth,
    rangeLabel: nextSlot.startFormatted,
    rangeStartIso: nextSlot.startIso,
    rangeEndIso: endIso,
    inRangeWindow: minFromNow <= 0,
  };
}

// ── Accuracy logging v2: snapshot & resolve ───────────────────────────────────
//
// v4 wrote rows in two broken ways:
//   - client: every 15 min, predicted_duration_min = shrinking REMAINING time
//   - server: matched events to schedule slots by circular time-of-day distance
//     on a schedule generated AFTER the event existed
// Both made the accuracy table pure noise (0% accuracy, ±230min avg error,
// 20000% coverage on the admin dashboard).
//
// v5 approach: every analysis run appends the CURRENT nextTransition (what
// users actually see) to prediction.snapshots. When a real power_event later
// arrives, we resolve it against the LATEST snapshot of that type issued
// BEFORE the event → one truthful row per event, pre-registered prediction.

interface ResolveOutcome {
  inserted: number;
  resolvedSnapIds: Set<string>;
}

async function resolveAccuracyRows(
  supabase: ReturnType<typeof getSupabase>,
  events: PowerEvent[],          // 36h window, any order
  prevSnapshots: PredictionSnapshot[],
): Promise<ResolveOutcome> {
  const outcome: ResolveOutcome = { inserted: 0, resolvedSnapIds: new Set() };
  if (prevSnapshots.length === 0 || events.length === 0) return outcome;

  const asc = [...events].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  );

  // Events already resolved by a previous run (dedupe)
  const windowStart = asc[0].occurred_at;
  const { data: alreadyRows } = await supabase
    .from("prediction_accuracy_logs")
    .select("actual_event_time")
    .like("slot_id", "snap_%")
    .gte("actual_event_time", windowStart);
  const alreadySet = new Set((alreadyRows ?? []).map((r: { actual_event_time: string }) => r.actual_event_time));

  const rows: Record<string, unknown>[] = [];
  const matchedSnapIds: string[] = [];
  for (let i = 0; i < asc.length; i++) {
    const ev = asc[i];
    const evMs = new Date(ev.occurred_at).getTime();
    if (alreadySet.has(ev.occurred_at)) continue;

    // Latest snapshot of this type issued strictly BEFORE the event
    let best: PredictionSnapshot | null = null;
    let bestGen = -1;
    for (const snap of prevSnapshots) {
      if (snap.type !== ev.event_type) continue;
      const genMs = new Date(snap.generatedAt).getTime();
      const predMs = new Date(snap.predictedIso).getTime();
      if (!Number.isFinite(genMs) || !Number.isFinite(predMs)) continue;
      if (genMs >= evMs) continue;                                   // must pre-date the event
      if (Math.abs(predMs - evMs) > SNAPSHOT_MATCH_TOLERANCE_MS) continue;
      if (genMs > bestGen) { bestGen = genMs; best = snap; }
    }
    if (!best) continue;

    // Actual duration of the run STARTED by this event (time to next event)
    let actualDur: number | null = null;
    if (i + 1 < asc.length) {
      const d = Math.round((new Date(asc[i + 1].occurred_at).getTime() - evMs) / 60_000);
      if (d > 0 && d <= 1440) actualDur = d;
    }

    const predMs = new Date(best.predictedIso).getTime();
    const absErrMin = Math.abs(evMs - predMs) / 60_000;
    const score = Math.max(0, Math.round(100 - (absErrMin / MAX_ALLOWED_ERROR_MIN) * 100));

    rows.push({
      predicted_event_time: best.predictedIso,
      actual_event_time: ev.occurred_at,
      // predicted_state / actual_state are NOT NULL in the schema — omitting
      // them silently rejected every v5 insert.
      predicted_state: ev.event_type,
      actual_state: ev.event_type,
      error_minutes: Math.round(absErrMin),
      accuracy_score: score,
      duration_type: ev.event_type === "UTILITY_ON" ? "ON" : "OFF",
      predicted_duration_min: best.slotDurationMin,
      actual_duration_min: actualDur,
      confidence_score: best.confidence,
      prediction_generated_at: best.generatedAt,
      slot_id: best.id,
      // v6: how far ahead the prediction looked — lets accuracy analysis
      // separate short-horizon (next slot) from long-horizon (tomorrow) error.
      horizon_minutes: Math.round((evMs - new Date(best.generatedAt).getTime()) / 60_000),
    });
    matchedSnapIds.push(best.id);
  }

  if (rows.length > 0) {
    const { error } = await supabase.from("prediction_accuracy_logs").insert(rows);
    if (error) {
      // CRITICAL: snapshots are NOT consumed on failure — they stay in the
      // payload so the next run retries the insert. (v5.0 consumed them even
      // when the insert failed, orphaning events with no accuracy row.)
      console.error("[analyze-patterns] resolve insert error:", error.message);
    } else {
      outcome.inserted = rows.length;
      for (const id of matchedSnapIds) outcome.resolvedSnapIds.add(id);
    }
  }
  return outcome;
}

// ── Snapshot list maintenance ─────────────────────────────────────────────────
function mergeSnapshots(
  prevSnapshots: PredictionSnapshot[],
  newSnap: PredictionSnapshot | null,
  resolvedIds: Set<string>,
  nowMs: number,
): PredictionSnapshot[] {
  const valid = (Array.isArray(prevSnapshots) ? prevSnapshots : []).filter(
    s => s && typeof s.id === "string" && typeof s.predictedIso === "string" &&
      typeof s.generatedAt === "string"
  );

  const kept = valid.filter(s => {
    if (resolvedIds.has(s.id)) return false;                          // resolved → archived in logs
    const genMs = new Date(s.generatedAt).getTime();
    const predMs = new Date(s.predictedIso).getTime();
    if (nowMs - genMs > SNAPSHOT_MAX_AGE_HOURS * 3600_000) return false; // too old
    if (predMs < nowMs - SNAPSHOT_MATCH_TOLERANCE_MS) return false;      // missed, unresolvable
    return true;
  });

  // Dedupe by id (keep earliest issued — the one users saw first)
  const seen = new Set<string>();
  const deduped: PredictionSnapshot[] = [];
  for (const s of kept) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    deduped.push(s);
  }

  if (newSnap && !seen.has(newSnap.id)) deduped.push(newSnap);

  deduped.sort((a, b) => new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime());
  return deduped.slice(-SNAPSHOT_CAP);
}

// ── Load accuracy history (v5: includes slot_id) ──────────────────────────────
async function loadHistory(supabase: ReturnType<typeof getSupabase>): Promise<AccuracyLogRow[]> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("prediction_accuracy_logs")
    .select(
      "predicted_event_time, actual_event_time, error_minutes, accuracy_score, " +
      "duration_type, predicted_duration_min, actual_duration_min, confidence_score, " +
      "slot_id, created_at"
    )
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[analyze-patterns] loadHistory error:", error.message);
    // Schema fallback: slot_id / duration columns may not exist yet
    const { data: fallbackData } = await supabase
      .from("prediction_accuracy_logs")
      .select("predicted_event_time, actual_event_time, error_minutes, accuracy_score, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: true });
    return (fallbackData ?? []).map((r: Record<string, unknown>) => ({
      ...(r as object),
      duration_type: null,
      predicted_duration_min: null,
      actual_duration_min: null,
      confidence_score: null,
      slot_id: null,
    })) as AccuracyLogRow[];
  }
  return (data ?? []) as AccuracyLogRow[];
}

// ── Expected duration range (avg ± sd) ──────────────────────────────────────
// v6.2: hoisted to module scope so the base model and the phase models share
// ONE implementation. Logic unchanged (was an inline closure in the handler).
function computeExpectedRange(arr: number[]): { minMin: number; maxMin: number; label: string } | null {
  if (arr.length === 0) return null;
  const avg = mean(arr);
  const sd = stdDev(arr);
  const minMin = Math.max(5, Math.round(avg - sd));
  const maxMin = Math.round(avg + sd);
  return { minMin, maxMin, label: `${durationLabel(minMin)}–${durationLabel(maxMin)}` };
}

// ── v6.2 Phase-model module ─────────────────────────────────────────────────
//
// ONE module for ALL phase groups — the only thing that changes between runs
// is the phase offset VALUE. The module re-runs the full analysis pipeline
// independently over the phase-shifted event stream: cycle extraction,
// pattern stats, the circadian kernel duration model, crisis detection, the
// shock detector, schedule generation, next-transition, confidence and
// reasoning are ALL recomputed from the shifted stream — no outputs are
// copied from the base model. Shared inputs are limited to:
//   • the physical sensor facts (current state + when it started), moved by
//     the phase offset to anchor the phase timeline, and
//   • the base model's LEARNED corrections (drift offset, bias ratios,
//     volatility EMA, sample pools) — phase models have no accuracy history
//     of their own (accuracy learning is intentionally base-model-only), so
//     they inherit the regime-level corrections while their statistics,
//     curves, schedules and reasoning stay fully their own.
//
// Output: a payload with the SAME shape as the base prediction (plus
// apppe.phaseOffsetHours), embedded under prediction.phaseModels["+5" …].
// Clients pick their phase model by rounding the user offset to the nearest
// hour group and apply only the sub-hour residual on top (minute precision).
function computePhaseModel(args: {
  phaseOffsetHours: number;
  extEvents: PowerEvent[];          // 80-day learning window (unshifted)
  currentState: "ON" | "OFF";       // real sensor state — shared physical fact
  currentStateStartMs: number;      // real sensor state start (unshifted)
  inverterOffline: boolean;
  driftOffset: number;              // learned on the base model — applied as-is
  driftSamples: number[];           // base drift sample pool (quality factor)
  driftSampleCount: number;
  biasResult: BiasResult;           // learned on the base model — applied as-is
  biasSamples: number[];            // base bias sample pool (quality factor)
  volatilityEMA: number;            // base volatility EMA (quality factor)
  nowMs: number;
}): Record<string, unknown> {
  const { phaseOffsetHours, nowMs } = args;
  const shiftMs = phaseOffsetHours * 3600_000;

  // ── 1. Phase-shift the event stream ───────────────────────────────────────
  // A phase user's timeline = the sensor timeline moved by the group offset.
  // The most recent event MAY land in the future for positive phases right
  // after a sensor flip — extractCycles then marks the still-active run
  // censored (excluded from duration stats), so statistics stay clean.
  const shiftedEvents: PowerEvent[] = args.extEvents.map(e => ({
    ...e,
    occurred_at: new Date(new Date(e.occurred_at).getTime() + shiftMs).toISOString(),
  }));

  // ── 2. Cycles + pattern stats (independent) ───────────────────────────────
  const cycles = extractCycles(shiftedEvents, LEARNING_WINDOW_DAYS * 24 * 3600_000, nowMs);
  const dayCycles = cycles.filter(c => c.period === "day");
  const nightCycles = cycles.filter(c => c.period === "night");
  const allStats = computePatternStats(cycles);
  const dayStats = computePatternStats(dayCycles);
  const nightStats = computePatternStats(nightCycles);

  // ── 3. Kernel duration model (independent) ────────────────────────────────
  const model = buildDurationModel(cycles, nowMs);

  // ── 4. Crisis + shock detection (independent, over the shifted stream) ────
  const last24hCycles = cycles.filter(c => c.startMs > nowMs - 24 * 3600_000);
  const { crisisActive, crisisReason, crisisShift } = detectCrisis(last24hCycles, cycles);
  const shock = detectShock(cycles, model);

  // ── 5. Schedule anchored at the phase timeline's current-state start ──────
  // Positive phases right after a sensor flip anchor in the FUTURE: the
  // schedule starts ahead of "now" and the client engine holds the prior
  // state until the first slot begins (same mechanics as a positive offset).
  const phaseStateStartMs = args.currentStateStartMs + shiftMs;
  const daySchedule = generateDaySchedule(
    args.currentState,
    phaseStateStartMs,
    model,
    args.driftOffset,
    args.biasResult,
    nowMs,
    crisisActive,
    crisisShift,
    shock,
  );

  // ── 6. Next transition (per phase timeline) ───────────────────────────────
  const nextTransition = computeNextTransition(daySchedule, args.currentState, model, nowMs);

  // ── 7. Confidence (own cycles; shared regime factors) ─────────────────────
  const qualityFactors = computeQualityFactors(
    cycles,
    args.driftSamples,
    args.biasSamples,
    args.volatilityEMA,
    crisisActive,
  );
  const confidence = computeConfidence(qualityFactors);
  // Same label thresholds as the base model.
  const confidenceLabel =
    confidence >= 88 ? "مرتفعة جداً" :
    confidence >= 72 ? "مرتفعة" :
    confidence >= 52 ? "متوسطة" : "منخفضة";

  // ── 8. Learning mode + stability (own cycles) ─────────────────────────────
  const effectiveWeightedSamples = Math.min(cycles.length, 25);
  const learningMode: "prior_only" | "hybrid" | "learned" =
    effectiveWeightedSamples >= 21 ? "learned" :
    effectiveWeightedSamples >= 7 ? "hybrid" : "prior_only";

  const offDurations = cycles.filter(c => c.state === "OFF" && !c.censored).map(c => c.durationMin);
  const onDurations = cycles.filter(c => c.state === "ON" && !c.censored).map(c => c.durationMin);
  const madOffVal = Math.round(mad(offDurations));
  const avgOffVal = mean(offDurations);
  const madOnVal = onDurations.length > 0 ? Math.round(mad(onDurations)) : null;
  const relativeMAD = avgOffVal > 0 ? mad(offDurations) / avgOffVal : 1;
  const stabilityScore = Math.max(0, Math.min(100, Math.round(100 - relativeMAD * 200)));
  const stabilityLabel = stabilityScore >= 75 ? "Stable"
    : stabilityScore >= 45 ? "Slightly Unstable" : "Unstable";
  const isUnstable = stabilityScore < 45;

  // ── 9. Expected ranges (own cycles, shared helper) ────────────────────────
  const expectedOffRange = computeExpectedRange(offDurations);
  const expectedOnRange = computeExpectedRange(onDurations);

  // ── 10. Reasoning (own stats/curve; same templates as the base model) ─────
  const sign = phaseOffsetHours > 0 ? "+" : "";
  const reasoning: string[] = [];
  reasoning.push(`تم تحليل ${cycles.length} دورة في نافذة ${LEARNING_WINDOW_DAYS} أيام`);
  if (model.offCurve.length > 0) {
    const durs = model.offCurve.map(p => p.durMin);
    const lo = Math.min(...durs);
    const hi = Math.max(...durs);
    if (hi - lo >= 30) {
      reasoning.push(
        `مدة الانقطاع تعتمد على وقت بدئها: من ${durationLabel(lo)} ظهراً (دعم الطاقة الشمسية) ` +
        `حتى ${durationLabel(hi)} في ذروة المساء`
      );
    }
  }
  if (crisisActive && crisisReason) {
    reasoning.push(`⚠️ وضع الأزمة: ${crisisReason}`);
  }
  if (shock.shockActive && shock.shockKind === "inrun") {
    reasoning.push(
      "⚠️ انقطاع ممتد: تجاوزت مدة الانقطاع الحالية النمط المعتاد لهذا الوقت — تم تمديد التوقع تلقائياً"
    );
  } else if (shock.shockActive && shock.shockKind === "persistent") {
    reasoning.push(
      `⚠️ كشف تغيّر مفاجئ في النمط (نقص وقود / طقس غائم / عطل): ` +
      `تم تعديل توقعات الانقطاع بمقدار ${shock.shiftOffMin > 0 ? "+" : ""}${shock.shiftOffMin} دقيقة`
    );
  }
  if (args.driftOffset !== 0) {
    reasoning.push(`انحراف التوقيت المُصحَّح: ${args.driftOffset > 0 ? "+" : ""}${args.driftOffset} دقيقة`);
  }
  if (args.biasResult.sampleCount >= 4) {
    reasoning.push(
      `تصحيح التحيّز: تشغيل ×${args.biasResult.biasRatioOn.toFixed(2)}, انقطاع ×${args.biasResult.biasRatioOff.toFixed(2)}`
    );
  }
  if (learningMode === "learned") {
    reasoning.push("النظام في وضع التعلم المكتمل — تعتمد التوقعات بالكامل على البيانات الفعلية");
  } else if (learningMode === "hybrid") {
    reasoning.push("وضع هجين — تمزج التوقعات بين البيانات الفعلية والنماذج الأساسية");
  } else {
    reasoning.push("وضع التعلم المبكر — التوقعات تعتمد على النماذج الأساسية في الوقت الحالي");
  }
  // Phase marker (last line — Home shows only reasoning[0]).
  reasoning.push(`🧭 نموذج طور مخصص: ${sign}${phaseOffsetHours} ساعات عن النموذج الأساسي`);

  const currentStateDurationMin = Math.max(0, Math.round((nowMs - phaseStateStartMs) / 60_000));

  // ── 11. Assemble the phase payload (same shape as the base prediction) ────
  return {
    currentState: args.currentState,
    currentStateDurationMin,
    currentStateDurationLabel: durationLabel(currentStateDurationMin),
    // The phase timeline's current-state start. May be future-dated for
    // positive phases right after a sensor flip (the phase's current state
    // has not begun yet) — the client engine derives its own display anchors.
    lastTransitionAt: new Date(phaseStateStartMs).toISOString(),
    inverterOffline: args.inverterOffline,

    nextTransition,
    expectedOffRange,
    expectedOnRange,
    daySchedule,
    snapshots: [], // phase models never register accuracy snapshots (base-only learning)

    confidence,
    confidenceLabel,
    isUnstable,
    stabilityScore,
    stabilityLabel,

    dayPattern: dayStats,
    nightPattern: nightStats,
    allPattern: allStats,
    cyclesAnalyzed: cycles.length,
    dayCyclesAnalyzed: dayCycles.length,
    nightCyclesAnalyzed: nightCycles.length,

    currentPeriod: getPeriod(nowMs),
    reasoning,
    learningMode,
    dataWindowHours: ANALYSIS_WINDOW_HOURS,
    computedAt: new Date(nowMs).toISOString(),

    apppe: {
      version: "6.2-phase",
      phaseOffsetHours,
      crisisActive,
      crisisReason,
      shockActive: shock.shockActive,
      shockKind: shock.shockKind,
      shockShiftOffMin: shock.shiftOffMin,
      shockReason: shock.reason,
      driftOffset: args.driftOffset,
      driftSampleCount: args.driftSampleCount,
      biasRatio: args.biasResult.biasRatioOn,
      biasRatioOff: args.biasResult.biasRatioOff,
      biasSampleCount: args.biasResult.sampleCount,
      volatilityEMA: args.volatilityEMA,
      volatilityLabel: args.volatilityEMA < 20 ? "Low" : args.volatilityEMA < 45 ? "Moderate" : args.volatilityEMA < 90 ? "Elevated" : "High",
      crisisShift,
      learningStrength: Math.round((effectiveWeightedSamples / 25) * 100),
      effectiveWeightedSamples,
      effectiveWeightedSamplesOn: onDurations.length,
      madOff: madOffVal,
      madOn: madOnVal,
      predictionQuality: qualityFactors,
      offDurationCurve: model.offCurve,
      historySource: "shared base-model learning (phase models never write accuracy rows)",
      rangeWasClamped: false,
    },
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getSupabase();
  const nowMs = Date.now();
  const windowMs = ANALYSIS_WINDOW_HOURS * 3600_000;

  console.log("[analyze-patterns] Starting APPPE v6 analysis...");

  try {
    // ── 1. Load current inverter state ────────────────────────────────────────
    const { data: invState } = await supabase
      .from("inverter_state")
      .select("utility_on, last_polled, inverter_offline")
      .eq("id", 1)
      .maybeSingle();

    // STALE-STATE FIX: when poll-growatt triggers this function it passes the
    // just-detected transition ({trigger:"poll-growatt", eventType, occurredAt})
    // in the POST body. That event is FIRST-HAND and newer than anything in
    // inverter_state — trust it as the authoritative current state. This makes
    // the analysis immune to any read/upsert ordering race; cron and manual
    // invocations carry no eventType and fall back to inverter_state as before.
    let bodyEventType: string | null = null;
    try {
      const body = await req.json();
      if (body && (body.eventType === "UTILITY_ON" || body.eventType === "UTILITY_OFF")) {
        bodyEventType = body.eventType;
      }
    } catch (_) { /* empty/invalid body — cron & manual calls */ }

    const currentState: "ON" | "OFF" = bodyEventType !== null
      ? (bodyEventType === "UTILITY_ON" ? "ON" : "OFF")
      : (invState?.utility_on ? "ON" : "OFF");
    const lastTransitionAt = invState?.last_polled ?? null;
    const inverterOffline = invState?.inverter_offline ?? false;

    console.log(`[analyze-patterns] Current state: ${currentState} (source: ${bodyEventType !== null ? "poll-growatt event" : "inverter_state"}), offline: ${inverterOffline}`);

    // ── 2. Load power events (analysis window) ────────────────────────────────
    const windowStart = new Date(nowMs - windowMs).toISOString();
    const { data: rawEvents, error: evErr } = await supabase
      .from("power_events")
      .select("id, event_type, occurred_at, vac, pac_to_user, status_text")
      .gte("occurred_at", windowStart)
      .order("occurred_at", { ascending: false })
      .limit(200);

    if (evErr) {
      console.error("[analyze-patterns] power_events error:", evErr.message);
    }

    const events: PowerEvent[] = (rawEvents ?? []) as PowerEvent[];
    console.log(`[analyze-patterns] Loaded ${events.length} events in last ${ANALYSIS_WINDOW_HOURS}h`);

    // ── 3. Load extended history for pattern learning ─────────────────────────
    const extWindowStart = new Date(nowMs - LEARNING_WINDOW_DAYS * 24 * 3600_000).toISOString();
    const { data: extEvents } = await supabase
      .from("power_events")
      .select("id, event_type, occurred_at")
      .gte("occurred_at", extWindowStart)
      .order("occurred_at", { ascending: false })
      .limit(1000);

    const allCycles = extractCycles(
      (extEvents ?? []) as PowerEvent[], LEARNING_WINDOW_DAYS * 24 * 3600_000, nowMs
    );
    const recentCycles = extractCycles(events, windowMs, nowMs);

    console.log(`[analyze-patterns] Cycles: ${allCycles.length} total, ${recentCycles.length} recent`);

    // ── 4. Split cycles by period ─────────────────────────────────────────────
    const dayCycles = allCycles.filter(c => c.period === "day");
    const nightCycles = allCycles.filter(c => c.period === "night");

    const allStats = computePatternStats(allCycles);
    const dayStats = computePatternStats(dayCycles);
    const nightStats = computePatternStats(nightCycles);

    // ── 5. Accuracy history (clean snapshot rows drive drift/bias) ────────────
    const history = await loadHistory(supabase);
    const cleanHistoryCount = history.filter(
      r => r.slot_id !== null && r.slot_id.startsWith("snap_")
    ).length;
    console.log(`[analyze-patterns] Accuracy history: ${history.length} rows (${cleanHistoryCount} clean)`);

    // ── 6. Drift offset ───────────────────────────────────────────────────────
    const { driftOffset, driftSamples, sampleCount: driftSampleCount } =
      computeDriftOffset(history);

    // ── 7. Previous prediction (volatility EMA + snapshots) ───────────────────
    const { data: prevPred } = await supabase
      .from("utility_predictions")
      .select("prediction")
      .eq("id", 1)
      .maybeSingle();

    const prevPayload = (prevPred?.prediction ?? null) as Record<string, unknown> | null;
    const prevApppe = (prevPayload?.apppe ?? null) as Record<string, unknown> | null;
    const prevVolEMA: number = (prevApppe?.volatilityEMA as number) ?? 0;
    const prevSnapshots: PredictionSnapshot[] =
      (Array.isArray(prevPayload?.snapshots) ? prevPayload.snapshots : []) as PredictionSnapshot[];

    const volatilityEMA = computeVolatilityEMA(
      history.filter(r => r.slot_id !== null && r.slot_id.startsWith("snap_")),
      prevVolEMA,
    );

    // ── 8. Crisis detection (last 24h vs 7-day baseline) ─────────────────────
    const last24hCycles = allCycles.filter(c => c.startMs > nowMs - 24 * 3600_000);
    const { crisisActive, crisisReason, crisisShift } = detectCrisis(last24hCycles, allCycles);
    console.log(`[analyze-patterns] Crisis: ${crisisActive}, reason: ${crisisReason ?? "none"}`);

    // ── 9. Bias Engine ────────────────────────────────────────────────────────
    const biasResult = loadBiasFromHistory(history);
    console.log(
      `[analyze-patterns] Bias: ON=${biasResult.biasRatioOn.toFixed(2)}x ` +
      `OFF=${biasResult.biasRatioOff.toFixed(2)}x samples=${biasResult.sampleCount}`
    );

    // ── 10. Quality factors & confidence ──────────────────────────────────────
    const biasSamples = history
      .filter(r => r.slot_id !== null && r.slot_id.startsWith("snap_") &&
        r.predicted_duration_min !== null && r.actual_duration_min !== null)
      .map(r => r.actual_duration_min! / r.predicted_duration_min!);

    const qualityFactors = computeQualityFactors(
      allCycles,
      driftSamples,
      biasSamples,
      volatilityEMA,
      crisisActive,
    );
    const confidence = computeConfidence(qualityFactors);

    // ── 11. Learning mode ─────────────────────────────────────────────────────
    const effectiveWeightedSamples = Math.min(allCycles.length, 25);
    const learningMode: "prior_only" | "hybrid" | "learned" =
      effectiveWeightedSamples >= 21 ? "learned" :
      effectiveWeightedSamples >= 7 ? "hybrid" : "prior_only";

    // ── 12. Solar-aware duration model ────────────────────────────────────────
    const model = buildDurationModel(allCycles, nowMs);

    // ── 12b. Shock detector (fuel shortage / cloudy day / breakdown) ─────────
    const shock = detectShock(allCycles, model);
    console.log(`[analyze-patterns] Shock: ${shock.shockActive} (${shock.shockKind}), shift=${shock.shiftOffMin}min`);

    // ── 13. Current state start time ─────────────────────────────────────────
    const sortedEvents = [...events].sort(
      (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
    );
    const lastTransitionEvent = sortedEvents.find(
      e => (e.event_type === "UTILITY_ON") === (currentState === "ON")
    );
    const currentStateStartMs = lastTransitionEvent
      ? new Date(lastTransitionEvent.occurred_at).getTime()
      : nowMs - 60 * 60_000; // fallback: 60 min ago

    const currentStateDurationMin = Math.round((nowMs - currentStateStartMs) / 60_000);

    // ── 14. Generate day schedule (per-slot durations) ────────────────────────
    const daySchedule = generateDaySchedule(
      currentState,
      currentStateStartMs,
      model,
      driftOffset,
      biasResult,
      nowMs,
      crisisActive,
      crisisShift,
      shock,
    );

    console.log(`[analyze-patterns] Generated ${daySchedule.length} schedule slots`);

    // ── 15. Next transition ───────────────────────────────────────────────────
    const nextTransition = computeNextTransition(daySchedule, currentState, model, nowMs) as {
      type: "UTILITY_ON" | "UTILITY_OFF";
      earliestTime: string;
      rangeStartIso: string;
    } | null;

    // ── 16. Resolve past snapshots against real events ────────────────────────
    let accInserted = 0;
    let resolvedSnapIds = new Set<string>();
    try {
      const res = await resolveAccuracyRows(supabase, events, prevSnapshots);
      accInserted = res.inserted;
      resolvedSnapIds = res.resolvedSnapIds;
      console.log(`[analyze-patterns] Accuracy resolve: inserted=${accInserted}`);
    } catch (accErr) {
      console.error("[analyze-patterns] Accuracy resolve failed (non-fatal):", accErr);
    }

    // ── 17. Append the live prediction as a new snapshot ──────────────────────
    let newSnap: PredictionSnapshot | null = null;
    if (nextTransition) {
      const targetState = nextTransition.type === "UTILITY_ON" ? "ON" : "OFF";
      const slot = daySchedule.find(
        s => s.state === targetState && s.startIso === nextTransition.earliestTime
      );
      let slotDurMin = 0;
      if (slot?.endIso) {
        slotDurMin = Math.round(
          (new Date(slot.endIso).getTime() - new Date(slot.startIso).getTime()) / 60_000
        );
      } else {
        slotDurMin = Math.round(
          targetState === "ON" ? model.onDurAt(nowMs) : model.offDurAt(nowMs)
        );
      }
      // Round the predicted time to the minute for the snapshot id/ISO:
      // recency weights shift the computed ISO by sub-second amounts each
      // run, which would otherwise mint a NEW snapshot id every invocation
      // (26 near-identical snapshots accumulated in one day).
      const predIsoMin = new Date(
        Math.round(new Date(nextTransition.earliestTime).getTime() / 60_000) * 60_000
      ).toISOString();
      newSnap = {
        id: `snap_${nextTransition.type}_${predIsoMin}`,
        type: nextTransition.type,
        predictedIso: predIsoMin,
        slotDurationMin: slotDurMin,
        generatedAt: new Date(nowMs).toISOString(),
        confidence,
      };
    }
    const snapshots = mergeSnapshots(prevSnapshots, newSnap, resolvedSnapIds, nowMs);

    // ── 18. Stability metrics (censored runs excluded) ────────────────────────
    const offDurations = allCycles
      .filter(c => c.state === "OFF" && !c.censored).map(c => c.durationMin);
    const madOffVal = Math.round(mad(offDurations));
    const avgOffVal = mean(offDurations);
    const onDurations = allCycles
      .filter(c => c.state === "ON" && !c.censored).map(c => c.durationMin);
    const madOnVal = onDurations.length > 0 ? Math.round(mad(onDurations)) : null;
    const relativeMAD = avgOffVal > 0 ? mad(offDurations) / avgOffVal : 1;
    const stabilityScore = Math.max(0, Math.min(100, Math.round(100 - relativeMAD * 200)));
    const stabilityLabel = stabilityScore >= 75 ? "Stable"
      : stabilityScore >= 45 ? "Slightly Unstable" : "Unstable";
    const isUnstable = stabilityScore < 45;

    // ── 19. Expected ranges (v6.2: shared module-level helper, same logic) ──
    const expectedOffRange = computeExpectedRange(offDurations);
    const expectedOnRange = computeExpectedRange(onDurations);

    // ── 20. Confidence label ──────────────────────────────────────────────────
    const confidenceLabel =
      confidence >= 88 ? "مرتفعة جداً" :
      confidence >= 72 ? "مرتفعة" :
      confidence >= 52 ? "متوسطة" : "منخفضة";

    // ── 21. Reasoning ─────────────────────────────────────────────────────────
    const reasoning: string[] = [];
    reasoning.push(
      `تم تحليل ${allCycles.length} دورة في نافذة ${LEARNING_WINDOW_DAYS} أيام`
    );
    if (model.offCurve.length > 0) {
      const durs = model.offCurve.map(p => p.durMin);
      const lo = Math.min(...durs);
      const hi = Math.max(...durs);
      if (hi - lo >= 30) {
        reasoning.push(
          `مدة الانقطاع تعتمد على وقت بدئها: من ${durationLabel(lo)} ظهراً (دعم الطاقة الشمسية) ` +
          `حتى ${durationLabel(hi)} في ذروة المساء`
        );
      }
    }
    if (crisisActive && crisisReason) {
      reasoning.push(`⚠️ وضع الأزمة: ${crisisReason}`);
    }
    if (shock.shockActive && shock.shockKind === "inrun") {
      reasoning.push(
        "⚠️ انقطاع ممتد: تجاوزت مدة الانقطاع الحالية النمط المعتاد لهذا الوقت — تم تمديد التوقع تلقائياً"
      );
    } else if (shock.shockActive && shock.shockKind === "persistent") {
      reasoning.push(
        `⚠️ كشف تغيّر مفاجئ في النمط (نقص وقود / طقس غائم / عطل): ` +
        `تم تعديل توقعات الانقطاع بمقدار ${shock.shiftOffMin > 0 ? "+" : ""}${shock.shiftOffMin} دقيقة`
      );
    }
    if (driftOffset !== 0) {
      reasoning.push(`انحراف التوقيت المُصحَّح: ${driftOffset > 0 ? "+" : ""}${driftOffset} دقيقة`);
    }
    if (biasResult.sampleCount >= 4) {
      reasoning.push(
        `تصحيح التحيّز: تشغيل ×${biasResult.biasRatioOn.toFixed(2)}, انقطاع ×${biasResult.biasRatioOff.toFixed(2)}`
      );
    }
    if (learningMode === "learned") {
      reasoning.push("النظام في وضع التعلم المكتمل — تعتمد التوقعات بالكامل على البيانات الفعلية");
    } else if (learningMode === "hybrid") {
      reasoning.push("وضع هجين — تمزج التوقعات بين البيانات الفعلية والنماذج الأساسية");
    } else {
      reasoning.push("وضع التعلم المبكر — التوقعات تعتمد على النماذج الأساسية في الوقت الحالي");
    }

    const currentPeriod = getPeriod(nowMs);

    // ── 21b. Phase-group models (v6.2) ──────────────────────────────────────
    // ONE shared module (computePhaseModel), called once per group with only
    // the phase offset VALUE changed. The base model above is untouched and
    // remains the ONLY learning model; a failing phase can never take the
    // base model down (per-phase try/catch).
    const phaseModels: Record<string, Record<string, unknown>> = {};
    for (const phaseOffsetHours of PHASE_GROUP_OFFSETS_HOURS) {
      const phaseKey = phaseOffsetHours > 0 ? `+${phaseOffsetHours}` : `${phaseOffsetHours}`;
      try {
        phaseModels[phaseKey] = computePhaseModel({
          phaseOffsetHours,
          extEvents: (extEvents ?? []) as PowerEvent[],
          currentState,
          currentStateStartMs,
          inverterOffline,
          driftOffset,
          driftSamples,
          driftSampleCount,
          biasResult,
          biasSamples,
          volatilityEMA,
          nowMs,
        });
      } catch (phaseErr) {
        console.error(`[analyze-patterns] phase model ${phaseKey} failed (non-fatal):`, phaseErr);
      }
    }
    console.log(`[analyze-patterns] Phase models computed: ${Object.keys(phaseModels).join(", ") || "none"}`);

    // ── 22. Assemble prediction object (v4 shape + v5 additions) ─────────────
    const prediction = {
      currentState,
      currentStateDurationMin,
      currentStateDurationLabel: durationLabel(currentStateDurationMin),
      lastTransitionAt: lastTransitionEvent?.occurred_at ?? lastTransitionAt,
      inverterOffline,

      nextTransition,
      expectedOffRange,
      expectedOnRange,
      daySchedule,
      snapshots,
      // v6.2: dedicated per-phase models (additive — older clients ignore
      // this key and keep using the base model with the full user offset).
      phaseModels,

      confidence,
      confidenceLabel,
      isUnstable,
      stabilityScore,
      stabilityLabel,

      dayPattern: dayStats,
      nightPattern: nightStats,
      allPattern: allStats,
      cyclesAnalyzed: allCycles.length,
      dayCyclesAnalyzed: dayCycles.length,
      nightCyclesAnalyzed: nightCycles.length,

      currentPeriod,
      reasoning,
      learningMode,
      dataWindowHours: ANALYSIS_WINDOW_HOURS,
      computedAt: new Date(nowMs).toISOString(),

      apppe: {
        version: "6.1",
        crisisActive,
        crisisReason,
        shockActive: shock.shockActive,
        shockKind: shock.shockKind,
        shockShiftOffMin: shock.shiftOffMin,
        shockReason: shock.reason,
        driftOffset,
        driftSampleCount,
        biasRatio: biasResult.biasRatioOn, // primary bias ratio (ON)
        biasRatioOff: biasResult.biasRatioOff,
        biasSampleCount: biasResult.sampleCount,
        volatilityEMA,
        volatilityLabel: volatilityEMA < 20 ? "Low" : volatilityEMA < 45 ? "Moderate" : volatilityEMA < 90 ? "Elevated" : "High",
        crisisShift,
        learningStrength: Math.round((effectiveWeightedSamples / 25) * 100),
        effectiveWeightedSamples,
        effectiveWeightedSamplesOn: onDurations.length,
        madOff: madOffVal,
        madOn: madOnVal,
        predictionQuality: qualityFactors,
        offDurationCurve: model.offCurve,
        historySource: `${cleanHistoryCount} snapshot-resolved rows (of ${history.length} total)`,
        rangeWasClamped: false,
      },
    };

    // ── 23. Upsert to utility_predictions ─────────────────────────────────────
    const { error: upsertErr } = await supabase
      .from("utility_predictions")
      .upsert({
        id: 1,
        prediction,
        computed_at: prediction.computedAt,
        analysis_window_hours: ANALYSIS_WINDOW_HOURS,
      });

    if (upsertErr) {
      console.error("[analyze-patterns] Upsert failed:", upsertErr.message);
      return new Response(
        JSON.stringify({ ok: false, error: upsertErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(
      `[analyze-patterns] Done. state=${currentState} confidence=${confidence}% ` +
      `slots=${daySchedule.length} drift=${driftOffset}min crisis=${crisisActive} ` +
      `shock=${shock.shockKind} snapshots=${snapshots.length}`
    );

    return new Response(
      JSON.stringify({
        ok: true,
        currentState,
        confidence,
        cyclesAnalyzed: allCycles.length,
        slotsGenerated: daySchedule.length,
        driftOffset,
        crisisActive,
        shockActive: shock.shockActive,
        shockKind: shock.shockKind,
        shockShiftOffMin: shock.shiftOffMin,
        biasRatioOn: biasResult.biasRatioOn,
        biasRatioOff: biasResult.biasRatioOff,
        biasSampleCount: biasResult.sampleCount,
        computedAt: prediction.computedAt,
        accuracyInserted: accInserted,
        snapshotCount: snapshots.length,
        phaseModelKeys: Object.keys(phaseModels),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[analyze-patterns] Fatal error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
