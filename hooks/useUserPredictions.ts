/**
 * useUserPredictions — Layered Scheduling Engine
 *
 * Formula:
 *   Effective User Timeline
 *     = Master Pattern (from utility_predictions)
 *     + User Offset
 *     + Growatt Adjustments (auto-applied via master update)
 *     + Community Sync Adjustments
 *     + ATC Decision Layer
 */

import { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { Prediction, ScheduleSlot } from './usePredictions';
import { ResyncPoint } from '../contexts/ResyncContext';

// ── Public types ──────────────────────────────────────────────────────────────

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT';

export interface ATCState {
  mode: ScheduleStateMode;
  overrunMinutes: number;
  communityElevated: boolean;
  statusLine: string | null;
  /** True when Growatt changed state but validation window is still active */
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
}

export interface CommunitySyncMeta {
  reporterName: string | null;
  reporterReliability: number | null;
  syncedAtIso: string;
  syncedState: 'ON' | 'OFF';
}

export interface ShiftedTransition {
  type: 'UTILITY_ON' | 'UTILITY_OFF';
  /** Formatted range — e.g. "7:00 م → 8:03 م" */
  rangeLabel: string;
  /** ISO strings for the range start and end */
  rangeStartIso: string;
  rangeEndIso: string;
  minFromNowMin: number;
  maxFromNowMin: number;
  waitLabel: string;
  /** True if current time has entered the prediction range window */
  inRangeWindow: boolean;
}

export interface ShiftedScheduleSlot extends ScheduleSlot {
  shiftedStartFormatted: string;
  shiftedEndFormatted: string | null;
  isResynced?: boolean;
}

export interface UserPrediction {
  atc: ATCState;
  nextTransition: ShiftedTransition | null;
  expectedOffDurationLabel: string | null;
  expectedOnDurationLabel: string | null;
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  currentState: 'ON' | 'OFF';
  currentStateDurationLabel: string;
  /** ISO of when the current state started (for elapsed timer) */
  currentStateStartIso: string | null;
  daySchedule: ShiftedScheduleSlot[];
  reasoning: string[];
  learningMode: string;
  computedAt: string | null;
  offsetMinutes: number;
  crisisMode: boolean;
  crisisReason: string | null;
  isResynced: boolean;
  resyncedAtIso: string | null;
  isHoldingState: boolean;
  communitySyncMeta: CommunitySyncMeta | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function shiftMs(iso: string, deltaMs: number): string {
  return new Date(new Date(iso).getTime() + deltaMs).toISOString();
}

function fmtYemenTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function getZoneFromIso(iso: string): string {
  const h = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000).getUTCHours();
  if (h < 6) return 'Night';
  if (h < 10) return 'Morning';
  if (h < 16) return 'Midday';
  if (h < 20) return 'Evening';
  return 'Late Night';
}

function fmtWait(min: number): string {
  if (min <= 0) return 'قريباً';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `~${m}د`;
  if (m === 0) return `~${h}س`;
  return `~${h}س ${m}د`;
}

function durationLabelFromMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
  return `${h}س ${m}د`;
}

// ── Step 1: Extend master schedule to 48h ────────────────────────────────────
function extendScheduleTo48h(masterSlots: ScheduleSlot[], prediction: Prediction): ScheduleSlot[] {
  if (masterSlots.length === 0) return [];

  let realOnMin: number | null = null;
  let realOffMin: number | null = null;

  for (let i = masterSlots.length - 1; i >= 0; i--) {
    const s = masterSlots[i];
    if (!s.endIso) continue;
    const durMin = (new Date(s.endIso).getTime() - new Date(s.startIso).getTime()) / 60_000;
    if (durMin < 5) continue;
    if (s.state === 'ON' && realOnMin === null) realOnMin = durMin;
    if (s.state === 'OFF' && realOffMin === null) realOffMin = durMin;
    if (realOnMin !== null && realOffMin !== null) break;
  }

  const extOnMin = realOnMin ?? prediction.expectedOnRange?.minMin ?? prediction.allPattern?.avgOnMin ?? prediction.dayPattern?.avgOnMin ?? 120;
  const extOffMin = realOffMin ?? prediction.expectedOffRange?.minMin ?? prediction.allPattern?.avgOffMin ?? prediction.dayPattern?.avgOffMin ?? 360;

  const horizonMs = Date.now() + 48 * 60 * 60 * 1000;
  const slots: ScheduleSlot[] = [...masterSlots];

  while (slots.length < 40) {
    const last = slots[slots.length - 1];
    if (!last.endIso) break;
    const lastEndMs = new Date(last.endIso).getTime();
    if (lastEndMs >= horizonMs) break;

    const nextState: 'ON' | 'OFF' = last.state === 'ON' ? 'OFF' : 'ON';
    const durationMin = nextState === 'OFF' ? extOffMin : extOnMin;
    const nextStartIso = last.endIso;
    const nextEndMs = lastEndMs + durationMin * 60_000;
    const nextEndIso = new Date(nextEndMs).toISOString();

    slots.push({
      state: nextState,
      startIso: nextStartIso,
      endIso: nextEndIso,
      startFormatted: fmtYemenTime(nextStartIso),
      endFormatted: fmtYemenTime(nextEndIso),
      durationLabel: durationLabelFromMin(Math.round(durationMin)),
      zone: getZoneFromIso(nextStartIso),
      isEstimated: true,
    });
  }

  return slots;
}

// ── Step 2: Apply offset ──────────────────────────────────────────────────────
function applyOffsetToSlots(slots: ScheduleSlot[], offsetMs: number): ShiftedScheduleSlot[] {
  return slots.map((slot) => {
    const startIso = shiftMs(slot.startIso, offsetMs);
    const endIso = slot.endIso ? shiftMs(slot.endIso, offsetMs) : null;
    return {
      ...slot,
      startIso,
      endIso,
      startFormatted: fmtYemenTime(startIso),
      endFormatted: endIso ? fmtYemenTime(endIso) : null,
      shiftedStartFormatted: fmtYemenTime(startIso),
      shiftedEndFormatted: endIso ? fmtYemenTime(endIso) : null,
      isResynced: false,
    };
  });
}

// ── Step 3: Apply community delta ─────────────────────────────────────────────
function applyCommunityDelta(offsetSlots: ShiftedScheduleSlot[], resync: ResyncPoint): ShiftedScheduleSlot[] {
  const syncMs = new Date(resync.syncedAtIso).getTime();
  const syncState = resync.syncedState;
  const LOOKAHEAD_MS = 90 * 60_000;

  let matchIdx = -1;

  for (let i = 0; i < offsetSlots.length; i++) {
    const s = offsetSlots[i];
    if (s.state !== syncState) continue;
    const sMs = new Date(s.startIso).getTime();
    const eMs = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    if (syncMs >= sMs - LOOKAHEAD_MS && syncMs < eMs + LOOKAHEAD_MS) {
      matchIdx = i;
      break;
    }
  }

  if (matchIdx === -1) {
    const nowMs = Date.now();
    for (let i = 0; i < offsetSlots.length; i++) {
      if (offsetSlots[i].state !== syncState) continue;
      const sMs = new Date(offsetSlots[i].startIso).getTime();
      if (sMs >= nowMs - LOOKAHEAD_MS) {
        matchIdx = i;
        break;
      }
    }
  }

  if (matchIdx === -1) return offsetSlots;

  const matchedSlotStartMs = new Date(offsetSlots[matchIdx].startIso).getTime();
  const deltaMs = syncMs - matchedSlotStartMs;

  return offsetSlots.map((slot, idx) => {
    if (idx < matchIdx) return slot;
    const newStartIso = shiftMs(slot.startIso, deltaMs);
    const newEndIso = slot.endIso ? shiftMs(slot.endIso, deltaMs) : null;
    return {
      ...slot,
      startIso: newStartIso,
      endIso: newEndIso,
      startFormatted: fmtYemenTime(newStartIso),
      endFormatted: newEndIso ? fmtYemenTime(newEndIso) : null,
      shiftedStartFormatted: fmtYemenTime(newStartIso),
      shiftedEndFormatted: newEndIso ? fmtYemenTime(newEndIso) : null,
      isResynced: idx === matchIdx,
    };
  });
}

// ── Validation Window (20 min) — Growatt changed while sync is active ─────────
const VALIDATION_WINDOW_MS = 20 * 60_000;

// ── ATC Decision Engine ───────────────────────────────────────────────────────
function computeATCState(
  effectiveSlots: ShiftedScheduleSlot[],
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  prediction: Prediction,
): ATCState {
  const nowMs = Date.now();

  // Community Sync path — check validation window
  if (resyncPoint) {
    const syncedState = resyncPoint.syncedState;
    const growattState = prediction.currentState;
    const growattDiffers = (syncedState === 'ON') !== (growattState === 'ON');
    const syncAgeMs = nowMs - new Date(resyncPoint.syncedAtIso).getTime();
    const inValidationWindow = growattDiffers && syncAgeMs < VALIDATION_WINDOW_MS;
    const validationRemainingMin = inValidationWindow ? (VALIDATION_WINDOW_MS - syncAgeMs) / 60_000 : 0;

    if (inValidationWindow) {
      return {
        mode: 'COMMUNITY_SYNCED',
        overrunMinutes: 0,
        communityElevated: true,
        statusLine: `نافذة التحقق نشطة — ${Math.ceil(validationRemainingMin)} د متبقية`,
        inValidationWindow: true,
        validationWindowRemainingMin: validationRemainingMin,
      };
    }

    // Validation window expired & Growatt differs → ATC takes over (fall through)
    if (growattDiffers && syncAgeMs >= VALIDATION_WINDOW_MS) {
      // Community sync expired due to Growatt confirmation
      // Fall through to normal ATC logic below
    } else {
      return {
        mode: 'COMMUNITY_SYNCED',
        overrunMinutes: 0,
        communityElevated: false,
        statusLine: null,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
      };
    }
  }

  // ── Find the active slot ──────────────────────────────────────────────────
  let activeSlot: ShiftedScheduleSlot | null = null;
  for (const slot of effectiveSlots) {
    const start = new Date(slot.startIso).getTime();
    const end = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
    if (nowMs >= start && nowMs < end) {
      activeSlot = slot;
      break;
    }
  }

  if (!activeSlot || !activeSlot.endIso) {
    return { mode: 'NORMAL', overrunMinutes: 0, communityElevated: false, statusLine: null, inValidationWindow: false, validationWindowRemainingMin: 0 };
  }

  const slotEndMs = new Date(activeSlot.endIso).getTime();
  const halfSpreadMs = 15 * 60_000;
  const rangeStartMs = slotEndMs - halfSpreadMs;
  const rangeEndMs = slotEndMs + halfSpreadMs;
  const overrunMs = Math.max(0, nowMs - rangeEndMs);
  const overrunMin = overrunMs / 60_000;

  if (nowMs < rangeStartMs) {
    return { mode: 'NORMAL', overrunMinutes: 0, communityElevated: false, statusLine: null, inValidationWindow: false, validationWindowRemainingMin: 0 };
  }

  if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
    return {
      mode: 'PREDICTION_RANGE',
      overrunMinutes: 0,
      communityElevated: false,
      statusLine: 'نطاق التوقع نشط — التغيير محتمل',
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
    };
  }

  const GRACE_PERIOD_MS = 15 * 60_000;

  if (offsetMinutes < 0) {
    return {
      mode: 'UNCERTAIN_ZONE',
      overrunMinutes: overrunMin,
      communityElevated: true,
      statusLine: 'استمرار غير معتاد — بانتظار تأكيد تغير الحالة',
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
    };
  }

  if (offsetMinutes > 0) {
    return {
      mode: 'WAITING_FOR_GROWATT',
      overrunMinutes: overrunMin,
      communityElevated: true,
      statusLine: 'بانتظار تأكيد الحساس الرئيسي أو بلاغ مجتمعي',
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
    };
  }

  if (overrunMs <= GRACE_PERIOD_MS) {
    return {
      mode: 'PREDICTION_RANGE',
      overrunMinutes: overrunMin,
      communityElevated: false,
      statusLine: 'تأخر غير معتاد — لا يزال التشغيل مستمراً خارج النطاق المتوقع',
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
    };
  }

  return {
    mode: 'UNCERTAIN_ZONE',
    overrunMinutes: overrunMin,
    communityElevated: true,
    statusLine: 'النمط الحالي ممتد بشكل غير معتاد — بانتظار تأكيد تغير الحالة',
    inValidationWindow: false,
    validationWindowRemainingMin: 0,
  };
}

function atcShouldHold(mode: ScheduleStateMode): boolean {
  return mode === 'UNCERTAIN_ZONE' || mode === 'WAITING_FOR_GROWATT' || mode === 'PREDICTION_RANGE';
}

// ── Derive next transition ────────────────────────────────────────────────────
function deriveNextTransition(
  effectiveSlots: ShiftedScheduleSlot[],
  currentState: 'ON' | 'OFF',
  prediction: Prediction,
): ShiftedTransition | null {
  const nowMs = Date.now();
  const oppositeState: 'ON' | 'OFF' = currentState === 'ON' ? 'OFF' : 'ON';

  for (const slot of effectiveSlots) {
    if (slot.state !== oppositeState) continue;
    const slotMs = new Date(slot.startIso).getTime();
    if (slotMs <= nowMs) continue;

    const minFromNow = (slotMs - nowMs) / 60_000;
    let halfSpread = 15;
    if (prediction.nextTransition) {
      halfSpread = Math.max(10, (prediction.nextTransition.maxFromNowMin - prediction.nextTransition.minFromNowMin) / 2);
    }

    const minMin = Math.max(0, minFromNow - halfSpread);
    const maxMin = Math.max(0, minFromNow + halfSpread);
    const earliestIso = shiftMs(slot.startIso, -halfSpread * 60_000);
    const latestIso = shiftMs(slot.startIso, halfSpread * 60_000);

    // Check if current time is already inside the range window
    const rangeStartMs = new Date(earliestIso).getTime();
    const rangeEndMs = new Date(latestIso).getTime();
    const inRangeWindow = nowMs >= rangeStartMs && nowMs <= rangeEndMs;

    return {
      type: oppositeState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
      rangeLabel: `${fmtYemenTime(earliestIso)} → ${fmtYemenTime(latestIso)}`,
      rangeStartIso: earliestIso,
      rangeEndIso: latestIso,
      minFromNowMin: minMin,
      maxFromNowMin: maxMin,
      waitLabel: `${fmtWait(minMin)} → ${fmtWait(maxMin)}`,
      inRangeWindow,
    };
  }

  return null;
}

// ── ATC-aware current state derivation ───────────────────────────────────────
function deriveCurrentStateATC(
  effectiveSlots: ShiftedScheduleSlot[],
  atcMode: ScheduleStateMode,
  masterCurrentState: 'ON' | 'OFF',
  resyncPoint: ResyncPoint | null,
): { state: 'ON' | 'OFF'; startIso: string | null } {
  if (resyncPoint) {
    return { state: resyncPoint.syncedState, startIso: resyncPoint.syncedAtIso };
  }

  const nowMs = Date.now();
  const holding = atcShouldHold(atcMode);

  if (holding) {
    let bestSlot: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      const startMs = new Date(slot.startIso).getTime();
      if (startMs <= nowMs) bestSlot = slot;
      else break;
    }
    if (bestSlot) return { state: bestSlot.state, startIso: bestSlot.startIso };
  }

  for (let i = effectiveSlots.length - 1; i >= 0; i--) {
    const slot = effectiveSlots[i];
    if (new Date(slot.startIso).getTime() <= nowMs) {
      return { state: slot.state, startIso: slot.startIso };
    }
  }

  return { state: masterCurrentState, startIso: null };
}

// ── Duration label from startIso ──────────────────────────────────────────────
function elapsedLabel(startIso: string | null): string {
  if (!startIso) return '';
  const elapsedMin = Math.round((Date.now() - new Date(startIso).getTime()) / 60_000);
  if (elapsedMin < 1) return 'للتو';
  const eH = Math.floor(elapsedMin / 60);
  const eM = elapsedMin % 60;
  if (eH === 0) return `${elapsedMin}د`;
  if (eM === 0) return `${eH}س`;
  return `${eH}س ${eM}د`;
}

// ── Main pipeline ─────────────────────────────────────────────────────────────
export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  communitySyncMeta?: CommunitySyncMeta | null,
): UserPrediction {
  const offsetMs = offsetMinutes * 60_000;

  const extended = extendScheduleTo48h(prediction.daySchedule ?? [], prediction);
  let effectiveSlots = applyOffsetToSlots(extended, offsetMs);

  const hasResync = !!resyncPoint;
  if (resyncPoint) {
    effectiveSlots = applyCommunityDelta(effectiveSlots, resyncPoint);
  }

  const atcState = computeATCState(effectiveSlots, offsetMinutes, resyncPoint ?? null, prediction);

  const { state: currentState, startIso: currentStateStartIso } =
    deriveCurrentStateATC(effectiveSlots, atcState.mode, prediction.currentState, resyncPoint ?? null);

  const nextTransition = prediction.isUnstable
    ? null
    : deriveNextTransition(effectiveSlots, currentState, prediction);

  const isHolding = atcShouldHold(atcState.mode);
  const durLabel = elapsedLabel(currentStateStartIso);

  return {
    nextTransition,
    expectedOffDurationLabel: prediction.expectedOffRange?.label ?? null,
    expectedOnDurationLabel: prediction.expectedOnRange?.label ?? null,
    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    isUnstable: prediction.isUnstable,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    currentState,
    currentStateDurationLabel: durLabel,
    currentStateStartIso,
    daySchedule: effectiveSlots,
    reasoning: prediction.reasoning,
    learningMode: prediction.learningMode ?? 'prior_only',
    computedAt: prediction.computedAt ?? null,
    offsetMinutes,
    crisisMode: prediction.apppe?.crisisMode ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    isResynced: hasResync,
    resyncedAtIso: resyncPoint?.syncedAtIso ?? null,
    atc: atcState,
    isHoldingState: isHolding,
    communitySyncMeta: communitySyncMeta
      ?? (resyncPoint ? {
          reporterName: resyncPoint.reporterName ?? null,
          reporterReliability: resyncPoint.reporterReliability ?? null,
          syncedAtIso: resyncPoint.syncedAtIso,
          syncedState: resyncPoint.syncedState,
        } : null),
  };
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
) {
  const [rawPrediction, setRawPrediction] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(true);

  // Stable startIso anchor — only reset when the utility state actually flips
  // OR when offsetMinutes changes (new report shifted the schedule).
  // Prevents prediction DB refreshes from resetting the "منذ" elapsed counter.
  const stableStartRef = useRef<{ state: 'ON' | 'OFF'; startIso: string | null } | null>(null);
  const prevOffsetRef  = useRef<number>(offsetMinutes);

  // Fetch (or re-fetch) the latest prediction row from Supabase.
  // Extracted so it can be called both on mount and on AppState foreground resume.
  const fetchPrediction = () => {
    supabase
      .from('utility_predictions')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) console.error('[useUserPredictions] fetch error:', error.message);
        if (data?.prediction) setRawPrediction(data.prediction as Prediction);
        setLoading(false);
      });
  };

  useEffect(() => {
    let cancelled = false;

    // Initial fetch
    supabase
      .from('utility_predictions')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error('[useUserPredictions] fetch error:', error.message);
        if (data?.prediction) setRawPrediction(data.prediction as Prediction);
        setLoading(false);
      });

    const timeout = setTimeout(() => {
      if (cancelled) return;
      setLoading(false);
    }, 8000);

    // Re-fetch every time the app returns to foreground so the schedule is
    // always fresh after the user switches back from another app.
    const { AppState } = require('react-native') as typeof import('react-native');
    const handleAppState = (nextState: string) => {
      if (nextState === 'active') fetchPrediction();
    };
    const appStateSub = AppState.addEventListener('change', handleAppState);

    const channel = supabase
      .channel(`user_predictions_live_${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'utility_predictions',
      }, (payload) => {
        const row = payload.new as any;
        if (row?.prediction) setRawPrediction(row.prediction as Prediction);
      })
      .subscribe();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      appStateSub.remove();
      supabase.removeChannel(channel);
    };
  }, []);

  // Reset start anchor when offset changes so new slot times are adopted
  // immediately after the user submits a report that shifts their offset.
  // Also trigger a fresh DB fetch so the schedule UI reflects the latest
  // prediction row without waiting for the next real-time event or foreground resume.
  // IMPORTANT: This useEffect must be at the top level of the hook — never inside
  // a conditional or IIFE — to satisfy React's Rules of Hooks.
  useEffect(() => {
    if (prevOffsetRef.current !== offsetMinutes) {
      prevOffsetRef.current  = offsetMinutes;
      stableStartRef.current = null;
      fetchPrediction();
    }
  }, [offsetMinutes]);

  const userPrediction: UserPrediction | null = rawPrediction
    ? (() => {
        const pred = applyOffsetToPrediction(rawPrediction, offsetMinutes, resyncPoint, null);

        // ── Stabilize currentStateStartIso ────────────────────────────────────
        // Only update the anchor when the actual utility state changes (ON↔OFF).
        // If the state is the same as before, reuse the original startIso so
        // the "منذ" elapsed timer and schedule slot start time don't jump every
        // time the DB prediction refreshes.
        if (
          stableStartRef.current &&
          stableStartRef.current.state === pred.currentState
        ) {
          pred.currentStateStartIso = stableStartRef.current.startIso;
        } else {
          stableStartRef.current = {
            state: pred.currentState,
            startIso: pred.currentStateStartIso,
          };
        }

        return pred;
      })()
    : null;

  return { userPrediction, rawPrediction, loading };
}
