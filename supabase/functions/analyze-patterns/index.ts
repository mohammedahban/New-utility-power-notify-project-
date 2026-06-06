// analyze-patterns Edge Function — APPPE v3.0
// Adaptive Pattern Profile Prediction Engine
// Replaces: 36-hour rolling averages
// Uses: 7-day recency-weighted profiles with smooth blending, P25/P75 ranges,
//       crisis detection, and adaptive confidence scoring.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const YEMEN_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3
const DATA_WINDOW_DAYS = 7;
const DATA_WINDOW_HOURS = DATA_WINDOW_DAYS * 24;

// Profile definitions: [peakHour, transitionHalfWidthHours]
// Smooth cosine blending across transitions
const PROFILES = {
  A_NIGHT_GEN:      { name: "Night Generator",    center: 3,  half: 3 },
  B_MORNING_TRANS:  { name: "Morning Transition",  center: 8,  half: 2 },
  C_SOLAR:          { name: "Solar Assisted",      center: 13, half: 3 },
  D_EVENING_TRANS:  { name: "Evening Transition",  center: 18, half: 2 },
  E_NIGHT_CONS:     { name: "Night Consumption",   center: 22, half: 2 },
} as const;

type ProfileKey = keyof typeof PROFILES;
const PROFILE_KEYS = Object.keys(PROFILES) as ProfileKey[];

// Recency weights per day (index 0 = today, 6 = 7 days ago)
const BASE_RECENCY_WEIGHTS = [10, 8, 6, 5, 4, 3, 2, 1];
const CRISIS_RECENCY_WEIGHTS = [20, 15, 10, 5, 1, 1, 1, 1];

// Crisis detection thresholds
const CRISIS_OFF_INCREASE_PCT = 0.20;  // 20% longer OFF = fuel shortage
const CRISIS_ON_DECREASE_PCT  = 0.20;  // 20% shorter ON = failure

// Minimum samples before trusting profile over priors
const MIN_SAMPLES_LEARNED = 4;

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
  onDurMin: number | null;   // null if ON hasn't ended yet
  yemenHourAtStart: number;  // OFF start hour in Yemen time
  ageDays: number;           // 0 = today, 1 = yesterday, …
  recencyWeight: number;     // assigned after crisis detection
}

interface ProfileStats {
  key: ProfileKey;
  name: string;
  sampleCount: number;
  weightedMedianOff: number;
  weightedMedianOn: number | null;
  p25Off: number;
  p75Off: number;
  p25On: number | null;
  p75On: number | null;
  varianceOff: number;
  stabilityScore: number;   // 0–1
  confidenceScore: number;  // 0–1
}

interface BlendedProfile {
  weights: Record<ProfileKey, number>;   // sums to 1
  medianOff: number;
  medianOn: number | null;
  p25Off: number;
  p75Off: number;
  p25On: number | null;
  p75On: number | null;
  stability: number;
  confidence: number;
  dominantProfile: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY HELPERS
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
  if (min <= 0) return "0m";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function daysBetween(isoA: string, isoB: string): number {
  return (new Date(isoB).getTime() - new Date(isoA).getTime()) / 86_400_000;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE INFLUENCE SCORING — smooth cosine blending
// ─────────────────────────────────────────────────────────────────────────────

// Returns the cosine-based influence score (0–1) of a profile at a given hour.
// Uses a circular hour space so 23:00 and 01:00 are close to each other.
function profileInfluenceAt(profileKey: ProfileKey, hourFloat: number): number {
  const p = PROFILES[profileKey];
  // Circular distance (handle day wrap)
  let dist = Math.abs(hourFloat - p.center);
  if (dist > 12) dist = 24 - dist; // wrap around midnight

  if (dist >= p.half * 2) return 0; // outside influence zone
  // Cosine taper: 1 at center, 0 at boundary
  return 0.5 * (1 + Math.cos(Math.PI * dist / (p.half * 2)));
}

// Returns normalized profile weight map at a given Yemen hour
function blendWeightsAt(hourFloat: number): Record<ProfileKey, number> {
  const raw = {} as Record<ProfileKey, number>;
  let total = 0;
  for (const key of PROFILE_KEYS) {
    raw[key] = profileInfluenceAt(key, hourFloat);
    total += raw[key];
  }
  const result = {} as Record<ProfileKey, number>;
  for (const key of PROFILE_KEYS) {
    result[key] = total > 0 ? raw[key] / total : 1 / PROFILE_KEYS.length;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// CYCLE EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

function extractCycles(events: RawEvent[], now: Date): Cycle[] {
  const cycles: Cycle[] = [];
  let offStart: string | null = null;
  const nowMs = now.getTime();

  // Build a "today" reference at midnight Yemen time
  const yemenNow = toYemenDate(now.toISOString());
  const todayMidnightMs = Date.UTC(
    yemenNow.getUTCFullYear(),
    yemenNow.getUTCMonth(),
    yemenNow.getUTCDate()
  ) - YEMEN_OFFSET_MS;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.event_type === "UTILITY_OFF") {
      offStart = ev.occurred_at;
    } else if (ev.event_type === "UTILITY_ON" && offStart !== null) {
      const onStartMs = new Date(ev.occurred_at).getTime();
      const offStartMs = new Date(offStart).getTime();
      const offDurMin = (onStartMs - offStartMs) / 60000;
      if (offDurMin < 1) { offStart = null; continue; } // noise

      // Find next OFF for onDuration
      let onDurMin: number | null = null;
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].event_type === "UTILITY_OFF") {
          onDurMin = (new Date(events[j].occurred_at).getTime() - onStartMs) / 60000;
          break;
        }
      }

      // Age in days (0 = today, 1 = yesterday …)
      const offStartYemenDay = Math.floor((offStartMs - todayMidnightMs) / 86_400_000);
      const ageDays = Math.max(0, -offStartYemenDay); // negative = past

      cycles.push({
        offStartIso: offStart,
        onStartIso: ev.occurred_at,
        offDurMin,
        onDurMin,
        yemenHourAtStart: yemenHour(offStart),
        ageDays,
        recencyWeight: 1, // assigned later
      });

      offStart = null; // CRITICAL: reset
    }
  }

  return cycles;
}

// ─────────────────────────────────────────────────────────────────────────────
// CRISIS DETECTION
// ─────────────────────────────────────────────────────────────────────────────

interface CrisisResult {
  active: boolean;
  reason: string | null;
  recencyWeights: number[];
}

function detectCrisis(cycles: Cycle[], now: Date): CrisisResult {
  const recent = cycles.filter((c) => c.ageDays < 1);   // last 24h
  const baseline = cycles.filter((c) => c.ageDays >= 1 && c.ageDays < 4); // prev 3 days

  if (recent.length < 2 || baseline.length < 2) {
    return { active: false, reason: null, recencyWeights: BASE_RECENCY_WEIGHTS };
  }

  const recentOffMed = simpleMedian(recent.map((c) => c.offDurMin));
  const baseOffMed = simpleMedian(baseline.map((c) => c.offDurMin));

  const offIncrease = (recentOffMed - baseOffMed) / (baseOffMed || 1);

  const recentOnSamples = recent.filter((c) => c.onDurMin !== null);
  const baseOnSamples = baseline.filter((c) => c.onDurMin !== null);

  let onDecrease = 0;
  if (recentOnSamples.length >= 2 && baseOnSamples.length >= 2) {
    const recentOnMed = simpleMedian(recentOnSamples.map((c) => c.onDurMin as number));
    const baseOnMed = simpleMedian(baseOnSamples.map((c) => c.onDurMin as number));
    onDecrease = (baseOnMed - recentOnMed) / (baseOnMed || 1);
  }

  if (offIncrease >= CRISIS_OFF_INCREASE_PCT) {
    return {
      active: true,
      reason: `Outage durations increased by ${Math.round(offIncrease * 100)}% vs baseline — possible fuel shortage or government schedule change.`,
      recencyWeights: CRISIS_RECENCY_WEIGHTS,
    };
  }
  if (onDecrease >= CRISIS_ON_DECREASE_PCT) {
    return {
      active: true,
      reason: `ON durations decreased by ${Math.round(onDecrease * 100)}% vs baseline — possible generator capacity issue.`,
      recencyWeights: CRISIS_RECENCY_WEIGHTS,
    };
  }

  return { active: false, reason: null, recencyWeights: BASE_RECENCY_WEIGHTS };
}

// ─────────────────────────────────────────────────────────────────────────────
// WEIGHTED MEDIAN & PERCENTILES
// ─────────────────────────────────────────────────────────────────────────────

function simpleMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// Weighted median: sort by value, accumulate weights until ≥ 50% total
function weightedMedian(values: number[], weights: number[]): number {
  if (values.length === 0) return 0;
  const pairs = values
    .map((v, i) => ({ v, w: weights[i] }))
    .sort((a, b) => a.v - b.v);
  const totalW = pairs.reduce((s, p) => s + p.w, 0);
  let cumW = 0;
  for (const pair of pairs) {
    cumW += pair.w;
    if (cumW >= totalW / 2) return pair.v;
  }
  return pairs[pairs.length - 1].v;
}

// Weighted percentile (0–100 scale)
function weightedPercentile(values: number[], weights: number[], pct: number): number {
  if (values.length === 0) return 0;
  const pairs = values
    .map((v, i) => ({ v, w: weights[i] }))
    .sort((a, b) => a.v - b.v);
  const totalW = pairs.reduce((s, p) => s + p.w, 0);
  const target = (pct / 100) * totalW;
  let cumW = 0;
  for (const pair of pairs) {
    cumW += pair.w;
    if (cumW >= target) return pair.v;
  }
  return pairs[pairs.length - 1].v;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE STATISTICS
// ─────────────────────────────────────────────────────────────────────────────

function computeProfileStats(
  key: ProfileKey,
  cycles: Cycle[],
  recencyWeights: number[]
): ProfileStats {
  // Assign influence of each cycle to this profile based on start hour
  const withInfluence = cycles.map((c) => ({
    cycle: c,
    influence: profileInfluenceAt(key, c.yemenHourAtStart),
    totalWeight: profileInfluenceAt(key, c.yemenHourAtStart) * recencyWeights[Math.min(c.ageDays, recencyWeights.length - 1)],
  })).filter((x) => x.influence > 0.05); // only cycles with meaningful influence

  if (withInfluence.length === 0) {
    return {
      key,
      name: PROFILES[key].name,
      sampleCount: 0,
      weightedMedianOff: 0,
      weightedMedianOn: null,
      p25Off: 0, p75Off: 0,
      p25On: null, p75On: null,
      varianceOff: 0,
      stabilityScore: 0.3,
      confidenceScore: 0,
    };
  }

  const offVals = withInfluence.map((x) => x.cycle.offDurMin);
  const offWts  = withInfluence.map((x) => x.totalWeight);

  const medOff = weightedMedian(offVals, offWts);
  const p25Off = weightedPercentile(offVals, offWts, 25);
  const p75Off = weightedPercentile(offVals, offWts, 75);

  // Coefficient of variation for stability
  const meanOff = offVals.reduce((s, v, i) => s + v * offWts[i], 0) / offWts.reduce((s, w) => s + w, 0);
  const varOff = offVals.reduce((s, v, i) => s + offWts[i] * Math.pow(v - meanOff, 2), 0) / offWts.reduce((s, w) => s + w, 0);
  const cv = meanOff > 0 ? Math.sqrt(varOff) / meanOff : 1;

  const stability = cv < 0.10 ? 0.95 : cv < 0.20 ? 0.82 : cv < 0.35 ? 0.65 :
    cv < 0.50 ? 0.45 : cv < 0.75 ? 0.28 : 0.12;

  // ON stats (only cycles with completed ON duration)
  const onCycles = withInfluence.filter((x) => x.cycle.onDurMin !== null);
  let medOn: number | null = null;
  let p25On: number | null = null;
  let p75On: number | null = null;

  if (onCycles.length >= 2) {
    const onVals = onCycles.map((x) => x.cycle.onDurMin as number);
    const onWts  = onCycles.map((x) => x.totalWeight);
    medOn = weightedMedian(onVals, onWts);
    p25On = weightedPercentile(onVals, onWts, 25);
    p75On = weightedPercentile(onVals, onWts, 75);
  }

  const n = withInfluence.length;
  const confFromSamples = n >= 8 ? 0.95 : n >= 5 ? 0.80 : n >= 3 ? 0.60 : n >= 2 ? 0.40 : 0.20;
  const confidenceScore = confFromSamples * stability;

  return {
    key,
    name: PROFILES[key].name,
    sampleCount: n,
    weightedMedianOff: Math.round(medOff),
    weightedMedianOn: medOn !== null ? Math.round(medOn) : null,
    p25Off: Math.round(p25Off),
    p75Off: Math.round(p75Off),
    p25On: p25On !== null ? Math.round(p25On) : null,
    p75On: p75On !== null ? Math.round(p75On) : null,
    varianceOff: Math.round(varOff),
    stabilityScore: stability,
    confidenceScore: Math.min(1, confidenceScore),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE BLENDING
// ─────────────────────────────────────────────────────────────────────────────

// Default priors when data is sparse — Yemen-specific calibrated starting points
const PRIORS: Record<ProfileKey, { medOff: number; medOn: number; p25Off: number; p75Off: number; p25On: number; p75On: number }> = {
  A_NIGHT_GEN:     { medOff: 480, medOn: 115, p25Off: 360, p75Off: 600, p25On: 80,  p75On: 150 },
  B_MORNING_TRANS: { medOff: 220, medOn: 135, p25Off: 150, p75Off: 290, p25On: 90,  p75On: 180 },
  C_SOLAR:         { medOff: 305, medOn: 155, p25Off: 200, p75Off: 400, p25On: 110, p75On: 200 },
  D_EVENING_TRANS: { medOff: 260, medOn: 125, p25Off: 180, p75Off: 340, p25On: 85,  p75On: 165 },
  E_NIGHT_CONS:    { medOff: 440, medOn: 115, p25Off: 300, p75Off: 560, p25On: 75,  p75On: 155 },
};

function blendProfiles(
  profileStats: Record<ProfileKey, ProfileStats>,
  hourFloat: number,
  totalCycles: number,
): BlendedProfile {
  const weights = blendWeightsAt(hourFloat);

  let sumOff = 0, sumOn = 0, sumP25Off = 0, sumP75Off = 0;
  let sumP25On = 0, sumP75On = 0;
  let sumStab = 0, sumConf = 0;
  let onWeight = 0;

  for (const key of PROFILE_KEYS) {
    const w = weights[key];
    if (w < 0.001) continue;

    const stats = profileStats[key];
    const prior = PRIORS[key];

    // Blend between prior and learned data based on sample quality
    // More samples → more trust in learned data
    const learnTrust = Math.min(1, stats.sampleCount / MIN_SAMPLES_LEARNED);
    const priorTrust = 1 - learnTrust;

    const effMedOff  = stats.sampleCount > 0 ? learnTrust * stats.weightedMedianOff  + priorTrust * prior.medOff  : prior.medOff;
    const effP25Off  = stats.sampleCount > 0 ? learnTrust * stats.p25Off             + priorTrust * prior.p25Off  : prior.p25Off;
    const effP75Off  = stats.sampleCount > 0 ? learnTrust * stats.p75Off             + priorTrust * prior.p75Off  : prior.p75Off;

    const effMedOn   = stats.weightedMedianOn !== null
      ? learnTrust * stats.weightedMedianOn + priorTrust * prior.medOn
      : prior.medOn;
    const effP25On   = stats.p25On !== null
      ? learnTrust * stats.p25On + priorTrust * prior.p25On
      : prior.p25On;
    const effP75On   = stats.p75On !== null
      ? learnTrust * stats.p75On + priorTrust * prior.p75On
      : prior.p75On;

    const effStab = stats.sampleCount > 0 ? learnTrust * stats.stabilityScore + priorTrust * 0.5 : 0.5;
    const effConf = stats.sampleCount > 0 ? learnTrust * stats.confidenceScore + priorTrust * 0.3 : 0.3;

    sumOff    += w * effMedOff;
    sumP25Off += w * effP25Off;
    sumP75Off += w * effP75Off;
    sumOn     += w * effMedOn;
    sumP25On  += w * effP25On;
    sumP75On  += w * effP75On;
    sumStab   += w * effStab;
    sumConf   += w * effConf;
    onWeight  += w;
  }

  // Find dominant profile name
  const dominant = PROFILE_KEYS.reduce((a, b) => weights[a] > weights[b] ? a : b);

  // Clamp confidence based on total cycles
  const cycleFactor = totalCycles === 0 ? 0.15 : Math.min(1, totalCycles / 10);
  const finalConf = Math.min(0.97, sumConf * cycleFactor);

  return {
    weights,
    medianOff: Math.round(sumOff),
    medianOn: onWeight > 0 ? Math.round(sumOn) : null,
    p25Off: Math.round(Math.max(5, sumP25Off)),
    p75Off: Math.round(sumP75Off),
    p25On: onWeight > 0 ? Math.round(Math.max(5, sumP25On)) : null,
    p75On: onWeight > 0 ? Math.round(sumP75On) : null,
    stability: sumStab,
    confidence: finalConf,
    dominantProfile: PROFILES[dominant].name,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEXT TRANSITION PREDICTION
// ─────────────────────────────────────────────────────────────────────────────

function buildNextTransition(
  now: Date,
  currentlyOn: boolean,
  currentStateDurationMin: number,
  blended: BlendedProfile,
  crisisActive: boolean,
) {
  const type = currentlyOn ? "UTILITY_OFF" : "UTILITY_ON";

  // Expected total duration of current state
  const totalExp = currentlyOn ? (blended.medianOn ?? blended.medianOff) : blended.medianOff;
  const remaining = Math.max(0, totalExp - currentStateDurationMin);

  // Range: P25/P75 of current-state duration minus already-elapsed time
  const pLow  = (currentlyOn ? (blended.p25On ?? blended.p25Off) : blended.p25Off);
  const pHigh = (currentlyOn ? (blended.p75On ?? blended.p75Off) : blended.p75Off);

  let minRemaining = Math.max(0, pLow - currentStateDurationMin);
  let maxRemaining = Math.max(minRemaining + 5, pHigh - currentStateDurationMin);

  // Adaptive range width based on stability
  if (blended.stability < 0.45) {
    minRemaining = Math.max(0, minRemaining * 0.7);
    maxRemaining = maxRemaining * 1.4;
  }

  // In crisis mode, widen range further
  if (crisisActive) {
    minRemaining = Math.max(0, minRemaining * 0.6);
    maxRemaining = maxRemaining * 1.6;
  }

  const earliest = new Date(now.getTime() + minRemaining * 60000);
  const latest   = new Date(now.getTime() + maxRemaining * 60000);
  const midMin   = (minRemaining + maxRemaining) / 2;

  // Human-friendly wait label
  const waitH = Math.floor(midMin / 60);
  const waitM = Math.round(midMin % 60);
  const waitLabel = waitH > 0
    ? `~${waitH}h ${waitM > 0 ? waitM + "m" : ""}`.trim()
    : `~${waitM}m`;

  return {
    type,
    earliestTime: earliest.toISOString(),
    latestTime: latest.toISOString(),
    earliestFormatted: fmtYemenWithDate(earliest),
    latestFormatted: fmtYemenWithDate(latest),
    minFromNowMin: Math.round(minRemaining),
    maxFromNowMin: Math.round(maxRemaining),
    rangeLabel: `${fmtYemen(earliest)} → ${fmtYemen(latest)}`,
    waitLabel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY SCHEDULE GENERATION
// ─────────────────────────────────────────────────────────────────────────────

function getZone(h: number): string {
  if (h < 6)  return "Night";
  if (h < 10) return "Morning";
  if (h < 16) return "Midday";
  if (h < 20) return "Evening";
  return "Late Night";
}

function generateDaySchedule(
  now: Date,
  currentlyOn: boolean,
  currentStateDurationMin: number,
  profileStats: Record<ProfileKey, ProfileStats>,
  totalCycles: number,
): object[] {
  const windowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const slots: object[] = [];
  let cursor = new Date(now);
  let stateOn = currentlyOn;

  // First slot remaining time
  const nowYemenH = yemenHour(now.toISOString());
  const firstBlend = blendProfiles(profileStats, nowYemenH, totalCycles);
  const firstTotal = stateOn ? (firstBlend.medianOn ?? firstBlend.medianOff) : firstBlend.medianOff;
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
      isEstimated: i > 0,
    });

    if (!end) break;

    cursor = slotEnd;
    stateOn = !stateOn;

    // Next duration: blend based on new cursor hour
    const nextYh = yemenHour(cursor.toISOString());
    const nextBlend = blendProfiles(profileStats, nextYh, totalCycles);
    const nextDur = stateOn ? (nextBlend.medianOn ?? nextBlend.medianOff) : nextBlend.medianOff;
    slotEndMs = cursor.getTime() + Math.max(10, nextDur) * 60000;
  }

  return slots;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY COMPAT: PatternStats shape for the existing UI
// ─────────────────────────────────────────────────────────────────────────────

function toPatternStats(stats: ProfileStats | null): object | null {
  if (!stats || stats.sampleCount === 0) return null;
  return {
    cycles: stats.sampleCount,
    avgOffMin: stats.weightedMedianOff,
    stdDevOffMin: Math.round(Math.sqrt(stats.varianceOff)),
    avgOnMin: stats.weightedMedianOn,
    stdDevOnMin: null,
    minOffMin: stats.p25Off,
    maxOffMin: stats.p75Off,
    minOnMin: stats.p25On,
    maxOnMin: stats.p75On,
  };
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
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
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

  // ── Extract & weight cycles ────────────────────────────────────────────────
  const cycles = extractCycles(events, now);
  const crisis = detectCrisis(cycles, now);

  // Apply recency weights to cycles
  for (const c of cycles) {
    c.recencyWeight = crisis.recencyWeights[Math.min(c.ageDays, crisis.recencyWeights.length - 1)];
  }

  // ── Per-profile statistics ─────────────────────────────────────────────────
  const profileStats = {} as Record<ProfileKey, ProfileStats>;
  for (const key of PROFILE_KEYS) {
    profileStats[key] = computeProfileStats(key, cycles, crisis.recencyWeights);
  }

  // ── Blended prediction for current hour ───────────────────────────────────
  const nowYemenH = yemenHour(now.toISOString());
  const blended = blendProfiles(profileStats, nowYemenH, cycles.length);

  // ── Overall stability & confidence ────────────────────────────────────────
  const stabilityRaw = blended.stability;
  const isUnstable = stabilityRaw < 0.28 || crisis.active;
  const stabilityScore = Math.round(stabilityRaw * 100);
  const stabLabel = stabilityRaw >= 0.75 ? "Stable" : stabilityRaw >= 0.45 ? "Slightly Unstable" : "Unstable";

  const confidenceRaw = isUnstable ? Math.min(blended.confidence, 0.30) : blended.confidence;
  const confidence = Math.round(confidenceRaw * 100);
  const confLabel = confidence >= 88 ? "Very High" : confidence >= 72 ? "High" :
    confidence >= 52 ? "Medium" : confidence >= 35 ? "Low" : "Very Low";

  // ── Next transition ────────────────────────────────────────────────────────
  let nextTransition: object | null = null;
  if (!isUnstable || cycles.length >= 2) {
    nextTransition = buildNextTransition(
      now, currentlyOn, currentStateDurationMin, blended, crisis.active
    );
  }

  // ── Expected ranges ────────────────────────────────────────────────────────
  const expectedOffRange = {
    minMin: blended.p25Off,
    maxMin: blended.p75Off,
    label: `${fmtMin(blended.p25Off)} → ${fmtMin(blended.p75Off)}`,
  };
  const expectedOnRange = blended.p25On !== null && blended.p75On !== null ? {
    minMin: blended.p25On,
    maxMin: blended.p75On,
    label: `${fmtMin(blended.p25On)} → ${fmtMin(blended.p75On)}`,
  } : null;

  // ── Day schedule ───────────────────────────────────────────────────────────
  const daySchedule = generateDaySchedule(
    now, currentlyOn, currentStateDurationMin, profileStats, cycles.length
  );

  // ── Day / night split for legacy UI ───────────────────────────────────────
  const dayCycles   = cycles.filter((c) => c.yemenHourAtStart >= 6 && c.yemenHourAtStart < 18);
  const nightCycles = cycles.filter((c) => c.yemenHourAtStart < 6 || c.yemenHourAtStart >= 18);
  const dayStats   = toPatternStats(profileStats.C_SOLAR);       // best proxy for daytime
  const nightStats = toPatternStats(profileStats.A_NIGHT_GEN);   // best proxy for nighttime
  const allStats   = cycles.length > 0 ? toPatternStats({
    key: "C_SOLAR" as ProfileKey,
    name: "All Cycles",
    sampleCount: cycles.length,
    weightedMedianOff: blended.medianOff,
    weightedMedianOn: blended.medianOn,
    p25Off: blended.p25Off,
    p75Off: blended.p75Off,
    p25On: blended.p25On,
    p75On: blended.p75On,
    varianceOff: 0,
    stabilityScore: stabilityRaw,
    confidenceScore: confidenceRaw,
  }) : null;

  // ── Learning mode ─────────────────────────────────────────────────────────
  const maxSamples = Math.max(...PROFILE_KEYS.map((k) => profileStats[k].sampleCount));
  const learningMode = maxSamples < 4 ? "prior_only" : maxSamples < 10 ? "hybrid" : "learned";

  // ── Reasoning ─────────────────────────────────────────────────────────────
  const reasoning: string[] = [];

  if (cycles.length === 0) {
    reasoning.push(`No complete utility cycles found in the last ${DATA_WINDOW_DAYS} days — using statistical priors.`);
    reasoning.push(`System will learn from your grid as events accumulate.`);
  } else {
    reasoning.push(`Analyzed ${cycles.length} cycle${cycles.length !== 1 ? "s" : ""} from the last ${DATA_WINDOW_DAYS} days.`);
    reasoning.push(`Currently matching: ${blended.dominantProfile} profile (${nowYemenH}:00 Yemen time).`);

    const offRangeStr = `${fmtMin(blended.p25Off)}–${fmtMin(blended.p75Off)}`;
    reasoning.push(`Expected outage length: ${offRangeStr} (P25–P75 range).`);

    if (blended.medianOn !== null) {
      const onRangeStr = blended.p25On !== null && blended.p75On !== null
        ? `${fmtMin(blended.p25On)}–${fmtMin(blended.p75On)}`
        : fmtMin(blended.medianOn);
      reasoning.push(`Expected ON duration: ${onRangeStr}.`);
    }

    if (crisis.active && crisis.reason) {
      reasoning.push(`⚠️ Pattern Shift Mode: ${crisis.reason}`);
    }

    reasoning.push(`Pattern: ${stabLabel} (${stabilityScore}%). Confidence: ${confLabel} (${confidence}%).`);

    if (currentStateDurationMin > 0) {
      reasoning.push(`Grid has been ${currentlyOn ? "ON" : "OFF"} for ${fmtMin(currentStateDurationMin)}.`);
    }

    // Profile blend info
    const topProfiles = PROFILE_KEYS
      .map((k) => ({ name: PROFILES[k].name, w: blended.weights[k] }))
      .filter((x) => x.w > 0.05)
      .sort((a, b) => b.w - a.w)
      .slice(0, 2);
    if (topProfiles.length > 1) {
      reasoning.push(`Blending: ${topProfiles.map((p) => `${p.name} ${Math.round(p.w * 100)}%`).join(" + ")}.`);
    }
  }

  if (isUnstable && cycles.length > 0) {
    reasoning.push("High pattern variability detected — prediction ranges are wider than usual.");
  }

  // ── Assemble prediction ────────────────────────────────────────────────────
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

    // APPPE-specific metadata (available for future UI enhancements)
    apppe: {
      version: "3.0",
      dominantProfile: blended.dominantProfile,
      crisisMode: crisis.active,
      crisisReason: crisis.reason,
      profileBlend: Object.fromEntries(
        PROFILE_KEYS.map((k) => [PROFILES[k].name, Math.round(blended.weights[k] * 100)])
      ),
      profileSamples: Object.fromEntries(
        PROFILE_KEYS.map((k) => [PROFILES[k].name, profileStats[k].sampleCount])
      ),
    },
  };

  // ── Upsert to database ─────────────────────────────────────────────────────
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
    JSON.stringify({ ok: true, cycles: cycles.length, crisisMode: crisis.active, profile: blended.dominantProfile }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
