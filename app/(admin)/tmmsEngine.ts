/**
 * tmmsEngine.ts — TMMS V2.1 Final Engine
 *
 * Dependency-free TypeScript — shared between the production hook
 * (hooks/useUserPredictions.ts) and admin tooling.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TMMS V2.1 FINAL RULES (Period 1 / Period 2)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Period 1 = first half of OFF (<50% consumed) → POSITIVE offset
 *   - Offset is ADDED (push) to start/end of EACH state (ON and OFF)
 *   - Verification Window: true
 *
 * Period 2 = second half of OFF (>50% consumed) → NEGATIVE offset
 *   - Offset is DECLINED (pull) from start/end of EACH state (ON and OFF)
 *   - UNCERTAIN_ZONE: true
 *
 * The offset is FINAL at report time. No recomputation.
 *
 * FILE LOCATION: app/(admin)/tmmsEngine.ts
 */

// ─── TYPES (matching the REAL usePredictions.ts output) ──────────────────────

export type TransitionMode = 'AUTO' | 'MANUAL';

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

export interface PatternStats {
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

/** NextTransition — matches usePredictions.ts EXACTLY */
export interface NextTransition {
  type: 'UTILITY_ON' | 'UTILITY_OFF';
  earliestTime: string;
  latestTime: string;
  earliestFormatted: string;
  latestFormatted: string;
  minFromNowMin: number;
  maxFromNowMin: number;
  rangeLabel: string;
}

export interface RangeLabel {
  minMin: number;
  maxMin: number;
  label: string;
}

/** ScheduleSlot — matches usePredictions.ts EXACTLY */
export interface ScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
}

/** Prediction — matches usePredictions.ts EXACTLY */
export interface Prediction {
  currentState: 'ON' | 'OFF';
  currentStateDurationMin: number;
  currentStateDurationLabel: string;
  lastTransitionAt: string | null;
  inverterOffline: boolean;

  nextTransition: NextTransition | null;
  expectedOffRange: RangeLabel | null;
  expectedOnRange: RangeLabel | null;
  daySchedule: ScheduleSlot[];

  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;

  dayPattern: PatternStats | null;
  nightPattern: PatternStats | null;
  allPattern: PatternStats | null;
  cyclesAnalyzed: number;
  dayCyclesAnalyzed: number;
  nightCyclesAnalyzed: number;

  currentPeriod: 'day' | 'night';
  reasoning: string[];
  learningMode: 'prior_only' | 'hybrid' | 'learned';
  dataWindowHours: number;
  computedAt: string;

  apppe?: {
    version: string;
    crisisActive: boolean;
    crisisReason: string | null;
    driftOffset: number;
    driftSampleCount: number;
    biasRatio: number;
    biasSampleCount: number;
    volatilityEMA: number;
    volatilityLabel: string;
    crisisShift: { off: number; on: number };
    learningStrength: number;
    effectiveWeightedSamples: number;
    effectiveWeightedSamplesOn: number;
    madOff: number;
    madOn: number | null;
    predictionQuality: {
      dataQuantityFactor: number;
      stabilityFactor: number;
      driftStabilityFactor: number;
      biasStabilityFactor: number;
      volatilityFactor: number;
      crisisFactor: number;
    };
    historySource: string;
    rangeWasClamped: boolean;
    crisisMode?: boolean;
    dominantProfile?: string;
    profileBlend?: Record<string, number>;
    profileSamples?: Record<string, number>;
    [key: string]: any;
  };
}

/** Community resync point (from ResyncContext) */
export interface ResyncPoint {
  syncedState: 'ON' | 'OFF';
  syncedAtIso: string;
  appliedAtIso: string;
  reporterName?: string | null;
  reporterReliability?: number | null;
  offsetState?: string;
  offsetValue?: number | string;
  timelineAlignment?: string;
  generatedOnStartIso?: string;
  generatedOnDurationMin?: number | null;
  generatedOnReferenceIso?: string | null;
  generatedOnReferenceKind?: string | null;
  confirmationTime?: string;
}

export interface CommunitySyncMeta {
  syncedAtIso: string;
  syncedState: 'ON' | 'OFF';
  reporterName: string | null;
  reporterReliability: number | null;
}

/** ShiftedScheduleSlot — a ScheduleSlot after offset is applied */
export interface ShiftedScheduleSlot extends ScheduleSlot {
  shiftedStartFormatted: string;
  shiftedEndFormatted: string | null;
  isResynced?: boolean;
}

export interface ATCInfo {
  mode: ScheduleStateMode;
  transitionMode: TransitionMode;
  statusLine: string;
  overrunMinutes: number;
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  scheduledAutoTransitionIso: string | null;
}

export interface AccuracyLogEvent {
  predictedTransitionIso: string;
  actualTransitionIso: string;
  targetState: 'UTILITY_ON' | 'UTILITY_OFF';
  offsetMinutes: number;
  exitMode: string;
  errorMinutes: number;
  accuracyScore: number;
}

/** UserPrediction — engine output, extends Prediction */
export interface UserPrediction extends Prediction {
  atc: ATCInfo;
  communitySyncMeta: CommunitySyncMeta | null;
  daySchedule: ShiftedScheduleSlot[];
  currentStateStartIso: string | null;
  offsetMinutes: number;
  isResynced: boolean;
  resyncedAtIso: string | null;
  isHoldingState: boolean;
  crisisMode: boolean | null;
  crisisReason: string | null;
  // V2.1 fields
  offsetState?: string;
  offsetValue?: number | string;
  timelineAlignment?: string;
  generatedOnInfo?: any;
  isPendingNegative?: boolean;
  isGeneratedOnCurrent?: boolean;
  pendingNegativeResolutionIso?: string | null;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

export function fmtYemenTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'Asia/Aden',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).replace('AM', ' ص').replace('PM', ' م');
  } catch {
    return iso;
  }
}

export function durationLabelFromMin(min: number): string {
  if (min <= 0) return '0د';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
  return `${h}س ${m}د`;
}

export function arabicDurationRange(min: number): string {
  return durationLabelFromMin(min);
}

export function getZoneFromIso(iso: string): string {
  const h = new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', hour12: false,
  });
  const hour = parseInt(h, 10);
  return hour >= 6 && hour < 20 ? 'DAY' : 'NIGHT';
}

// ─── OFFSET APPLICATION ──────────────────────────────────────────────────────

/**
 * Apply offset to ALL slots in the schedule.
 * V2.1: Positive → push forward, Negative → pull backward.
 * Both start AND end times are shifted. Generated ON is NOT shifted.
 */
function applyOffsetToSlotsInternal(
  schedule: ScheduleSlot[],
  offsetMs: number,
  resyncPoint: ResyncPoint | null,
): ShiftedScheduleSlot[] {
  return schedule.map(slot => {
    // V2.1: Don't shift the Generated ON slot
    const isGeneratedOn = resyncPoint &&
      resyncPoint.syncedState === 'ON' &&
      slot.startIso === resyncPoint.syncedAtIso;

    if (isGeneratedOn) {
      return {
        ...slot,
        shiftedStartFormatted: slot.startFormatted,
        shiftedEndFormatted: slot.endFormatted,
        isResynced: true,
      };
    }

    const startMs = new Date(slot.startIso).getTime();
    const shiftedStartMs = startMs + offsetMs;
    const shiftedStartIso = new Date(shiftedStartMs).toISOString();

    let shiftedEndIso: string | null = null;
    let shiftedEndFormatted: string | null = null;
    if (slot.endIso) {
      const endMs = new Date(slot.endIso).getTime();
      shiftedEndIso = new Date(endMs + offsetMs).toISOString();
      shiftedEndFormatted = fmtYemenTime(shiftedEndIso);
    }

    return {
      ...slot,
      startIso: shiftedStartIso,
      endIso: shiftedEndIso,
      shiftedStartFormatted: fmtYemenTime(shiftedStartIso),
      shiftedEndFormatted,
      isResynced: resyncPoint ? true : false,
    };
  });
}

// ─── ATC STATE MACHINE ───────────────────────────────────────────────────────
//
// V2.1 FINAL — Offset Sign Meaning (VERY IMPORTANT):
//
//   POSITIVE offset = user turns ON AFTER Growatt
//     - Growatt turns ON at 10:00, offset +30 → user turns ON at 10:30
//     - At end of user's predicted OFF → short VERIFICATION WINDOW
//       (user is confident — Growatt already confirmed)
//     - If between slots (Growatt ON but user's ON hasn't started) →
//       POSITIVE_OFFSET_PENDING (holding pre-transition state)
//
//   NEGATIVE offset = user turns ON BEFORE Growatt
//     - Growatt turns ON at 10:00, offset -30 → user turns ON at 9:30
//     - At end of user's predicted OFF → UNCERTAIN_ZONE
//       (user is uncertain — doesn't know when Growatt will confirm)
//     - The ON state uses the predicted ON duration automatically
//     - Remains in UNCERTAIN_ZONE until Growatt confirms OR community report
//
//   NEUTRAL offset = user clones Growatt exactly
//     - Same start/end times and durations as Growatt
//     - At end of predicted OFF → short VERIFICATION WINDOW only
//       (for API/communication delays)
//
// AUTO MODE: all of the above apply
// MANUAL MODE: only community reports and user reports trigger transitions

const PREDICTION_RANGE_MIN = 15;
const GRACE_MODE_MAX_MIN = 30;
const VERIFICATION_WINDOW_MIN = 20;

function computeATCMode(
  shiftedSlots: ShiftedScheduleSlot[],
  growattCurrentState: 'ON' | 'OFF',
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode,
  nowMs: number,
): {
  mode: ScheduleStateMode;
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  isHoldingState: boolean;
  overrunMinutes: number;
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  scheduledAutoTransitionIso: string | null;
  statusLine: string;
} {
  const activeSlot = shiftedSlots.find(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  }) ?? null;

  // ── COMMUNITY_SYNCED ─────────────────────────────────────────────────────
  // A community resync overrides everything — the user's timeline is
  // synced to the community report's Generated ON.
  if (resyncPoint) {
    const syncedMs = new Date(resyncPoint.syncedAtIso).getTime();
    const durationMin = resyncPoint.generatedOnDurationMin ?? 0;
    const cycleEndMs = syncedMs + durationMin * 60_000;
    const inWindow = nowMs < cycleEndMs;
    const validationWindowRemainingMin = inWindow
      ? Math.max(0, (cycleEndMs - nowMs) / 60_000) : 0;

    if (inWindow || durationMin === 0) {
      return {
        mode: 'COMMUNITY_SYNCED',
        currentState: resyncPoint.syncedState,
        currentStateStartIso: resyncPoint.syncedAtIso,
        isHoldingState: true,
        overrunMinutes: 0,
        communityElevated: true,
        inValidationWindow: inWindow,
        validationWindowRemainingMin,
        scheduledAutoTransitionIso: durationMin > 0 ? new Date(cycleEndMs).toISOString() : null,
        statusLine: 'الحالة مُزامَنة مجتمعياً',
      };
    }
  }

  // ── CASE 1: No active slot — user is between slots ───────────────────────
  // This happens when the user's shifted schedule has a gap, meaning:
  //   - POSITIVE offset: Growatt already transitioned, user's next slot
  //     hasn't started yet → POSITIVE_OFFSET_PENDING
  //   - NEGATIVE offset: user's predicted OFF ended before Growatt's OFF,
  //     user is waiting for Growatt to confirm → UNCERTAIN_ZONE
  if (!activeSlot) {
    // ── POSITIVE_OFFSET_PENDING ──────────────────────────────────────────
    // Positive offset = user turns ON AFTER Growatt.
    // Growatt has already transitioned, but the user's scheduled transition
    // is still in the future. The user holds their current state until
    // their scheduled time arrives.
    if (offsetMinutes > 0) {
      const nextSlot = shiftedSlots
        .filter(s => new Date(s.startIso).getTime() > nowMs)
        .sort((a, b) => new Date(a.startIso).getTime() - new Date(b.startIso).getTime())[0];

      if (nextSlot && nextSlot.state !== growattCurrentState) {
        return {
          mode: 'POSITIVE_OFFSET_PENDING',
          currentState: growattCurrentState === 'ON' ? 'OFF' : 'ON',
          currentStateStartIso: null,
          isHoldingState: true,
          overrunMinutes: 0,
          communityElevated: false,
          inValidationWindow: false,
          validationWindowRemainingMin: 0,
          scheduledAutoTransitionIso: nextSlot.startIso,
          statusLine: `تغيير تلقائي مجدول في ${fmtYemenTime(nextSlot.startIso)}`,
        };
      }
    }

    // ── NEGATIVE OFFSET: UNCERTAIN_ZONE ──────────────────────────────────
    // Negative offset = user turns ON BEFORE Growatt.
    // The user's predicted OFF has ended (shifted earlier by negative offset),
    // but Growatt hasn't transitioned to ON yet. The user doesn't know
    // exactly when Growatt will turn ON, so they enter UNCERTAIN_ZONE.
    // The ON state will use the predicted ON duration automatically.
    // Remains in UNCERTAIN_ZONE until:
    //   - Growatt finally transitions to ON, OR
    //   - A new accepted community ON report arrives
    if (offsetMinutes < 0) {
      const recentlyEnded = shiftedSlots
        .filter(s => s.endIso && new Date(s.endIso).getTime() <= nowMs)
        .sort((a, b) => new Date(b.endIso!).getTime() - new Date(a.endIso!).getTime())[0];

      if (recentlyEnded) {
        const slotEndMs = new Date(recentlyEnded.endIso!).getTime();
        const overrunMin = Math.round((nowMs - slotEndMs) / 60_000);
        const offsetMs = offsetMinutes * 60_000;
        const backedStartIso = new Date(slotEndMs + offsetMs).toISOString();

        if (overrunMin <= GRACE_MODE_MAX_MIN) {
          return {
            mode: overrunMin <= 5 ? 'GRACE_MODE' : 'UNCERTAIN_ZONE',
            currentState: recentlyEnded.state,
            currentStateStartIso: backedStartIso,
            isHoldingState: true,
            overrunMinutes: overrunMin,
            communityElevated: overrunMin >= PREDICTION_RANGE_MIN,
            inValidationWindow: false,
            validationWindowRemainingMin: 0,
            scheduledAutoTransitionIso: null,
            statusLine: overrunMin <= 5
              ? `مهلة المزامنة — تجاوزنا الجدول بـ ${overrunMin} دقيقة`
              : `غير مؤكد — تجاوزنا الجدول بـ ${overrunMin} دقيقة`,
          };
        }
        // Overrun > 30 min — escalate to WAITING_FOR_GROWATT
        return {
          mode: 'WAITING_FOR_GROWATT',
          currentState: growattCurrentState,
          currentStateStartIso: null,
          isHoldingState: false,
          overrunMinutes: overrunMin,
          communityElevated: true,
          inValidationWindow: false,
          validationWindowRemainingMin: 0,
          scheduledAutoTransitionIso: null,
          statusLine: `بانتظار تأكيد Growatt — تأخير ${overrunMin} دقيقة`,
        };
      }
    }
  }

  // ── CASE 2: Active slot exists — check end-of-slot behavior ──────────────
  // When the user is near the end of their current slot (within the
  // verification window), the behavior depends on the offset sign:
  //
  //   POSITIVE / NEUTRAL offset → VERIFICATION WINDOW (short, confident)
  //     The user trusts the prediction. Growatt has either already
  //     transitioned (positive) or will transition at the same time (neutral).
  //     A short verification window accounts for API/communication delays.
  //
  //   NEGATIVE offset → PREDICTION_RANGE (preparing for UNCERTAIN_ZONE)
  //     The user is about to enter UNCERTAIN_ZONE when the slot ends.
  //     The prediction range badge warns the user that uncertainty is coming.
  if (activeSlot?.endIso) {
    const endMs = new Date(activeSlot.endIso).getTime();
    const minutesUntilEnd = (endMs - nowMs) / 60_000;

    if (minutesUntilEnd >= 0 && minutesUntilEnd <= VERIFICATION_WINDOW_MIN) {
      if (offsetMinutes >= 0) {
        // ── VERIFICATION WINDOW (Positive / Neutral) ─────────────────────
        // User is confident — Growatt already confirmed (positive) or
        // will confirm at the same time (neutral). Short window only.
        return {
          mode: 'NORMAL', // Still NORMAL mode, but with verification window active
          currentState: activeSlot.state,
          currentStateStartIso: activeSlot.startIso,
          isHoldingState: false,
          overrunMinutes: 0,
          communityElevated: false,
          inValidationWindow: true,
          validationWindowRemainingMin: Math.round(minutesUntilEnd),
          scheduledAutoTransitionIso: null,
          statusLine: `نافذة التحقق — ${Math.round(minutesUntilEnd)} دقيقة للتغيير المتوقع`,
        };
      } else {
        // ── PREDICTION_RANGE (Negative — preparing for UNCERTAIN_ZONE) ──
        // User is about to enter UNCERTAIN_ZONE when this slot ends.
        // Warn the user that uncertainty is coming.
        return {
          mode: 'PREDICTION_RANGE',
          currentState: activeSlot.state,
          currentStateStartIso: activeSlot.startIso,
          isHoldingState: false,
          overrunMinutes: 0,
          communityElevated: false,
          inValidationWindow: false,
          validationWindowRemainingMin: 0,
          scheduledAutoTransitionIso: null,
          statusLine: `نطاق التوقع — ${Math.round(minutesUntilEnd)} دقيقة (تحذير: قريبة من UNCERTAIN_ZONE)`,
        };
      }
    }

    // ── PREDICTION_RANGE (beyond verification window, within 15 min) ──────
    if (minutesUntilEnd >= 0 && minutesUntilEnd <= PREDICTION_RANGE_MIN) {
      return {
        mode: 'PREDICTION_RANGE',
        currentState: activeSlot.state,
        currentStateStartIso: activeSlot.startIso,
        isHoldingState: false,
        overrunMinutes: 0,
        communityElevated: false,
        inValidationWindow: offsetMinutes >= 0,
        validationWindowRemainingMin: offsetMinutes >= 0 ? Math.round(minutesUntilEnd) : 0,
        scheduledAutoTransitionIso: null,
        statusLine: `نطاق التوقع — ${Math.round(minutesUntilEnd)} دقيقة للتغيير المتوقع`,
      };
    }
  }

  // ── NORMAL ───────────────────────────────────────────────────────────────
  // User is in the middle of a slot, not near the end. Everything is fine.
  // For neutral offset: this means the user's timeline matches Growatt exactly.
  return {
    mode: 'NORMAL',
    currentState: activeSlot ? activeSlot.state : growattCurrentState,
    currentStateStartIso: activeSlot ? activeSlot.startIso : null,
    isHoldingState: false,
    overrunMinutes: 0,
    communityElevated: false,
    inValidationWindow: false,
    validationWindowRemainingMin: 0,
    scheduledAutoTransitionIso: null,
    statusLine: '',
  };
}

// ─── MAIN ENGINE FUNCTION ───────────────────────────────────────────────────

export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  communitySyncMeta: CommunitySyncMeta | null = null,
  transitionMode: TransitionMode = 'AUTO',
  anchorStartIso: string | null = null,
  frozenCommunityOffset: number | null = null,
  onOffsetCalculated?: (
    computedOffsetMinutes: number,
    meta: { sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; referenceIso: string | null; referenceKind: string | null },
  ) => void,
  nowMs: number = Date.now(),
  onAccuracyEvent?: (event: AccuracyLogEvent) => void,
): UserPrediction {
  const rawSlots: ScheduleSlot[] = prediction.daySchedule ?? [];
  const effectiveOffset = frozenCommunityOffset ?? offsetMinutes;
  const offsetMs = effectiveOffset * 60_000;

  // ── 1. Build shifted schedule ──────────────────────────────────────────────
  const shiftedSlots = applyOffsetToSlotsInternal(rawSlots, offsetMs, resyncPoint);

  // ── 2. Run ATC state machine ───────────────────────────────────────────────
  const atcResult = computeATCMode(
    shiftedSlots,
    prediction.currentState,
    effectiveOffset,
    resyncPoint,
    transitionMode,
    nowMs,
  );

  // ── 3. Inject synthetic slot for POSITIVE_OFFSET_PENDING ───────────────────
  let finalSlots: ShiftedScheduleSlot[] = [...shiftedSlots];
  if (atcResult.mode === 'POSITIVE_OFFSET_PENDING' && atcResult.scheduledAutoTransitionIso) {
    const heldState: 'ON' | 'OFF' = atcResult.currentState;
    const nowIso = new Date(nowMs).toISOString();
    const schedIso = atcResult.scheduledAutoTransitionIso;
    finalSlots = [{
      state: heldState,
      startIso: nowIso,
      endIso: schedIso,
      startFormatted: fmtYemenTime(nowIso),
      endFormatted: fmtYemenTime(schedIso),
      durationLabel: durationLabelFromMin(
        Math.round((new Date(schedIso).getTime() - nowMs) / 60_000),
      ),
      zone: getZoneFromIso(nowIso),
      isEstimated: false,
      shiftedStartFormatted: fmtYemenTime(nowIso),
      shiftedEndFormatted: fmtYemenTime(schedIso),
    }, ...shiftedSlots];
  }

  // ── 4. Inject synthetic slot for COMMUNITY_SYNCED ──────────────────────────
  if (atcResult.mode === 'COMMUNITY_SYNCED' && resyncPoint) {
    const syncedMs = new Date(resyncPoint.syncedAtIso).getTime();
    const durationMin = resyncPoint.generatedOnDurationMin ?? 60;
    const cycleEndIso = new Date(syncedMs + durationMin * 60_000).toISOString();
    const alreadyFirst = finalSlots.length > 0 &&
      Math.abs(new Date(finalSlots[0].startIso).getTime() - syncedMs) < 60_000;
    if (!alreadyFirst) {
      finalSlots = [{
        state: resyncPoint.syncedState,
        startIso: resyncPoint.syncedAtIso,
        endIso: cycleEndIso,
        startFormatted: fmtYemenTime(resyncPoint.syncedAtIso),
        endFormatted: fmtYemenTime(cycleEndIso),
        durationLabel: durationLabelFromMin(durationMin),
        zone: getZoneFromIso(resyncPoint.syncedAtIso),
        isEstimated: false,
        shiftedStartFormatted: fmtYemenTime(resyncPoint.syncedAtIso),
        shiftedEndFormatted: fmtYemenTime(cycleEndIso),
        isResynced: true,
      }, ...shiftedSlots];
    }
  }

  // ── 5. Compute community offset (Rule Q2-A) ───────────────────────────────
  if (resyncPoint && frozenCommunityOffset === null && onOffsetCalculated) {
    const syncMs = new Date(resyncPoint.syncedAtIso).getTime();
    const referenceSlot = rawSlots.find(s => {
      const startMs = new Date(s.startIso).getTime();
      const endMs = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return s.state === resyncPoint.syncedState && syncMs >= startMs && syncMs < endMs;
    }) ?? rawSlots.find(s => s.state === resyncPoint.syncedState) ?? null;

    if (referenceSlot) {
      const refStartMs = new Date(referenceSlot.startIso).getTime();
      const computedOffset = Math.round((syncMs - refStartMs) / 60_000);
      const sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' =
        computedOffset > 0 ? 'POSITIVE' : computedOffset < 0 ? 'NEGATIVE' : 'NEUTRAL';
      onOffsetCalculated(computedOffset, {
        sign,
        referenceIso: referenceSlot.startIso,
        referenceKind: 'completed',
      });
    }
  }

  // ── 6. Build next-transition from shifted schedule ─────────────────────────
  const targetState: 'ON' | 'OFF' = atcResult.currentState === 'ON' ? 'OFF' : 'ON';
  const nextSlot = finalSlots.find(s =>
    s.state === targetState && new Date(s.startIso).getTime() > nowMs,
  );

  let nextTransition: NextTransition | null = null;
  if (nextSlot) {
    const startMs = new Date(nextSlot.startIso).getTime();
    const minFromNow = Math.max(0, (startMs - nowMs) / 60_000);
    const originalNt = prediction.nextTransition;
    const rangeWidthMs = originalNt
      ? Math.max(0, (originalNt.maxFromNowMin - originalNt.minFromNowMin) * 60_000)
      : 30 * 60_000;
    const endMs = startMs + rangeWidthMs;
    const endIso = new Date(endMs).toISOString();

    nextTransition = {
      type: targetState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
      earliestTime: nextSlot.startIso,
      latestTime: endIso,
      earliestFormatted: nextSlot.shiftedStartFormatted ?? fmtYemenTime(nextSlot.startIso),
      latestFormatted: fmtYemenTime(endIso),
      minFromNowMin: minFromNow,
      maxFromNowMin: minFromNow + rangeWidthMs / 60_000,
      rangeLabel: nextSlot.shiftedStartFormatted ?? fmtYemenTime(nextSlot.startIso),
    };
  } else if (prediction.nextTransition) {
    nextTransition = prediction.nextTransition;
  }

  // ── 7. Determine V2.1 fields ──────────────────────────────────────────────
  const isGeneratedOnCurrent = !!resyncPoint &&
    resyncPoint.syncedState === 'ON' &&
    resyncPoint.generatedOnStartIso !== undefined;
  const generatedOnInfo = isGeneratedOnCurrent ? {
    startIso: resyncPoint!.generatedOnStartIso!,
    durationMin: resyncPoint!.generatedOnDurationMin ?? 0,
    referenceIso: resyncPoint!.generatedOnReferenceIso ?? resyncPoint!.syncedAtIso,
    referenceKind: (resyncPoint!.generatedOnReferenceKind ?? 'completed') as 'completed' | 'active',
    inheritsReferenceLifecycle: false,
  } : null;

  // ── 8. Compute duration labels ─────────────────────────────────────────────
  const onSlots = finalSlots.filter(s => s.state === 'ON' && s.endIso);
  const offSlots = finalSlots.filter(s => s.state === 'OFF' && s.endIso);
  const avgOn = onSlots.length > 0
    ? onSlots.reduce((sum, s) => sum + (new Date(s.endIso!).getTime() - new Date(s.startIso).getTime()) / 60_000, 0) / onSlots.length
    : 0;
  const avgOff = offSlots.length > 0
    ? offSlots.reduce((sum, s) => sum + (new Date(s.endIso!).getTime() - new Date(s.startIso).getTime()) / 60_000, 0) / offSlots.length
    : 0;
  const expectedOnDurationLabel = avgOn > 0 ? arabicDurationRange(Math.round(avgOn)) : null;
  const expectedOffDurationLabel = avgOff > 0 ? arabicDurationRange(Math.round(avgOff)) : null;

  // ── 9. Assemble UserPrediction ─────────────────────────────────────────────
  const atcInfo: ATCInfo = {
    mode: atcResult.mode,
    transitionMode,
    statusLine: atcResult.statusLine,
    overrunMinutes: atcResult.overrunMinutes,
    communityElevated: atcResult.communityElevated,
    inValidationWindow: atcResult.inValidationWindow,
    validationWindowRemainingMin: atcResult.validationWindowRemainingMin,
    scheduledAutoTransitionIso: atcResult.scheduledAutoTransitionIso,
  };

  return {
    ...prediction,
    atc: atcInfo,
    communitySyncMeta,
    daySchedule: finalSlots,
    currentState: atcResult.currentState,
    currentStateStartIso: atcResult.currentStateStartIso,
    isHoldingState: atcResult.isHoldingState,
    isResynced: !!resyncPoint,
    resyncedAtIso: resyncPoint?.syncedAtIso ?? null,
    offsetMinutes: effectiveOffset,
    nextTransition,
    crisisMode: prediction.apppe?.crisisActive ?? null,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    expectedOnDurationLabel,
    expectedOffDurationLabel,
    // V2.1 fields
    offsetState: resyncPoint?.offsetState,
    offsetValue: resyncPoint?.offsetValue,
    timelineAlignment: resyncPoint?.timelineAlignment,
    generatedOnInfo,
    isPendingNegative: false,
    isGeneratedOnCurrent,
    pendingNegativeResolutionIso: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD HELPER EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export function extendScheduleTo48h(schedule: ShiftedScheduleSlot[]): ShiftedScheduleSlot[] {
  if (!schedule?.length) return schedule;
  const extended: ShiftedScheduleSlot[] = [...schedule];
  for (const slot of schedule) {
    const startMs = new Date(slot.startIso).getTime();
    const endMs = slot.endIso ? new Date(slot.endIso).getTime() : startMs + 120 * 60_000;
    const dayMs = 24 * 60 * 60 * 1000;
    extended.push({
      ...slot,
      startIso: new Date(startMs + dayMs).toISOString(),
      endIso: new Date(endMs + dayMs).toISOString(),
      startFormatted: fmtYemenTime(new Date(startMs + dayMs).toISOString()),
      endFormatted: fmtYemenTime(new Date(endMs + dayMs).toISOString()),
      shiftedStartFormatted: fmtYemenTime(new Date(startMs + dayMs).toISOString()),
      shiftedEndFormatted: fmtYemenTime(new Date(endMs + dayMs).toISOString()),
    });
  }
  return extended;
}

export function applyOffsetToSlots(schedule: ShiftedScheduleSlot[], offsetMinutes: number): ShiftedScheduleSlot[] {
  const offsetMs = offsetMinutes * 60_000;
  return schedule.map(slot => {
    const startMs = new Date(slot.startIso).getTime();
    const endMs = slot.endIso ? new Date(slot.endIso).getTime() : null;
    const sStart = new Date(startMs + offsetMs).toISOString();
    const sEnd = endMs !== null ? new Date(endMs + offsetMs).toISOString() : null;
    return {
      ...slot,
      startIso: sStart,
      endIso: sEnd,
      shiftedStartFormatted: fmtYemenTime(sStart),
      shiftedEndFormatted: sEnd ? fmtYemenTime(sEnd) : null,
    };
  });
}

export function computeCommunityOffset(
  resyncPoint: ResyncPoint | null,
  frozenOffset: number | null,
  fallbackOffset: number,
): number {
  if (frozenOffset !== null) return frozenOffset;
  if (resyncPoint?.offsetValue !== undefined && resyncPoint.offsetValue !== null) {
    return typeof resyncPoint.offsetValue === 'string' ? 0 : resyncPoint.offsetValue;
  }
  return fallbackOffset;
}

export function computeCommunityTransition(
  resyncPoint: ResyncPoint | null,
): { transitionIso: string | null; state: 'ON' | 'OFF' | null } {
  if (!resyncPoint) return { transitionIso: null, state: null };
  return { transitionIso: resyncPoint.syncedAtIso, state: resyncPoint.syncedState };
}

export function computeATCStateExport(
  offsetMin: number, isResynced: boolean, transitionMode: TransitionMode,
  schedule: ShiftedScheduleSlot[], nowMs: number, currentState: 'ON' | 'OFF',
): ATCInfo {
  const result = computeATCMode(schedule, currentState, offsetMin, null, transitionMode, nowMs);
  return {
    mode: result.mode, transitionMode, statusLine: result.statusLine,
    overrunMinutes: result.overrunMinutes, communityElevated: result.communityElevated,
    inValidationWindow: result.inValidationWindow,
    validationWindowRemainingMin: result.validationWindowRemainingMin,
    scheduledAutoTransitionIso: result.scheduledAutoTransitionIso,
  };
}

export function deriveCurrentStateATC(
  schedule: ShiftedScheduleSlot[], nowMs: number, resyncPoint: ResyncPoint | null,
): { state: 'ON' | 'OFF'; startIso: string | null } {
  if (resyncPoint?.syncedState === 'ON') {
    const syncedMs = new Date(resyncPoint.syncedAtIso).getTime();
    const dur = resyncPoint.generatedOnDurationMin ?? 120;
    if (nowMs >= syncedMs && nowMs < syncedMs + dur * 60_000) {
      return { state: 'ON', startIso: resyncPoint.syncedAtIso };
    }
  }
  for (const slot of schedule) {
    const start = new Date(slot.startIso).getTime();
    const end = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
    if (nowMs >= start && nowMs < end) return { state: slot.state, startIso: slot.startIso };
  }
  return { state: 'OFF', startIso: null };
}

export function deriveNextTransitionExport(
  schedule: ShiftedScheduleSlot[], currentState: 'ON' | 'OFF', nowMs: number,
  isHolding: boolean, scheduledAutoTransitionIso: string | null,
): NextTransition | null {
  if (isHolding && scheduledAutoTransitionIso) {
    const ms = new Date(scheduledAutoTransitionIso).getTime();
    const min = Math.max(0, (ms - nowMs) / 60_000);
    return {
      type: (currentState === 'ON' ? 'UTILITY_OFF' : 'UTILITY_ON') as 'UTILITY_ON' | 'UTILITY_OFF',
      earliestTime: scheduledAutoTransitionIso,
      latestTime: scheduledAutoTransitionIso,
      earliestFormatted: fmtYemenTime(scheduledAutoTransitionIso),
      latestFormatted: fmtYemenTime(scheduledAutoTransitionIso),
      minFromNowMin: min, maxFromNowMin: min, rangeLabel: fmtYemenTime(scheduledAutoTransitionIso),
    };
  }
  const target = currentState === 'ON' ? 'OFF' : 'ON';
  for (const slot of schedule) {
    if (slot.state !== target) continue;
    const startMs = new Date(slot.startIso).getTime();
    if (startMs > nowMs) {
      const min = (startMs - nowMs) / 60_000;
      return {
        type: target === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
        earliestTime: slot.startIso,
        latestTime: slot.endIso ?? slot.startIso,
        earliestFormatted: slot.shiftedStartFormatted ?? fmtYemenTime(slot.startIso),
        latestFormatted: slot.shiftedEndFormatted ?? (slot.endIso ? fmtYemenTime(slot.endIso) : ''),
        minFromNowMin: Math.max(0, min), maxFromNowMin: Math.max(0, min),
        rangeLabel: slot.shiftedStartFormatted ?? fmtYemenTime(slot.startIso),
      };
    }
  }
  return null;
}

export function computeReconciledCycleStart(growattTransitionIso: string, offsetMinutes: number): string {
  return new Date(new Date(growattTransitionIso).getTime() + offsetMinutes * 60_000).toISOString();
}

export function computeAccuracyLogEvent(
  predictedTransitionIso: string, actualTransitionIso: string,
  targetState: 'UTILITY_ON' | 'UTILITY_OFF', offsetMinutes: number, exitMode: string,
): AccuracyLogEvent {
  const errorMin = Math.round((new Date(actualTransitionIso).getTime() - new Date(predictedTransitionIso).getTime()) / 60_000);
  return {
    predictedTransitionIso, actualTransitionIso, targetState, offsetMinutes, exitMode,
    errorMinutes: errorMin, accuracyScore: Math.max(0, Math.min(100, 100 - Math.abs(errorMin))),
  };
}

// ─── Type re-exports for backwards compat ───────────────────────────────────
export type { ScheduleStateMode as ATCMode };
// cache-bust: 2026-07-02
