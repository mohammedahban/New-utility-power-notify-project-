/**
 * useUserPredictions — ATC (Adaptive Transition Controller) state machine.
 *
 * Applies a user's DSD offset to the raw Growatt prediction, producing a
 * user-specific schedule and determining the current ATC mode.
 *
 * ATC Modes (ScheduleStateMode):
 *   NORMAL               — Within a known schedule slot, no special conditions.
 *   PREDICTION_RANGE     — Currently inside the prediction range window.
 *   UNCERTAIN_ZONE       — Negative-offset user is ahead of Growatt; waiting for
 *                          Growatt to confirm the transition the user already saw.
 *   COMMUNITY_SYNCED     — State overridden by a community report confirmation.
 *   WAITING_FOR_GROWATT  — Past expected transition; awaiting Growatt/community.
 *   GRACE_MODE           — Extended overrun; grace period active.
 *   POSITIVE_OFFSET_PENDING — Growatt transitioned; user's scheduled time is future.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { Prediction, ScheduleSlot } from './usePredictions';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

export interface ShiftedScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  shiftedStartFormatted: string | null;
  shiftedEndFormatted: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
  isResynced: boolean;
}

export interface CommunitySyncMeta {
  reporterName: string | null;
  reporterReliability: number | null;
  reportId: number | null;
  syncedAtIso: string | null;
  targetState: 'ON' | 'OFF';
}

export interface ATCState {
  mode: ScheduleStateMode;
  statusLine: string;
  overrunMinutes: number;
  transitionMode: 'AUTO' | 'MANUAL';
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  scheduledAutoTransitionIso: string | null;
}

export interface NextTransitionInfo {
  type: 'UTILITY_ON' | 'UTILITY_OFF';
  rangeStartIso: string;
  rangeEndIso: string;
  rangeLabel: string;
  minFromNowMin: number;
  maxFromNowMin: number;
  waitLabel: string;
  inRangeWindow: boolean;
}

export interface UserPrediction {
  // Current state
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;

  // Next transition
  nextTransition: NextTransitionInfo | null;

  // User's shifted schedule
  daySchedule: ShiftedScheduleSlot[];

  // ATC state machine
  atc: ATCState;
  isHoldingState: boolean;

  // Community sync
  isResynced: boolean;
  resyncedAtIso: string | null;
  communitySyncMeta: CommunitySyncMeta | null;

  // Prediction quality
  confidence: number;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  learningMode: 'prior_only' | 'hybrid' | 'learned';

  // Crisis
  crisisMode: boolean;
  crisisReason: string | null;

  // Typical durations
  expectedOnDurationLabel: string | null;
  expectedOffDurationLabel: string | null;
  reasoning: string[];

  // Offset metadata
  offsetMinutes: number;
  computedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ResyncPoint (from ResyncContext shape)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResyncPoint {
  targetState: 'ON' | 'OFF';
  syncedAtIso: string;
  reporterName: string | null;
  reporterReliability: number | null;
  reportId: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtTimeYemen(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'Asia/Aden',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).replace('AM', ' ص').replace('PM', ' م');
  } catch {
    return '';
  }
}

function fmtDurationLabel(durationMin: number): string {
  const h = Math.floor(durationMin / 60);
  const m = Math.round(durationMin % 60);
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
  return `${h}س ${m}د`;
}

function shiftIso(iso: string, offsetMinutes: number): string {
  return new Date(new Date(iso).getTime() + offsetMinutes * 60_000).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// applyOffsetToPrediction — Pure function, exported for admin/nearby usage
// ─────────────────────────────────────────────────────────────────────────────

export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  transitionMode?: 'AUTO' | 'MANUAL',
  anchorStartIso?: string | null,
): UserPrediction {
  const tMode = transitionMode ?? 'AUTO';
  const nowMs = Date.now();
  const offsetMs = offsetMinutes * 60_000;

  // ── Build shifted schedule ────────────────────────────────────────────────
  const rawSlots: ScheduleSlot[] = prediction.daySchedule ?? [];

  const shiftedSlots: ShiftedScheduleSlot[] = rawSlots.map((slot) => {
    const shiftedStart = shiftIso(slot.startIso, offsetMinutes);
    const shiftedEnd = slot.endIso ? shiftIso(slot.endIso, offsetMinutes) : null;
    const durationMin = slot.endIso
      ? (new Date(slot.endIso).getTime() - new Date(slot.startIso).getTime()) / 60_000
      : null;
    return {
      state: slot.state,
      startIso: shiftedStart,
      endIso: shiftedEnd,
      startFormatted: slot.startFormatted,
      endFormatted: slot.endFormatted ?? null,
      shiftedStartFormatted: fmtTimeYemen(shiftedStart),
      shiftedEndFormatted: shiftedEnd ? fmtTimeYemen(shiftedEnd) : null,
      durationLabel: durationMin !== null ? fmtDurationLabel(durationMin) : null,
      zone: slot.zone,
      isEstimated: slot.isEstimated,
      isResynced: false,
    };
  });

  // ── Determine current slot ────────────────────────────────────────────────
  const currentSlotIdx = shiftedSlots.findIndex((s) => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  });
  const currentSlot = currentSlotIdx >= 0 ? shiftedSlots[currentSlotIdx] : null;

  // ── Community sync ────────────────────────────────────────────────────────
  if (resyncPoint) {
    const syncedState = resyncPoint.targetState;
    const syncedAtMs = new Date(resyncPoint.syncedAtIso).getTime();

    // Validation window: 30 minutes after sync
    const VALIDATION_WINDOW_MS = 30 * 60_000;
    const elapsedSinceSyncMs = nowMs - syncedAtMs;
    const inValidationWindow = elapsedSinceSyncMs < VALIDATION_WINDOW_MS && prediction.currentState !== syncedState;
    const validationWindowRemainingMin = Math.max(0, (VALIDATION_WINDOW_MS - elapsedSinceSyncMs) / 60_000);

    const syncedSlots = shiftedSlots.map((s) => ({ ...s, isResynced: true }));

    return {
      currentState: syncedState,
      currentStateStartIso: resyncPoint.syncedAtIso,
      nextTransition: buildNextTransition(prediction, syncedState, offsetMinutes),
      daySchedule: syncedSlots,
      atc: {
        mode: 'COMMUNITY_SYNCED',
        statusLine: 'تم ضبط الحالة عبر بلاغ مجتمعي',
        overrunMinutes: 0,
        transitionMode: tMode,
        communityElevated: true,
        inValidationWindow,
        validationWindowRemainingMin,
        scheduledAutoTransitionIso: null,
      },
      isHoldingState: false,
      isResynced: true,
      resyncedAtIso: resyncPoint.syncedAtIso,
      communitySyncMeta: {
        reporterName: resyncPoint.reporterName,
        reporterReliability: resyncPoint.reporterReliability,
        reportId: resyncPoint.reportId,
        syncedAtIso: resyncPoint.syncedAtIso,
        targetState: syncedState,
      },
      confidence: prediction.confidence,
      isUnstable: prediction.isUnstable,
      stabilityScore: prediction.stabilityScore,
      stabilityLabel: prediction.stabilityLabel,
      learningMode: prediction.learningMode,
      crisisMode: prediction.apppe?.crisisActive ?? false,
      crisisReason: prediction.apppe?.crisisReason ?? null,
      expectedOnDurationLabel: buildDurationLabel(prediction, 'ON'),
      expectedOffDurationLabel: buildDurationLabel(prediction, 'OFF'),
      reasoning: prediction.reasoning,
      offsetMinutes,
      computedAt: prediction.computedAt,
    };
  }

  // ── POSITIVE_OFFSET_PENDING ───────────────────────────────────────────────
  // Growatt has already transitioned to nextState, but the user's shifted
  // schedule hasn't reached that time yet (positive offset = user is behind Growatt).
  if (offsetMinutes > 0) {
    const growattState = prediction.currentState;
    const growattTransitionMs = prediction.lastTransitionAt
      ? new Date(prediction.lastTransitionAt).getTime()
      : null;

    if (growattTransitionMs) {
      // Find which shifted slot SHOULD be active now based on user's shifted schedule
      const userCurrentSlot = currentSlot;
      const userCurrentState: 'ON' | 'OFF' = userCurrentSlot ? userCurrentSlot.state : prediction.currentState;

      // If Growatt is already in a different state than user's schedule says
      if (growattState !== userCurrentState) {
        // The scheduled auto-transition time for the user
        const scheduledAutoTransitionIso = userCurrentSlot?.endIso ?? null;

        // Build synthetic "hold" slot representing current held state
        const syntheticSlot: ShiftedScheduleSlot = {
          state: userCurrentState,
          startIso: anchorStartIso ?? new Date(growattTransitionMs + offsetMs).toISOString(),
          endIso: scheduledAutoTransitionIso,
          startFormatted: fmtTimeYemen(anchorStartIso ?? new Date(growattTransitionMs + offsetMs).toISOString()),
          endFormatted: scheduledAutoTransitionIso ? fmtTimeYemen(scheduledAutoTransitionIso) : null,
          shiftedStartFormatted: fmtTimeYemen(anchorStartIso ?? new Date(growattTransitionMs + offsetMs).toISOString()),
          shiftedEndFormatted: scheduledAutoTransitionIso ? fmtTimeYemen(scheduledAutoTransitionIso) : null,
          durationLabel: scheduledAutoTransitionIso
            ? fmtDurationLabel(Math.max(0, (new Date(scheduledAutoTransitionIso).getTime() - growattTransitionMs) / 60_000))
            : null,
          zone: userCurrentSlot?.zone ?? 'transition',
          isEstimated: false,
          isResynced: false,
        };

        // Future slots after the pending transition
        const futureSlots = shiftedSlots.filter(
          (s) => s.endIso && new Date(s.endIso).getTime() > (scheduledAutoTransitionIso ? new Date(scheduledAutoTransitionIso).getTime() : nowMs)
        );

        const pendingMinutes = scheduledAutoTransitionIso
          ? Math.max(0, (new Date(scheduledAutoTransitionIso).getTime() - nowMs) / 60_000)
          : 0;

        return {
          currentState: userCurrentState,
          currentStateStartIso: anchorStartIso ?? new Date(growattTransitionMs + offsetMs).toISOString(),
          nextTransition: buildNextTransition(prediction, userCurrentState, offsetMinutes),
          daySchedule: [syntheticSlot, ...futureSlots],
          atc: {
            mode: 'POSITIVE_OFFSET_PENDING',
            statusLine: `سيتم التحديث تلقائياً في ${scheduledAutoTransitionIso ? fmtTimeYemen(scheduledAutoTransitionIso) : 'وقت مجدول'}`,
            overrunMinutes: 0,
            transitionMode: tMode,
            communityElevated: true,
            inValidationWindow: false,
            validationWindowRemainingMin: 0,
            scheduledAutoTransitionIso,
          },
          isHoldingState: true,
          isResynced: false,
          resyncedAtIso: null,
          communitySyncMeta: null,
          confidence: prediction.confidence,
          isUnstable: prediction.isUnstable,
          stabilityScore: prediction.stabilityScore,
          stabilityLabel: prediction.stabilityLabel,
          learningMode: prediction.learningMode,
          crisisMode: prediction.apppe?.crisisActive ?? false,
          crisisReason: prediction.apppe?.crisisReason ?? null,
          expectedOnDurationLabel: buildDurationLabel(prediction, 'ON'),
          expectedOffDurationLabel: buildDurationLabel(prediction, 'OFF'),
          reasoning: prediction.reasoning,
          offsetMinutes,
          computedAt: prediction.computedAt,
        };
      }
    }
  }

  // ── UNCERTAIN_ZONE (negative offset) ─────────────────────────────────────
  // User is ahead of Growatt. The user's shifted schedule says a transition
  // already happened, but Growatt hasn't confirmed it yet.
  if (offsetMinutes < 0) {
    const growattState = prediction.currentState;
    // Find what state the user SHOULD be in according to their shifted schedule
    const expectedSlot = currentSlot;
    const expectedState: 'ON' | 'OFF' = expectedSlot ? expectedSlot.state : growattState;

    if (expectedState !== growattState) {
      // User is in UNCERTAIN_ZONE — Growatt hasn't caught up yet
      const expectedTransitionMs = expectedSlot
        ? new Date(expectedSlot.startIso).getTime()
        : nowMs;
      const overrunMinutes = Math.max(0, (nowMs - expectedTransitionMs) / 60_000);

      // The backdated cycle start (spec: reconciledCycleStartIso = GrowattTime + Offset)
      const reconciledCycleStartIso = prediction.lastTransitionAt
        ? shiftIso(prediction.lastTransitionAt, offsetMinutes)
        : expectedSlot?.startIso ?? null;

      return {
        currentState: growattState, // Still showing Growatt state until confirmed
        currentStateStartIso: reconciledCycleStartIso,
        nextTransition: buildNextTransition(prediction, growattState, offsetMinutes),
        daySchedule: shiftedSlots,
        atc: {
          mode: 'UNCERTAIN_ZONE',
          statusLine: `تجاوزت المدة المتوقعة — بانتظار تأكيد Growatt`,
          overrunMinutes,
          transitionMode: tMode,
          communityElevated: true,
          inValidationWindow: false,
          validationWindowRemainingMin: 0,
          scheduledAutoTransitionIso: null,
        },
        isHoldingState: true,
        isResynced: false,
        resyncedAtIso: null,
        communitySyncMeta: null,
        confidence: prediction.confidence,
        isUnstable: prediction.isUnstable,
        stabilityScore: prediction.stabilityScore,
        stabilityLabel: prediction.stabilityLabel,
        learningMode: prediction.learningMode,
        crisisMode: prediction.apppe?.crisisActive ?? false,
        crisisReason: prediction.apppe?.crisisReason ?? null,
        expectedOnDurationLabel: buildDurationLabel(prediction, 'ON'),
        expectedOffDurationLabel: buildDurationLabel(prediction, 'OFF'),
        reasoning: prediction.reasoning,
        offsetMinutes,
        computedAt: prediction.computedAt,
      };
    }
  }

  // ── Standard ATC mode determination ──────────────────────────────────────
  const currentState = prediction.currentState;
  const currentStateStartIso = prediction.lastTransitionAt
    ? (offsetMinutes !== 0 ? shiftIso(prediction.lastTransitionAt, offsetMinutes) : prediction.lastTransitionAt)
    : currentSlot?.startIso ?? null;

  // Check prediction range window
  const nt = prediction.nextTransition;
  const inRangeWindow = nt
    ? (nowMs >= new Date(nt.earliestTime).getTime() - offsetMs &&
       nowMs <= new Date(nt.latestTime).getTime() - offsetMs)
    : false;

  // Check if we're past the expected transition (holding/overrun)
  let atcMode: ScheduleStateMode = 'NORMAL';
  let overrunMinutes = 0;
  let isHolding = false;
  let statusLine = '';
  let communityElevated = false;

  if (nt) {
    const rangeStartMs = new Date(nt.earliestTime).getTime() + offsetMs;
    const rangeEndMs = new Date(nt.latestTime).getTime() + offsetMs;

    if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
      atcMode = 'PREDICTION_RANGE';
      statusLine = 'أنت داخل نطاق التوقع الآن';
      communityElevated = true;
    } else if (nowMs > rangeEndMs) {
      overrunMinutes = (nowMs - rangeEndMs) / 60_000;
      // Grace period: first 30 minutes after range end
      if (overrunMinutes < 30) {
        atcMode = 'WAITING_FOR_GROWATT';
        statusLine = 'تجاوزنا نطاق التوقع — بانتظار تأكيد';
        communityElevated = true;
        isHolding = true;
      } else {
        atcMode = 'GRACE_MODE';
        statusLine = 'تأخر غير معتاد — مهلة المزامنة نشطة';
        communityElevated = true;
        isHolding = true;
      }
    }
  }

  if (tMode === 'MANUAL' && atcMode === 'NORMAL') {
    atcMode = 'NORMAL';
    statusLine = 'وضع يدوي — الانتقال عبر بلاغاتك فقط';
  }

  const nextTransitionInfo = buildNextTransition(prediction, currentState, offsetMinutes);

  return {
    currentState,
    currentStateStartIso,
    nextTransition: nextTransitionInfo,
    daySchedule: shiftedSlots,
    atc: {
      mode: atcMode,
      statusLine,
      overrunMinutes,
      transitionMode: tMode,
      communityElevated,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      scheduledAutoTransitionIso: null,
    },
    isHoldingState: isHolding,
    isResynced: false,
    resyncedAtIso: null,
    communitySyncMeta: null,
    confidence: prediction.confidence,
    isUnstable: prediction.isUnstable,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    learningMode: prediction.learningMode,
    crisisMode: prediction.apppe?.crisisActive ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    expectedOnDurationLabel: buildDurationLabel(prediction, 'ON'),
    expectedOffDurationLabel: buildDurationLabel(prediction, 'OFF'),
    reasoning: prediction.reasoning,
    offsetMinutes,
    computedAt: prediction.computedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for applyOffsetToPrediction
// ─────────────────────────────────────────────────────────────────────────────

function buildNextTransition(
  prediction: Prediction,
  currentState: 'ON' | 'OFF',
  offsetMinutes: number,
): NextTransitionInfo | null {
  const nt = prediction.nextTransition;
  if (!nt) return null;

  const nowMs = Date.now();
  const offsetMs = offsetMinutes * 60_000;

  const rangeStartIso = shiftIso(nt.earliestTime, offsetMinutes);
  const rangeEndIso = shiftIso(nt.latestTime, offsetMinutes);

  const rangeStartMs = new Date(rangeStartIso).getTime();
  const rangeEndMs = new Date(rangeEndIso).getTime();

  const minFromNowMin = Math.max(0, (rangeStartMs - nowMs) / 60_000);
  const maxFromNowMin = Math.max(0, (rangeEndMs - nowMs) / 60_000);
  const inRangeWindow = nowMs >= rangeStartMs && nowMs <= rangeEndMs;

  return {
    type: nt.type,
    rangeStartIso,
    rangeEndIso,
    rangeLabel: nt.rangeLabel,
    minFromNowMin,
    maxFromNowMin,
    waitLabel: inRangeWindow ? 'الآن' : `${Math.round(minFromNowMin)} دقيقة`,
    inRangeWindow,
  };
}

function buildDurationLabel(prediction: Prediction, state: 'ON' | 'OFF'): string | null {
  const pattern = prediction.allPattern ?? (prediction.currentPeriod === 'day' ? prediction.dayPattern : prediction.nightPattern);
  if (!pattern) return null;

  if (state === 'ON') {
    if (pattern.avgOnMin === null) return null;
    return fmtDurationLabel(pattern.avgOnMin);
  } else {
    return fmtDurationLabel(pattern.avgOffMin);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// useUserPredictions — React Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode?: 'AUTO' | 'MANUAL',
  anchorStartIso?: string | null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { user } = useAuth();
  const [rawPrediction, setRawPrediction] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(true);

  const offsetRef = useRef(offsetMinutes);
  offsetRef.current = offsetMinutes;
  const resyncRef = useRef(resyncPoint);
  resyncRef.current = resyncPoint;
  const modeRef = useRef(transitionMode);
  modeRef.current = transitionMode;
  const anchorRef = useRef(anchorStartIso);
  anchorRef.current = anchorStartIso;

  const fetchPrediction = useCallback(async () => {
    const { data, error } = await supabase
      .from('utility_predictions')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (!error && data?.prediction) {
      setRawPrediction(data.prediction as Prediction);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchPrediction();

    const channelName = `user_predictions_${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'utility_predictions' },
        (payload) => {
          const row = payload.new as any;
          if (row?.prediction) {
            setRawPrediction(row.prediction as Prediction);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchPrediction]);

  // Derive user prediction from raw prediction + offset + resync
  const userPrediction = rawPrediction
    ? applyOffsetToPrediction(
        rawPrediction,
        offsetMinutes,
        resyncPoint,
        transitionMode,
        anchorStartIso,
      )
    : null;

  return { userPrediction, loading };
}
