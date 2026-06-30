/**
 * tmmsEngine.ts — TMMS V2.1 Pure TypeScript Engine
 *
 * This file is intentionally dependency-free (no React imports) so it can be
 * shared between the production hook (hooks/useUserPredictions.ts) and any
 * admin debug/simulation tooling without circular-dependency issues.
 *
 * Exports:
 *   Types:       Prediction, ScheduleSlot, ResyncPoint, UserPrediction,
 *                CommunitySyncMeta, ShiftedScheduleSlot, ATCInfo,
 *                ScheduleStateMode, TransitionMode, AccuracyLogEvent
 *   Functions:   applyOffsetToPrediction
 */

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type TransitionMode = 'AUTO' | 'MANUAL';

/**
 * Seven ATC (Automatic Transition Controller) operational modes.
 *
 * NORMAL                — No active offset or community sync; pure Growatt schedule.
 * PREDICTION_RANGE      — Within ±15 min of the scheduled slot boundary.
 * UNCERTAIN_ZONE        — User slot ended before Growatt confirmed; overrun < 30 min.
 * COMMUNITY_SYNCED      — A community report generated a synthetic cycle that is
 *                         still within its expected duration.
 * WAITING_FOR_GROWATT   — Overrun ≥ 30 min; awaiting Growatt OR community confirmation.
 * GRACE_MODE            — Growatt schedule end has passed by 5–30 min; grace window.
 * POSITIVE_OFFSET_PENDING — Growatt has already transitioned but the user's
 *                           scheduled transition is still in the future (positive offset).
 */
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

/** Raw schedule slot as returned by the APPPE prediction engine */
export interface ScheduleSlot {
  state: 'ON' | 'OFF';
  /** HH:MM string in Yemen local time */
  start: string;
  /** HH:MM string in Yemen local time */
  end: string;
  durationMin: number;
  zone?: 'DAY' | 'NIGHT';
  /** Whether this slot is an estimate (not fully learned) */
  isEstimated?: boolean;
}

/** Community synchronisation point stored in ResyncContext */
export interface ResyncPoint {
  syncedState: 'ON' | 'OFF';
  syncedAtIso: string;
  appliedAtIso: string;
  reporterName?: string | null;
  reporterReliability?: number | null;
  // V2.1 additions
  offsetState?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';
  offsetValue?: number | 'PENDING';
  timelineAlignment?: string;
  generatedOnStartIso?: string;
  generatedOnDurationMin?: number | null;
  generatedOnReferenceIso?: string | null;
  generatedOnReferenceKind?: 'completed' | 'active' | null;
  confirmationTime?: string;
}

/** Community sync display metadata attached to UserPrediction */
export interface CommunitySyncMeta {
  syncedAtIso: string;
  syncedState: 'ON' | 'OFF';
  reporterName: string | null;
  reporterReliability: number | null;
}

/** A schedule slot after offset shifting, ready for UI consumption */
export interface ShiftedScheduleSlot {
  state: 'ON' | 'OFF';
  /** Absolute ISO timestamp (shifted by user offset) */
  startIso: string;
  /** Absolute ISO timestamp or null if open-ended */
  endIso: string | null;
  /** Original Growatt start formatted (Yemen time) */
  startFormatted: string;
  /** Original Growatt end formatted (Yemen time) */
  endFormatted: string | null;
  /** Offset-shifted start formatted (Yemen time) */
  shiftedStartFormatted: string;
  /** Offset-shifted end formatted (Yemen time) */
  shiftedEndFormatted: string | null;
  /** Human-readable duration label (e.g. "2س 30د") */
  durationLabel: string;
  zone: 'DAY' | 'NIGHT';
  /** True when this slot is an APPPE estimate, not a learned cycle */
  isEstimated: boolean;
  /** True when this slot was affected by a community resync */
  isResynced?: boolean;
}

/** ATC runtime information attached to UserPrediction */
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

/** Raw APPPE v4 prediction as stored in the predictions table */
export interface Prediction {
  id?: number;
  computedAt?: string;
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  currentState: 'ON' | 'OFF';
  learningMode: 'learned' | 'hybrid' | 'estimated';
  daySchedule: ScheduleSlot[];
  nextTransition?: {
    type: 'UTILITY_ON' | 'UTILITY_OFF';
    rangeStartIso: string;
    rangeEndIso: string;
    rangeLabel: string;
    minFromNowMin: number;
    maxFromNowMin: number;
    waitLabel: string;
    inRangeWindow: boolean;
  } | null;
  expectedOnDurationLabel?: string;
  expectedOffDurationLabel?: string;
  crisisMode?: boolean;
  crisisReason?: string;
  reasoning?: string[];
  offsetMinutes?: number;
  resyncedAtIso?: string;
  currentStateStartIso?: string;
  isResynced?: boolean;
  isHoldingState?: boolean;
  reconciledCycleStartIso?: string | null;
  apppe?: {
    crisisActive?: boolean;
    crisisReason?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

/** UserPrediction — engine output, consumed by UI hooks */
export interface UserPrediction extends Prediction {
  atc: ATCInfo;
  communitySyncMeta: CommunitySyncMeta | null;
  daySchedule: ShiftedScheduleSlot[];
  currentStateStartIso: string | null;
  reconciledCycleStartIso: string | null;
}

/** Accuracy log event emitted by the engine when a mode exit is detected */
export interface AccuracyLogEvent {
  predictedTransitionIso: string;
  actualTransitionIso: string;
  targetState: 'ON' | 'OFF';
  offsetMinutes: number;
  exitMode: ScheduleStateMode;
  errorMinutes: number;
  accuracyScore: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Yemen timezone offset: UTC+3 */
const YEMEN_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Convert a HH:MM string (Yemen local time) to a full ISO timestamp for today.
 */
function hmToIso(hhmm: string, nowMs: number): string {
  const yemenNowMs = nowMs + YEMEN_OFFSET_MS;
  const yemenDate = new Date(yemenNowMs);
  const yemenMidnightMs = yemenNowMs - (
    yemenDate.getUTCHours() * 3600000 +
    yemenDate.getUTCMinutes() * 60000 +
    yemenDate.getUTCSeconds() * 1000 +
    yemenDate.getUTCMilliseconds()
  );
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(yemenMidnightMs - YEMEN_OFFSET_MS + h * 3600000 + m * 60000).toISOString();
}

/**
 * Format an ISO timestamp to HH:MM AM/PM in Yemen time with Arabic AM/PM suffix.
 */
export function fmtYemenTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');
}

/**
 * Convert minutes to a human-readable Arabic duration label.
 */
export function durationLabelFromMin(min: number): string {
  if (min <= 0) return '0د';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
  return `${h}س ${m}د`;
}

/**
 * Determine whether a Yemen-time HH:MM slot falls in DAY (06:00–20:00) or NIGHT.
 */
export function getZoneFromIso(iso: string): 'DAY' | 'NIGHT' {
  const h = new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: 'numeric',
    hour12: false,
  });
  const hour = parseInt(h, 10);
  return hour >= 6 && hour < 20 ? 'DAY' : 'NIGHT';
}

/**
 * Build a ShiftedScheduleSlot from a raw ScheduleSlot + an offset in minutes.
 */
function buildShiftedSlot(
  raw: ScheduleSlot,
  offsetMs: number,
  nowMs: number,
  isResynced = false,
): ShiftedScheduleSlot {
  const startIso  = hmToIso(raw.start, nowMs);
  const endIso    = raw.end ? hmToIso(raw.end, nowMs) : null;

  // Handle slots that wrap midnight: if endIso ≤ startIso, push end to next day
  let adjustedEndIso = endIso;
  if (adjustedEndIso && new Date(adjustedEndIso).getTime() <= new Date(startIso).getTime()) {
    adjustedEndIso = new Date(new Date(adjustedEndIso).getTime() + 24 * 3600000).toISOString();
  }

  const shiftedStartIso = new Date(new Date(startIso).getTime() + offsetMs).toISOString();
  const shiftedEndIso   = adjustedEndIso
    ? new Date(new Date(adjustedEndIso).getTime() + offsetMs).toISOString()
    : null;

  return {
    state: raw.state,
    startIso: shiftedStartIso,
    endIso: shiftedEndIso,
    startFormatted: fmtYemenTime(startIso),
    endFormatted: adjustedEndIso ? fmtYemenTime(adjustedEndIso) : null,
    shiftedStartFormatted: fmtYemenTime(shiftedStartIso),
    shiftedEndFormatted: shiftedEndIso ? fmtYemenTime(shiftedEndIso) : null,
    durationLabel: durationLabelFromMin(raw.durationMin),
    zone: raw.zone ?? getZoneFromIso(startIso),
    isEstimated: raw.isEstimated ?? false,
    isResynced,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ATC STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────

const PREDICTION_RANGE_MIN   = 15;
const GRACE_MODE_MAX_MIN     = 30;
const UNCERTAIN_ZONE_MAX_MIN = 30;
const VALIDATION_WINDOW_MIN  = 20;

/**
 * Determine the current ATC operational mode given the shifted schedule,
 * the raw prediction's current state, the user's offset, an optional resync
 * point, and the current wall-clock time.
 */
function computeATCMode(
  shiftedSlots: ShiftedScheduleSlot[],
  growattCurrentState: 'ON' | 'OFF',
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode,
  frozenCommunityOffset: number | null,
  nowMs: number,
): {
  mode: ScheduleStateMode;
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  reconciledCycleStartIso: string | null;
  isHoldingState: boolean;
  overrunMinutes: number;
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  scheduledAutoTransitionIso: string | null;
  statusLine: string;
} {
  const offsetMs = offsetMinutes * 60_000;

  // ── Find the shifted slot that covers "now" ────────────────────────────────
  const activeSlot = shiftedSlots.find(s => {
    const start = new Date(s.startIso).getTime();
    const end   = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  }) ?? null;

  // ── COMMUNITY_SYNCED check ─────────────────────────────────────────────────
  // If a resync point exists and the generated ON cycle is still active, the
  // user is in COMMUNITY_SYNCED mode regardless of Growatt.
  if (resyncPoint) {
    const syncedMs    = new Date(resyncPoint.syncedAtIso).getTime();
    const durationMin = resyncPoint.generatedOnDurationMin ?? 0;
    const cycleEndMs  = syncedMs + durationMin * 60_000;

    const inWindow    = nowMs < cycleEndMs;
    const validationWindowRemainingMin = inWindow
      ? Math.max(0, (cycleEndMs - nowMs) / 60_000)
      : 0;

    if (inWindow || durationMin === 0) {
      // Still within the generated ON window
      return {
        mode: 'COMMUNITY_SYNCED',
        currentState: resyncPoint.syncedState,
        currentStateStartIso: resyncPoint.syncedAtIso,
        reconciledCycleStartIso: resyncPoint.syncedAtIso,
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

  // ── POSITIVE_OFFSET_PENDING check ─────────────────────────────────────────
  // Growatt has transitioned but the user's scheduled transition hasn't arrived yet.
  // This happens when offsetMinutes > 0 AND the shifted slot is in the future.
  if (offsetMinutes > 0 && activeSlot === null) {
    // The current real Growatt state is growattCurrentState.
    // The user's slot hasn't started yet — find the next upcoming shifted slot.
    const nextSlot = shiftedSlots
      .filter(s => new Date(s.startIso).getTime() > nowMs)
      .sort((a, b) => new Date(a.startIso).getTime() - new Date(b.startIso).getTime())[0] ?? null;

    if (nextSlot && nextSlot.state !== growattCurrentState) {
      // The user is holding the pre-transition state
      const scheduledAutoTransitionIso = nextSlot.startIso;
      return {
        mode: 'POSITIVE_OFFSET_PENDING',
        currentState: growattCurrentState === 'ON' ? 'OFF' : 'ON', // inverse of Growatt
        currentStateStartIso: null,
        reconciledCycleStartIso: null,
        isHoldingState: true,
        overrunMinutes: 0,
        communityElevated: false,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso,
        statusLine: `تغيير تلقائي مجدول في ${fmtYemenTime(scheduledAutoTransitionIso)}`,
      };
    }
  }

  // ── NEGATIVE OFFSET: UNCERTAIN_ZONE check ─────────────────────────────────
  // Negative offset means the user's cycle ends before Growatt's.
  // When the active slot has ended (according to user's shifted schedule)
  // but Growatt hasn't transitioned yet, we're in UNCERTAIN_ZONE.
  if (offsetMinutes < 0 && activeSlot === null) {
    // Find the most recently ended slot
    const recentlyEnded = shiftedSlots
      .filter(s => s.endIso && new Date(s.endIso).getTime() <= nowMs)
      .sort((a, b) => new Date(b.endIso!).getTime() - new Date(a.endIso!).getTime())[0] ?? null;

    if (recentlyEnded) {
      const slotEndMs   = new Date(recentlyEnded.endIso!).getTime();
      const overrunMin  = Math.round((nowMs - slotEndMs) / 60_000);
      const backedStartIso = new Date(slotEndMs + offsetMs).toISOString(); // backdated start

      if (overrunMin <= GRACE_MODE_MAX_MIN) {
        return {
          mode: overrunMin <= 5 ? 'GRACE_MODE' : 'UNCERTAIN_ZONE',
          currentState: recentlyEnded.state,
          currentStateStartIso: backedStartIso,
          reconciledCycleStartIso: backedStartIso,
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
      } else {
        return {
          mode: 'WAITING_FOR_GROWATT',
          currentState: growattCurrentState,
          currentStateStartIso: null,
          reconciledCycleStartIso: null,
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

  // ── PREDICTION_RANGE check ─────────────────────────────────────────────────
  // Within ±PREDICTION_RANGE_MIN of a slot boundary.
  if (activeSlot?.endIso) {
    const endMs = new Date(activeSlot.endIso).getTime();
    const minutesUntilEnd = (endMs - nowMs) / 60_000;
    if (minutesUntilEnd >= 0 && minutesUntilEnd <= PREDICTION_RANGE_MIN) {
      return {
        mode: 'PREDICTION_RANGE',
        currentState: activeSlot.state,
        currentStateStartIso: activeSlot.startIso,
        reconciledCycleStartIso: null,
        isHoldingState: false,
        overrunMinutes: 0,
        communityElevated: false,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
        statusLine: `نطاق التوقع — ${Math.round(minutesUntilEnd)} دقيقة للتغيير المتوقع`,
      };
    }
  }

  // ── NORMAL ─────────────────────────────────────────────────────────────────
  return {
    mode: 'NORMAL',
    currentState: activeSlot ? activeSlot.state : growattCurrentState,
    currentStateStartIso: activeSlot ? activeSlot.startIso : null,
    reconciledCycleStartIso: null,
    isHoldingState: false,
    overrunMinutes: 0,
    communityElevated: false,
    inValidationWindow: false,
    validationWindowRemainingMin: 0,
    scheduledAutoTransitionIso: null,
    statusLine: '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENGINE FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * applyOffsetToPrediction
 *
 * Takes a raw APPPE prediction + user context and returns a fully-resolved
 * UserPrediction with shifted schedule, ATC mode, community sync metadata,
 * and optional accuracy event emission.
 *
 * @param prediction             Raw APPPE prediction from Supabase
 * @param offsetMinutes          User's personal DSD offset in minutes
 * @param resyncPoint            Active community resync point, or null
 * @param communitySyncMeta      CommunitySyncMeta display object, or null
 * @param transitionMode         'AUTO' | 'MANUAL'
 * @param anchorStartIso         External state-anchor ISO (from useStateAnchor)
 * @param frozenCommunityOffset  Frozen community offset (Rule Q2-A), or null
 * @param onOffsetCalculated     Callback fired once when offset is first computed
 * @param nowMs                  Current wall-clock time in milliseconds
 * @param onAccuracyEvent        Optional callback for accuracy log emission
 */
export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  communitySyncMeta: CommunitySyncMeta | null,
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
  const offsetMs = offsetMinutes * 60_000;

  // ── 1. Build shifted schedule ──────────────────────────────────────────────
  const shiftedSlots: ShiftedScheduleSlot[] = rawSlots.map(raw =>
    buildShiftedSlot(raw, offsetMs, nowMs),
  );

  // ── 2. Run ATC state machine ───────────────────────────────────────────────
  const atcResult = computeATCMode(
    shiftedSlots,
    prediction.currentState,
    offsetMinutes,
    resyncPoint,
    transitionMode,
    frozenCommunityOffset,
    nowMs,
  );

  // ── 3. Inject synthetic lingering slot for POSITIVE_OFFSET_PENDING ─────────
  // This ensures the schedule screen can find an "active" slot at index 0.
  let finalSlots = [...shiftedSlots];
  if (atcResult.mode === 'POSITIVE_OFFSET_PENDING' && atcResult.scheduledAutoTransitionIso) {
    const heldState: 'ON' | 'OFF' = atcResult.currentState;
    const fmt = (iso: string) => fmtYemenTime(iso);
    const nowIso = new Date(nowMs).toISOString();
    const syntheticSlot: ShiftedScheduleSlot = {
      state: heldState,
      startIso: nowIso,
      endIso: atcResult.scheduledAutoTransitionIso,
      startFormatted: fmt(nowIso),
      endFormatted: fmt(atcResult.scheduledAutoTransitionIso),
      shiftedStartFormatted: fmt(nowIso),
      shiftedEndFormatted: fmt(atcResult.scheduledAutoTransitionIso),
      durationLabel: durationLabelFromMin(
        Math.round((new Date(atcResult.scheduledAutoTransitionIso).getTime() - nowMs) / 60_000),
      ),
      zone: getZoneFromIso(nowIso),
      isEstimated: false,
    };
    finalSlots = [syntheticSlot, ...shiftedSlots];
  }

  // ── 4. Inject synthetic slot for COMMUNITY_SYNCED ──────────────────────────
  if (atcResult.mode === 'COMMUNITY_SYNCED' && resyncPoint) {
    const syncedMs = new Date(resyncPoint.syncedAtIso).getTime();
    const durationMin = resyncPoint.generatedOnDurationMin ?? 60;
    const cycleEndMs = syncedMs + durationMin * 60_000;
    const cycleEndIso = new Date(cycleEndMs).toISOString();
    const fmt = (iso: string) => fmtYemenTime(iso);
    const syntheticSlot: ShiftedScheduleSlot = {
      state: resyncPoint.syncedState,
      startIso: resyncPoint.syncedAtIso,
      endIso: cycleEndIso,
      startFormatted: fmt(resyncPoint.syncedAtIso),
      endFormatted: fmt(cycleEndIso),
      shiftedStartFormatted: fmt(resyncPoint.syncedAtIso),
      shiftedEndFormatted: fmt(cycleEndIso),
      durationLabel: durationLabelFromMin(durationMin),
      zone: getZoneFromIso(resyncPoint.syncedAtIso),
      isEstimated: false,
      isResynced: true,
    };
    // Only prepend if not already there (avoid duplicates on repeated calls)
    const alreadyFirst =
      finalSlots.length > 0 &&
      Math.abs(new Date(finalSlots[0].startIso).getTime() - syncedMs) < 60_000;
    if (!alreadyFirst) {
      finalSlots = [syntheticSlot, ...shiftedSlots];
    }
  }

  // ── 5. Compute community offset (Rule Q2-A) ───────────────────────────────
  if (resyncPoint && frozenCommunityOffset === null && onOffsetCalculated) {
    // Determine the offset from the resync point against the schedule
    const syncMs = new Date(resyncPoint.syncedAtIso).getTime();
    // Find the reference slot — the nearest ON slot in the raw schedule
    const referenceSlot = rawSlots.find(s => {
      const startMs = new Date(hmToIso(s.start, nowMs)).getTime();
      const endMs   = s.end ? new Date(hmToIso(s.end, nowMs)).getTime() : Infinity;
      return s.state === resyncPoint.syncedState && syncMs >= startMs && syncMs < endMs;
    }) ?? rawSlots.find(s => s.state === resyncPoint.syncedState) ?? null;

    if (referenceSlot) {
      const refStartMs = new Date(hmToIso(referenceSlot.start, nowMs)).getTime();
      const computedOffset = Math.round((syncMs - refStartMs) / 60_000);
      const sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' =
        computedOffset > 0 ? 'POSITIVE' : computedOffset < 0 ? 'NEGATIVE' : 'NEUTRAL';
      onOffsetCalculated(computedOffset, {
        sign,
        referenceIso: hmToIso(referenceSlot.start, nowMs),
        referenceKind: 'completed',
      });
    }
  }

  // ── 6. Build next-transition from shifted schedule ─────────────────────────
  const currentStateForNext = atcResult.currentState;
  const targetState: 'ON' | 'OFF' = currentStateForNext === 'ON' ? 'OFF' : 'ON';
  const nextSlotForTransition = finalSlots.find(s =>
    s.state === targetState && new Date(s.startIso).getTime() > nowMs,
  ) ?? null;

  let nextTransition: UserPrediction['nextTransition'] = null;

  if (nextSlotForTransition) {
    const rangeStartMs = new Date(nextSlotForTransition.startIso).getTime();
    const minFromNowMin = Math.max(0, (rangeStartMs - nowMs) / 60_000);
    // Use original prediction's range width if available, else ±15 min
    const originalNt = prediction.nextTransition;
    const rangeWidthMs = originalNt
      ? (originalNt.maxFromNowMin - originalNt.minFromNowMin) * 60_000
      : 30 * 60_000;
    const rangeEndMs = rangeStartMs + rangeWidthMs;

    nextTransition = {
      type: targetState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
      rangeStartIso: nextSlotForTransition.startIso,
      rangeEndIso: new Date(rangeEndMs).toISOString(),
      rangeLabel: nextSlotForTransition.shiftedStartFormatted ?? fmtYemenTime(nextSlotForTransition.startIso),
      minFromNowMin,
      maxFromNowMin: minFromNowMin + rangeWidthMs / 60_000,
      waitLabel: durationLabelFromMin(Math.round(minFromNowMin)),
      inRangeWindow: minFromNowMin <= 0,
    };
  } else if (prediction.nextTransition) {
    // Fall back to raw prediction's nextTransition if we can't derive one
    nextTransition = prediction.nextTransition;
  }

  // ── 7. Assemble UserPrediction ─────────────────────────────────────────────
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
    // V2 engine additions
    atc: atcInfo,
    communitySyncMeta: communitySyncMeta,
    daySchedule: finalSlots,
    currentState: atcResult.currentState,
    currentStateStartIso: atcResult.currentStateStartIso,
    reconciledCycleStartIso: atcResult.reconciledCycleStartIso,
    isHoldingState: atcResult.isHoldingState,
    isResynced: !!resyncPoint,
    resyncedAtIso: resyncPoint?.syncedAtIso ?? undefined,
    offsetMinutes,
    nextTransition,
    // Crisis passthrough
    crisisMode: prediction.apppe?.crisisActive ?? prediction.crisisMode,
    crisisReason: prediction.apppe?.crisisReason ?? prediction.crisisReason,
  };
}
