/**
 * analyze-patterns — APPPE v4 with Phase 4 Bias Engine
 *
 * Triggered automatically by poll-growatt on every Growatt state change.
 * Also runs on schedule (cron) and manual invocation from admin dashboard.
 *
 * Pipeline:
 *   1. Load power_events (last 36 hours configurable window)
 *   2. Extract ON/OFF cycles with durations
 *   3. APPPE v4 quality factor computation
 *   4. Phase 4 Bias Engine: correct duration predictions using accuracy logs
 *   5. Generate day schedule slots
 *   6. Write result to utility_predictions (id = 1, upsert)
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
const ANALYSIS_WINDOW_HOURS = 36;
const MIN_CYCLES_FOR_LEARNING = 3;
const MAX_DRIFT_SAMPLES = 20;
const VOLATILITY_EMA_ALPHA = 0.3;
const CRISIS_THRESHOLD_PCT = 0.40; // 40% change triggers crisis mode
const SCHEDULE_AHEAD_HOURS = 24;

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

// ── Time helpers ──────────────────────────────────────────────────────────────
function getPeriod(ms: number): "day" | "night" {
  const h = new Date(ms).toLocaleString("en-US", {
    timeZone: "Asia/Aden", hour: "numeric", hour12: false,
  });
  const hour = parseInt(h, 10);
  return hour >= 6 && hour < 20 ? "day" : "night";
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

// ── Extract cycles from power events ─────────────────────────────────────────
function extractCycles(events: PowerEvent[], windowMs: number, nowMs: number): Cycle[] {
  const cycles: Cycle[] = [];
  // Sort ascending
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
    cycles.push({
      state,
      startMs,
      endMs,
      durationMin,
      period: getPeriod(startMs),
    });
  }

  // Handle the last (still-active) state if within window
  if (sorted.length > 0) {
    const last = sorted[sorted.length - 1];
    const lastMs = new Date(last.occurred_at).getTime();
    if (nowMs - lastMs < windowMs) {
      const state: "ON" | "OFF" = last.event_type === "UTILITY_ON" ? "ON" : "OFF";
      cycles.push({
        state,
        startMs: lastMs,
        endMs: nowMs,
        durationMin: (nowMs - lastMs) / 60_000,
        period: getPeriod(lastMs),
      });
    }
  }

  return cycles;
}

// ── Pattern stats ─────────────────────────────────────────────────────────────
function computePatternStats(cycles: Cycle[]): PatternStats {
  const offDurations = cycles.filter(c => c.state === "OFF").map(c => c.durationMin);
  const onDurations = cycles.filter(c => c.state === "ON").map(c => c.durationMin);

  return {
    cycles: cycles.length,
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

// ── APPPE v4 quality factor computation ───────────────────────────────────────
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
  // 1. Data Quantity Factor (0-100): based on effective weighted samples
  const effectiveSamples = Math.min(cycles.length, 25);
  const dataQuantityFactor = Math.min(100, Math.round((effectiveSamples / 25) * 100));

  // 2. Stability Factor (0-100): based on relative MAD of OFF durations
  const offDurs = cycles.filter(c => c.state === "OFF").map(c => c.durationMin);
  const avgOff = mean(offDurs);
  const madOff = mad(offDurs);
  const relMad = avgOff > 0 ? madOff / avgOff : 1;
  const stabilityFactor = Math.max(0, Math.round(100 - relMad * 200));

  // 3. Drift Stability Factor (0-100): how consistent is the timing drift
  const driftStabilityFactor = driftSamples.length < 2
    ? 50
    : Math.max(0, Math.round(100 - (stdDev(driftSamples) / 30) * 100));

  // 4. Bias Stability Factor (0-100): how close bias ratio is to 1.0
  const avgBias = biasSamples.length > 0 ? mean(biasSamples) : 1.0;
  const biasDeviation = Math.abs(1 - avgBias);
  const biasStabilityFactor = Math.max(0, Math.round(100 - biasDeviation * 200));

  // 5. Volatility Factor (0-100): low volatility = high factor
  const volatilityFactor = Math.max(0, Math.round(100 - (volatilityEMA / 60) * 100));

  // 6. Crisis Factor (0-100): 100 if no crisis, penalized if crisis active
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

// ── Phase 4 Bias Engine ───────────────────────────────────────────────────────
interface BiasResult {
  biasRatioOn: number;  // actual/predicted for ON durations
  biasRatioOff: number; // actual/predicted for OFF durations
  sampleCount: number;
}

function loadBiasFromHistory(history: AccuracyLogRow[]): BiasResult {
  const onRows = history.filter(
    r => r.duration_type === "ON" &&
      r.predicted_duration_min !== null &&
      r.actual_duration_min !== null &&
      (r.predicted_duration_min ?? 0) > 0
  );
  const offRows = history.filter(
    r => r.duration_type === "OFF" &&
      r.predicted_duration_min !== null &&
      r.actual_duration_min !== null &&
      (r.predicted_duration_min ?? 0) > 0
  );

  const biasRatioOn = onRows.length >= 2
    ? mean(onRows.map(r => r.actual_duration_min! / r.predicted_duration_min!))
    : 1.0;
  const biasRatioOff = offRows.length >= 2
    ? mean(offRows.map(r => r.actual_duration_min! / r.predicted_duration_min!))
    : 1.0;

  // Clamp bias ratios to reasonable range [0.3, 3.0] to prevent absurd corrections
  return {
    biasRatioOn: Math.min(3.0, Math.max(0.3, biasRatioOn)),
    biasRatioOff: Math.min(3.0, Math.max(0.3, biasRatioOff)),
    sampleCount: onRows.length + offRows.length,
  };
}

// ── Drift offset computation ───────────────────────────────────────────────────
function computeDriftOffset(history: AccuracyLogRow[]): {
  driftOffset: number;
  driftSamples: number[];
  sampleCount: number;
} {
  if (history.length < 2) return { driftOffset: 0, driftSamples: [], sampleCount: 0 };

  const recent = history
    .slice(-MAX_DRIFT_SAMPLES)
    .map(r => {
      const predicted = new Date(r.predicted_event_time).getTime();
      const actual = new Date(r.actual_event_time).getTime();
      return (actual - predicted) / 60_000;
    })
    .filter(v => Number.isFinite(v) && Math.abs(v) < 300);

  if (recent.length < 2) return { driftOffset: 0, driftSamples: [], sampleCount: 0 };

  // Exponential recency weighting
  const weights = recent.map((_, i) => Math.exp(0.15 * (i - recent.length + 1)));
  const driftOffset = Math.round(weightedMean(recent, weights));

  return { driftOffset, driftSamples: recent, sampleCount: recent.length };
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

// ── Generate day schedule ─────────────────────────────────────────────────────
function generateDaySchedule(
  currentState: "ON" | "OFF",
  currentStateStartMs: number,
  avgOnMin: number,
  avgOffMin: number,
  driftOffsetMin: number,
  biasResult: BiasResult,
  nowMs: number,
  crisisActive: boolean,
  crisisShift: { on: number; off: number },
): Array<{
  state: "ON" | "OFF";
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
}> {
  const slots = [];
  const aheadMs = SCHEDULE_AHEAD_HOURS * 3600_000;
  const endMs = nowMs + aheadMs;

  // Apply bias corrections
  const correctedOnMin = avgOnMin * biasResult.biasRatioOn + (crisisActive ? crisisShift.on : 0);
  const correctedOffMin = avgOffMin * biasResult.biasRatioOff + (crisisActive ? crisisShift.off : 0);

  // Clamp to sane bounds
  const onMin = Math.max(10, Math.min(480, correctedOnMin));
  const offMin = Math.max(5, Math.min(480, correctedOffMin));

  let state = currentState;
  let slotStartMs = currentStateStartMs + driftOffsetMin * 60_000;

  // Backtrack if slotStartMs is before currentStateStartMs (drift went negative)
  if (slotStartMs > nowMs) slotStartMs = currentStateStartMs;

  let iterCount = 0;
  const MAX_ITER = 48;

  while (slotStartMs < endMs && iterCount < MAX_ITER) {
    iterCount++;
    const dur = state === "ON" ? onMin : offMin;
    const slotEndMs = slotStartMs + dur * 60_000;

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

  const histOff = historicalCycles.filter(c => c.state === "OFF").map(c => c.durationMin);
  const histOn = historicalCycles.filter(c => c.state === "ON").map(c => c.durationMin);
  const currOff = currentCycles.filter(c => c.state === "OFF").map(c => c.durationMin);
  const currOn = currentCycles.filter(c => c.state === "ON").map(c => c.durationMin);

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

// ── Next transition computation ────────────────────────────────────────────────
function computeNextTransition(
  slots: ReturnType<typeof generateDaySchedule>,
  currentState: "ON" | "OFF",
  nowMs: number,
): object | null {
  const targetState: "ON" | "OFF" = currentState === "ON" ? "OFF" : "ON";
  const nextSlot = slots.find(s => s.state === targetState && new Date(s.startIso).getTime() > nowMs);
  if (!nextSlot) return null;

  const startMs = new Date(nextSlot.startIso).getTime();
  const minFromNow = Math.max(0, (startMs - nowMs) / 60_000);
  const rangeWidth = 30; // ±30 min range
  const endMs = startMs + rangeWidth * 60_000;
  const endIso = new Date(endMs).toISOString();

  return {
    type: targetState === "ON" ? "UTILITY_ON" : "UTILITY_OFF",
    earliestTime: nextSlot.startIso,
    latestTime: endIso,
    earliestFormatted: nextSlot.startFormatted,
    latestFormatted: fmtYemenTime(endMs),
    minFromNowMin: minFromNow,
    maxFromNowMin: minFromNow + rangeWidth,
    rangeLabel: nextSlot.startFormatted,
    rangeStartIso: nextSlot.startIso,
    rangeEndIso: endIso,
    inRangeWindow: minFromNow <= 0,
  };
}

// ── Load accuracy history ─────────────────────────────────────────────────────
async function loadHistory(supabase: ReturnType<typeof getSupabase>): Promise<AccuracyLogRow[]> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("prediction_accuracy_logs")
    .select(
      "predicted_event_time, actual_event_time, error_minutes, accuracy_score, " +
      "duration_type, predicted_duration_min, actual_duration_min, confidence_score, created_at"
    )
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[analyze-patterns] loadHistory error:", error.message);
    // If the error is about missing columns (schema evolution), retry without those cols
    if (error.message.includes("duration_type") || error.message.includes("column")) {
      const { data: fallbackData } = await supabase
        .from("prediction_accuracy_logs")
        .select("predicted_event_time, actual_event_time, error_minutes, accuracy_score, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: true });
      return (fallbackData ?? []).map((r: any) => ({
        ...r,
        duration_type: null,
        predicted_duration_min: null,
        actual_duration_min: null,
        confidence_score: null,
      }));
    }
    return [];
  }

  return (data ?? []).map((r: any) => ({
    predicted_event_time: r.predicted_event_time,
    actual_event_time: r.actual_event_time,
    error_minutes: Number(r.error_minutes) || 0,
    accuracy_score: Number(r.accuracy_score) || 0,
    duration_type: r.duration_type ?? null,
    predicted_duration_min: r.predicted_duration_min !== null && r.predicted_duration_min !== undefined
      ? Number(r.predicted_duration_min) : null,
    actual_duration_min: r.actual_duration_min !== null && r.actual_duration_min !== undefined
      ? Number(r.actual_duration_min) : null,
    confidence_score: r.confidence_score !== null ? Number(r.confidence_score) : null,
    created_at: r.created_at,
  }));
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getSupabase();
  const nowMs = Date.now();
  const windowMs = ANALYSIS_WINDOW_HOURS * 3600_000;

  console.log("[analyze-patterns] Starting APPPE v4 analysis...");

  try {
    // ── 1. Load current inverter state ────────────────────────────────────────
    const { data: invState } = await supabase
      .from("inverter_state")
      .select("utility_on, last_polled, inverter_offline")
      .eq("id", 1)
      .maybeSingle();

    const currentState: "ON" | "OFF" = invState?.utility_on ? "ON" : "OFF";
    const lastTransitionAt = invState?.last_polled ?? null;
    const inverterOffline = invState?.inverter_offline ?? false;

    console.log(`[analyze-patterns] Current state: ${currentState}, offline: ${inverterOffline}`);

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

    // ── 3. Load extended history for pattern learning (7 days) ────────────────
    const extWindowStart = new Date(nowMs - 7 * 24 * 3600_000).toISOString();
    const { data: extEvents } = await supabase
      .from("power_events")
      .select("id, event_type, occurred_at")
      .gte("occurred_at", extWindowStart)
      .order("occurred_at", { ascending: false })
      .limit(500);

    const allCycles = extractCycles((extEvents ?? []) as PowerEvent[], 7 * 24 * 3600_000, nowMs);
    const recentCycles = extractCycles(events, windowMs, nowMs);

    console.log(`[analyze-patterns] Cycles: ${allCycles.length} total, ${recentCycles.length} recent`);

    // ── 4. Split cycles by period ─────────────────────────────────────────────
    const dayCycles = allCycles.filter(c => c.period === "day");
    const nightCycles = allCycles.filter(c => c.period === "night");

    const allStats = computePatternStats(allCycles);
    const dayStats = computePatternStats(dayCycles);
    const nightStats = computePatternStats(nightCycles);

    // ── 5. Load accuracy history (Phase 4) ────────────────────────────────────
    const history = await loadHistory(supabase);
    console.log(`[analyze-patterns] Accuracy history: ${history.length} rows`);

    // ── 6. Drift offset (timing correction) ───────────────────────────────────
    const { driftOffset, driftSamples, sampleCount: driftSampleCount } =
      computeDriftOffset(history);

    // ── 7. Volatility EMA ─────────────────────────────────────────────────────
    // Read previous EMA from last prediction if available
    const { data: prevPred } = await supabase
      .from("utility_predictions")
      .select("prediction")
      .eq("id", 1)
      .maybeSingle();

    const prevVolEMA: number = (prevPred?.prediction as any)?.apppe?.volatilityEMA ?? 0;
    const volatilityEMA = computeVolatilityEMA(history, prevVolEMA);

    // ── 8. Crisis detection ────────────────────────────────────────────────────
    // Use last 24h as "recent" vs 7-day as "historical" baseline
    const last24hCycles = allCycles.filter(c => c.startMs > nowMs - 24 * 3600_000);
    const { crisisActive, crisisReason, crisisShift } = detectCrisis(last24hCycles, allCycles);
    console.log(`[analyze-patterns] Crisis: ${crisisActive}, reason: ${crisisReason ?? "none"}`);

    // ── 9. Phase 4 Bias Engine ────────────────────────────────────────────────
    const biasResult = loadBiasFromHistory(history);
    console.log(
      `[analyze-patterns] Bias: ON=${biasResult.biasRatioOn.toFixed(2)}x ` +
      `OFF=${biasResult.biasRatioOff.toFixed(2)}x samples=${biasResult.sampleCount}`
    );

    // ── 10. APPPE v4 quality factors ──────────────────────────────────────────
    const biasSamples = history
      .filter(r => r.predicted_duration_min !== null && r.actual_duration_min !== null)
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

    // ── 12. Determine effective ON/OFF durations ──────────────────────────────
    // Use period-specific stats if available, otherwise all-period stats
    const currentPeriod = getPeriod(nowMs);
    const periodStats = currentPeriod === "day" ? dayStats : nightStats;

    const avgOffMin = periodStats.avgOffMin > 0
      ? periodStats.avgOffMin
      : allStats.avgOffMin > 0 ? allStats.avgOffMin : 120;
    const avgOnMin = (periodStats.avgOnMin ?? allStats.avgOnMin) ?? 120;

    // ── 13. Current state start time ─────────────────────────────────────────
    // Find the last event that matches the current state
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

    // ── 14. Generate day schedule ─────────────────────────────────────────────
    const daySchedule = generateDaySchedule(
      currentState,
      currentStateStartMs,
      avgOnMin,
      avgOffMin,
      driftOffset,
      biasResult,
      nowMs,
      crisisActive,
      crisisShift,
    );

    console.log(`[analyze-patterns] Generated ${daySchedule.length} schedule slots`);

    // ── 15. Next transition ───────────────────────────────────────────────────
    const nextTransition = computeNextTransition(daySchedule, currentState, nowMs);

    // ── 16. Stability metrics ─────────────────────────────────────────────────
    const offDurations = allCycles.filter(c => c.state === "OFF").map(c => c.durationMin);
    const madOffVal = Math.round(mad(offDurations));
    const avgOffVal = mean(offDurations);
    const onDurations = allCycles.filter(c => c.state === "ON").map(c => c.durationMin);
    const madOnVal = onDurations.length > 0 ? Math.round(mad(onDurations)) : null;
    const relativeMAD = avgOffVal > 0 ? mad(offDurations) / avgOffVal : 1;
    const stabilityScore = Math.max(0, Math.min(100, Math.round(100 - relativeMAD * 200)));
    const stabilityLabel = stabilityScore >= 75 ? "Stable"
      : stabilityScore >= 45 ? "Slightly Unstable" : "Unstable";
    const isUnstable = stabilityScore < 45;

    // ── 17. Expected ranges ───────────────────────────────────────────────────
    const computeRange = (arr: number[]) => {
      if (arr.length === 0) return null;
      const avg = mean(arr);
      const sd = stdDev(arr);
      const minMin = Math.max(5, Math.round(avg - sd));
      const maxMin = Math.round(avg + sd);
      return { minMin, maxMin, label: `${durationLabel(minMin)}–${durationLabel(maxMin)}` };
    };
    const expectedOffRange = computeRange(offDurations);
    const expectedOnRange = computeRange(onDurations);

    // ── 18. Confidence label ──────────────────────────────────────────────────
    const confidenceLabel =
      confidence >= 88 ? "مرتفعة جداً" :
      confidence >= 72 ? "مرتفعة" :
      confidence >= 52 ? "متوسطة" : "منخفضة";

    // ── 19. Reasoning ─────────────────────────────────────────────────────────
    const reasoning: string[] = [];
    reasoning.push(
      `تم تحليل ${allCycles.length} دورة في نافذة ${ANALYSIS_WINDOW_HOURS} ساعة`
    );
    if (crisisActive && crisisReason) {
      reasoning.push(`⚠️ وضع الأزمة: ${crisisReason}`);
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

    // ── 20. Assemble prediction object ────────────────────────────────────────
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
        version: "4",
        crisisActive,
        crisisReason,
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
        historySource: `${history.length} accuracy log rows`,
        rangeWasClamped: false,
      },
    };

    // ── 21. Upsert to utility_predictions ─────────────────────────────────────
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
      `slots=${daySchedule.length} drift=${driftOffset}min crisis=${crisisActive}`
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
        biasRatioOn: biasResult.biasRatioOn,
        biasRatioOff: biasResult.biasRatioOff,
        biasSampleCount: biasResult.sampleCount,
        computedAt: prediction.computedAt,
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
