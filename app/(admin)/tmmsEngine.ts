/**
 * tmmsEngine.ts — TMMS V2.1 ATC State Machine (Pure TypeScript)
 *
 * This file is the single source of truth for all TMMS-related logic.
 * It is intentionally free of React dependencies so it can be used in:
 *   - hooks/useUserPredictions.ts (production)
 *   - app/(admin)/TMMSDebugSimulator.tsx (admin debug)
 *   - app/(admin)/tmmsSimulation.ts (scenario tests)
 *
 * Exports:
 *   Types   — Prediction, UserPrediction, ShiftedScheduleSlot, ATCInfo,
 *             ScheduleStateMode, TransitionMode, AccuracyLogEvent,
 *             ResyncPoint, CommunitySyncMeta
 *   Helpers — fmtYemenTime, durationLabelFromMin, getZoneFromIso
 *   Engine  — applyOffsetToPrediction
 */

// ── Operational mode for the ATC state machine ─────────────────────────────
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

// ── Transition mode ─────────────────────────────────────────────────────────
export type TransitionMode = 'AUTO' | 'MANUAL';

// ── Day zone ────────────────────────────────────────────────────────────────
export type DayZone = 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT';

// ── Raw prediction from Supabase / analyze-patterns ────────────────────────
export interface Prediction {
  id?: number;
  computedAt: string;
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  learningMode: 'learned' | 'hybrid' | 'estimated';
  nextTransition: NextTransition | null;
  daySchedule: RawScheduleSlot[];
  nightPattern?: any;
  allTimePattern?: any;
  cycleCounts?: any;
  crisisMode?: boolean;
  crisisReason?: string;
  expectedOnDurationLabel?: string;
  expectedOffDurationLabel?: string;
  reasoning?: string[];
  apppe?: {
    crisisActive?: boolean;
    crisisReason?: string;
    driftOffset?: number;
    biasRatio?: number;
    volatilityEMA?: number;
    historyDiagnostics?: {
      clientRowsFiltered?: number;
    };
    [key: string]: any;
  };
  [key: string]: any;
}

// ── Raw schedule slot from the prediction JSON ──────────────────────────────
export interface RawScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso?: string | null;
  startFormatted?: string;
  endFormatted?: string;
  durationLabel?: string;
  zone?: DayZone;
  isEstimated?: boolean;
  [key: string]: any;
}

// ── Shifted schedule slot (after offset is applied) ─────────────────────────
export interface ShiftedScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso?: string | null;
  startFormatted?: string;
  endFormatted?: string;
  shiftedStartFormatted?: string;
  shiftedEndFormatted?: string;
  durationLabel?: string;
  zone: DayZone;
  isEstimated: boolean;
  isResynced?: boolean;
}

// ── Next-transition window ──────────────────────────────────────────────────
export interface NextTransition {
  type: 'UTILITY_ON' | 'UTILITY_OFF';
  rangeStartIso: string;
  rangeEndIso: string;
  rangeLabel: string;
  minFromNowMin: number;
  maxFromNowMin: number;
  waitLabel: string;
  inRangeWindow: boolean;
}

// ── ATC info block attached to UserPrediction ───────────────────────────────
export interface ATCInfo {
  mode: ScheduleStateMode;
  transitionMode: TransitionMode;
  statusLine: string;
  overrunMinutes: number;
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  scheduledAutoTransitionIso?: string | null;
}

// ── Community sync metadata ─────────────────────────────────────────────────
export interface CommunitySyncMeta {
  syncedAtIso: string;
  syncedState: 'ON' | 'OFF';
  reporterName: string | null;
  reporterReliability: number | null;
}

// ── Resync point ────────────────────────────────────────────────────────────
export interface ResyncPoint {
  syncedState: 'ON' | 'OFF';
  syncedAtIso: string;
  appliedAtIso: string;
  reporterName?: string | null;
  reporterReliability?: number | null;
  offsetState?: string;
  offsetValue?: number | 'PENDING' | null;
  timelineAlignment?: string;
  generatedOnStartIso?: string;
  generatedOnDurationMin?: number | null;
  generatedOnReferenceIso?: string | null;
  generatedOnReferenceKind?: 'completed' | 'active' | null;
  confirmationTime?: string;
}

// ── Accuracy log event ──────────────────────────────────────────────────────
export interface AccuracyLogEvent {
  predictedTransitionIso: string;
  actualTransitionIso: string;
  targetState: 'ON' | 'OFF';
  offsetMinutes: number;
  exitMode: ScheduleStateMode;
  errorMinutes: number;
  accuracyScore: number;
}

// ── UserPrediction — the engine's output ────────────────────────────────────
export interface UserPrediction {
  // Current user state (after offset + resync applied)
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;

  // Flags
  isHoldingState: boolean;
  isResynced: boolean;
  resyncedAtIso: string | null;

  // Schedule
  daySchedule: ShiftedScheduleSlot[];
  nextTransition: NextTransition | null;

  // Metrics (passed through from raw prediction)
  confidence: number;
  stabilityScore: number;
  stabilityLabel: string;
  learningMode: 'learned' | 'hybrid' | 'estimated';
  computedAt: string;
  isUnstable: boolean;
  crisisMode: boolean;
  crisisReason: string | null;
  expectedOnDurationLabel?: string;
  expectedOffDurationLabel?: string;
  reasoning?: string[];
  apppe?: Prediction['apppe'];

  // Offset used for schedule shifting
  offsetMinutes: number;

  // ATC state machine output
  atc: ATCInfo;

  // Community sync display metadata
  communitySyncMeta: CommunitySyncMeta | null;

  // Reconciliation
  reconciledCycleStartIso: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Format an ISO string in Yemen timezone (Asia/Aden), 12-hour with Arabic AM/PM */
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

/** Convert a duration in minutes to a human-readable Arabic label */
export function durationLabelFromMin(minutes: number): string {
  if (!minutes || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) {
    if (h === 1) return 'ساعة';
    if (h === 2) return 'ساعتان';
    return `${h} ساعات`;
  }
  return `${h}س ${m}د`;
}

/** Determine the day zone from an ISO timestamp in Yemen timezone */
export function getZoneFromIso(iso: string): DayZone {
  try {
    const hour = new Date(iso).toLocaleString('en-US', {
      timeZone: 'Asia/Aden',
      hour: 'numeric',
      hour12: false,
    });
    const h = parseInt(hour, 10);
    if (h >= 5 && h < 12) return 'MORNING';
    if (h >= 12 && h < 17) return 'AFTERNOON';
    if (h >= 17 && h < 21) return 'EVENING';
    return 'NIGHT';
  } catch {
    return 'NIGHT';
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

function shiftIso(iso: string, offsetMs: number): string {
  return new Date(new Date(iso).getTime() + offsetMs).toISOString();
}

function buildShiftedSlot(raw: RawScheduleSlot, offsetMs: number): ShiftedScheduleSlot {
  const shiftedStart = shiftIso(raw.startIso, offsetMs);
  const shiftedEnd = raw.endIso ? shiftIso(raw.endIso, offsetMs) : null;
  return {
    state: raw.state,
    startIso: shiftedStart,
    endIso: shiftedEnd,
    startFormatted: raw.startFormatted ?? fmtYemenTime(raw.startIso),
    endFormatted: raw.endIso ? (raw.endFormatted ?? fmtYemenTime(raw.endIso)) : undefined,
    shiftedStartFormatted: fmtYemenTime(shiftedStart),
    shiftedEndFormatted: shiftedEnd ? fmtYemenTime(shiftedEnd) : undefined,
    durationLabel: raw.durationLabel,
    zone: raw.zone ?? getZoneFromIso(shiftedStart),
    isEstimated: raw.isEstimated ?? false,
  };
}

function findCurrentSlot(
  slots: ShiftedScheduleSlot[],
  nowMs: number,
): ShiftedScheduleSlot | null {
  return slots.find(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  }) ?? null;
}

function findNextTransition(
  slots: ShiftedScheduleSlot[],
  currentState: 'ON' | 'OFF',
  nowMs: number,
): NextTransition | null {
  const targetState = currentState === 'ON' ? 'OFF' : 'ON';
  const upcoming = slots.filter(
    s => s.state === targetState && new Date(s.startIso).getTime() > nowMs,
  );
  if (upcoming.length === 0) return null;

  const next = upcoming[0];
  const startMs = new Date(next.startIso).getTime();
  const minFromNow = (startMs - nowMs) / 60_000;

  // The range window is ±15 minutes around the slot start
  const windowMs = 15 * 60_000;
  const rangeStartMs = startMs - windowMs;
  const rangeEndMs = startMs + windowMs;
  const inRangeWindow = nowMs >= rangeStartMs && nowMs <= rangeEndMs;

  const rangeStartIso = new Date(rangeStartMs).toISOString();
  const rangeEndIso = new Date(rangeEndMs).toISOString();

  const h = Math.floor(Math.max(0, minFromNow) / 60);
  const m = Math.round(Math.max(0, minFromNow) % 60);
  const waitLabel = minFromNow <= 0 ? 'الآن'
    : h === 0 ? `${m} دقيقة`
    : m === 0 ? `${h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`}`
    : `${h}س ${m}د`;

  return {
    type: targetState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
    rangeStartIso,
    rangeEndIso,
    rangeLabel: `${fmtYemenTime(rangeStartIso)} — ${fmtYemenTime(rangeEndIso)}`,
    minFromNowMin: Math.max(0, minFromNow - 15),
    maxFromNowMin: Math.max(0, minFromNow + 15),
    waitLabel,
    inRangeWindow,
  };
}

// ── Main engine function ────────────────────────────────────────────────────

/**
 * applyOffsetToPrediction
 *
 * Applies the user's ATC offset and community resync point to the raw
 * prediction, running the full 7-mode ATC state machine.
 *
 * @param prediction          Raw prediction from Supabase
 * @param offsetMinutes       User's personal offset in minutes
 * @param resyncPoint         Active community resync point (or null)
 * @param syncMeta            Community sync display metadata (or null)
 * @param transitionMode      AUTO | MANUAL
 * @param anchorStartIso      State anchor ISO (from useStateAnchor)
 * @param frozenOffset        Pre-computed community offset (Rule Q2-A)
 * @param onOffsetCalculated  Callback when a new community offset is first computed
 * @param nowMs               Current timestamp in ms (injectable for testing)
 * @param onAccuracyEvent     Callback when an accuracy log event is ready
 */
export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  syncMeta: CommunitySyncMeta | null,
  transitionMode: TransitionMode,
  anchorStartIso: string | null,
  frozenOffset: number | null,
  onOffsetCalculated: (
    computedOffsetMinutes: number,
    meta: { sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; referenceIso: string | null; referenceKind: string | null },
  ) => void,
  nowMs: number,
  onAccuracyEvent: (event: AccuracyLogEvent) => void,
): UserPrediction {
  const offsetMs = offsetMinutes * 60_000;

  // ── 1. Build the shifted day schedule ──────────────────────────────────
  const rawSlots: RawScheduleSlot[] = prediction.daySchedule ?? [];
  let shiftedSlots: ShiftedScheduleSlot[] = rawSlots.map(s => buildShiftedSlot(s, offsetMs));

  // ── 2. Apply resync point ──────────────────────────────────────────────
  let isResynced = false;
  let resyncedAtIso: string | null = null;
  let communitySyncMeta: CommunitySyncMeta | null = null;

  if (resyncPoint) {
    isResynced = true;
    resyncedAtIso = resyncPoint.syncedAtIso;
    communitySyncMeta = syncMeta;

    // Mark any slot that overlaps the resync time as resynced
    shiftedSlots = shiftedSlots.map(s => {
      const startMs = new Date(s.startIso).getTime();
      const endMs = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      const resyncMs = new Date(resyncPoint.syncedAtIso).getTime();
      if (resyncMs >= startMs && resyncMs < endMs) {
        return { ...s, isResynced: true };
      }
      return s;
    });
  }

  // ── 3. Determine current state ─────────────────────────────────────────
  let currentSlot = findCurrentSlot(shiftedSlots, nowMs);
  let currentState: 'ON' | 'OFF';
  let currentStateStartIso: string | null;

  if (resyncPoint) {
    // Community resync overrides the schedule-derived current state
    currentState = resyncPoint.syncedState;
    currentStateStartIso = resyncPoint.syncedAtIso;
  } else if (currentSlot) {
    currentState = currentSlot.state;
    currentStateStartIso = currentSlot.startIso;
  } else {
    // Fallback: use the last slot's state or the prediction's implied state
    const lastPast = [...shiftedSlots]
      .reverse()
      .find(s => new Date(s.startIso).getTime() <= nowMs);
    currentState = lastPast?.state ?? 'OFF';
    currentStateStartIso = lastPast?.startIso ?? null;
  }

  // ── 4. ATC State Machine ───────────────────────────────────────────────
  const GRACE_THRESHOLD_MIN = 30;
  const PREDICTION_RANGE_MIN = 15;
  const VALIDATION_WINDOW_MIN = 20;

  let atcMode: ScheduleStateMode = 'NORMAL';
  let isHoldingState = false;
  let overrunMinutes = 0;
  let communityElevated = false;
  let inValidationWindow = false;
  let validationWindowRemainingMin = 0;
  let scheduledAutoTransitionIso: string | null = null;
  let statusLine = '';
  let reconciledCycleStartIso: string | null = null;

  // ── COMMUNITY_SYNCED ───────────────────────────────────────────────────
  if (resyncPoint) {
    const syncMs = new Date(resyncPoint.syncedAtIso).getTime();
    const validationEndMs = syncMs + VALIDATION_WINDOW_MIN * 60_000;
    inValidationWindow = nowMs < validationEndMs;
    validationWindowRemainingMin = Math.max(0, (validationEndMs - nowMs) / 60_000);

    // Find the next Growatt transition (unshifted) and check if it conflicts
    // with the community-synced state. If so, raise the validation window flag.
    const growattCurrentSlot = findCurrentSlot(
      rawSlots.map(s => buildShiftedSlot(s, 0)),
      nowMs,
    );
    if (growattCurrentSlot && growattCurrentSlot.state !== currentState) {
      inValidationWindow = true;
      communityElevated = true;
    }

    // Inject a synthetic "current held state" slot at the front of the schedule
    // so the Home Screen / Schedule screen can find it as the active slot.
    const nextRealSlot = shiftedSlots.find(
      s => s.state !== currentState && new Date(s.startIso).getTime() > nowMs,
    );
    const syntheticEnd = nextRealSlot?.startIso ?? null;
    const syntheticSlot: ShiftedScheduleSlot = {
      state: currentState,
      startIso: resyncPoint.syncedAtIso,
      endIso: syntheticEnd,
      startFormatted: fmtYemenTime(resyncPoint.syncedAtIso),
      endFormatted: syntheticEnd ? fmtYemenTime(syntheticEnd) : undefined,
      shiftedStartFormatted: fmtYemenTime(resyncPoint.syncedAtIso),
      shiftedEndFormatted: syntheticEnd ? fmtYemenTime(syntheticEnd) : undefined,
      durationLabel: undefined,
      zone: getZoneFromIso(resyncPoint.syncedAtIso),
      isEstimated: false,
      isResynced: true,
    };

    shiftedSlots = [syntheticSlot, ...shiftedSlots.filter(
      s => new Date(s.startIso).getTime() > nowMs,
    )];

    atcMode = 'COMMUNITY_SYNCED';
    isHoldingState = true;
    statusLine = `مزامنة مجتمعية${resyncPoint.reporterName ? ' · ' + resyncPoint.reporterName : ''}`;
    reconciledCycleStartIso = resyncPoint.syncedAtIso;
  }

  // ── Non-community modes (only when not community-synced) ───────────────
  if (atcMode === 'NORMAL' && shiftedSlots.length > 0) {
    // Find the slot that SHOULD be ending now (the current state's end)
    const schedCurrentSlot = findCurrentSlot(shiftedSlots, nowMs);
    const schedCurrentEnd = schedCurrentSlot?.endIso
      ? new Date(schedCurrentSlot.endIso).getTime()
      : null;

    // Check for POSITIVE_OFFSET_PENDING:
    // The Growatt-unshifted current state differs from the user's shifted state.
    // This means Growatt already transitioned, but the user's schedule hasn't yet.
    const growattShiftedSlots = rawSlots.map(s => buildShiftedSlot(s, 0));
    const growattCurrentSlot = findCurrentSlot(growattShiftedSlots, nowMs);
    const growattState = growattCurrentSlot?.state ?? null;

    if (
      offsetMinutes > 0 &&
      growattState !== null &&
      growattState !== currentState
    ) {
      // Growatt has transitioned but user's schedule hasn't caught up yet
      atcMode = 'POSITIVE_OFFSET_PENDING';
      isHoldingState = true;
      communityElevated = true;

      // Scheduled auto-transition = now + remaining offset time
      // Find the next slot in user's shifted schedule where state flips
      const nextFlipSlot = shiftedSlots.find(
        s => s.state !== currentState && new Date(s.startIso).getTime() > nowMs,
      );
      scheduledAutoTransitionIso = nextFlipSlot?.startIso ?? null;

      statusLine = scheduledAutoTransitionIso
        ? `تغيير تلقائي في ${fmtYemenTime(scheduledAutoTransitionIso)}`
        : 'تغيير تلقائي مجدول';

      // Inject synthetic lingering slot at front with "الآن" marker
      const syntheticEnd = scheduledAutoTransitionIso;
      const syntheticSlot: ShiftedScheduleSlot = {
        state: currentState,
        startIso: currentStateStartIso ?? new Date(nowMs).toISOString(),
        endIso: syntheticEnd,
        startFormatted: currentStateStartIso ? fmtYemenTime(currentStateStartIso) : fmtYemenTime(new Date(nowMs).toISOString()),
        endFormatted: syntheticEnd ? fmtYemenTime(syntheticEnd) : undefined,
        shiftedStartFormatted: currentStateStartIso ? fmtYemenTime(currentStateStartIso) : fmtYemenTime(new Date(nowMs).toISOString()),
        shiftedEndFormatted: syntheticEnd ? fmtYemenTime(syntheticEnd) : undefined,
        durationLabel: undefined,
        zone: getZoneFromIso(currentStateStartIso ?? new Date(nowMs).toISOString()),
        isEstimated: false,
      };

      shiftedSlots = [syntheticSlot, ...shiftedSlots.filter(
        s => new Date(s.startIso).getTime() > nowMs,
      )];
    } else if (schedCurrentEnd !== null) {
      const overrunMs = nowMs - schedCurrentEnd;
      const overrunMin = overrunMs / 60_000;

      if (overrunMin > 0) {
        overrunMinutes = overrunMin;
        communityElevated = true;

        if (overrunMin <= GRACE_THRESHOLD_MIN) {
          atcMode = 'GRACE_MODE';
          isHoldingState = true;
          statusLine = `تأخر ${Math.ceil(overrunMin)} دقيقة عن المتوقع`;
        } else {
          atcMode = 'WAITING_FOR_GROWATT';
          isHoldingState = true;
          statusLine = transitionMode === 'MANUAL'
            ? 'وضع يدوي — بانتظار تأكيدك'
            : 'تجاوزنا نطاق التوقع — بانتظار Growatt';
        }
      } else if (schedCurrentEnd !== null) {
        // Within prediction range?
        const timeToEnd = (schedCurrentEnd - nowMs) / 60_000;
        if (timeToEnd <= PREDICTION_RANGE_MIN) {
          atcMode = 'PREDICTION_RANGE';
          statusLine = 'نطاق التوقع نشط';
        }
      }

      // Negative offset: reconciledCycleStartIso is backdated
      if (offsetMinutes < 0 && currentStateStartIso) {
        reconciledCycleStartIso = currentStateStartIso; // already shifted back by offsetMs
      }
    }
  }

  // ── 5. Next transition ─────────────────────────────────────────────────
  let nextTransition: NextTransition | null = null;
  if (!isHoldingState || atcMode === 'POSITIVE_OFFSET_PENDING') {
    nextTransition = findNextTransition(shiftedSlots, currentState, nowMs);
  } else if (atcMode === 'POSITIVE_OFFSET_PENDING' && scheduledAutoTransitionIso) {
    const scheduledMs = new Date(scheduledAutoTransitionIso).getTime();
    const minFromNow = Math.max(0, (scheduledMs - nowMs) / 60_000);
    nextTransition = {
      type: currentState === 'ON' ? 'UTILITY_OFF' : 'UTILITY_ON',
      rangeStartIso: scheduledAutoTransitionIso,
      rangeEndIso: scheduledAutoTransitionIso,
      rangeLabel: fmtYemenTime(scheduledAutoTransitionIso),
      minFromNowMin: minFromNow,
      maxFromNowMin: minFromNow,
      waitLabel: minFromNow <= 0 ? 'الآن' : durationLabelFromMin(minFromNow),
      inRangeWindow: minFromNow <= 0,
    };
  } else {
    nextTransition = findNextTransition(shiftedSlots, currentState, nowMs);
  }

  // ── 6. Assemble ATCInfo ────────────────────────────────────────────────
  const atc: ATCInfo = {
    mode: atcMode,
    transitionMode,
    statusLine,
    overrunMinutes,
    communityElevated,
    inValidationWindow,
    validationWindowRemainingMin,
    scheduledAutoTransitionIso,
  };

  // ── 7. Assemble UserPrediction ─────────────────────────────────────────
  return {
    currentState,
    currentStateStartIso,
    isHoldingState,
    isResynced,
    resyncedAtIso,
    daySchedule: shiftedSlots,
    nextTransition,
    confidence: prediction.confidence ?? 0,
    stabilityScore: prediction.stabilityScore ?? 0,
    stabilityLabel: prediction.stabilityLabel ?? '',
    learningMode: prediction.learningMode ?? 'estimated',
    computedAt: prediction.computedAt ?? new Date().toISOString(),
    isUnstable: prediction.isUnstable ?? false,
    crisisMode: prediction.crisisMode ?? prediction.apppe?.crisisActive ?? false,
    crisisReason: prediction.crisisReason ?? prediction.apppe?.crisisReason ?? null,
    expectedOnDurationLabel: prediction.expectedOnDurationLabel,
    expectedOffDurationLabel: prediction.expectedOffDurationLabel,
    reasoning: prediction.reasoning,
    apppe: prediction.apppe,
    offsetMinutes,
    atc,
    communitySyncMeta,
    reconciledCycleStartIso,
  };
}
