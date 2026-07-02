/**
 * tmmsEngine.ts — TMMS V2.2 Personal Timeline Replacement Model
 *
 * Dependency-free TypeScript — shared between the production hook
 * (hooks/useUserPredictions.ts) and admin tooling.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TMMS V2.2 RULES (Period 1 / Period 2 / Period 3)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Period 1 = starts immediately after Growatt ON begins, continues through
 *            the entire Growatt ON duration PLUS the first half of the
 *            following Growatt OFF duration.
 *   - Generated ON replaces the Growatt ON that belongs to this period
 *   - Generated ON receives the FULL duration of the replaced ON
 *   - Creates POSITIVE offset (offset = GeneratedONstart - ReplacedONstart)
 *   - Following OFF receives the full duration of the original following OFF
 *   - Short Verification Window after Growatt turns ON (countdown until
 *     personal scheduled ON time)
 *
 * Period 2 = second half of Growatt OFF (>50% consumed) through immediately
 *            before the next Growatt ON starts.
 *   - Generated ON replaces the NEXT upcoming Growatt ON
 *   - Generated ON receives the full duration of the next ON
 *   - Creates PENDING_NEGATIVE (initially — exact numeric value unknown
 *     because the referenced Growatt ON hasn't started yet)
 *   - Automatically resolves to NEGATIVE when Growatt ON begins:
 *     offsetValue = GeneratedONstart - ActualGrowattONstart
 *   - Following OFF receives the full duration of the OFF that followed
 *     the replaced next ON
 *   - UNCERTAIN_ZONE when predicted OFF finishes before Growatt turns ON:
 *     waiting time is deducted from the next ON duration
 *
 * Period 3 = exact instant the Growatt ON state begins.
 *   - Offset = 0, NEUTRAL
 *   - Personal Timeline = exact clone of Growatt Timeline
 *   - No shifting, no Pending state, no UNCERTAIN_ZONE
 *
 * PERSONAL TIMELINE REPLACEMENT MODEL:
 *   Specific Growatt ON states are REPLACED by Generated ON states.
 *   The Personal Timeline is a "customized copy" built from the Growatt
 *   template. After replacement, the user's timeline is independent while
 *   still borrowing Growatt durations.
 *
 * GENERATED ON:
 *   - Permanent timeline event — never temporary, never deleted
 *   - Immediately becomes the current user state
 *   - When user reports ON: ends current OFF, creates Generated ON,
 *     chooses its duration (from replaced ON), calculates offset,
 *     rebuilds remaining timeline and future schedules
 *
 * UNCERTAIN_ZONE (Negative Offset):
 *   - When predicted OFF duration finishes before Growatt turns ON:
 *     OFF → UNCERTAIN_ZONE
 *   - Home Page shows: "Electricity OFF — Waiting for Growatt ON..."
 *     with elapsed waiting time counter
 *   - When Growatt turns ON:
 *     1. Measure actual waiting time inside UNCERTAIN_ZONE
 *     2. Deduct waiting time from next ON duration
 *     3. User immediately enters new ON state
 *
 * ON DURATION RECONCILIATION:
 *   Displayed Personal ON Duration = Expected ON Duration - UNCERTAIN_ZONE waiting time
 *   This preserves correct cycle timing without introducing timeline gaps.
 *
 * COMMUNITY APPROVAL:
 *   - Approver clones Reporter's synchronization state exactly:
 *     Offset State, Offset Value (or Pending Negative if unresolved),
 *     Timeline Alignment, Personal Timeline structure
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
  /** The utility state that was confirmed as active */
  syncedState: 'ON' | 'OFF';
  /**
   * The ISO timestamp at which this state effectively became active.
   * For reporter: transition time (now - selectedTimeOffsetMinutes)
   * For recipient: same as reporter (Confirmation Timestamp Rule)
   */
  syncedAtIso: string;
  /** When the resync was applied locally */
  appliedAtIso: string;
  /** Reporter display name */
  reporterName?: string | null;
  /** Reporter reliability score (0–100) */
  reporterReliability?: number | null;

  // ── V2.2 additions ────────────────────────────────────────────────────────
  /** V2.2: Offset state (POSITIVE for Period 1, PENDING_NEGATIVE for Period 2,
   *  NEUTRAL for Period 3, NEGATIVE after Pending Negative resolves) */
  offsetState?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';
  /** V2.2: Offset value in signed minutes, or 'PENDING' when waiting for
   *  Growatt ON to resolve Period 2 */
  offsetValue?: number | 'PENDING';
  /** V2.2: Timeline alignment anchor (ISO timestamp of the reference ON start) */
  timelineAlignment?: string;
  /** V2.2: Generated ON start time (ISO) */
  generatedOnStartIso?: string;
  /** V2.2: Generated ON duration in minutes */
  generatedOnDurationMin?: number | null;
  /** V2.2: Reference ON start time (ISO) — the Growatt ON that was replaced */
  generatedOnReferenceIso?: string | null;
  /** V2.2: Reference kind */
  generatedOnReferenceKind?: 'completed' | 'active' | null;
  /** V2.2: For approvers — the time they confirmed */
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
  // V2.2: slot-level flags for Generated ON and Estimated Pending Offset
  isGeneratedOn?: boolean;
  isEstimatedPendingOffset?: boolean;
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
  // V2.2: UNCERTAIN_ZONE tracking fields
  /** Elapsed waiting time inside UNCERTAIN_ZONE (minutes) */
  uncertainZoneElapsedMin?: number;
  /** Whether the current state is inside UNCERTAIN_ZONE */
  isInUncertainZone?: boolean;
  /** The deducted duration from the next ON due to UNCERTAIN_ZONE waiting */
  onDurationDeductionMin?: number;
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
  // V2.2 fields
  offsetState?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';
  offsetValue?: number | 'PENDING';
  timelineAlignment?: string;
  generatedOnInfo?: GeneratedOnInfo | null;
  isPendingNegative?: boolean;
  isGeneratedOnCurrent?: boolean;
  pendingNegativeResolutionIso?: string | null;
}

/** V2.2: Generated ON metadata */
export interface GeneratedOnInfo {
  /** ISO when the Generated ON began */
  startIso: string;
  /** Duration in minutes, copied from the replaced ON */
  durationMin: number;
  /** ISO of the reference ON used to compute duration */
  referenceIso: string;
  /** Whether the reference was 'completed' or 'active' */
  referenceKind: 'completed' | 'active';
  /** When referenceKind='active', inherits reference ON's lifecycle */
  inheritsReferenceLifecycle: boolean;
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

// ─── PERSONAL TIMELINE REPLACEMENT: OFFSET APPLICATION ──────────────────────

/**
 * V2.2: Apply offset to ALL slots in the schedule.
 *
 * Positive Offset → pushes every future ON and OFF later by offset value.
 * Negative Offset → pulls every future ON and OFF earlier by offset value.
 * Neutral Offset → no shifting (clone of Growatt).
 * Pending Negative → behaves as future Negative Offset (pull earlier).
 *
 * The Generated ON slot itself is NOT shifted — it sits at its natural
 * position. Only the Growatt-derived slots are shifted.
 *
 * Per the Personal Timeline Replacement Model: specific Growatt ON states
 * are replaced by Generated ON states. The offset shifts all remaining
 * timeline slots while preserving their durations.
 */
function applyOffsetToSlotsInternal(
  schedule: ScheduleSlot[],
  offsetMs: number,
  resyncPoint: ResyncPoint | null,
): ShiftedScheduleSlot[] {
  return schedule.map(slot => {
    // V2.2: Don't shift the Generated ON slot — it sits at its natural position
    const isGeneratedOn = resyncPoint &&
      resyncPoint.syncedState === 'ON' &&
      slot.startIso === resyncPoint.syncedAtIso;

    if (isGeneratedOn) {
      return {
        ...slot,
        shiftedStartFormatted: slot.startFormatted,
        shiftedEndFormatted: slot.endFormatted,
        isResynced: true,
        isGeneratedOn: true,
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
// V2.2 — Offset State meanings:
//
//   POSITIVE offset = user's Personal Timeline occurs later than Growatt
//     - Created when Generated ON is inside Period 1
//     - Pushes every future ON and OFF later
//     - Short Verification Window after Growatt turns ON:
//       Home Page remains OFF during countdown, auto-switches at zero
//
//   PENDING_NEGATIVE = user is known to be Negative category but exact value
//     is unknown (referenced Growatt ON hasn't started yet)
//     - Created when Generated ON is inside Period 2
//     - Behaves as future Negative Offset (pulls future ON/OFF earlier)
//     - Auto-resolves to NEGATIVE when Growatt ON begins
//
//   NEGATIVE offset = user's Personal Timeline occurs earlier than Growatt
//     - Created after Pending Negative resolves
//     - Pulls every future ON and OFF earlier
//     - UNCERTAIN_ZONE when predicted OFF finishes before Growatt turns ON:
//       waiting time is deducted from next ON duration
//
//   NEUTRAL offset = user perfectly synchronized with Growatt
//     - Created at exact Growatt ON start instant (Period 3)
//     - Offset = 0, Personal Timeline clones Growatt completely
//     - No shifting, no Pending state, no UNCERTAIN_ZONE
//
// AUTO MODE: all of the above apply
// MANUAL MODE: only community reports and user reports trigger transitions

const PREDICTION_RANGE_MIN = 15;
const GRACE_MODE_MAX_MIN = 30;
const VERIFICATION_WINDOW_MIN = 20;

/**
 * V2.2: Compute the ATC mode based on current timeline state.
 *
 * Key V2.2 behaviors:
 * - POSITIVE_OFFSET_PENDING: Growatt turned ON but user's scheduled ON is
 *   still in the future. Home Page shows OFF with countdown.
 * - UNCERTAIN_ZONE (Negative): user's predicted OFF ended before Growatt ON.
 *   Track elapsed waiting time, deduct from next ON duration.
 * - PENDING_NEGATIVE: waiting for Growatt ON to resolve the numeric offset.
 *   Future ON predictions shown as "Estimated (Pending Offset)".
 */
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
  // V2.2 UNCERTAIN_ZONE tracking
  uncertainZoneElapsedMin: number;
  isInUncertainZone: boolean;
  onDurationDeductionMin: number;
} {
  // Determine effective offset (numeric). PENDING_NEGATIVE behaves as
  // negative for timeline positioning purposes.
  const effectiveOffsetMin = typeof resyncPoint?.offsetValue === 'number'
    ? resyncPoint.offsetValue
    : offsetMinutes;

  const activeSlot = shiftedSlots.find(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  }) ?? null;

  // ── COMMUNITY_SYNCED ─────────────────────────────────────────────────────
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
        uncertainZoneElapsedMin: 0,
        isInUncertainZone: false,
        onDurationDeductionMin: 0,
      };
    }
  }

  // ── CASE 1: No active slot — user is between slots ───────────────────────
  if (!activeSlot) {
    // ── POSITIVE_OFFSET_PENDING ──────────────────────────────────────────
    // V2.2: Positive offset = user's timeline is later than Growatt.
    // Growatt has already transitioned, but user's scheduled transition
    // is still in the future. Short Verification Window behavior:
    // Home Page shows OFF with countdown until scheduled time.
    if (effectiveOffsetMin > 0) {
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
          statusLine: `تغيير تلقائي مجدول في ${fmtYemenTime(nextSlot.startIso)} — الفارق الإيجابي +${effectiveOffsetMin}د`,
          uncertainZoneElapsedMin: 0,
          isInUncertainZone: false,
          onDurationDeductionMin: 0,
        };
      }
    }

    // ── NEGATIVE OFFSET: UNCERTAIN_ZONE ──────────────────────────────────
    // V2.2: Negative offset = user's timeline is ahead of Growatt.
    // The user's predicted OFF has ended (shifted earlier by negative offset),
    // but Growatt hasn't transitioned to ON yet. Enter UNCERTAIN_ZONE.
    // When Growatt finally turns ON, waiting time is deducted from next ON.
    if (effectiveOffsetMin < 0 || resyncPoint?.offsetState === 'PENDING_NEGATIVE') {
      const recentlyEnded = shiftedSlots
        .filter(s => s.endIso && new Date(s.endIso).getTime() <= nowMs)
        .sort((a, b) => new Date(b.endIso!).getTime() - new Date(a.endIso!).getTime())[0];

      if (recentlyEnded) {
        const slotEndMs = new Date(recentlyEnded.endIso!).getTime();
        const overrunMin = Math.round((nowMs - slotEndMs) / 60_000);
        const offsetMs = effectiveOffsetMin * 60_000;
        const backedStartIso = new Date(slotEndMs + offsetMs).toISOString();

        // V2.2: Track UNCERTAIN_ZONE elapsed time for ON duration deduction
        const uncertainZoneElapsedMin = Math.max(0, overrunMin);

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
              : `منطقة غير مؤكدة — بانتظار Growatt (${overrunMin} دقيقة انتظار)`,
            uncertainZoneElapsedMin,
            isInUncertainZone: overrunMin > 5,
            onDurationDeductionMin: 0, // Will be set when Growatt turns ON
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
          uncertainZoneElapsedMin,
          isInUncertainZone: true,
          onDurationDeductionMin: 0,
        };
      }
    }
  }

  // ── CASE 2: Active slot exists — check end-of-slot behavior ──────────────
  if (activeSlot?.endIso) {
    const endMs = new Date(activeSlot.endIso).getTime();
    const minutesUntilEnd = (endMs - nowMs) / 60_000;

    if (minutesUntilEnd >= 0 && minutesUntilEnd <= VERIFICATION_WINDOW_MIN) {
      if (effectiveOffsetMin >= 0) {
        // ── VERIFICATION WINDOW (Positive / Neutral) ─────────────────────
        // V2.2: Short verification window. User is confident — Growatt already
        // confirmed (positive) or will confirm at same time (neutral).
        return {
          mode: 'NORMAL',
          currentState: activeSlot.state,
          currentStateStartIso: activeSlot.startIso,
          isHoldingState: false,
          overrunMinutes: 0,
          communityElevated: false,
          inValidationWindow: true,
          validationWindowRemainingMin: Math.round(minutesUntilEnd),
          scheduledAutoTransitionIso: null,
          statusLine: `نافذة التحقق — ${Math.round(minutesUntilEnd)} دقيقة للتغيير المتوقع`,
          uncertainZoneElapsedMin: 0,
          isInUncertainZone: false,
          onDurationDeductionMin: 0,
        };
      } else {
        // ── PREDICTION_RANGE (Negative — approaching UNCERTAIN_ZONE) ──
        // V2.2: User is about to enter UNCERTAIN_ZONE when this slot ends.
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
          statusLine: `نطاق التوقع — ${Math.round(minutesUntilEnd)} دقيقة (ستدخل منطقة غير مؤكدة)`,
          uncertainZoneElapsedMin: 0,
          isInUncertainZone: false,
          onDurationDeductionMin: 0,
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
        inValidationWindow: effectiveOffsetMin >= 0,
        validationWindowRemainingMin: effectiveOffsetMin >= 0 ? Math.round(minutesUntilEnd) : 0,
        scheduledAutoTransitionIso: null,
        statusLine: `نطاق التوقع — ${Math.round(minutesUntilEnd)} دقيقة للتغيير المتوقع`,
        uncertainZoneElapsedMin: 0,
        isInUncertainZone: false,
        onDurationDeductionMin: 0,
      };
    }
  }

  // ── NORMAL ───────────────────────────────────────────────────────────────
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
    uncertainZoneElapsedMin: 0,
    isInUncertainZone: false,
    onDurationDeductionMin: 0,
  };
}

// ─── V2.2: UNCERTAIN ZONE → ON DURATION RECONCILIATION ─────────────────────

/**
 * V2.2: When a Negative Offset user exits UNCERTAIN_ZONE because Growatt
 * turned ON, deduct the UNCERTAIN_ZONE waiting time from the next ON duration.
 *
 * Formula: Reconciled ON Duration = Expected ON Duration - UNCERTAIN_ZONE Waiting Time
 *
 * This preserves correct cycle timing and keeps the Personal Timeline
 * synchronized without introducing timeline gaps.
 */
function reconcileOnDurationAfterUncertainZone(
  schedule: ShiftedScheduleSlot[],
  uncertainZoneElapsedMin: number,
  nowMs: number,
): ShiftedScheduleSlot[] {
  if (uncertainZoneElapsedMin <= 0) return schedule;

  // Find the next ON slot after now and adjust its duration
  return schedule.map(slot => {
    if (slot.state !== 'ON') return slot;
    const slotStartMs = new Date(slot.startIso).getTime();
    if (slotStartMs < nowMs) return slot; // Already started — don't adjust past slots

    // This is the next ON slot — deduct waiting time from its duration
    const originalEndMs = slot.endIso ? new Date(slot.endIso).getTime() : null;
    if (!originalEndMs) return slot;

    const originalDurationMs = originalEndMs - slotStartMs;
    const deductedDurationMs = Math.max(
      5 * 60_000, // Minimum 5 minutes ON
      originalDurationMs - uncertainZoneElapsedMin * 60_000,
    );
    const newEndMs = slotStartMs + deductedDurationMs;
    const newEndIso = new Date(newEndMs).toISOString();

    return {
      ...slot,
      endIso: newEndIso,
      endFormatted: fmtYemenTime(newEndIso),
      shiftedEndFormatted: fmtYemenTime(newEndIso),
      durationLabel: durationLabelFromMin(Math.round(deductedDurationMs / 60_000)),
    };
  });
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
  let shiftedSlots = applyOffsetToSlotsInternal(rawSlots, offsetMs, resyncPoint);

  // ── 2. V2.2: UNCERTAIN_ZONE ON duration reconciliation ─────────────────────
  // If the user was in UNCERTAIN_ZONE and Growatt just turned ON, deduct
  // the waiting time from the next ON duration.
  const offsetState = resyncPoint?.offsetState;
  const offsetValue = resyncPoint?.offsetValue;
  const isPendingNegative = offsetState === 'PENDING_NEGATIVE';

  // Track UNCERTAIN_ZONE elapsed time for the UI
  let uncertainZoneElapsedMin = 0;
  if (offsetState === 'NEGATIVE' && prediction.currentState === 'OFF') {
    // Check if we're in the gap between predicted OFF end and Growatt ON
    const lastOffSlot = shiftedSlots
      .filter(s => s.state === 'OFF' && s.endIso && new Date(s.endIso).getTime() <= nowMs)
      .sort((a, b) => new Date(b.endIso!).getTime() - new Date(a.endIso!).getTime())[0];
    if (lastOffSlot?.endIso) {
      uncertainZoneElapsedMin = Math.max(0, Math.round((nowMs - new Date(lastOffSlot.endIso).getTime()) / 60_000));
    }
  }

  // Apply ON duration reconciliation if we have UNCERTAIN_ZONE time to deduct
  if (uncertainZoneElapsedMin > 0) {
    shiftedSlots = reconcileOnDurationAfterUncertainZone(
      shiftedSlots,
      uncertainZoneElapsedMin,
      nowMs,
    );
  }

  // ── 3. Run ATC state machine ───────────────────────────────────────────────
  const atcResult = computeATCMode(
    shiftedSlots,
    prediction.currentState,
    effectiveOffset,
    resyncPoint,
    transitionMode,
    nowMs,
  );

  // ── 4. Inject synthetic slot for POSITIVE_OFFSET_PENDING ───────────────────
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

  // ── 5. Inject synthetic slot for COMMUNITY_SYNCED ──────────────────────────
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

  // ── 6. Compute community offset (Rule Q2-A) ───────────────────────────────
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

  // ── 7. Build next-transition from shifted schedule ─────────────────────────
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

    // V2.2: If next ON slot was reconciled (duration deducted after UNCERTAIN_ZONE),
    // reflect the shorter duration in the transition info
    const reconciledDurationMin = nextSlot.durationLabel
      ? parseDurationLabel(nextSlot.durationLabel)
      : null;

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

  // ── 8. Determine V2.2 fields ──────────────────────────────────────────────
  const isGeneratedOnCurrent = !!resyncPoint &&
    resyncPoint.syncedState === 'ON' &&
    resyncPoint.generatedOnStartIso !== undefined;
  const generatedOnInfo = isGeneratedOnCurrent ? {
    startIso: resyncPoint!.generatedOnStartIso!,
    durationMin: resyncPoint!.generatedOnDurationMin ?? 0,
    referenceIso: resyncPoint!.generatedOnReferenceIso ?? resyncPoint!.syncedAtIso,
    referenceKind: (resyncPoint!.generatedOnReferenceKind ?? 'completed') as 'completed' | 'active',
    inheritsReferenceLifecycle: (resyncPoint!.generatedOnReferenceKind ?? 'completed') === 'active',
  } : null;

  // V2.2: Pending Negative resolution forecast — use the next Growatt ON
  // transition as the expected resolution time
  const pendingNegativeResolutionIso =
    isPendingNegative && prediction.nextTransition?.type === 'UTILITY_ON'
      ? prediction.nextTransition.earliestTime
      : null;

  // ── 9. Compute duration labels ─────────────────────────────────────────────
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

  // ── 10. Assemble UserPrediction ────────────────────────────────────────────
  const atcInfo: ATCInfo = {
    mode: atcResult.mode,
    transitionMode,
    statusLine: atcResult.statusLine,
    overrunMinutes: atcResult.overrunMinutes,
    communityElevated: atcResult.communityElevated,
    inValidationWindow: atcResult.inValidationWindow,
    validationWindowRemainingMin: atcResult.validationWindowRemainingMin,
    scheduledAutoTransitionIso: atcResult.scheduledAutoTransitionIso,
    // V2.2 UNCERTAIN_ZONE tracking
    uncertainZoneElapsedMin: atcResult.uncertainZoneElapsedMin || uncertainZoneElapsedMin,
    isInUncertainZone: atcResult.isInUncertainZone,
    onDurationDeductionMin: atcResult.onDurationDeductionMin,
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
    // V2.2 fields
    offsetState: resyncPoint?.offsetState ?? deriveOffsetState(effectiveOffset),
    offsetValue: offsetValue ?? effectiveOffset,
    timelineAlignment: resyncPoint?.timelineAlignment,
    generatedOnInfo,
    isPendingNegative,
    isGeneratedOnCurrent,
    pendingNegativeResolutionIso,
  };
}

// ─── V2.2: Derive Offset State from numeric offset ──────────────────────────
function deriveOffsetState(
  offsetMinutes: number,
): 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' {
  if (offsetMinutes > 0) return 'POSITIVE';
  if (offsetMinutes < 0) return 'NEGATIVE';
  return 'NEUTRAL';
}

// ─── V2.2: Parse duration label back to minutes ─────────────────────────────
function parseDurationLabel(label: string): number | null {
  // Handle formats like "2س 30د", "1ساعة", "45د"
  const match = label.match(/(?:(\d+)س\s*)?(?:(\d+)د)?/);
  if (!match) return null;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  return hours * 60 + minutes;
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
    uncertainZoneElapsedMin: result.uncertainZoneElapsedMin,
    isInUncertainZone: result.isInUncertainZone,
    onDurationDeductionMin: result.onDurationDeductionMin,
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
